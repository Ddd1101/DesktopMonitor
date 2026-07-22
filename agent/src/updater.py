"""Agent 自更新与重启模块

提供：
- check_for_update: 比较版本号判断是否需要更新
- download_and_verify: 下载 exe 并校验 SHA256
- perform_update: 生成 PowerShell 替换脚本，替换当前 exe 后重启
- perform_restart: 生成 PowerShell 重启脚本，重启当前进程

仅在打包模式（sys.frozen=True）下执行实际更新/重启；
开发模式仅打印日志，便于本地调试。
"""
import hashlib
import os
import subprocess
import sys
import tempfile
from typing import Any

import requests

from src.utils.logger import get_logger

logger = get_logger(__name__)


def _parse_semver(version: str) -> tuple[int, int, int]:
    """将 'major.minor.patch' 字符串解析为 (major, minor, patch) 元组。

    解析失败时对应位补 0。
    """
    parts = version.strip().split('.')
    nums: list[int] = []
    for p in parts[:3]:
        try:
            nums.append(int(p))
        except ValueError:
            nums.append(0)
    while len(nums) < 3:
        nums.append(0)
    return (nums[0], nums[1], nums[2])


def check_for_update(update_info: dict) -> bool:
    """比较当前版本与最新版本，返回是否需要更新。

    update_info 格式：{ latest_version, download_url, sha256, force }
    使用 semver 比较（major.minor.patch），force=True 时无论版本都返回 True。
    """
    if not update_info:
        return False

    # force=True 时强制更新
    if update_info.get('force'):
        logger.info('服务端标记强制更新')
        return True

    latest = update_info.get('latest_version') or update_info.get('version')
    if not latest:
        return False

    # 延迟导入避免循环依赖（main.py 导入 worker.py，worker.py 导入 updater.py）
    from src.main import AGENT_VERSION
    current = AGENT_VERSION

    current_tuple = _parse_semver(current)
    latest_tuple = _parse_semver(latest)

    logger.info(f'版本比较: 当前={current} 最新={latest}')
    return latest_tuple > current_tuple


def download_and_verify(url: str, expected_sha256: str, session: requests.Session) -> str:
    """下载 exe 到临时目录并校验 SHA256。

    返回临时文件路径。校验失败抛 ValueError。
    """
    logger.info(f'开始下载更新: {url}')

    # 创建临时文件（不自动删除，由 perform_update / 调用方负责清理）
    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.exe', prefix='agent_update_')
    os.close(tmp_fd)

    sha256 = hashlib.sha256()
    try:
        with session.get(url, stream=True, timeout=300) as resp:
            resp.raise_for_status()
            with open(tmp_path, 'wb') as f:
                for chunk in resp.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        f.write(chunk)
                        sha256.update(chunk)
    except Exception:
        # 下载失败清理临时文件
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise

    actual_sha256 = sha256.hexdigest()
    if expected_sha256 and actual_sha256.lower() != expected_sha256.lower():
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise ValueError(
            f'SHA256 校验失败: 期望={expected_sha256} 实际={actual_sha256}'
        )

    logger.info(f'下载完成: {tmp_path} sha256={actual_sha256}')
    return tmp_path


def _is_frozen() -> bool:
    """判断是否为 PyInstaller 打包模式。"""
    return getattr(sys, 'frozen', False)


def perform_update(new_exe_path: str, agent: Any) -> None:
    """执行升级：生成 PowerShell 替换脚本，调用当前进程退出。

    流程：
    1. 获取当前 exe 路径（sys.executable，打包模式）与当前 PID（os.getpid()）
    2. 生成 PowerShell 脚本到临时 .ps1 文件：
       - 等待当前 PID 退出（Wait-Process -Id <pid>）
       - Copy-Item -Force new_exe_path -> sys.executable
       - Start-Process sys.executable
       - 删除自身 .ps1
    3. 用 subprocess.Popen 启动 PowerShell（非阻塞）
    4. 调用 agent.stop() 优雅退出
    5. sys.exit(0)
    """
    if not _is_frozen():
        logger.info('开发模式跳过更新')
        return

    current_exe = sys.executable
    current_pid = os.getpid()

    # 生成 PowerShell 脚本
    ps_script = f"""$ErrorActionPreference = 'Stop'
try {{
    Wait-Process -Id {current_pid} -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Copy-Item -Path '{new_exe_path}' -Destination '{current_exe}' -Force
    Start-Process -FilePath '{current_exe}'
}} catch {{
    Write-Host "Update failed: $($_.Exception.Message)"
}} finally {{
    Remove-Item -Path '{new_exe_path}' -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
}}
"""

    # 写入临时 .ps1 文件
    ps_fd, ps_path = tempfile.mkstemp(suffix='.ps1', prefix='agent_update_')
    with os.fdopen(ps_fd, 'w', encoding='utf-8') as f:
        f.write(ps_script)

    logger.info(f'启动更新脚本: {ps_path}')
    logger.info(
        f'当前 exe={current_exe} PID={current_pid} 新 exe={new_exe_path}'
    )

    # 非阻塞启动 PowerShell
    subprocess.Popen([
        'powershell',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', ps_path,
    ])

    # 优雅退出
    try:
        agent.stop()
    except Exception as e:
        logger.error(f'agent.stop 异常: {e}', exc_info=True)

    logger.info('Agent 即将退出以完成更新')
    sys.exit(0)


def perform_restart(agent: Any) -> None:
    """执行重启：生成 PowerShell 重启脚本，调用当前进程退出。

    流程：
    1. 获取当前 exe 路径（sys.executable）与 PID（os.getpid()）
    2. 生成 PowerShell 脚本：
       - 等待当前 PID 退出（Wait-Process -Id <pid>）
       - Start-Process sys.executable
       - 删除自身 .ps1
    3. 启动 PowerShell（非阻塞）
    4. 调用 agent.stop()
    5. sys.exit(0)
    """
    if not _is_frozen():
        logger.info('开发模式跳过重启')
        return

    current_exe = sys.executable
    current_pid = os.getpid()

    # 生成 PowerShell 脚本
    ps_script = f"""$ErrorActionPreference = 'Stop'
try {{
    Wait-Process -Id {current_pid} -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Start-Process -FilePath '{current_exe}'
}} catch {{
    Write-Host "Restart failed: $($_.Exception.Message)"
}} finally {{
    Remove-Item -Path $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
}}
"""

    # 写入临时 .ps1 文件
    ps_fd, ps_path = tempfile.mkstemp(suffix='.ps1', prefix='agent_restart_')
    with os.fdopen(ps_fd, 'w', encoding='utf-8') as f:
        f.write(ps_script)

    logger.info(f'启动重启脚本: {ps_path}')
    logger.info(f'当前 exe={current_exe} PID={current_pid}')

    # 非阻塞启动 PowerShell
    subprocess.Popen([
        'powershell',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', ps_path,
    ])

    # 优雅退出
    try:
        agent.stop()
    except Exception as e:
        logger.error(f'agent.stop 异常: {e}', exc_info=True)

    logger.info('Agent 即将退出以完成重启')
    sys.exit(0)

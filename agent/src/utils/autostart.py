r"""Windows 开机自启管理模块

通过写入注册表 ``HKCU\Software\Microsoft\Windows\CurrentVersion\Run``
实现 Agent 开机自启。仅 Windows 平台生效。

提供三个对外接口：
- enable_autostart()    启用开机自启
- disable_autostart()   禁用开机自启
- is_autostart_enabled() 检查是否已启用
"""
import os
import sys

from src.utils.logger import get_logger

logger = get_logger(__name__)

# 注册表子键路径
_AUTOSTART_KEY_PATH = r'Software\Microsoft\Windows\CurrentVersion\Run'
# 注册表值名称
_AUTOSTART_VALUE_NAME = 'DesktopMonitorAgent'


def _get_pythonw_path() -> str:
    """获取 pythonw.exe 路径（无控制台窗口的 Python 解释器）。

    优先使用与当前解释器同目录下的 pythonw.exe；
    若不存在（如虚拟环境未提供 pythonw），回退到当前解释器。
    """
    exe_dir = os.path.dirname(sys.executable)
    pythonw = os.path.join(exe_dir, 'pythonw.exe')
    if os.path.exists(pythonw):
        return pythonw
    # 回退到当前解释器（可能是 python.exe 或已在 pythonw 中运行）
    return sys.executable


def _get_main_py_path() -> str:
    """获取 ``src/main.py`` 的绝对路径。

    本文件位于 ``src/utils/autostart.py``，上溯一级即为 ``src/``。
    """
    src_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(src_dir, 'main.py')


def _build_autostart_command() -> str:
    r"""构建注册表中存储的自启命令字符串。

    格式：``"C:\path\to\pythonw.exe" "C:\path\to\agent\src\main.py"``
    """
    pythonw = _get_pythonw_path()
    main_py = _get_main_py_path()
    # 路径两端加引号，避免路径中包含空格时被解析为多个参数
    return f'"{pythonw}" "{main_py}"'


def _is_windows() -> bool:
    """判断当前平台是否为 Windows。"""
    return sys.platform.startswith('win')


def enable_autostart() -> bool:
    """启用开机自启（写入注册表）。

    Returns:
        True 表示成功；False 表示失败或平台不支持
    """
    # 非 Windows 平台直接跳过
    if not _is_windows():
        logger.warning(f'当前平台 {sys.platform} 不支持开机自启，已跳过')
        return False

    try:
        import winreg
    except ImportError:
        logger.error('当前环境缺少 winreg 模块，无法配置开机自启')
        return False

    command = _build_autostart_command()
    try:
        # 以写权限打开 HKCU\Software\Microsoft\Windows\CurrentVersion\Run
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            _AUTOSTART_KEY_PATH,
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.SetValueEx(
                key,
                _AUTOSTART_VALUE_NAME,
                0,
                winreg.REG_SZ,
                command,
            )
        logger.info(f'已写入注册表开机自启项: {command}')
        return True
    except OSError as e:
        logger.error(f'写入注册表失败: {e}')
        return False
    except Exception as e:
        logger.error(f'启用开机自启异常: {e}', exc_info=True)
        return False


def disable_autostart() -> bool:
    """禁用开机自启（删除注册表项）。

    Returns:
        True 表示成功或键本就不存在；False 表示失败
    """
    if not _is_windows():
        logger.warning(f'当前平台 {sys.platform} 不支持开机自启，已跳过')
        return False

    try:
        import winreg
    except ImportError:
        logger.error('当前环境缺少 winreg 模块')
        return False

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            _AUTOSTART_KEY_PATH,
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.DeleteValue(key, _AUTOSTART_VALUE_NAME)
        logger.info('已删除注册表开机自启项')
        return True
    except FileNotFoundError:
        # 键不存在视为已禁用，幂等返回成功
        logger.info('开机自启项不存在，无需删除')
        return True
    except OSError as e:
        logger.error(f'删除注册表失败: {e}')
        return False
    except Exception as e:
        logger.error(f'禁用开机自启异常: {e}', exc_info=True)
        return False


def is_autostart_enabled() -> bool:
    """检查开机自启是否已启用。

    Returns:
        True 表示已启用（注册表中存在该值）；False 表示未启用或查询失败
    """
    if not _is_windows():
        return False

    try:
        import winreg
    except ImportError:
        return False

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            _AUTOSTART_KEY_PATH,
            0,
            winreg.KEY_READ,
        ) as key:
            value, _ = winreg.QueryValueEx(key, _AUTOSTART_VALUE_NAME)
            return bool(value)
    except FileNotFoundError:
        return False
    except OSError as e:
        logger.error(f'查询注册表失败: {e}')
        return False
    except Exception as e:
        logger.error(f'检查开机自启异常: {e}', exc_info=True)
        return False

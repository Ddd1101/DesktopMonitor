"""服务端 HTTP 客户端封装

封装 Agent 与服务端之间的所有 HTTP 交互：
- POST /api/agent/register   注册并获取 (deviceId, token)
- POST /api/agent/events     上报活动事件
- POST /api/agent/screenshots multipart 上传截图
- POST /api/agent/heartbeat  发送心跳

约定：
- 所有受保护接口使用 Authorization: Bearer <token>
- 注册接口在请求体中携带 registerToken
- 所有请求超时 30 秒
- 401 响应统一抛 TokenExpiredError
"""
import os
from typing import Optional

import requests

from src.config.config import config
from src.utils.logger import get_logger

logger = get_logger(__name__)


class TokenExpiredError(Exception):
    """Token 失效或过期异常。

    上传工作线程捕获此异常后会触发重新注册流程。
    """
    pass


class ServerClient:
    """服务端 HTTP 客户端。"""

    # 所有请求统一超时（秒）
    REQUEST_TIMEOUT = 30

    def __init__(self, base_url: Optional[str] = None) -> None:
        """初始化客户端。

        Args:
            base_url: 服务端基础地址，默认 config.SERVER_URL
        """
        self.base_url = (base_url or config.SERVER_URL).rstrip('/')
        self._token: Optional[str] = None
        self._device_id: Optional[str] = None
        # 使用 Session 复用连接
        self._session = requests.Session()
        # 注册接口的预置 Token
        self._register_token = config.AGENT_REGISTER_TOKEN

    # ----- Token / DeviceId 管理 -----
    def set_token(self, token: Optional[str]) -> None:
        """设置 token，并同步更新 Session 的 Authorization 头。"""
        self._token = token
        if token:
            self._session.headers.update({'Authorization': f'Bearer {token}'})
        else:
            self._session.headers.pop('Authorization', None)

    def get_token(self) -> Optional[str]:
        return self._token

    def set_device_id(self, device_id: Optional[str]) -> None:
        self._device_id = device_id

    def get_device_id(self) -> Optional[str]:
        return self._device_id

    # ----- 注册 -----
    def register(
        self, hostname: str, os_info: Optional[str] = None
    ) -> tuple[str, str, Optional[str]]:
        """调用 POST /api/agent/register 完成注册。

        Args:
            hostname: 主机名
            os_info: 操作系统信息

        Returns:
            (deviceId, token, publicKey)；publicKey 可能为 None

        Raises:
            RuntimeError: 注册失败
            requests.RequestException: 网络异常
        """
        url = f'{self.base_url}/api/agent/register'
        # 服务端字段为 camelCase
        payload = {
            'registerToken': self._register_token,
            'hostname': hostname,
            'osInfo': os_info or '',
        }
        try:
            resp = self._session.post(
                url, json=payload, timeout=self.REQUEST_TIMEOUT
            )
        except requests.RequestException as e:
            logger.error(f'注册请求失败: {e}')
            raise

        if resp.status_code not in (200, 201):
            logger.error(
                f'注册失败 status={resp.status_code} body={resp.text[:200]}'
            )
            raise RuntimeError(f'注册失败: HTTP {resp.status_code}')

        try:
            data = resp.json()
        except ValueError:
            raise RuntimeError('注册响应非 JSON')

        device_id = data.get('deviceId') or data.get('device_id')
        token = data.get('token')
        if not device_id or not token:
            raise RuntimeError(f'注册响应缺少 deviceId/token: {data}')
        # 公钥用于截图加密（camelCase 或 snake_case 兼容）
        public_key = data.get('publicKey') or data.get('public_key')

        # 注册成功，保存到内存（凭证持久化由调用方负责）
        self.set_token(token)
        self.set_device_id(device_id)
        logger.info(f'注册成功 deviceId={device_id}')
        return (device_id, token, public_key)

    # ----- 事件上报 -----
    def send_events(self, events: list[dict]) -> bool:
        """调用 POST /api/agent/events 上报事件。

        Args:
            events: 事件列表

        Returns:
            True 表示成功；False 表示业务失败（非 401）

        Raises:
            TokenExpiredError: 401 时抛出
        """
        if not self._token:
            raise TokenExpiredError('未设置 token')

        url = f'{self.base_url}/api/agent/events'
        try:
            resp = self._session.post(
                url, json={'events': events}, timeout=self.REQUEST_TIMEOUT
            )
        except requests.RequestException as e:
            logger.error(f'上报事件网络异常: {e}')
            return False

        if resp.status_code == 401:
            raise TokenExpiredError('事件上报返回 401')
        if resp.status_code not in (200, 201):
            logger.error(
                f'上报事件失败 status={resp.status_code} body={resp.text[:200]}'
            )
            return False
        return True

    # ----- 截图上传 -----
    def send_screenshot(
        self,
        file_path: str,
        taken_at: str,
        monitor_index: int = 1,
    ) -> bool:
        """multipart 上传单张截图到 POST /api/agent/screenshots。

        Args:
            file_path: 截图文件绝对路径
            taken_at: 截图时间（ISO 8601）
            monitor_index: 显示器索引（从 1 开始，1=主屏）

        Returns:
            True 表示成功；False 表示业务失败（非 401）

        Raises:
            TokenExpiredError: 401 时抛出
        """
        if not self._token:
            raise TokenExpiredError('未设置 token')

        if not os.path.exists(file_path):
            logger.warning(f'截图文件不存在: {file_path}')
            return False

        url = f'{self.base_url}/api/agent/screenshots'
        try:
            # 使用上下文管理器确保文件句柄关闭
            with open(file_path, 'rb') as f:
                files = {
                    'file': (
                        os.path.basename(file_path),
                        f,
                        'application/octet-stream',
                    ),
                }
                data = {
                    'taken_at': taken_at,
                    'takenAt': taken_at,
                    'monitor_index': str(monitor_index),
                    'monitorIndex': str(monitor_index),
                    'device_id': self._device_id or '',
                    'deviceId': self._device_id or '',
                }
                resp = self._session.post(
                    url, files=files, data=data, timeout=self.REQUEST_TIMEOUT
                )
        except requests.RequestException as e:
            logger.error(f'上传截图网络异常: {e}')
            return False
        except OSError as e:
            logger.error(f'读取截图文件失败: {e}')
            return False

        if resp.status_code == 401:
            raise TokenExpiredError('截图上传返回 401')
        if resp.status_code not in (200, 201):
            logger.error(
                f'上传截图失败 status={resp.status_code} body={resp.text[:200]}'
            )
            return False
        return True

    # ----- 心跳 -----
    def heartbeat(
        self,
        hostname: Optional[str] = None,
        ip: Optional[str] = None,
        os_info: Optional[str] = None,
        monitor_resolutions: Optional[list[dict]] = None,
    ) -> bool:
        """调用 POST /api/agent/heartbeat 发送心跳。

        Args:
            hostname: 主机名
            ip: 本机内网 IP
            os_info: 操作系统信息
            monitor_resolutions: 各显示器分辨率列表，
                形如 [{"width": 1920, "height": 1080}, ...]；为 None 时不携带该字段

        Returns:
            True 表示成功；False 表示业务失败（非 401）

        Raises:
            TokenExpiredError: 401 时抛出
        """
        if not self._token:
            raise TokenExpiredError('未设置 token')

        url = f'{self.base_url}/api/agent/heartbeat'
        payload = {
            'hostname': hostname or '',
            'ip': ip or '',
            'os_info': os_info or '',
            'osInfo': os_info or '',
        }
        if monitor_resolutions is not None:
            payload['monitor_resolutions'] = monitor_resolutions
            payload['monitorResolutions'] = monitor_resolutions
        try:
            resp = self._session.post(
                url, json=payload, timeout=self.REQUEST_TIMEOUT
            )
        except requests.RequestException as e:
            logger.error(f'心跳网络异常: {e}')
            return False

        if resp.status_code == 401:
            raise TokenExpiredError('心跳返回 401')
        if resp.status_code not in (200, 201):
            logger.error(
                f'心跳失败 status={resp.status_code} body={resp.text[:200]}'
            )
            return False
        return True

    # ----- 远端配置拉取 -----
    def get_remote_config(self) -> Optional[dict]:
        """调用 GET /api/agent/config 拉取远端配置。

        服务端响应格式：{ config: {...}, update: {...} | null }
        其中 update 字段（非 null 时）形如：
        { latest_version, download_url, sha256, force }

        Returns:
            完整响应 dict（包含 config 与 update 字段）；失败时返回 None

        Raises:
            TokenExpiredError: 401 时抛出
        """
        if not self._token:
            raise TokenExpiredError('未设置 token')

        url = f'{self.base_url}/api/agent/config'
        try:
            resp = self._session.get(url, timeout=self.REQUEST_TIMEOUT)
        except requests.RequestException as e:
            logger.error(f'拉取远端配置网络异常: {e}')
            return None

        if resp.status_code == 401:
            raise TokenExpiredError('拉取远端配置返回 401')
        if resp.status_code != 200:
            logger.error(
                f'拉取远端配置失败 status={resp.status_code} '
                f'body={resp.text[:200]}'
            )
            return None

        try:
            data = resp.json()
        except ValueError:
            logger.error('拉取远端配置响应非 JSON')
            return None

        if not isinstance(data, dict) or not isinstance(data.get('config'), dict):
            logger.error(f'远端配置响应缺少 config 字段: {data}')
            return None
        return data

    # ----- 命令拉取与上报 -----
    def get_commands(self) -> list[dict]:
        """拉取当前设备的待执行命令。

        调用 GET /api/agent/commands，返回命令列表。
        每条命令形如：{ id, command, payload }，payload 为 JSON 字符串。

        Returns:
            命令列表；失败时返回空列表

        Raises:
            TokenExpiredError: 401 时抛出
        """
        if not self._token:
            raise TokenExpiredError('未设置 token')

        url = f'{self.base_url}/api/agent/commands'
        try:
            resp = self._session.get(url, timeout=self.REQUEST_TIMEOUT)
        except requests.RequestException as e:
            logger.error(f'拉取命令网络异常: {e}')
            return []

        if resp.status_code == 401:
            raise TokenExpiredError('拉取命令返回 401')
        if resp.status_code != 200:
            logger.error(
                f'拉取命令失败 status={resp.status_code} '
                f'body={resp.text[:200]}'
            )
            return []

        try:
            data = resp.json()
        except ValueError:
            logger.error('拉取命令响应非 JSON')
            return []

        commands = data.get('commands', [])
        if not isinstance(commands, list):
            logger.error(f'拉取命令响应 commands 字段非列表: {data}')
            return []
        return commands

    def report_command_done(self, command_id: int) -> None:
        """上报命令执行完成。

        调用 POST /api/agent/commands/:id/done。

        Raises:
            TokenExpiredError: 401 时抛出
            requests.RequestException: 网络异常
        """
        if not self._token:
            raise TokenExpiredError('未设置 token')

        url = f'{self.base_url}/api/agent/commands/{command_id}/done'
        resp = self._session.post(url, timeout=self.REQUEST_TIMEOUT)

        if resp.status_code == 401:
            raise TokenExpiredError('上报命令完成返回 401')
        if resp.status_code not in (200, 201, 204):
            logger.error(
                f'上报命令完成失败 id={command_id} '
                f'status={resp.status_code} body={resp.text[:200]}'
            )
            resp.raise_for_status()

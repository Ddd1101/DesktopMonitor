"""Agent 凭证持久化模块

注册成功后，将 (device_id, token) 持久化到 agent/data/credentials.json，
下次启动时直接加载，避免每次重启都重新注册。
"""
import json
import os
from typing import Optional

from src.config.config import config
from src.utils.logger import get_logger

logger = get_logger(__name__)


def load_credentials() -> Optional[dict]:
    """从 CREDENTIALS_FILE 读取凭证。

    Returns:
        {'device_id': str, 'token': str}；文件不存在或格式错误时返回 None
    """
    cred_path = config.CREDENTIALS_FILE
    if not os.path.exists(cred_path):
        return None
    try:
        with open(cred_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get('device_id') and data.get('token'):
            return {
                'device_id': data['device_id'],
                'token': data['token'],
            }
        logger.warning('凭证文件格式不正确，忽略')
        return None
    except (OSError, json.JSONDecodeError) as e:
        logger.warning(f'读取凭证文件失败: {e}')
        return None


def save_credentials(device_id: str, token: str) -> None:
    """将凭证保存到 JSON 文件。

    Args:
        device_id: 设备 ID
        token: JWT token
    """
    cred_path = config.CREDENTIALS_FILE
    try:
        # 确保目录存在
        cred_dir = os.path.dirname(cred_path)
        if cred_dir:
            os.makedirs(cred_dir, exist_ok=True)
        with open(cred_path, 'w', encoding='utf-8') as f:
            json.dump(
                {'device_id': device_id, 'token': token},
                f,
                ensure_ascii=False,
                indent=2,
            )
        logger.debug('凭证已保存')
    except OSError as e:
        logger.error(f'保存凭证失败: {e}')


def clear_credentials() -> None:
    """删除凭证文件（用于 token 失效后触发重新注册）。"""
    cred_path = config.CREDENTIALS_FILE
    try:
        if os.path.exists(cred_path):
            os.remove(cred_path)
            logger.info('凭证文件已删除')
    except OSError as e:
        logger.warning(f'删除凭证文件失败: {e}')

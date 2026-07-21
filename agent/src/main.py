"""Agent 主进程入口

职责：
1. 初始化日志、数据库
2. 初始化 ServerClient（检查本地 credentials.json 决定是否注册）
3. 初始化 ScreenCollector、WindowCollector、UploadWorker
4. 启动所有线程
5. 注册信号处理（SIGINT/SIGTERM）优雅退出

启动方式：
    pythonw.exe src/main.py    无控制台窗口运行（推荐用于开机自启）
    python.exe src/main.py     带控制台窗口运行（调试用）

退出方式：
    收到 SIGINT (Ctrl+C) 或 SIGTERM 时优雅停止所有子线程后退出。
    所有子线程均为 daemon=True，主线程退出时也会被强制终止，
    但正常退出场景下会通过 stop() 显式 join 等待子线程结束。
"""
import platform
import signal
import socket
import sys
import time

from src.collectors.screen import ScreenCollector
from src.collectors.window import WindowCollector
from src.config.config import config
from src.storage.db import get_db
from src.uploader.client import ServerClient
from src.uploader.credentials import load_credentials, save_credentials
from src.uploader.worker import UploadWorker
from src.utils.autostart import enable_autostart
from src.utils.logger import get_logger

logger = get_logger('main')

# Agent 版本号
AGENT_VERSION = '1.0.0'


def _mask_token(token: str) -> str:
    """对敏感 token 做脱敏处理，仅保留首尾各 4 位。

    长度不足时统一返回 ``***``。
    """
    if not token:
        return '***'
    if len(token) <= 8:
        return '***'
    return f'{token[:4]}***{token[-4:]}'


def _print_banner() -> None:
    """打印版本信息与配置摘要（脱敏，不打印完整 token）。"""
    logger.info('=' * 60)
    logger.info(f'DesktopMonitor Agent v{AGENT_VERSION}')
    logger.info(f'  Python: {sys.version.split()[0]}')
    logger.info(f'  Platform: {platform.platform()}')
    logger.info(f'  Hostname: {socket.gethostname()}')
    logger.info('-' * 60)
    logger.info('配置摘要:')
    logger.info(f'  SERVER_URL: {config.SERVER_URL}')
    # 注册 Token 脱敏，避免日志泄露
    logger.info(
        f'  AGENT_REGISTER_TOKEN: {_mask_token(config.AGENT_REGISTER_TOKEN)}'
    )
    logger.info(f'  SCREENSHOT_INTERVAL: {config.SCREENSHOT_INTERVAL}s')
    logger.info(f'  WINDOW_SAMPLE_INTERVAL: {config.WINDOW_SAMPLE_INTERVAL}s')
    logger.info(f'  EVENT_AGGREGATE_INTERVAL: {config.EVENT_AGGREGATE_INTERVAL}s')
    logger.info(f'  UPLOAD_INTERVAL: {config.UPLOAD_INTERVAL}s')
    logger.info(f'  LOG_LEVEL: {config.LOG_LEVEL}')
    logger.info(f'  DB_PATH: {config.DB_PATH}')
    logger.info(f'  SCREENSHOTS_DIR: {config.SCREENSHOTS_DIR}')
    logger.info('=' * 60)


class Agent:
    """Agent 主进程：协调屏幕采集、窗口采集与上传工作线程。"""

    def __init__(self) -> None:
        # 1. 初始化数据库（Database 构造函数已自动建表，幂等）
        self.db = get_db()
        logger.info('数据库已初始化')

        # 2. 初始化服务端客户端并尝试注册
        self.client = ServerClient()
        self._ensure_registered()

        # 3. 初始化采集器
        self.screen_collector = ScreenCollector()
        self.window_collector = WindowCollector()

        # 4. 初始化上传器（内部会处理 token 失效后的重新注册）
        self.upload_worker = UploadWorker(
            self.client, screen_collector=self.screen_collector
        )

    def _ensure_registered(self) -> None:
        """检查本地凭证，未注册则调用服务端注册。

        注册失败不抛异常，由 UploadWorker 在后台重试。
        """
        creds = load_credentials()
        if creds:
            self.client.set_device_id(creds['device_id'])
            self.client.set_token(creds['token'])
            logger.info(f'已加载本地凭证，设备ID: {creds["device_id"]}')
            return

        logger.info('未找到本地凭证，开始注册...')
        try:
            hostname = socket.gethostname()
            os_info = platform.platform()
            device_id, token = self.client.register(hostname, os_info)
            save_credentials(device_id, token)
            logger.info(f'注册成功，设备ID: {device_id}')
        except Exception as e:
            logger.error(f'注册失败: {e}')
            logger.info(
                '将以后台重试模式运行，待服务端可用后由 UploadWorker 自动注册'
            )

    def start(self) -> None:
        """启动所有子线程。"""
        logger.info('Agent 启动中...')
        self.screen_collector.start()
        self.window_collector.start()
        self.upload_worker.start()
        logger.info('Agent 已启动')

    def stop(self) -> None:
        """停止所有子线程并关闭数据库。"""
        logger.info('Agent 停止中...')
        # 顺序停止：先停采集器，再停上传器
        self.screen_collector.stop()
        self.window_collector.stop()
        self.upload_worker.stop()
        # 关闭数据库连接
        try:
            self.db.close()
        except Exception as e:
            logger.warning(f'关闭数据库异常: {e}')
        logger.info('Agent 已停止')


def main() -> None:
    """Agent 主入口。"""
    # 打印版本信息与配置摘要
    _print_banner()

    # 尝试启用开机自启（失败仅记录日志，不中断启动流程）
    try:
        if enable_autostart():
            logger.info('开机自启已启用')
        else:
            logger.warning('开机自启启用失败（仅记录，不影响运行）')
    except Exception as e:
        logger.warning(f'启用开机自启异常: {e}', exc_info=True)

    # 初始化 Agent
    agent = Agent()

    # 注册信号处理（优雅退出）
    def signal_handler(signum, frame) -> None:
        logger.info(f'收到信号 {signum}，准备退出')
        agent.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # 启动所有子线程
    agent.start()

    # 主线程保持运行，等待子线程结束或被信号中断
    # 子线程均为 daemon=True，主线程退出时会被强制终止，
    # 但正常退出场景下 stop() 会显式 join 等待子线程结束。
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        # Ctrl+C 兜底（与 SIGINT 信号处理互补）
        agent.stop()


if __name__ == '__main__':
    main()

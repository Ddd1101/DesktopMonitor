"""配置模块

使用 python-dotenv 加载 .env 环境变量，集中管理 Agent 运行配置。
"""
import os
from dotenv import load_dotenv

# 加载 agent/.env 文件（位于 src/config/ 上两级目录）
load_dotenv()


class Config:
    """Agent 运行配置

    所有配置项均从环境变量读取，并提供合理默认值。
    """

    # ----- 服务端连接 -----
    # 服务端基础地址
    SERVER_URL = os.getenv('SERVER_URL', 'http://localhost:3000')
    # Agent 注册预置 Token（需与服务端保持一致）
    AGENT_REGISTER_TOKEN = os.getenv('AGENT_REGISTER_TOKEN', 'change-me-please')

    # ----- 采集与上传调度 -----
    # 截图采集间隔（秒）
    SCREENSHOT_INTERVAL = int(os.getenv('SCREENSHOT_INTERVAL', '30'))
    # 活动窗口采样间隔（秒）
    WINDOW_SAMPLE_INTERVAL = float(os.getenv('WINDOW_SAMPLE_INTERVAL', '1'))
    # 活动事件聚合周期（秒）
    EVENT_AGGREGATE_INTERVAL = int(os.getenv('EVENT_AGGREGATE_INTERVAL', '30'))
    # 上传器轮询间隔（秒）
    UPLOAD_INTERVAL = int(os.getenv('UPLOAD_INTERVAL', '60'))

    # ----- 截图压缩 -----
    # 截图大小阈值（KB），超过则自动降低清晰度重新压缩
    SCREENSHOT_MAX_SIZE_KB = int(os.getenv('SCREENSHOT_MAX_SIZE_KB', '200'))
    # 压缩递降的质量档位（依次尝试，直到低于阈值或用完）
    SCREENSHOT_QUALITY_STEPS = [70, 50, 30, 15]
    # 缩放比例上限（宽/高超过此值时按比例缩小，None 表示不缩放）
    # 高分屏（如 4K）截图分辨率过大，即使低质量也超阈值，需缩放
    SCREENSHOT_MAX_WIDTH = int(os.getenv('SCREENSHOT_MAX_WIDTH', '1920'))

    # ----- 日志 -----
    # 日志级别（DEBUG / INFO / WARNING / ERROR）
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')

    # ----- 路径 -----
    # agent/ 根目录（src/config/config.py 上溯三级）
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    # 数据目录
    DATA_DIR = os.path.join(BASE_DIR, 'data')
    # SQLite 数据库文件路径
    DB_PATH = os.path.join(DATA_DIR, 'agent.db')
    # 截图落盘目录
    SCREENSHOTS_DIR = os.path.join(DATA_DIR, 'screenshots')

    # ----- Agent 凭证持久化 -----
    # Agent 注册成功后保存的凭证文件
    CREDENTIALS_FILE = os.path.join(DATA_DIR, 'credentials.json')

    def apply_remote_config(self, remote: dict) -> bool:
        """根据远端配置更新本机配置项。

        比较 screenshot_quality、screenshot_max_width、screenshot_interval_sec
        与当前值，有变化则更新对应类属性并返回 True；无变化返回 False。

        screenshot_quality 变化时，同步更新 SCREENSHOT_QUALITY_STEPS 为：
        [q, int(q*0.7), int(q*0.4), max(5, int(q*0.2))]

        Args:
            remote: 远端配置 dict，应包含 screenshot_quality、
                screenshot_max_width、screenshot_interval_sec 等字段

        Returns:
            True 表示有配置项发生变化；False 表示无变化
        """
        changed = False

        # 截图清晰度
        quality = remote.get('screenshot_quality')
        if quality is not None and int(quality) != self.SCREENSHOT_QUALITY_STEPS[0]:
            q = int(quality)
            self.SCREENSHOT_QUALITY_STEPS = [
                q, int(q * 0.7), int(q * 0.4), max(5, int(q * 0.2))
            ]
            changed = True

        # 截图最大宽度
        max_width = remote.get('screenshot_max_width')
        if max_width is not None and int(max_width) != self.SCREENSHOT_MAX_WIDTH:
            self.SCREENSHOT_MAX_WIDTH = int(max_width)
            changed = True

        # 截图采集间隔
        interval = remote.get('screenshot_interval_sec')
        if interval is not None and int(interval) != self.SCREENSHOT_INTERVAL:
            self.SCREENSHOT_INTERVAL = int(interval)
            changed = True

        return changed


# 全局配置单例
config = Config()

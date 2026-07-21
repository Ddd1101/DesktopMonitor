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


# 全局配置单例
config = Config()

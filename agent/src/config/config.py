"""配置模块

使用 python-dotenv 加载 .env 环境变量，集中管理 Agent 运行配置。

打包模式（PyInstaller）下：
- 数据目录使用 %PROGRAMDATA%\\DesktopMonitorAgent\\data\\
- 配置文件优先从 exe 同级 config.env 加载，回退到数据目录
开发模式下：
- 数据目录保持原有 agent/data/
- 配置文件使用 agent/.env
"""
import os
import sys

from dotenv import load_dotenv


def _is_frozen() -> bool:
    """判断是否为 PyInstaller 打包模式。"""
    return getattr(sys, 'frozen', False)


if _is_frozen():
    # 打包模式：数据目录使用 %PROGRAMDATA%\DesktopMonitorAgent\data\
    _BASE_DIR = os.path.join(os.environ.get('PROGRAMDATA', r'C:\ProgramData'), 'DesktopMonitorAgent')
    _DATA_DIR = os.path.join(_BASE_DIR, 'data')
else:
    # 开发模式：保持原有 agent/data/（src/config/config.py 上溯三级到 agent/）
    _BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _DATA_DIR = os.path.join(_BASE_DIR, 'data')


def _find_env_file() -> str | None:
    """定位 .env 配置文件：打包模式优先 exe 同级 config.env，开发模式用 agent/.env。"""
    if _is_frozen():
        # 打包模式：exe 同级 config.env
        exe_dir = os.path.dirname(sys.executable)
        env_path = os.path.join(exe_dir, 'config.env')
        if os.path.exists(env_path):
            return env_path
        # 兼容：也可能放在数据目录
        data_env = os.path.join(_DATA_DIR, 'config.env')
        if os.path.exists(data_env):
            return data_env
        return None
    # 开发模式：agent/.env
    dev_env = os.path.join(_BASE_DIR, '.env')
    return dev_env if os.path.exists(dev_env) else None


_env_file = _find_env_file()
if _env_file:
    load_dotenv(_env_file)


# 首次启动时自动创建数据目录与截图子目录（exist_ok 保证幂等）
os.makedirs(_DATA_DIR, exist_ok=True)
os.makedirs(os.path.join(_DATA_DIR, 'screenshots'), exist_ok=True)


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
    # 截图采集间隔（秒）—— 由 server 远端配置动态覆盖
    SCREENSHOT_INTERVAL = int(os.getenv('SCREENSHOT_INTERVAL', '30'))
    # 活动窗口采样间隔（秒）
    WINDOW_SAMPLE_INTERVAL = float(os.getenv('WINDOW_SAMPLE_INTERVAL', '1'))
    # 活动事件聚合周期（秒）
    EVENT_AGGREGATE_INTERVAL = int(os.getenv('EVENT_AGGREGATE_INTERVAL', '30'))
    # 上传器轮询间隔（秒）—— 由 _recalculate_upload_params 根据 SCREENSHOT_INTERVAL 自动计算
    UPLOAD_INTERVAL = 30
    # 每轮上传截图批量 —— 由 _recalculate_upload_params 根据 SCREENSHOT_INTERVAL 自动计算
    SCREENSHOT_BATCH = 10

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
    # agent/ 根目录（开发模式：src/config/config.py 上溯三级；打包模式：%PROGRAMDATA%\DesktopMonitorAgent）
    BASE_DIR = _BASE_DIR
    # 数据目录
    DATA_DIR = _DATA_DIR
    # SQLite 数据库文件路径
    DB_PATH = os.path.join(DATA_DIR, 'agent.db')
    # 截图落盘目录
    SCREENSHOTS_DIR = os.path.join(DATA_DIR, 'screenshots')
    # 截图本地保留时长（小时），超过则清理对应的日期目录
    SCREENSHOT_LOCAL_RETENTION_HOURS = int(os.getenv('SCREENSHOT_LOCAL_RETENTION_HOURS', '24'))

    # ----- Agent 凭证持久化 -----
    # Agent 注册成功后保存的凭证文件
    CREDENTIALS_FILE = os.path.join(DATA_DIR, 'credentials.json')

    def _recalculate_upload_params(self) -> None:
        """根据 SCREENSHOT_INTERVAL 重新计算上传间隔与批量大小。

        确保上传吞吐量 ≥ 采集吞吐量（假设最多 4 屏，含 2 倍冗余）：
        - UPLOAD_INTERVAL: 取 SCREENSHOT_INTERVAL 与 30 的较小值，不小于 10s
          → 采集越频繁，上传也越频繁
        - SCREENSHOT_BATCH: 每轮上传覆盖的采集周期 × 4 屏 × 2 倍冗余，不小于 10
          → 单轮即可清空一个上传间隔内产生的全部截图
        """
        self.UPLOAD_INTERVAL = max(10, min(self.SCREENSHOT_INTERVAL, 30))
        # ceil(UPLOAD_INTERVAL / SCREENSHOT_INTERVAL) 的整数实现
        cycles = (self.UPLOAD_INTERVAL + self.SCREENSHOT_INTERVAL - 1) // self.SCREENSHOT_INTERVAL
        # 8 = 4屏 × 2倍冗余
        self.SCREENSHOT_BATCH = max(10, cycles * 8)

    def apply_remote_config(self, remote: dict) -> bool:
        """根据远端配置更新本机配置项。

        比较 screenshot_quality、screenshot_max_width、screenshot_interval_sec
        与当前值，有变化则更新对应类属性并返回 True；无变化返回 False。

        screenshot_quality 变化时，同步更新 SCREENSHOT_QUALITY_STEPS 为：
        [q, int(q*0.7), int(q*0.4), max(5, int(q*0.2))]

        screenshot_interval_sec 变化时，同步重新计算 UPLOAD_INTERVAL 和
        SCREENSHOT_BATCH，确保上传吞吐量适应新的采集频率。

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

        # 截图采集间隔 —— 变化时同步重算上传参数
        interval = remote.get('screenshot_interval_sec')
        if interval is not None and int(interval) != self.SCREENSHOT_INTERVAL:
            self.SCREENSHOT_INTERVAL = int(interval)
            self._recalculate_upload_params()
            changed = True

        return changed


# 全局配置单例
config = Config()
# 根据初始 SCREENSHOT_INTERVAL 计算上传参数（确保启动时即为合理值）
config._recalculate_upload_params()

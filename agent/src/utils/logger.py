"""日志模块

基于标准库 logging，配置控制台 + 文件双通道输出。
文件输出位于 agent/data/agent.log
"""
import logging
import os
import sys
from logging.handlers import RotatingFileHandler

# 复用 config 模块中的路径配置
try:
    from src.config.config import config
    _DATA_DIR = config.DATA_DIR
    _LOG_LEVEL = config.LOG_LEVEL
except Exception:
    # 配置加载失败时回退到默认值，避免日志初始化失败阻塞进程
    _BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _DATA_DIR = os.path.join(_BASE_DIR, 'data')
    _LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')


def _ensure_data_dir() -> None:
    """确保数据目录存在，避免文件 handler 创建失败。"""
    try:
        os.makedirs(_DATA_DIR, exist_ok=True)
    except OSError:
        # 目录创建失败时仅记录到 stderr，不抛异常
        pass


def _resolve_level(level: str) -> int:
    """将字符串日志级别转换为 logging 模块常量。"""
    return getattr(logging, str(level).upper(), logging.INFO)


# 模块级标记，避免重复配置 root logger
_initialized = False


def _init_root_logger() -> None:
    """初始化 root logger 的格式与 handler。"""
    global _initialized
    if _initialized:
        return

    _ensure_data_dir()

    level = _resolve_level(_LOG_LEVEL)
    root = logging.getLogger()
    root.setLevel(level)

    # 统一日志格式：时间 - 级别 - 名称 - 消息
    fmt = logging.Formatter(
        fmt='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
    )

    # 控制台输出
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(fmt)
    console_handler.setLevel(level)
    root.addHandler(console_handler)

    # 文件输出（滚动，单文件 5MB，保留 3 个备份）
    log_file = os.path.join(_DATA_DIR, 'agent.log')
    try:
        file_handler = RotatingFileHandler(
            log_file, maxBytes=5 * 1024 * 1024, backupCount=3, encoding='utf-8'
        )
        file_handler.setFormatter(fmt)
        file_handler.setLevel(level)
        root.addHandler(file_handler)
    except OSError:
        # 文件不可写时仅使用控制台输出
        pass

    _initialized = True


def get_logger(name: str) -> logging.Logger:
    """获取指定名称的 logger。

    Args:
        name: 通常传 __name__，便于按模块区分日志来源。

    Returns:
        logging.Logger 实例
    """
    _init_root_logger()
    return logging.getLogger(name)

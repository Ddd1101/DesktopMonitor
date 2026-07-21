"""活动窗口监控模块

每秒采样一次前台窗口，按 30 秒窗口聚合并写入待上传事件队列。

进程名获取采用 wmic 子进程方式（约 100ms 一次），结果按 PID 缓存避免重复查询。
"""
import subprocess
import threading
import time
from datetime import datetime
from typing import Optional

import win32gui
import win32process

from src.config.config import config
from src.storage.db import get_db
from src.utils.logger import get_logger

logger = get_logger(__name__)


# ----- 进程名缓存 -----
# pid -> process_name
_process_name_cache: dict[int, str] = {}
_cache_lock = threading.Lock()


def _get_process_name(pid: int) -> str:
    """通过 wmic 查询进程名并缓存。

    查询失败或超时时回退为 'pid-{pid}'。
    """
    if not pid:
        return 'unknown'

    # 先读缓存
    with _cache_lock:
        cached = _process_name_cache.get(pid)
    if cached:
        return cached

    name = f'pid-{pid}'
    try:
        # 使用 wmic 查询进程名（Windows 内置命令，约 100ms）
        result = subprocess.run(
            ['wmic', 'process', 'where', f'processid={pid}', 'get', 'name'],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
            # 输出格式：第一行是 "Name"，第二行才是进程名
            if len(lines) >= 2:
                name = lines[1]
    except Exception as e:
        logger.debug(f'查询进程名失败 pid={pid}: {e}')

    # 写入缓存
    with _cache_lock:
        _process_name_cache[pid] = name
    return name


def _get_foreground_window_info() -> tuple[str, str]:
    """获取当前前台窗口的 (app_name, window_title)。

    失败时返回 ('unknown', '')。
    """
    try:
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return ('unknown', '')
        title = win32gui.GetWindowText(hwnd) or ''
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
        except Exception:
            pid = 0
        app_name = _get_process_name(pid) if pid else 'unknown'
        return (app_name, title)
    except Exception as e:
        logger.warning(f'获取前台窗口失败: {e}')
        return ('unknown', '')


class WindowCollector:
    """活动窗口监控器：每秒采样、每 30 秒聚合一次。

    聚合维度：(app_name, window_title) -> {started_at, ended_at, duration_seconds}
    """

    def __init__(
        self,
        sample_interval: Optional[float] = None,
        aggregate_interval: Optional[int] = None,
    ) -> None:
        """初始化窗口监控器。

        Args:
            sample_interval: 采样间隔（秒），默认 config.WINDOW_SAMPLE_INTERVAL
            aggregate_interval: 聚合周期（秒），默认 config.EVENT_AGGREGATE_INTERVAL
        """
        self.sample_interval = (
            sample_interval
            if sample_interval is not None
            else config.WINDOW_SAMPLE_INTERVAL
        )
        self.aggregate_interval = (
            aggregate_interval
            if aggregate_interval is not None
            else config.EVENT_AGGREGATE_INTERVAL
        )
        # 停止信号
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

        # 当前活动窗口信息（仅用于日志/调试）
        self._current_app: str = ''
        self._current_title: str = ''
        # 聚合表：(app_name, window_title) -> {started_at, ended_at, duration_seconds}
        self._aggregates: dict[tuple[str, str], dict] = {}

    def _sample(self) -> None:
        """采样一次前台窗口并更新聚合表。"""
        app_name, window_title = _get_foreground_window_info()
        now_iso = datetime.now().isoformat()
        key = (app_name, window_title)

        if key in self._aggregates:
            # 同一窗口持续活动：累加 duration_seconds，更新 ended_at
            agg = self._aggregates[key]
            try:
                prev_dt = datetime.fromisoformat(agg['ended_at'])
                cur_dt = datetime.fromisoformat(now_iso)
                delta = int((cur_dt - prev_dt).total_seconds())
                # 限制单次累加不超过 5 倍采样间隔，避免系统休眠等异常情况
                if 0 < delta <= int(self.sample_interval * 5):
                    agg['duration_seconds'] += delta
            except Exception:
                # 时间解析失败时跳过本次累加
                pass
            agg['ended_at'] = now_iso
        else:
            # 切换到新窗口：新建 aggregate 项
            self._aggregates[key] = {
                'started_at': now_iso,
                'ended_at': now_iso,
                'duration_seconds': 0,
            }

        self._current_app = app_name
        self._current_title = window_title

    def _flush(self) -> None:
        """将当前聚合表写入数据库并清空。"""
        if not self._aggregates:
            return

        try:
            db = get_db()
            for (app_name, window_title), agg in self._aggregates.items():
                try:
                    db.insert_event(
                        app_name=app_name,
                        window_title=window_title,
                        started_at=agg['started_at'],
                        ended_at=agg['ended_at'],
                        duration_seconds=agg['duration_seconds'],
                    )
                except Exception as e:
                    logger.error(
                        f'写入事件失败 app={app_name} title={window_title}: {e}',
                        exc_info=True,
                    )
        except Exception as e:
            logger.error(f'flush 聚合表异常: {e}', exc_info=True)
        finally:
            self._aggregates.clear()

    def _loop(self) -> None:
        """后台监控循环：每秒采样，每 aggregate_interval 秒 flush 一次。"""
        logger.info(
            f'活动窗口监控已启动，采样 {self.sample_interval}s，'
            f'聚合 {self.aggregate_interval}s'
        )
        last_flush = time.monotonic()
        while not self._stop_event.is_set():
            try:
                self._sample()
            except Exception as e:
                logger.error(f'采样异常: {e}', exc_info=True)

            # 判断是否到达聚合 flush 周期
            now = time.monotonic()
            if now - last_flush >= self.aggregate_interval:
                try:
                    self._flush()
                except Exception as e:
                    logger.error(f'flush 异常: {e}', exc_info=True)
                last_flush = now

            # 可中断的 sleep
            self._stop_event.wait(self.sample_interval)

        # 退出前再 flush 一次，避免丢失最后一段数据
        try:
            self._flush()
        except Exception as e:
            logger.error(f'退出 flush 异常: {e}', exc_info=True)
        logger.info('活动窗口监控已停止')

    def start(self) -> None:
        """启动后台监控线程。"""
        if self._thread and self._thread.is_alive():
            logger.warning('活动窗口监控已在运行')
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._loop, name='WindowCollector', daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        """停止监控线程。"""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None

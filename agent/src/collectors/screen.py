"""屏幕采集器模块

使用 mss 抓取所有显示器（多屏支持），Pillow 转 JPEG 后落盘，并写入待上传队列。
采集目录结构：agent/data/screenshots/{YYYYMMDD}/{YYYYMMDD_HHMMSS}_m{idx}.jpg
"""
import os
import threading
from datetime import datetime
from typing import List, Optional

import mss
from PIL import Image

from src.config.config import config
from src.storage.db import get_db
from src.utils.logger import get_logger

logger = get_logger(__name__)


class ScreenCollector:
    """屏幕采集器：定时抓取所有显示器截图并写入数据库队列。

    支持多屏幕：mss.monitors[0] 是所有屏幕合并的虚拟区域，monitors[1:] 才是
    各个物理显示器。本采集器会遍历 monitors[1:]，每个屏幕单独生成一张截图。
    使用 threading.Event 作为停止信号，后台线程 daemon=True。
    """

    def __init__(self, interval: Optional[int] = None) -> None:
        """初始化屏幕采集器。

        Args:
            interval: 采集间隔（秒），默认 config.SCREENSHOT_INTERVAL
        """
        self.interval = (
            interval if interval is not None else config.SCREENSHOT_INTERVAL
        )
        # 停止信号
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def capture_once(self) -> List[str]:
        """抓取一次所有显示器并保存为 JPEG，写入数据库队列。

        Returns:
            所有截图的绝对路径列表（按显示器索引顺序）；全部失败时返回空列表
        """
        now = datetime.now()
        date_dir = now.strftime('%Y%m%d')
        timestamp = now.strftime('%Y%m%d_%H%M%S')
        # 落盘目录：{SCREENSHOTS_DIR}/{YYYYMMDD}/
        target_dir = os.path.join(config.SCREENSHOTS_DIR, date_dir)
        # 统一的采集时间戳（ISO 8601），所有屏幕共用一条记录的 taken_at
        taken_at = now.isoformat()
        saved_paths: List[str] = []

        try:
            os.makedirs(target_dir, exist_ok=True)

            with mss.mss() as sct:
                # monitors[0] 是所有屏幕合并的虚拟区域，跳过；monitors[1:] 是各物理屏幕
                monitors = sct.monitors[1:]
                if not monitors:
                    # 极少见情况：拿不到任何屏幕
                    logger.warning('未检测到任何显示器')
                    return []

                for idx, monitor in enumerate(monitors, start=1):
                    # 文件名带显示器索引 _m{idx}，便于区分
                    file_path = os.path.join(
                        target_dir, f'{timestamp}_m{idx}.jpg'
                    )
                    try:
                        raw = sct.grab(monitor)
                        # mss 返回 BGRA 像素缓冲，转 RGB 后保存为 JPEG
                        img = Image.frombytes(
                            'RGB', raw.size, raw.bgra, 'raw', 'BGRX'
                        )
                        img.save(file_path, 'JPEG', quality=70)
                        saved_paths.append(file_path)
                    except Exception as e:
                        # 单个屏幕失败不影响其他屏幕
                        logger.error(
                            f'显示器 {idx} 截图失败: {e}', exc_info=True
                        )
                        continue

            # 统一写入数据库待上传队列
            for idx, file_path in enumerate(saved_paths, start=1):
                try:
                    get_db().insert_screenshot(
                        file_path, taken_at, monitor_index=idx
                    )
                except Exception as e:
                    # 文件已落盘但写库失败，仅记录日志
                    logger.error(
                        f'写入截图队列失败: {e}', exc_info=True
                    )
        except Exception as e:
            logger.error(f'截图流程异常: {e}', exc_info=True)
            return saved_paths

        logger.debug(f'本次共采集 {len(saved_paths)} 张截图')
        return saved_paths

    def _loop(self) -> None:
        """后台采集循环：每隔 interval 秒采集一次。"""
        logger.info(f'屏幕采集器已启动，间隔 {self.interval} 秒')
        while not self._stop_event.is_set():
            try:
                self.capture_once()
            except Exception as e:
                # 线程内异常必须捕获，不让线程崩溃
                logger.error(f'采集循环异常: {e}', exc_info=True)
            # 使用 wait 实现可中断的 sleep
            self._stop_event.wait(self.interval)
        logger.info('屏幕采集器已停止')

    def start(self) -> None:
        """启动后台采集线程。"""
        if self._thread and self._thread.is_alive():
            logger.warning('屏幕采集器已在运行')
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._loop, name='ScreenCollector', daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        """停止采集线程。"""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None

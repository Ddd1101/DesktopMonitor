"""屏幕采集器模块

使用 mss 抓取所有显示器（多屏支持），Pillow 转 JPEG 后落盘，并写入待上传队列。
落盘前根据 SCREENSHOT_MAX_SIZE_KB 阈值自动压缩（降质量 + 缩放），控制文件体积。
采集目录结构：agent/data/screenshots/{YYYYMMDD}/{YYYYMMDD_HHMMSS}_m{idx}.jpg
"""
import os
import threading
from datetime import datetime
from io import BytesIO
from typing import List, Optional

import mss
from PIL import Image

from src.config.config import config
from src.storage.db import get_db
from src.utils.logger import get_logger

logger = get_logger(__name__)


def get_monitor_resolutions() -> list[dict]:
    """获取本机所有物理显示器的分辨率。

    使用 mss.mss().monitors[1:] 获取各物理显示器（monitors[0] 是合并虚拟区域）。

    Returns:
        形如 [{"width": 1920, "height": 1080}, ...]；异常时返回空列表
    """
    try:
        with mss.mss() as sct:
            monitors = sct.monitors[1:]
            return [
                {'width': m['width'], 'height': m['height']} for m in monitors
            ]
    except Exception as e:
        logger.error(f'获取显示器分辨率失败: {e}', exc_info=True)
        return []


def _save_with_size_limit(img: Image.Image, file_path: str) -> int:
    """将图片保存为 JPEG，若超过大小阈值则逐步降低清晰度重新压缩。

    压缩策略：
    1. 先按 SCREENSHOT_MAX_WIDTH 缩放（高分屏降分辨率）
    2. 在内存中依次尝试递降 quality 档位，命中后一次性落盘
    3. 若所有 quality 档位仍超阈值，则缩小 50% 再尝试一轮
    4. 最终保证落盘文件不超过阈值（或尽可能接近）

    Args:
        img: PIL Image 对象（RGB）
        file_path: 保存路径

    Returns:
        最终保存的 quality 值
    """
    max_size = config.SCREENSHOT_MAX_SIZE_KB * 1024
    quality_steps = config.SCREENSHOT_QUALITY_STEPS
    max_width = config.SCREENSHOT_MAX_WIDTH

    # 高分屏缩放：宽度超过 max_width 时等比缩小
    current = img
    if current.width > max_width:
        ratio = max_width / current.width
        new_size = (max_width, int(current.height * ratio))
        current = current.resize(new_size, Image.LANCZOS)
        logger.debug(
            f'缩放: {img.width}x{img.height} -> {new_size[0]}x{new_size[1]}'
        )

    # 在内存中尝试各 quality 档位，命中后一次性落盘
    chosen_buf: Optional[bytes] = None
    chosen_quality = quality_steps[-1]
    for quality in quality_steps:
        buf = BytesIO()
        current.save(buf, 'JPEG', quality=quality)
        if buf.tell() <= max_size:
            chosen_buf = buf.getvalue()
            chosen_quality = quality
            break

    # 所有 quality 档位仍超阈值：缩小 50% 再试一轮
    if chosen_buf is None and current.width > 480:
        new_size = (current.width // 2, current.height // 2)
        current = current.resize(new_size, Image.LANCZOS)
        for quality in quality_steps:
            buf = BytesIO()
            current.save(buf, 'JPEG', quality=quality)
            if buf.tell() <= max_size:
                chosen_buf = buf.getvalue()
                chosen_quality = quality
                break
        if chosen_buf is None:
            logger.warning(
                f'截图仍超阈值({config.SCREENSHOT_MAX_SIZE_KB}KB)，'
                f'最终质量={quality_steps[-1]} 尺寸={new_size}'
            )

    # 最终一次性落盘（仅一次磁盘写入）
    if chosen_buf is None:
        buf = BytesIO()
        current.save(buf, 'JPEG', quality=quality_steps[-1])
        chosen_buf = buf.getvalue()

    with open(file_path, 'wb') as f:
        f.write(chosen_buf)
    return chosen_quality


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
                        # mss 返回 BGRA 像素缓冲，转 RGB
                        img = Image.frombytes(
                            'RGB', raw.size, raw.bgra, 'raw', 'BGRX'
                        )
                        # 按阈值压缩保存
                        quality = _save_with_size_limit(img, file_path)
                        file_size_kb = os.path.getsize(file_path) / 1024
                        logger.debug(
                            f'显示器{idx} 截图已保存 q={quality} '
                            f'{file_size_kb:.0f}KB'
                        )
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

    def update_interval(self, new_interval: int) -> None:
        """动态更新采集间隔。

        下一次 _loop 中的 wait 调用会自动使用新值。

        Args:
            new_interval: 新的采集间隔（秒）
        """
        if new_interval == self.interval:
            return
        old = self.interval
        self.interval = new_interval
        logger.info(f'采集间隔已更新: {old}s -> {new_interval}s')

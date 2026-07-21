"""上传工作线程模块

UploadWorker 负责：
1. 确保已注册（内存 token -> 本地凭证 -> 触发注册）
2. 每轮上传最多 5 张截图、50 条事件
3. 成功后删除本地记录；失败时 increment_retry，超过 10 次跳过
4. 遇到 TokenExpiredError 自动重新注册并刷新凭证
5. 每 60 秒发送一次心跳（与上传循环共享线程，避免多开线程）
"""
import platform
import socket
import threading
import time
from typing import Optional

from src.config.config import config
from src.storage.db import get_db
from src.uploader.client import ServerClient, TokenExpiredError
from src.uploader.credentials import (
    clear_credentials,
    load_credentials,
    save_credentials,
)
from src.utils.logger import get_logger

logger = get_logger(__name__)


def _get_local_ip() -> str:
    """获取本机内网 IP（用于心跳上报）。失败时回退到 127.0.0.1。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # 不真正发包，仅用于获取本机出口 IP
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def _get_os_info() -> str:
    """获取本机操作系统信息。"""
    return f'{platform.system()} {platform.release()}'


class UploadWorker:
    """上传工作线程：定时上传截图/事件并发送心跳。"""

    # 最大重试次数：超过则跳过该记录避免阻塞队列
    MAX_RETRY = 10
    # 每轮上传截图批量
    SCREENSHOT_BATCH = 5
    # 每轮上传事件批量
    EVENT_BATCH = 50
    # 心跳间隔（秒）
    HEARTBEAT_INTERVAL = 60

    def __init__(
        self,
        client: ServerClient,
        interval: Optional[int] = None,
    ) -> None:
        """初始化上传工作线程。

        Args:
            client: ServerClient 实例
            interval: 上传轮询间隔（秒），默认 config.UPLOAD_INTERVAL
        """
        self.client = client
        self.interval = interval if interval is not None else config.UPLOAD_INTERVAL
        # 停止信号
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        # 心跳时间戳（monotonic）
        self._last_heartbeat: float = 0.0

    # ----- 注册 / 重新注册 -----
    def _ensure_registered(self) -> bool:
        """确保 client 已具备有效 token。

        优先级：内存 token > 本地凭证 > 触发注册。

        Returns:
            True 表示当前已有 token；False 表示注册失败
        """
        if self.client.get_token():
            return True

        # 尝试从本地凭证恢复
        creds = load_credentials()
        if creds:
            self.client.set_token(creds['token'])
            self.client.set_device_id(creds['device_id'])
            logger.info('已从本地凭证恢复 token')
            return True

        # 触发首次注册
        try:
            hostname = platform.node()
            os_info = _get_os_info()
            device_id, token = self.client.register(hostname=hostname, os_info=os_info)
            save_credentials(device_id, token)
            logger.info('首次注册完成并已保存凭证')
            return True
        except Exception as e:
            logger.error(f'首次注册失败: {e}', exc_info=True)
            return False

    def _re_register(self) -> bool:
        """Token 失效后重新注册并刷新本地凭证。

        Returns:
            True 表示重新注册成功
        """
        logger.info('Token 失效，尝试重新注册')
        # 清空内存 token 与本地凭证
        self.client.set_token(None)
        clear_credentials()
        try:
            hostname = platform.node()
            os_info = _get_os_info()
            device_id, token = self.client.register(hostname=hostname, os_info=os_info)
            save_credentials(device_id, token)
            logger.info('重新注册成功')
            return True
        except Exception as e:
            logger.error(f'重新注册失败: {e}', exc_info=True)
            return False

    # ----- 截图上传 -----
    def _upload_screenshots(self) -> None:
        """上传一批截图（最多 SCREENSHOT_BATCH 张）。"""
        db = get_db()
        try:
            rows = db.get_pending_screenshots(limit=self.SCREENSHOT_BATCH)
        except Exception as e:
            logger.error(f'读取待上传截图失败: {e}', exc_info=True)
            return

        for row in rows:
            if self._stop_event.is_set():
                break

            row_id = row['id']
            file_path = row['file_path']
            taken_at = row['taken_at']
            # monitor_index 字段可能因旧表而缺失，回退为 1
            monitor_index = int(row.get('monitor_index', 1) or 1)
            retry = int(row.get('retry_count', 0) or 0)

            # 超过最大重试次数则跳过该记录，避免阻塞队列
            if retry >= self.MAX_RETRY:
                logger.warning(
                    f'截图 id={row_id} 重试 {retry} 次仍失败，跳过'
                )
                continue

            try:
                ok = self.client.send_screenshot(
                    file_path, taken_at, monitor_index=monitor_index
                )
            except TokenExpiredError:
                # 抛给外层处理（触发重新注册）
                raise
            except Exception as e:
                logger.error(f'上传截图异常 id={row_id}: {e}', exc_info=True)
                ok = False

            if ok:
                try:
                    db.delete_screenshot(row_id)
                    logger.debug(f'截图上传成功 id={row_id}')
                except Exception as e:
                    logger.error(f'删除截图记录失败 id={row_id}: {e}')
            else:
                try:
                    db.increment_retry('pending_screenshots', row_id)
                except Exception as e:
                    logger.error(f'递增重试次数失败 id={row_id}: {e}')

    # ----- 事件上传 -----
    def _upload_events(self) -> None:
        """上传一批事件（最多 EVENT_BATCH 条）。"""
        db = get_db()
        try:
            rows = db.get_pending_events(limit=self.EVENT_BATCH)
        except Exception as e:
            logger.error(f'读取待上传事件失败: {e}', exc_info=True)
            return

        if not rows:
            return

        # 构造上报 payload
        events_payload = [
            {
                'app_name': row['app_name'],
                'appName': row['app_name'],
                'window_title': row['window_title'] or '',
                'windowTitle': row['window_title'] or '',
                'started_at': row['started_at'],
                'startedAt': row['started_at'],
                'ended_at': row['ended_at'],
                'endedAt': row['ended_at'],
                'duration_seconds': row['duration_seconds'],
                'durationSeconds': row['duration_seconds'],
            }
            for row in rows
        ]

        try:
            ok = self.client.send_events(events_payload)
        except TokenExpiredError:
            raise
        except Exception as e:
            logger.error(f'上报事件异常: {e}', exc_info=True)
            ok = False

        if ok:
            # 成功：批量删除
            for row in rows:
                try:
                    db.delete_event(row['id'])
                except Exception as e:
                    logger.error(f'删除事件记录失败 id={row["id"]}: {e}')
            logger.debug(f'事件批量上传成功 count={len(rows)}')
        else:
            # 失败：逐条递增重试次数，超过上限的跳过
            for row in rows:
                if int(row.get('retry_count', 0) or 0) >= self.MAX_RETRY:
                    logger.warning(
                        f'事件 id={row["id"]} 重试已达上限，跳过'
                    )
                    continue
                try:
                    db.increment_retry('pending_events', row['id'])
                except Exception as e:
                    logger.error(f'递增重试次数失败 id={row["id"]}: {e}')

    # ----- 心跳 -----
    def _send_heartbeat(self) -> None:
        """发送一次心跳。"""
        try:
            ok = self.client.heartbeat(
                hostname=platform.node(),
                ip=_get_local_ip(),
                os_info=_get_os_info(),
            )
            if ok:
                logger.debug('心跳发送成功')
        except TokenExpiredError:
            raise
        except Exception as e:
            logger.error(f'心跳异常: {e}', exc_info=True)

    # ----- 单轮执行 -----
    def run_once(self) -> None:
        """执行一轮上传逻辑。"""
        # 1. 确保已注册
        if not self._ensure_registered():
            return

        # 2. 上传截图（遇 401 触发重新注册，本轮结束）
        try:
            self._upload_screenshots()
        except TokenExpiredError:
            self._re_register()
            return

        # 3. 上传事件
        try:
            self._upload_events()
        except TokenExpiredError:
            self._re_register()
            return

        # 4. 心跳（每 HEARTBEAT_INTERVAL 秒发一次）
        now = time.monotonic()
        if now - self._last_heartbeat >= self.HEARTBEAT_INTERVAL:
            try:
                self._send_heartbeat()
                self._last_heartbeat = now
            except TokenExpiredError:
                if self._re_register():
                    self._last_heartbeat = now
                return

    # ----- 后台循环 -----
    def _loop(self) -> None:
        """后台上传循环。"""
        logger.info(f'上传工作线程已启动，间隔 {self.interval} 秒')
        # 启动后立即触发一次心跳
        self._last_heartbeat = time.monotonic() - self.HEARTBEAT_INTERVAL
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception as e:
                # 兜底：线程内任何异常都不应让线程崩溃
                logger.error(f'上传循环异常: {e}', exc_info=True)
            # 可中断的 sleep
            self._stop_event.wait(self.interval)
        logger.info('上传工作线程已停止')

    def start(self) -> None:
        """启动后台上传线程。"""
        if self._thread and self._thread.is_alive():
            logger.warning('上传工作线程已在运行')
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._loop, name='UploadWorker', daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        """停止上传线程。"""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None

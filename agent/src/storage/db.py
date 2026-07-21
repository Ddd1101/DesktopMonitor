"""本地 SQLite 缓存模块

提供线程安全的待上报事件 / 截图队列管理。
DB 文件默认位于 agent/data/agent.db。
"""
import os
import sqlite3
import threading
from typing import Optional

# 复用配置中的 DB_PATH
try:
    from src.config.config import config as _config
    _DEFAULT_DB_PATH = _config.DB_PATH
    _DEFAULT_DATA_DIR = _config.DATA_DIR
except Exception:
    # 配置加载失败时回退到相对路径
    _BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _DEFAULT_DATA_DIR = os.path.join(_BASE_DIR, 'data')
    _DEFAULT_DB_PATH = os.path.join(_DEFAULT_DATA_DIR, 'agent.db')


# 允许调用方传入的表名白名单，防止 SQL 注入
_VALID_TABLES = {'pending_events', 'pending_screenshots'}


class Database:
    """线程安全的本地 SQLite 缓存。

    使用 threading.Lock 保护写操作；连接开启 check_same_thread=False
    以允许跨线程共享（实际并发由外部调用方或本类锁控制）。
    """

    def __init__(self, db_path: Optional[str] = None) -> None:
        """初始化数据库连接。

        Args:
            db_path: SQLite 文件路径，默认 agent/data/agent.db
        """
        self.db_path = db_path or _DEFAULT_DB_PATH
        # 确保数据目录存在
        data_dir = os.path.dirname(self.db_path)
        if data_dir:
            os.makedirs(data_dir, exist_ok=True)

        # 线程安全锁
        self._lock = threading.Lock()

        # 建立连接（允许跨线程使用）
        self._conn = sqlite3.connect(
            self.db_path,
            check_same_thread=False,
            isolation_level=None,  # 自动提交模式，事务由显式 BEGIN/COMMIT 控制
            timeout=5.0,  # 等待锁最多 5 秒
        )
        # 行结果以 dict 形式返回
        self._conn.row_factory = sqlite3.Row

        # 性能 PRAGMA：WAL 模式允许读写并发，synchronous=NORMAL 在 WAL 下安全
        # （仅在断电时可能丢最后一条事务，对监控类数据可接受）
        self._conn.execute('PRAGMA journal_mode=WAL')
        self._conn.execute('PRAGMA synchronous=NORMAL')
        self._conn.execute('PRAGMA temp_store=MEMORY')
        self._conn.execute('PRAGMA cache_size=-8192')  # 8MB 缓存

        # 初始化表结构
        self.init_db()

    def init_db(self) -> None:
        """创建表与索引（幂等）。"""
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute('BEGIN')
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS pending_events (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      app_name TEXT NOT NULL,
                      window_title TEXT,
                      started_at TEXT NOT NULL,
                      ended_at TEXT NOT NULL,
                      duration_seconds INTEGER NOT NULL,
                      created_at TEXT NOT NULL DEFAULT (datetime('now')),
                      retry_count INTEGER NOT NULL DEFAULT 0
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS pending_screenshots (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      file_path TEXT NOT NULL,
                      taken_at TEXT NOT NULL,
                      monitor_index INTEGER NOT NULL DEFAULT 1,
                      created_at TEXT NOT NULL DEFAULT (datetime('now')),
                      retry_count INTEGER NOT NULL DEFAULT 0
                    )
                    """
                )
                cur.execute(
                    'CREATE INDEX IF NOT EXISTS idx_pending_events_created '
                    'ON pending_events(created_at)'
                )
                cur.execute(
                    'CREATE INDEX IF NOT EXISTS idx_pending_screenshots_created '
                    'ON pending_screenshots(created_at)'
                )
                cur.execute('COMMIT')

                # 兼容旧表：若 pending_screenshots 缺 monitor_index 列则补上
                cur.execute('PRAGMA table_info(pending_screenshots)')
                cols = [row[1] for row in cur.fetchall()]
                if 'monitor_index' not in cols:
                    cur.execute(
                        'ALTER TABLE pending_screenshots '
                        'ADD COLUMN monitor_index INTEGER NOT NULL DEFAULT 1'
                    )
            except Exception:
                cur.execute('ROLLBACK')
                raise

    def insert_event(
        self,
        app_name: str,
        window_title: str,
        started_at: str,
        ended_at: str,
        duration_seconds: int,
    ) -> int:
        """插入一条待上报活动事件。

        Args:
            app_name: 应用/进程名
            window_title: 窗口标题
            started_at: 开始时间（ISO 8601）
            ended_at: 结束时间（ISO 8601）
            duration_seconds: 持续时长（秒）

        Returns:
            新插入行的主键 id
        """
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute('BEGIN')
                cur.execute(
                    """
                    INSERT INTO pending_events
                      (app_name, window_title, started_at, ended_at, duration_seconds)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (app_name, window_title, started_at, ended_at, duration_seconds),
                )
                last_id = cur.lastrowid
                cur.execute('COMMIT')
                return int(last_id) if last_id is not None else 0
            except Exception:
                cur.execute('ROLLBACK')
                raise

    def insert_screenshot(
        self, file_path: str, taken_at: str, monitor_index: int = 1
    ) -> int:
        """插入一条待上报截图记录。

        Args:
            file_path: 本地截图文件绝对路径
            taken_at: 截图时间（ISO 8601）
            monitor_index: 显示器索引（从 1 开始，1=主屏）

        Returns:
            新插入行的主键 id
        """
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute('BEGIN')
                cur.execute(
                    """
                    INSERT INTO pending_screenshots
                      (file_path, taken_at, monitor_index)
                    VALUES (?, ?, ?)
                    """,
                    (file_path, taken_at, monitor_index),
                )
                last_id = cur.lastrowid
                cur.execute('COMMIT')
                return int(last_id) if last_id is not None else 0
            except Exception:
                cur.execute('ROLLBACK')
                raise

    def get_pending_events(self, limit: int = 50) -> list[dict]:
        """按入队时间升序获取待上报事件。

        Args:
            limit: 最多返回条数

        Returns:
            字典列表，每条包含 id, app_name, window_title,
            started_at, ended_at, duration_seconds, created_at, retry_count
        """
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                """
                SELECT id, app_name, window_title, started_at, ended_at,
                       duration_seconds, created_at, retry_count
                FROM pending_events
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cur.fetchall()
            return [dict(row) for row in rows]

    def get_pending_screenshots(self, limit: int = 10) -> list[dict]:
        """按入队时间升序获取待上报截图。

        Args:
            limit: 最多返回条数

        Returns:
            字典列表，每条包含 id, file_path, taken_at, monitor_index,
            created_at, retry_count
        """
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                """
                SELECT id, file_path, taken_at, monitor_index,
                       created_at, retry_count
                FROM pending_screenshots
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cur.fetchall()
            return [dict(row) for row in rows]

    def delete_event(self, event_id: int) -> None:
        """根据 id 删除一条待上报事件。"""
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute('BEGIN')
                cur.execute('DELETE FROM pending_events WHERE id = ?', (event_id,))
                cur.execute('COMMIT')
            except Exception:
                cur.execute('ROLLBACK')
                raise

    def delete_events_batch(self, ids: list[int]) -> None:
        """批量删除待上报事件（单事务，避免每条独立 fsync）。"""
        if not ids:
            return
        placeholders = ','.join('?' * len(ids))
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute('BEGIN')
                cur.execute(
                    f'DELETE FROM pending_events WHERE id IN ({placeholders})',
                    ids,
                )
                cur.execute('COMMIT')
            except Exception:
                cur.execute('ROLLBACK')
                raise

    def delete_screenshot(self, screenshot_id: int) -> None:
        """根据 id 删除一条待上报截图记录。"""
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute('BEGIN')
                cur.execute('DELETE FROM pending_screenshots WHERE id = ?', (screenshot_id,))
                cur.execute('COMMIT')
            except Exception:
                cur.execute('ROLLBACK')
                raise

    def delete_screenshots_batch(self, ids: list[int]) -> None:
        """批量删除待上报截图记录（单事务，避免每条独立 fsync）。"""
        if not ids:
            return
        placeholders = ','.join('?' * len(ids))
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute('BEGIN')
                cur.execute(
                    f'DELETE FROM pending_screenshots WHERE id IN ({placeholders})',
                    ids,
                )
                cur.execute('COMMIT')
            except Exception:
                cur.execute('ROLLBACK')
                raise

    def increment_retry_batch(self, table: str, ids: list[int]) -> None:
        """批量将指定表的多条记录 retry_count + 1（单事务）。

        Args:
            table: 表名，仅允许 'pending_events' 或 'pending_screenshots'
            ids: 记录主键 id 列表
        """
        if not ids:
            return
        if table not in _VALID_TABLES:
            raise ValueError(
                f'非法表名: {table!r}，仅允许 {sorted(_VALID_TABLES)}'
            )
        placeholders = ','.join('?' * len(ids))
        sql = f'UPDATE {table} SET retry_count = retry_count + 1 WHERE id IN ({placeholders})'
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute('BEGIN')
                cur.execute(sql, ids)
                cur.execute('COMMIT')
            except Exception:
                cur.execute('ROLLBACK')
                raise

    def increment_retry(self, table: str, record_id: int) -> None:
        """将指定表的某条记录 retry_count + 1。

        Args:
            table: 表名，仅允许 'pending_events' 或 'pending_screenshots'
            record_id: 记录主键 id
        """
        if table not in _VALID_TABLES:
            raise ValueError(
                f'非法表名: {table!r}，仅允许 {sorted(_VALID_TABLES)}'
            )
        # table 已通过白名单校验，可安全拼接到 SQL
        sql = f'UPDATE {table} SET retry_count = retry_count + 1 WHERE id = ?'
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute('BEGIN')
                cur.execute(sql, (record_id,))
                cur.execute('COMMIT')
            except Exception:
                cur.execute('ROLLBACK')
                raise

    def get_pending_counts(self) -> dict:
        """返回各队列入队未处理条数。

        Returns:
            {'events': N, 'screenshots': N}
        """
        with self._lock:
            cur = self._conn.cursor()
            cur.execute('SELECT COUNT(*) AS n FROM pending_events')
            events_count = cur.fetchone()['n']
            cur.execute('SELECT COUNT(*) AS n FROM pending_screenshots')
            screenshots_count = cur.fetchone()['n']
            return {'events': int(events_count), 'screenshots': int(screenshots_count)}

    def close(self) -> None:
        """关闭数据库连接。"""
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass


# ----- 全局单例（懒加载） -----
_db_instance: Optional[Database] = None
_db_lock = threading.Lock()


def get_db() -> Database:
    """获取全局 Database 单例（懒加载，线程安全）。"""
    global _db_instance
    if _db_instance is None:
        with _db_lock:
            if _db_instance is None:
                _db_instance = Database()
    return _db_instance

-- 本地 SQLite 缓存表结构
-- 文件：agent/data/agent.db

-- 待上报活动事件队列
CREATE TABLE IF NOT EXISTS pending_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name TEXT NOT NULL,
  window_title TEXT,
  started_at TEXT NOT NULL,    -- ISO 8601 格式
  ended_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retry_count INTEGER NOT NULL DEFAULT 0
);

-- 待上报截图队列
CREATE TABLE IF NOT EXISTS pending_screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,       -- 本地文件绝对路径
  taken_at TEXT NOT NULL,        -- ISO 8601 格式
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retry_count INTEGER NOT NULL DEFAULT 0
);

-- 按创建时间索引，便于按入队顺序上传
CREATE INDEX IF NOT EXISTS idx_pending_events_created ON pending_events(created_at);
CREATE INDEX IF NOT EXISTS idx_pending_screenshots_created ON pending_screenshots(created_at);

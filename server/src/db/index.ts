import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { hashPassword } from '../utils/auth.js';

// 单例 db 实例
let dbInstance: Database.Database | null = null;

/**
 * 初始化数据库：
 * 1. 确保数据目录存在
 * 2. 创建连接并启用 WAL 模式
 * 3. 执行 migrations（建表）
 * 4. 写入默认管理员账号
 */
function initDatabase(): Database.Database {
  // 确保 db 文件所在目录存在
  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(config.dbPath);
  // 启用 WAL 模式以提升并发读写性能
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  ensureDefaultAdmin(db);

  return db;
}

/**
 * 执行数据库迁移：创建所有表与索引（幂等）
 */
function runMigrations(db: Database.Database): void {
  db.exec(`
    -- 管理员表
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Agent 注册凭证表（预置 Token 关联）
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT UNIQUE NOT NULL,
      hostname TEXT,
      register_token TEXT NOT NULL,
      jwt_secret TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat_at TEXT
    );

    -- 设备表（与 agents 1:1，但分离更清晰）
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT UNIQUE NOT NULL,
      agent_id INTEGER NOT NULL,
      hostname TEXT,
      ip_address TEXT,
      os_info TEXT,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    -- 事件表（活动窗口记录）
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      window_title TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(device_id, started_at) -- 用于去重
    );

    -- 截图表
    CREATE TABLE IF NOT EXISTS screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      taken_at TEXT NOT NULL,
      monitor_index INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(device_id, taken_at, monitor_index) -- 用于去重（含屏幕索引，支持多屏）
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_events_device_started ON events(device_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_screenshots_device_taken ON screenshots(device_id, taken_at);
    CREATE INDEX IF NOT EXISTS idx_devices_last_heartbeat ON devices(last_heartbeat_at);
  `);

  // 兼容旧表迁移：若 screenshots 缺 monitor_index 列则补上
  const cols = db.prepare("PRAGMA table_info(screenshots)").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'monitor_index')) {
    // SQLite 不支持直接修改 UNIQUE 约束，这里仅补列；旧约束 UNIQUE(device_id, taken_at)
    // 会阻止同一秒多屏入库，需重建表替换为新约束。
    // 为简化迁移，直接重建 screenshots 表（保留数据）。
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE screenshots_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          taken_at TEXT NOT NULL,
          monitor_index INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(device_id, taken_at, monitor_index)
        );
        INSERT OR IGNORE INTO screenshots_new
          (id, device_id, file_path, taken_at, monitor_index, created_at)
        SELECT id, device_id, file_path, taken_at, 1, created_at FROM screenshots;
        DROP TABLE screenshots;
        ALTER TABLE screenshots_new RENAME TO screenshots;
        CREATE INDEX IF NOT EXISTS idx_screenshots_device_taken
          ON screenshots(device_id, taken_at);
      `);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/**
 * 确保 admins 表中至少有一个默认管理员账号
 * 仅在表为空时插入 admin / config.adminDefaultPassword
 */
function ensureDefaultAdmin(db: Database.Database): void {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM admins');
  const row = stmt.get() as { count: number };
  if (row.count === 0) {
    const insert = db.prepare(
      'INSERT INTO admins (username, password_hash) VALUES (?, ?)',
    );
    insert.run('admin', hashPassword(config.adminDefaultPassword));
  }
}

/**
 * 获取数据库单例（懒加载）
 */
export function getDb(): Database.Database {
  if (!dbInstance) {
    dbInstance = initDatabase();
  }
  return dbInstance;
}

// 模块加载时即初始化，导出 db 单例便于直接使用
export const db = getDb();

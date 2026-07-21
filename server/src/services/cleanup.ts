import fs from 'node:fs';
import path from 'node:path';
import dayjs from 'dayjs';
import { db } from '../db/index.js';
import { config } from '../config/index.js';

// 清理服务运行间隔：1 小时
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// 默认保留：30 天
const DEFAULT_RETENTION_VALUE = 30;
const DEFAULT_RETENTION_UNIT: RetentionUnit = 'days';

type RetentionUnit = 'hours' | 'days' | 'months' | 'years';

interface DeviceConfigRow {
  device_id: string;
  retention_value: number;
  retention_unit: string;
}

interface ScreenshotRow {
  id: number;
  device_id: string;
  file_path: string;
  taken_at: string;
}

interface DeviceIdRow {
  device_id: string;
}

/**
 * 根据保留策略计算截止时间（早于此时间的截图将被清理）
 * 使用 dayjs 的 subtract 方法，支持 hours/days/months/years
 */
function computeCutoff(value: number, unit: RetentionUnit): string {
  return dayjs().subtract(value, unit).toISOString();
}

/**
 * 删除指定设备在截止时间之前的截图记录及对应物理文件
 * @returns 删除的记录数与文件数
 */
function cleanupDeviceScreenshots(deviceId: string, cutoff: string): {
  deletedRecords: number;
  deletedFiles: number;
} {
  // 查询待删除的截图记录（含 file_path，用于物理文件删除）
  const selectStmt = db.prepare(`
    SELECT id, device_id, file_path, taken_at
    FROM screenshots
    WHERE device_id = ? AND taken_at < ?
  `);
  const rows = selectStmt.all(deviceId, cutoff) as ScreenshotRow[];

  if (rows.length === 0) {
    return { deletedRecords: 0, deletedFiles: 0 };
  }

  // 收集所有待删除记录的 id（用于批量 DELETE）
  const ids = rows.map((r) => r.id);

  // 删除物理文件（容错：文件不存在或不可访问时跳过，不影响数据库清理）
  let deletedFiles = 0;
  for (const row of rows) {
    // file_path 是相对路径（如 deviceId/yyyyMMdd/xxx.jpg），拼接根目录得到绝对路径
    const absPath = path.join(config.screenshotsDir, row.file_path);
    try {
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        deletedFiles++;
      }
    } catch (err) {
      // 文件删除失败不阻塞流程，仅记录日志
      console.error(`[cleanup] 删除文件失败: ${absPath}`, err);
    }
  }

  // 批量删除数据库记录
  const deleteStmt = db.prepare(
    `DELETE FROM screenshots WHERE id IN (${ids.map(() => '?').join(',')})`,
  );
  const result = deleteStmt.run(...ids) as { changes?: number };
  const deletedRecords = result.changes ?? 0;

  return { deletedRecords, deletedFiles };
}

/**
 * 执行一次清理：
 * 1. 遍历所有 device_configs 记录，按各自保留策略清理
 * 2. 对于有截图但无配置的设备：使用默认保留 30 天
 */
function runCleanup(): void {
  try {
    // 1. 有配置的设备：按各自策略清理
    const configStmt = db.prepare(
      'SELECT device_id, retention_value, retention_unit FROM device_configs',
    );
    const configRows = configStmt.all() as DeviceConfigRow[];

    let totalRecords = 0;
    let totalFiles = 0;
    const handledDeviceIds = new Set<string>();

    for (const row of configRows) {
      handledDeviceIds.add(row.device_id);
      const cutoff = computeCutoff(
        row.retention_value,
        row.retention_unit as RetentionUnit,
      );
      const { deletedRecords, deletedFiles } = cleanupDeviceScreenshots(
        row.device_id,
        cutoff,
      );
      totalRecords += deletedRecords;
      totalFiles += deletedFiles;
    }

    // 2. 有截图但无配置的设备：使用默认保留 30 天
    const defaultCutoff = computeCutoff(
      DEFAULT_RETENTION_VALUE,
      DEFAULT_RETENTION_UNIT,
    );
    const unconfiguredStmt = db.prepare(
      'SELECT DISTINCT device_id FROM screenshots',
    );
    const allDeviceIds = unconfiguredStmt.all() as DeviceIdRow[];
    for (const { device_id } of allDeviceIds) {
      if (handledDeviceIds.has(device_id)) continue;
      const { deletedRecords, deletedFiles } = cleanupDeviceScreenshots(
        device_id,
        defaultCutoff,
      );
      totalRecords += deletedRecords;
      totalFiles += deletedFiles;
    }

    if (totalRecords > 0 || totalFiles > 0) {
      console.log(
        `[cleanup] 清理完成：删除记录 ${totalRecords} 条，文件 ${totalFiles} 个`,
      );
    }
  } catch (err) {
    console.error('[cleanup] 清理过程发生错误:', err);
  }
}

/**
 * 启动清理服务：每小时执行一次截图过期清理
 *
 * 调用时机：buildApp 末尾，应用启动后调用
 */
export function startCleanupService(): void {
  // 启动时立即执行一次，清理过期数据
  runCleanup();
  // 周期性执行
  setInterval(() => {
    runCleanup();
  }, CLEANUP_INTERVAL_MS);
}

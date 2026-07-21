import { promises as fsp } from 'node:fs';
import path from 'node:path';
import dayjs from 'dayjs';
import { db } from '../db/index.js';
import { config } from '../config/index.js';

// 清理服务运行间隔：1 小时
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// 默认保留：30 天
const DEFAULT_RETENTION_VALUE = 30;
const DEFAULT_RETENTION_UNIT: RetentionUnit = 'days';

// 单设备每批处理的记录数（控制内存 + 让出事件循环）
const BATCH_SIZE = 500;

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
 * 采用流式 iterate + 分批处理，避免一次性载入大量行，并在每批之间让出事件循环
 * @returns 删除的记录数与文件数
 */
async function cleanupDeviceScreenshots(
  deviceId: string,
  cutoff: string,
): Promise<{ deletedRecords: number; deletedFiles: number }> {
  const selectStmt = db.prepare(`
    SELECT id, device_id, file_path, taken_at
    FROM screenshots
    WHERE device_id = ? AND taken_at < ?
  `);

  const deleteStmt = db.prepare('DELETE FROM screenshots WHERE id = ?');

  let deletedRecords = 0;
  let deletedFiles = 0;
  let batch: ScreenshotRow[] = [];

  // 使用 iterate 流式遍历，避免一次性载入全部待删行
  for (const row of selectStmt.iterate(deviceId, cutoff) as Iterable<ScreenshotRow>) {
    batch.push(row);

    if (batch.length >= BATCH_SIZE) {
      const { recs, files } = await processBatch(batch, deleteStmt);
      deletedRecords += recs;
      deletedFiles += files;
      batch = [];
      // 让出事件循环，避免长时间阻塞心跳与上传请求
      await new Promise((r) => setImmediate(r));
    }
  }

  // 处理剩余不足一批的记录
  if (batch.length > 0) {
    const { recs, files } = await processBatch(batch, deleteStmt);
    deletedRecords += recs;
    deletedFiles += files;
  }

  return { deletedRecords, deletedFiles };
}

/**
 * 处理一批记录：异步删文件 + 同步删 DB 记录
 */
async function processBatch(
  batch: ScreenshotRow[],
  deleteStmt: ReturnType<typeof db.prepare>,
): Promise<{ recs: number; files: number }> {
  let recs = 0;
  let files = 0;

  // 并发删除物理文件（ENOENT 视为已删除）
  await Promise.all(
    batch.map(async (row) => {
      const absPath = path.join(config.screenshotsDir, row.file_path);
      try {
        await fsp.unlink(absPath);
        files++;
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          // 文件已不存在，视为已删除
        } else {
          console.error(`[cleanup] 删除文件失败: ${absPath}`, err);
        }
      }
    }),
  );

  // 同步删除 DB 记录（单条 DELETE，better-sqlite3 要求同步）
  // 使用事务包裹批量删除，避免每条独立 fsync
  const tx = db.transaction(() => {
    for (const row of batch) {
      const result = deleteStmt.run(row.id) as { changes?: number };
      recs += result.changes ?? 0;
    }
  });
  tx();

  return { recs, files };
}

/**
 * 执行一次清理：
 * 1. 遍历所有 device_configs 记录，按各自保留策略清理
 * 2. 对于有截图但无配置的设备：使用默认保留 30 天
 */
async function runCleanup(): Promise<void> {
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
      const { deletedRecords, deletedFiles } = await cleanupDeviceScreenshots(
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
      const { deletedRecords, deletedFiles } = await cleanupDeviceScreenshots(
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
  // 启动时立即执行一次，清理过期数据（异步，不阻塞启动）
  void runCleanup();
  // 周期性执行
  setInterval(() => {
    void runCleanup();
  }, CLEANUP_INTERVAL_MS);
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { verifyAdminAuth } from '../../utils/adminAuth.js';

// 预编译语句（模块级复用，GET/PUT 共享）
const stmtInsertDefaultConfig = db.prepare(`
  INSERT OR IGNORE INTO device_configs
    (device_id, screenshot_quality, screenshot_max_width,
     screenshot_interval_sec, retention_value, retention_unit)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtSelectDeviceConfig = db.prepare(
  'SELECT * FROM device_configs WHERE device_id = ?',
);
const stmtSelectMonitorResolutions = db.prepare(
  'SELECT monitor_resolutions FROM devices WHERE device_id = ?',
);

// 设备配置类型
export interface DeviceConfig {
  screenshot_quality: number;
  screenshot_max_width: number;
  screenshot_interval_sec: number;
  retention_value: number;
  retention_unit: 'hours' | 'days' | 'months' | 'years';
  updated_at: string;
}

// 默认配置（与 device_configs 表 DEFAULT 一致）
const DEFAULT_CONFIG: Omit<DeviceConfig, 'updated_at'> = {
  screenshot_quality: 70,
  screenshot_max_width: 1920,
  screenshot_interval_sec: 30,
  retention_value: 30,
  retention_unit: 'days',
};

// device_configs 行类型
interface DeviceConfigRow {
  device_id: string;
  screenshot_quality: number;
  screenshot_max_width: number;
  screenshot_interval_sec: number;
  retention_value: number;
  retention_unit: string;
  updated_at: string;
}

// devices 表中 monitor_resolutions 列类型
interface DeviceMonitorRow {
  monitor_resolutions: string | null;
}

// PUT 请求体 schema：所有字段可选，但若提供则需通过校验
const updateConfigSchema = z
  .object({
    screenshot_quality: z.number().int().min(1).max(100).optional(),
    screenshot_max_width: z.number().int().min(320).optional(),
    screenshot_interval_sec: z.number().int().min(5).optional(),
    retention_value: z.number().int().min(1).optional(),
    retention_unit: z.enum(['hours', 'days', 'months', 'years']).optional(),
  })
  .strict();

/**
 * 将数据库行转为 DeviceConfig 类型（含类型断言保证 retention_unit 联合类型）
 */
function rowToConfig(row: DeviceConfigRow): DeviceConfig {
  return {
    screenshot_quality: row.screenshot_quality,
    screenshot_max_width: row.screenshot_max_width,
    screenshot_interval_sec: row.screenshot_interval_sec,
    retention_value: row.retention_value,
    retention_unit: row.retention_unit as DeviceConfig['retention_unit'],
    updated_at: row.updated_at,
  };
}

/**
 * 管理员设备配置路由
 * - GET /api/admin/devices/:deviceId/config：读取设备配置（无则自动插入默认行）
 * - PUT /api/admin/devices/:deviceId/config：更新设备配置（UPSERT）
 */
export default async function adminConfigRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 读取设备配置：
   * - 若 device_configs 无记录，用 INSERT OR IGNORE 插入默认行后返回
   * - 同时返回 devices.monitor_resolutions（JSON 解析失败返回空数组）
   */
  app.get(
    '/api/admin/devices/:deviceId/config',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };

      // 若无记录则插入默认行（INSERT OR IGNORE 保证幂等）
      stmtInsertDefaultConfig.run(
        deviceId,
        DEFAULT_CONFIG.screenshot_quality,
        DEFAULT_CONFIG.screenshot_max_width,
        DEFAULT_CONFIG.screenshot_interval_sec,
        DEFAULT_CONFIG.retention_value,
        DEFAULT_CONFIG.retention_unit,
      );

      // 读取配置行
      const row = stmtSelectDeviceConfig.get(deviceId) as DeviceConfigRow | undefined;
      if (!row) {
        // 理论上不会走到这里（INSERT OR IGNORE 后必然存在）
        reply.code(500).send({ error: '配置读取失败' });
        return;
      }
      const config = rowToConfig(row);

      // 读取 devices.monitor_resolutions
      const deviceRow = stmtSelectMonitorResolutions.get(deviceId) as DeviceMonitorRow | undefined;
      let monitor_resolutions: { width: number; height: number }[] = [];
      if (deviceRow?.monitor_resolutions) {
        try {
          const parsed = JSON.parse(deviceRow.monitor_resolutions);
          if (Array.isArray(parsed)) {
            monitor_resolutions = parsed.filter(
              (m) =>
                m &&
                typeof m === 'object' &&
                typeof m.width === 'number' &&
                typeof m.height === 'number',
            );
          }
        } catch {
          // JSON 解析失败时返回空数组
          monitor_resolutions = [];
        }
      }

      reply.send({ config, monitor_resolutions });
    },
  );

  /**
   * 更新设备配置（UPSERT）：
   * - 仅允许更新 screenshot_quality / screenshot_max_width / screenshot_interval_sec
   *   / retention_value / retention_unit
   * - updated_at 自动刷新为当前时间
   */
  app.put(
    '/api/admin/devices/:deviceId/config',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };

      const parsed = updateConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        reply
          .code(400)
          .send({ error: '请求参数不合法', details: parsed.error.flatten() });
        return;
      }

      // 先确保存在一行（INSERT OR IGNORE 默认行），再 UPDATE
      stmtInsertDefaultConfig.run(
        deviceId,
        DEFAULT_CONFIG.screenshot_quality,
        DEFAULT_CONFIG.screenshot_max_width,
        DEFAULT_CONFIG.screenshot_interval_sec,
        DEFAULT_CONFIG.retention_value,
        DEFAULT_CONFIG.retention_unit,
      );

      // 动态拼装 UPDATE 语句，仅更新提供的字段
      const updates: string[] = ["updated_at = datetime('now')"];
      const params: (string | number)[] = [];
      const data = parsed.data;

      if (data.screenshot_quality !== undefined) {
        updates.push('screenshot_quality = ?');
        params.push(data.screenshot_quality);
      }
      if (data.screenshot_max_width !== undefined) {
        updates.push('screenshot_max_width = ?');
        params.push(data.screenshot_max_width);
      }
      if (data.screenshot_interval_sec !== undefined) {
        updates.push('screenshot_interval_sec = ?');
        params.push(data.screenshot_interval_sec);
      }
      if (data.retention_value !== undefined) {
        updates.push('retention_value = ?');
        params.push(data.retention_value);
      }
      if (data.retention_unit !== undefined) {
        updates.push('retention_unit = ?');
        params.push(data.retention_unit);
      }

      params.push(deviceId);

      const updateStmt = db.prepare(
        `UPDATE device_configs SET ${updates.join(', ')} WHERE device_id = ?`,
      );
      updateStmt.run(...params);

      // 返回更新后的配置
      const row = stmtSelectDeviceConfig.get(deviceId) as DeviceConfigRow;
      const config = rowToConfig(row);

      reply.send({ success: true, config });
    },
  );
}

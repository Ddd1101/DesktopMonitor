import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { verifyAgentAuth } from '../../utils/agentAuth.js';

// 预编译语句（模块级复用，Agent 每 60 秒轮询一次）
const stmtSelectDeviceConfig = db.prepare(
  'SELECT * FROM device_configs WHERE device_id = ?',
);

// 设备配置类型
interface DeviceConfig {
  screenshot_quality: number;
  screenshot_max_width: number;
  screenshot_interval_sec: number;
  retention_value: number;
  retention_unit: 'hours' | 'days' | 'months' | 'years';
  updated_at: string;
}

// 默认配置（无记录时返回）
const DEFAULT_CONFIG: DeviceConfig = {
  screenshot_quality: 70,
  screenshot_max_width: 1920,
  screenshot_interval_sec: 30,
  retention_value: 30,
  retention_unit: 'days',
  updated_at: '',
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

/**
 * Agent 配置拉取路由
 * - GET /api/agent/config：返回当前设备的配置，无记录则返回默认值（不写入数据库）
 */
export default async function agentConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agent/config',
    {
      preHandler: [verifyAgentAuth],
    },
    async (request, reply) => {
      const deviceId = request.agent!.deviceId;

      const row = stmtSelectDeviceConfig.get(deviceId) as DeviceConfigRow | undefined;

      if (!row) {
        // 无记录则返回默认值（不写入数据库，避免 Agent 轮询触发副作用）
        reply.send({ config: DEFAULT_CONFIG });
        return;
      }

      const config: DeviceConfig = {
        screenshot_quality: row.screenshot_quality,
        screenshot_max_width: row.screenshot_max_width,
        screenshot_interval_sec: row.screenshot_interval_sec,
        retention_value: row.retention_value,
        retention_unit: row.retention_unit as DeviceConfig['retention_unit'],
        updated_at: row.updated_at,
      };

      reply.send({ config });
    },
  );
}

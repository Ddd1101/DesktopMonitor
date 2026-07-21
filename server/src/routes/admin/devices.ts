import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { config } from '../../config/index.js';
import { verifyAdminAuth } from '../../utils/adminAuth.js';

// 设备行类型
interface DeviceRow {
  device_id: string;
  hostname: string | null;
  ip_address: string | null;
  os_info: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  agent_hostname: string | null;
}

/**
 * 将 SQLite datetime('now') 产生的 UTC 时间字符串解析为毫秒时间戳
 * SQLite 返回格式 'YYYY-MM-DD HH:MM:SS'，需转 ISO 才能正确按 UTC 解析
 */
function parseSqliteUtc(s: string | null): number {
  if (!s) return 0;
  const iso = s.replace(' ', 'T') + 'Z';
  const ts = new Date(iso).getTime();
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * 管理员设备列表路由
 * - GET /api/admin/devices：返回所有设备列表，附带在线状态
 */
export default async function adminDevicesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/devices',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      // 关联 agents 表取 hostname，作为 devices.hostname 的补充
      const stmt = db.prepare(`
        SELECT d.device_id, d.hostname, d.ip_address, d.os_info,
               d.last_heartbeat_at, d.created_at,
               a.hostname AS agent_hostname
        FROM devices d
        LEFT JOIN agents a ON d.agent_id = a.id
        ORDER BY d.created_at DESC
      `);
      const rows = stmt.all() as DeviceRow[];

      const now = Date.now();
      const timeoutMs = config.heartbeatTimeoutSeconds * 1000;

      // 计算每台设备的在线状态
      const items = rows.map((row) => {
        const lastTs = parseSqliteUtc(row.last_heartbeat_at);
        const is_online = lastTs > 0 && now - lastTs < timeoutMs;

        return {
          device_id: row.device_id,
          // 优先 devices.hostname，缺失时回退到 agents.hostname
          hostname: row.hostname ?? row.agent_hostname,
          ip_address: row.ip_address,
          os_info: row.os_info,
          last_heartbeat_at: row.last_heartbeat_at,
          created_at: row.created_at,
          is_online,
        };
      });

      reply.send({ items });
    },
  );
}

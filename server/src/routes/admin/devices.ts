import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { config } from '../../config/index.js';
import { verifyAdminAuth } from '../../utils/adminAuth.js';

// 预编译语句（模块级复用，避免每次请求都 prepare）
const stmtSelectAllDevices = db.prepare(`
  SELECT d.device_id, d.hostname, d.ip_address, d.os_info,
         d.last_heartbeat_at, d.created_at,
         a.hostname AS agent_hostname
  FROM devices d
  LEFT JOIN agents a ON d.agent_id = a.id
  ORDER BY d.created_at DESC
`);
const stmtSelectDeviceById = db.prepare(`
  SELECT d.device_id, d.hostname, d.ip_address, d.os_info,
         d.last_heartbeat_at, d.created_at,
         a.hostname AS agent_hostname
  FROM devices d
  LEFT JOIN agents a ON d.agent_id = a.id
  WHERE d.device_id = ?
`);

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
 * 将 last_heartbeat_at 字符串解析为毫秒时间戳
 * 心跳写入使用 dayjs 本地时间 ISO 8601 格式（YYYY-MM-DDTHH:mm:ss），
 * 因此按本地时间解析（不追加 Z），与 Date.now() 比较判定在线状态
 */
function parseHeartbeatTs(s: string | null): number {
  if (!s) return 0;
  // 兼容旧格式（空格分隔）：'YYYY-MM-DD HH:MM:SS' -> 'YYYY-MM-DDTHH:MM:SS'
  const iso = s.replace(' ', 'T');
  const ts = new Date(iso).getTime();
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * 管理员设备列表路由
 * - GET /api/admin/devices：返回所有设备列表，附带在线状态
 * - GET /api/admin/devices/:deviceId：返回单个设备详情，附带在线状态
 */
export default async function adminDevicesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/devices',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      // 关联 agents 表取 hostname，作为 devices.hostname 的补充
      const rows = stmtSelectAllDevices.all() as DeviceRow[];

      const now = Date.now();
      const timeoutMs = config.heartbeatTimeoutSeconds * 1000;

      // 计算每台设备的在线状态
      const items = rows.map((row) => {
        const lastTs = parseHeartbeatTs(row.last_heartbeat_at);
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

  // 单设备详情：避免前端拉取全量列表后 .find() 筛选
  app.get(
    '/api/admin/devices/:deviceId',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const row = stmtSelectDeviceById.get(deviceId) as DeviceRow | undefined;
      if (!row) {
        reply.code(404).send({ error: '设备不存在' });
        return;
      }

      const now = Date.now();
      const timeoutMs = config.heartbeatTimeoutSeconds * 1000;
      const lastTs = parseHeartbeatTs(row.last_heartbeat_at);
      const is_online = lastTs > 0 && now - lastTs < timeoutMs;

      reply.send({
        device_id: row.device_id,
        hostname: row.hostname ?? row.agent_hostname,
        ip_address: row.ip_address,
        os_info: row.os_info,
        last_heartbeat_at: row.last_heartbeat_at,
        created_at: row.created_at,
        is_online,
      });
    },
  );
}

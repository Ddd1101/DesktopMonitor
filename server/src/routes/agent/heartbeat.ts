import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { verifyAgentAuth } from '../../utils/agentAuth.js';

// 心跳请求体 schema（所有字段均为可选）
const heartbeatSchema = z.object({
  hostname: z.string().optional(),
  ip_address: z.string().optional(),
  os_info: z.string().optional(),
});

/**
 * Agent 心跳上报路由
 * - POST /api/agent/heartbeat：更新设备最后心跳时间，可选更新 hostname/ip/os_info
 */
export default async function agentHeartbeatRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/agent/heartbeat',
    {
      preHandler: [verifyAgentAuth],
    },
    async (request, reply) => {
      const deviceId = request.agent!.deviceId;

      // body 可能为空（仅刷新心跳时间），故使用 ?? {}
      const parsed = heartbeatSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply
          .code(400)
          .send({ error: '请求参数不合法', details: parsed.error.flatten() });
        return;
      }

      const { hostname, ip_address, os_info } = parsed.data;

      // 动态拼装 UPDATE 语句，仅更新提供的字段
      const updates: string[] = ["last_heartbeat_at = datetime('now')"];
      const params: (string | null)[] = [];

      if (hostname !== undefined) {
        updates.push('hostname = ?');
        params.push(hostname);
      }
      if (ip_address !== undefined) {
        updates.push('ip_address = ?');
        params.push(ip_address);
      }
      if (os_info !== undefined) {
        updates.push('os_info = ?');
        params.push(os_info);
      }

      params.push(deviceId);

      const stmt = db.prepare(
        `UPDATE devices SET ${updates.join(', ')} WHERE device_id = ?`,
      );
      stmt.run(...params);

      reply.send({ success: true });
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { verifyAgentAuth } from '../../utils/agentAuth.js';

// 事件上报请求体 schema
const eventsSchema = z.object({
  events: z.array(
    z.object({
      app_name: z.string().min(1),
      window_title: z.string().optional(),
      started_at: z.string().min(1),
      ended_at: z.string().min(1),
      duration_seconds: z.number().nonnegative(),
    }),
  ),
});

/**
 * Agent 事件上报路由
 * - POST /api/agent/events：批量接收活动事件，基于 UNIQUE(device_id, started_at) 去重写入
 */
export default async function agentEventsRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/agent/events',
    {
      preHandler: [verifyAgentAuth],
    },
    async (request, reply) => {
      const deviceId = request.agent!.deviceId;

      const parsed = eventsSchema.safeParse(request.body);
      if (!parsed.success) {
        reply
          .code(400)
          .send({ error: '请求参数不合法', details: parsed.error.flatten() });
        return;
      }

      const { events } = parsed.data;

      // 空数组直接返回
      if (events.length === 0) {
        reply.send({ inserted: 0 });
        return;
      }

      // 基于 UNIQUE(device_id, started_at) 去重，使用 INSERT OR IGNORE
      const insert = db.prepare(`
        INSERT OR IGNORE INTO events
          (device_id, app_name, window_title, started_at, ended_at, duration_seconds)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      // 使用事务批量插入，保证原子性与性能
      const tx = db.transaction((items: typeof events) => {
        let inserted = 0;
        for (const item of items) {
          const result = insert.run(
            deviceId,
            item.app_name,
            item.window_title ?? null,
            item.started_at,
            item.ended_at,
            item.duration_seconds,
          );
          // changes > 0 表示实际插入了一行（未被 IGNORE）
          if (result.changes > 0) inserted++;
        }
        return inserted;
      });

      const inserted = tx(events);
      reply.send({ inserted });
    },
  );
}

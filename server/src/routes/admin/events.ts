import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { verifyAdminAuth } from '../../utils/adminAuth.js';

// 事件行类型
interface EventRow {
  id: number;
  device_id: string;
  app_name: string;
  window_title: string | null;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  created_at: string;
}

/**
 * 管理员事件分页查询路由
 * - GET /api/admin/devices/:deviceId/events：按 started_at 降序分页查询，支持按日期过滤
 */
export default async function adminEventsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/devices/:deviceId/events',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const query = request.query as {
        page?: string;
        pageSize?: string;
        date?: string;
      };

      // 分页参数解析与边界保护
      const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
      const pageSize = Math.max(
        1,
        Math.min(200, parseInt(query.pageSize ?? '50', 10) || 50),
      );
      const offset = (page - 1) * pageSize;
      const date = query.date;

      let total: number;
      let rows: EventRow[];

      if (date) {
        // 按日期过滤：date(started_at) = date(?) 支持传入 'YYYY-MM-DD'
        const countStmt = db.prepare(`
          SELECT COUNT(*) AS total FROM events
          WHERE device_id = ? AND date(started_at) = date(?)
        `);
        total = (countStmt.get(deviceId, date) as { total: number }).total;

        const stmt = db.prepare(`
          SELECT id, device_id, app_name, window_title, started_at, ended_at,
                 duration_seconds, created_at
          FROM events
          WHERE device_id = ? AND date(started_at) = date(?)
          ORDER BY started_at DESC
          LIMIT ? OFFSET ?
        `);
        rows = stmt.all(deviceId, date, pageSize, offset) as EventRow[];
      } else {
        const countStmt = db.prepare(
          'SELECT COUNT(*) AS total FROM events WHERE device_id = ?',
        );
        total = (countStmt.get(deviceId) as { total: number }).total;

        const stmt = db.prepare(`
          SELECT id, device_id, app_name, window_title, started_at, ended_at,
                 duration_seconds, created_at
          FROM events
          WHERE device_id = ?
          ORDER BY started_at DESC
          LIMIT ? OFFSET ?
        `);
        rows = stmt.all(deviceId, pageSize, offset) as EventRow[];
      }

      reply.send({ items: rows, total });
    },
  );
}

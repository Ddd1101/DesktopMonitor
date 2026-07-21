import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { verifyAdminAuth } from '../../utils/adminAuth.js';

// 截图行类型
interface ScreenshotRow {
  id: number;
  device_id: string;
  file_path: string;
  taken_at: string;
  monitor_index: number;
  created_at: string;
}

/**
 * 管理员截图分页查询路由
 * - GET /api/admin/devices/:deviceId/screenshots：按 taken_at 降序分页查询
 */
export default async function adminScreenshotsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/devices/:deviceId/screenshots',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const query = request.query as { page?: string; pageSize?: string };

      // 分页参数解析与边界保护
      const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
      const pageSize = Math.max(
        1,
        Math.min(100, parseInt(query.pageSize ?? '20', 10) || 20),
      );
      const offset = (page - 1) * pageSize;

      // 总数
      const countStmt = db.prepare(
        'SELECT COUNT(*) AS total FROM screenshots WHERE device_id = ?',
      );
      const total = (countStmt.get(deviceId) as { total: number }).total;

      // 分页查询（按 taken_at 降序，monitor_index 升序）
      const stmt = db.prepare(`
        SELECT id, device_id, file_path, taken_at, monitor_index, created_at
        FROM screenshots
        WHERE device_id = ?
        ORDER BY taken_at DESC, monitor_index ASC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(deviceId, pageSize, offset) as ScreenshotRow[];

      // 为每条记录构造访问 URL
      const items = rows.map((row) => ({
        ...row,
        url: `/screenshots/${row.file_path}`,
      }));

      reply.send({ items, total, page, pageSize });
    },
  );
}

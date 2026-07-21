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
 * 管理员截图路由
 * - GET /api/admin/devices/:deviceId/screenshots：按 taken_at 降序分页查询
 * - GET /api/admin/devices/:deviceId/screenshots/playback：按时间范围查询（回放用）
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

  /**
   * 回放查询：按时间范围获取截图（升序），最多 500 条
   * 查询参数：startTime, endTime（ISO 8601）
   */
  app.get(
    '/api/admin/devices/:deviceId/screenshots/playback',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const query = request.query as { startTime?: string; endTime?: string };

      const startTime = query.startTime;
      const endTime = query.endTime;

      if (!startTime || !endTime) {
        reply.code(400).send({ error: '需要 startTime 和 endTime 参数' });
        return;
      }

      // 验证时间格式
      const startDate = new Date(startTime);
      const endDate = new Date(endTime);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        reply.code(400).send({ error: '时间格式无效' });
        return;
      }

      // 查询时间范围内的截图（升序，最多 500 条避免过大响应）
      const MAX_PLAYBACK = 500;
      const stmt = db.prepare(`
        SELECT id, device_id, file_path, taken_at, monitor_index, created_at
        FROM screenshots
        WHERE device_id = ? AND taken_at >= ? AND taken_at <= ?
        ORDER BY taken_at ASC, monitor_index ASC
        LIMIT ?
      `);
      const rows = stmt.all(deviceId, startTime, endTime, MAX_PLAYBACK) as ScreenshotRow[];

      const items = rows.map((row) => ({
        ...row,
        url: `/screenshots/${row.file_path}`,
      }));

      reply.send({ items, total: items.length });
    },
  );
}

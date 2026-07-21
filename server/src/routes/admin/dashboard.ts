import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { verifyAdminAuth } from '../../utils/adminAuth.js';

// Top 应用聚合结果类型
interface TopAppRow {
  app_name: string;
  total_seconds: number;
}

/**
 * 管理员看板数据路由
 * - GET /api/admin/dashboard：返回活跃设备数、今日截图数、Top10 应用时长
 */
export default async function adminDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/dashboard',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      // 活跃设备数：今天有心跳的设备数
      const activeStmt = db.prepare(`
        SELECT COUNT(*) AS count FROM devices
        WHERE last_heartbeat_at IS NOT NULL
          AND date(last_heartbeat_at) = date('now')
      `);
      const active_device_count = (activeStmt.get() as { count: number }).count;

      // 截图总数：今天的截图数
      const screenshotStmt = db.prepare(`
        SELECT COUNT(*) AS count FROM screenshots
        WHERE date(taken_at) = date('now')
      `);
      const screenshot_count_today = (screenshotStmt.get() as { count: number })
        .count;

      // Top 10 应用：今天事件表中按 app_name 聚合，sum(duration_seconds)，取前 10
      const topAppsStmt = db.prepare(`
        SELECT app_name, SUM(duration_seconds) AS total_seconds
        FROM events
        WHERE date(started_at) = date('now')
        GROUP BY app_name
        ORDER BY total_seconds DESC
        LIMIT 10
      `);
      const top_apps = topAppsStmt.all() as TopAppRow[];

      reply.send({
        active_device_count,
        screenshot_count_today,
        top_apps,
      });
    },
  );
}

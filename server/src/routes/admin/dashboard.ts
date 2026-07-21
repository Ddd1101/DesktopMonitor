import type { FastifyInstance } from 'fastify';
import dayjs from 'dayjs';
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
 *
 * 注意：DB 中 taken_at/started_at/last_heartbeat_at 由 Agent 写入，
 * 使用本地时间 ISO 8601 格式（无时区后缀），因此这里用本地时间构造范围边界，
 * 避免使用 date() 函数包裹列导致索引失效。
 */
export default async function adminDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/dashboard',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      // 本地时间今天 00:00:00 ~ 明天 00:00:00（字符串比较等价于时间比较）
      const startOfToday = dayjs().startOf('day').format('YYYY-MM-DDTHH:mm:ss');
      const startOfTomorrow = dayjs().add(1, 'day').startOf('day').format('YYYY-MM-DDTHH:mm:ss');

      // 活跃设备数：今天有心跳的设备数
      const activeStmt = db.prepare(`
        SELECT COUNT(*) AS count FROM devices
        WHERE last_heartbeat_at IS NOT NULL
          AND last_heartbeat_at >= ? AND last_heartbeat_at < ?
      `);
      const active_device_count = (activeStmt.get(startOfToday, startOfTomorrow) as { count: number }).count;

      // 截图总数：今天的截图数
      const screenshotStmt = db.prepare(`
        SELECT COUNT(*) AS count FROM screenshots
        WHERE taken_at >= ? AND taken_at < ?
      `);
      const screenshot_count_today = (screenshotStmt.get(startOfToday, startOfTomorrow) as { count: number })
        .count;

      // Top 10 应用：今天事件表中按 app_name 聚合，sum(duration_seconds)，取前 10
      const topAppsStmt = db.prepare(`
        SELECT app_name, SUM(duration_seconds) AS total_seconds
        FROM events
        WHERE started_at >= ? AND started_at < ?
        GROUP BY app_name
        ORDER BY total_seconds DESC
        LIMIT 10
      `);
      const top_apps = topAppsStmt.all(startOfToday, startOfTomorrow) as TopAppRow[];

      reply.send({
        active_device_count,
        screenshot_count_today,
        top_apps,
      });
    },
  );
}

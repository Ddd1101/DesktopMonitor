import type { FastifyInstance } from 'fastify';
import dayjs from 'dayjs';
import { db } from '../../db/index.js';
import { verifyAdminAuth } from '../../utils/adminAuth.js';

// 预编译语句（模块级复用，避免每次请求都 prepare）
// 按日期过滤
const stmtCountEventsByDate = db.prepare(`
  SELECT COUNT(*) AS total FROM events
  WHERE device_id = ? AND started_at >= ? AND started_at < ?
`);
const stmtSelectEventsByDate = db.prepare(`
  SELECT id, device_id, app_name, window_title, started_at, ended_at,
         duration_seconds, created_at
  FROM events
  WHERE device_id = ? AND started_at >= ? AND started_at < ?
  ORDER BY started_at DESC
  LIMIT ? OFFSET ?
`);
// 无日期过滤
const stmtCountEvents = db.prepare(
  'SELECT COUNT(*) AS total FROM events WHERE device_id = ?',
);
const stmtSelectEvents = db.prepare(`
  SELECT id, device_id, app_name, window_title, started_at, ended_at,
         duration_seconds, created_at
  FROM events
  WHERE device_id = ?
  ORDER BY started_at DESC
  LIMIT ? OFFSET ?
`);
// 按任意时间范围过滤（startTime/endTime，升序，最多 1000 条，不分页）
const stmtCountEventsByRange = db.prepare(`
  SELECT COUNT(*) AS total FROM events
  WHERE device_id = ? AND started_at >= ? AND started_at <= ?
`);
const stmtSelectEventsByRange = db.prepare(`
  SELECT id, device_id, app_name, window_title, started_at, ended_at,
         duration_seconds, created_at
  FROM events
  WHERE device_id = ? AND started_at >= ? AND started_at <= ?
  ORDER BY started_at ASC
  LIMIT ?
`);

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
 *   - 优先级：startTime/endTime（任意时间范围，升序，最多 1000 条，不分页）> date（按天）> 无过滤（分页）
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
        startTime?: string;
        endTime?: string;
      };

      // 分页参数解析与边界保护
      const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
      const pageSize = Math.max(
        1,
        Math.min(200, parseInt(query.pageSize ?? '50', 10) || 50),
      );
      const offset = (page - 1) * pageSize;
      const date = query.date;
      const startTime = query.startTime;
      const endTime = query.endTime;

      let total: number;
      let rows: EventRow[];

      if (startTime && endTime) {
        // 按任意时间范围过滤：与 date 互斥，优先使用；升序，最多 1000 条，不分页
        // 用于回放面板按时间范围拉取事件标记
        const rangeLimit = 1000;
        total = (
          stmtCountEventsByRange.get(deviceId, startTime, endTime) as { total: number }
        ).total;
        rows = stmtSelectEventsByRange.all(
          deviceId,
          startTime,
          endTime,
          rangeLimit,
        ) as EventRow[];
      } else if (date) {
        // 按日期过滤：将 'YYYY-MM-DD' 转为范围查询，避免 date() 包裹列导致索引失效
        // DB 中 started_at 是本地时间 ISO 8601 格式（无时区后缀）
        const dayStart = dayjs(date).startOf('day').format('YYYY-MM-DDTHH:mm:ss');
        const dayEnd = dayjs(date).add(1, 'day').startOf('day').format('YYYY-MM-DDTHH:mm:ss');
        total = (stmtCountEventsByDate.get(deviceId, dayStart, dayEnd) as { total: number }).total;
        rows = stmtSelectEventsByDate.all(deviceId, dayStart, dayEnd, pageSize, offset) as EventRow[];
      } else {
        total = (stmtCountEvents.get(deviceId) as { total: number }).total;
        rows = stmtSelectEvents.all(deviceId, pageSize, offset) as EventRow[];
      }

      reply.send({ items: rows, total });
    },
  );
}

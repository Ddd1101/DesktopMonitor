import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { verifyAdminAuth } from '../../utils/adminAuth.js';

// 预编译语句（模块级复用，避免每次请求都 prepare）
const stmtCountScreenshots = db.prepare(
  'SELECT COUNT(*) AS total FROM screenshots WHERE device_id = ?',
);
const stmtSelectScreenshotsPage = db.prepare(`
  SELECT id, device_id, file_path, taken_at, monitor_index, created_at
  FROM screenshots
  WHERE device_id = ?
  ORDER BY taken_at DESC, monitor_index ASC
  LIMIT ? OFFSET ?
`);
const stmtSelectScreenshotsPlayback = db.prepare(`
  SELECT id, device_id, file_path, taken_at, monitor_index, created_at
  FROM screenshots
  WHERE device_id = ? AND taken_at >= ? AND taken_at <= ?
  ORDER BY taken_at ASC, monitor_index ASC
  LIMIT ? OFFSET ?
`);
// 回放时间范围内总数（用于 hasMore 计算）
const stmtCountScreenshotsPlayback = db.prepare(
  'SELECT COUNT(*) AS total FROM screenshots WHERE device_id = ? AND taken_at >= ? AND taken_at <= ?',
);
// 时间轴摘要：按 bucketSec 分桶聚合
const stmtSelectScreenshotsTimeline = db.prepare(`
  SELECT
    strftime('%Y-%m-%dT%H:%M:%S', (strftime('%s', taken_at) / ?) * ?, 'unixepoch') AS bucket_start,
    COUNT(*) AS count,
    MIN(taken_at) AS first_taken_at,
    MAX(taken_at) AS last_taken_at
  FROM screenshots
  WHERE device_id = ? AND taken_at >= ? AND taken_at <= ?
  GROUP BY bucket_start
  ORDER BY bucket_start ASC
`);

// 截图行类型
interface ScreenshotRow {
  id: number;
  device_id: string;
  file_path: string;
  taken_at: string;
  monitor_index: number;
  created_at: string;
}

// 时间轴摘要行类型
interface TimelineRow {
  bucket_start: string;
  count: number;
  first_taken_at: string;
  last_taken_at: string;
}

/**
 * 管理员截图路由
 * - GET /api/admin/devices/:deviceId/screenshots：按 taken_at 降序分页查询
 * - GET /api/admin/devices/:deviceId/screenshots/playback：按时间范围分页查询（回放用）
 * - GET /api/admin/devices/:deviceId/screenshots/timeline：按时间分桶聚合的摘要
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
      const total = (stmtCountScreenshots.get(deviceId) as { total: number }).total;

      // 分页查询（按 taken_at 降序，monitor_index 升序）
      const rows = stmtSelectScreenshotsPage.all(deviceId, pageSize, offset) as ScreenshotRow[];

      // 为每条记录构造访问 URL
      const items = rows.map((row) => ({
        ...row,
        url: `/screenshots/${row.file_path}`,
      }));

      reply.send({ items, total, page, pageSize });
    },
  );

  /**
   * 回放查询：按时间范围分页获取截图（升序）
   * 查询参数：startTime, endTime（ISO 8601），limit（默认 200，最大 1000），offset（默认 0）
   */
  app.get(
    '/api/admin/devices/:deviceId/screenshots/playback',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const query = request.query as {
        startTime?: string;
        endTime?: string;
        limit?: string;
        offset?: string;
      };

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

      // 分页参数：limit 默认 200，最大 1000（超过截断）；offset 默认 0
      const limit = Math.min(
        1000,
        Math.max(1, parseInt(query.limit ?? '200', 10)) || 200,
      );
      const offset = Math.max(0, parseInt(query.offset ?? '0', 10)) || 0;

      // 时间范围内总数（用于 hasMore 计算）
      const total = (
        stmtCountScreenshotsPlayback.get(deviceId, startTime, endTime) as { total: number }
      ).total;

      // 分页查询（升序）
      const rows = stmtSelectScreenshotsPlayback.all(
        deviceId,
        startTime,
        endTime,
        limit,
        offset,
      ) as ScreenshotRow[];

      const items = rows.map((row) => ({
        ...row,
        url: `/screenshots/${row.file_path}`,
      }));

      const hasMore = offset + items.length < total;

      reply.send({ items, total, limit, offset, hasMore });
    },
  );

  /**
   * 时间轴摘要：按 bucketSec 分桶聚合统计截图数量
   * 查询参数：startTime, endTime（必填，ISO 8601），bucketSec（可选，默认 60）
   * 自动提升：若 endTime - startTime 超过 24 小时且未显式传 bucketSec，则 bucketSec 提升至 300
   */
  app.get(
    '/api/admin/devices/:deviceId/screenshots/timeline',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const query = request.query as {
        startTime?: string;
        endTime?: string;
        bucketSec?: string;
      };

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

      // bucketSec 解析与自动提升逻辑
      const bucketSecExplicit = query.bucketSec !== undefined;
      const DEFAULT_BUCKET_SEC = 60;
      const BOOST_BUCKET_SEC = 300;
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;

      let bucketSec: number;
      if (bucketSecExplicit) {
        const parsed = parseInt(query.bucketSec as string, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          reply.code(400).send({ error: 'bucketSec 必须为正整数' });
          return;
        }
        bucketSec = parsed;
      } else if (endDate.getTime() - startDate.getTime() > ONE_DAY_MS) {
        // 时间跨度超过 24 小时且未显式传 bucketSec，提升至 300
        bucketSec = BOOST_BUCKET_SEC;
      } else {
        bucketSec = DEFAULT_BUCKET_SEC;
      }

      // 分桶聚合查询
      const rows = stmtSelectScreenshotsTimeline.all(
        bucketSec,
        bucketSec,
        deviceId,
        startTime,
        endTime,
      ) as TimelineRow[];

      const items = rows.map((row) => ({
        bucket_start: row.bucket_start,
        count: row.count,
        first_taken_at: row.first_taken_at,
        last_taken_at: row.last_taken_at,
      }));

      reply.send({ items });
    },
  );
}

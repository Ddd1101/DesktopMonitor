import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import { config } from './config/index.js';
// 引入 db 单例，触发模块加载时的自动初始化（建表 + 默认管理员）
import './db/index.js';

// 路由模块（均为默认导出）
import adminAuthRoutes from './routes/admin/auth.js';
import adminDevicesRoutes from './routes/admin/devices.js';
import adminScreenshotsRoutes from './routes/admin/screenshots.js';
import adminEventsRoutes from './routes/admin/events.js';
import adminDashboardRoutes from './routes/admin/dashboard.js';
import agentRegisterRoutes from './routes/agent/register.js';
import agentEventsRoutes from './routes/agent/events.js';
import agentScreenshotsRoutes from './routes/agent/screenshots.js';
import agentHeartbeatRoutes from './routes/agent/heartbeat.js';
import monitorWsRoutes from './routes/ws/monitor.js';

/**
 * 构建 Fastify 应用实例
 *
 * 注意：所有路由文件内部已声明完整路径（如 /api/admin/login、/ws/monitor/:deviceId），
 * 因此此处注册时不再额外添加 prefix，以避免路径重复。
 *
 * @returns 已完成插件与路由注册的 Fastify 实例
 */
export async function buildApp(): Promise<FastifyInstance> {
  // 创建 Fastify 实例，启用 info 级别日志
  const app = Fastify({
    logger: { level: 'info' },
  });

  // 注册 CORS 插件：MVP 简化，允许所有来源
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // 注册 multipart 插件：用于 Agent 截图上传，限制单文件 10MB
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB
    },
  });

  // 注册 WebSocket 插件：用于实时截图推送
  await app.register(websocket);

  // 确保静态文件服务根目录存在（启动时自动创建）
  if (!fs.existsSync(config.screenshotsDir)) {
    fs.mkdirSync(config.screenshotsDir, { recursive: true });
  }

  // 注册静态文件服务插件：访问 /screenshots/* 时返回对应截图文件
  await app.register(staticPlugin, {
    root: path.resolve(config.screenshotsDir),
    prefix: '/screenshots',
    decorateReply: false,
  });

  // 注册管理员路由
  app.register(adminAuthRoutes);
  app.register(adminDevicesRoutes);
  app.register(adminScreenshotsRoutes);
  app.register(adminEventsRoutes);
  app.register(adminDashboardRoutes);

  // 注册 Agent 路由
  app.register(agentRegisterRoutes);
  app.register(agentEventsRoutes);
  app.register(agentScreenshotsRoutes);
  app.register(agentHeartbeatRoutes);

  // 注册 WebSocket 监控路由（路径已含 /ws 前缀，无需额外 prefix）
  app.register(monitorWsRoutes);

  // 健康检查路由
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // 全局错误处理：统一返回 { error: string } 格式
  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // 记录错误日志
    request.log.error({ err }, '请求处理失败');

    // 校验错误（zod 等）返回 400
    const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;

    reply.code(statusCode).send({
      error: err.message || '服务器内部错误',
    });
  });

  return app;
}

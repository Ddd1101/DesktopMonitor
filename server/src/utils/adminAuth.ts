import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAdminToken } from './auth.js';

/**
 * 管理员鉴权中间件（Fastify preHandler）
 *
 * 流程：
 * 1. 从 Authorization header 解析 Bearer token
 * 2. 调用 verifyAdminToken 校验签名
 * 3. 失败返回 401
 * 4. 成功时将 { adminId, username } 挂载到 request.admin
 */
export async function verifyAdminAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: '缺少 Authorization 头或格式不正确' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();

  // 校验 JWT
  const payload = verifyAdminToken(token);
  if (!payload) {
    reply.code(401).send({ error: 'Token 校验失败或已过期' });
    return;
  }

  // 挂载到 request 上，供后续 handler 使用
  request.admin = payload;
}

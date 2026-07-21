import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { db } from '../db/index.js';
import { verifyAgentToken } from './auth.js';

/**
 * Agent 鉴权中间件（Fastify preHandler）
 *
 * 流程：
 * 1. 从 Authorization header 解析 Bearer token
 * 2. 不验签解码拿到 deviceId（用于查找该 Agent 的 jwt_secret）
 * 3. 查询 agents 表拿到该 Agent 的 jwt_secret
 * 4. 用该 jwt_secret 校验签名（支持单独吊销）
 * 5. 成功时将 deviceId 挂载到 request.agent
 */
export async function verifyAgentAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: '缺少 Authorization 头或格式不正确' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();

  // 第一阶段：不验签解码，仅用于拿到 deviceId 以查询对应 Agent 的 secret
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded === 'string') {
    reply.code(401).send({ error: '无效的 Token' });
    return;
  }
  const payload = decoded as JwtPayload;
  const deviceId = payload.deviceId;
  if (typeof deviceId !== 'string') {
    reply.code(401).send({ error: 'Token 中缺少 deviceId' });
    return;
  }

  // 查询该 Agent 的 jwt_secret
  const stmt = db.prepare('SELECT jwt_secret FROM agents WHERE device_id = ?');
  const row = stmt.get(deviceId) as { jwt_secret: string } | undefined;
  if (!row) {
    reply.code(401).send({ error: '设备未注册或已被吊销' });
    return;
  }

  // 用 Agent 独立 secret 验签
  const verified = verifyAgentToken(token, row.jwt_secret);
  if (!verified) {
    reply.code(401).send({ error: 'Token 校验失败或已过期' });
    return;
  }

  // 挂载到 request 上，供后续 handler 使用
  request.agent = { deviceId: verified.deviceId };
}

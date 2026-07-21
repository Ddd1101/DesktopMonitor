import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { config } from '../../config/index.js';
import { signAgentJwt } from '../../utils/auth.js';

// 注册请求体 schema
const registerSchema = z.object({
  registerToken: z.string().min(1),
  hostname: z.string().min(1),
  osInfo: z.string().optional(),
});

/**
 * Agent 注册路由
 * - POST /api/agent/register：预置 Token 校验 + 设备 ID 生成 + JWT 签发
 */
export default async function agentRegisterRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/agent/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: '请求参数不合法', details: parsed.error.flatten() });
      return;
    }

    const { registerToken, hostname, osInfo } = parsed.data;

    // 校验预置 Token
    if (registerToken !== config.agentRegisterToken) {
      reply.code(401).send({ error: '注册 Token 无效' });
      return;
    }

    // 生成 deviceId 与 jwt_secret
    const deviceId = `dev-${crypto.randomUUID()}`;
    const jwtSecret = crypto.randomBytes(32).toString('hex');

    // 事务：写入 agents 表 + upsert devices 表
    const insertAgent = db.prepare(`
      INSERT INTO agents (device_id, hostname, register_token, jwt_secret)
      VALUES (?, ?, ?, ?)
    `);
    const upsertDevice = db.prepare(`
      INSERT INTO devices (device_id, agent_id, hostname, os_info)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        hostname = excluded.hostname,
        os_info = excluded.os_info
    `);

    const tx = db.transaction(() => {
      const result = insertAgent.run(deviceId, hostname, registerToken, jwtSecret);
      upsertDevice.run(deviceId, result.lastInsertRowid, hostname, osInfo ?? null);
    });

    try {
      tx();
    } catch (err) {
      request.log.error({ err }, 'Agent 注册写入数据库失败');
      reply.code(500).send({ error: '注册失败' });
      return;
    }

    // 使用 Agent 独立 secret 签发 JWT，便于后续单独吊销
    const token = signAgentJwt({ deviceId }, jwtSecret);

    // 读取 RSA 公钥返回给 Agent（注册是低频操作，同步读取即可）
    const publicKeyPath = path.join(config.dataDir, 'rsa_public.pem');
    const publicKey = fs.readFileSync(publicKeyPath, 'utf8');

    reply.send({ deviceId, token, publicKey });
  });
}

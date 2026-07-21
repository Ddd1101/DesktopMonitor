import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { verifyPassword, signAdminJwt } from '../../utils/auth.js';

// 登录请求体 schema
const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * 管理员鉴权路由
 * - POST /api/admin/login：账号密码登录，签发 JWT
 */
export default async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/admin/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: '请求参数不合法', details: parsed.error.flatten() });
      return;
    }

    const { username, password } = parsed.data;

    // 查询管理员记录
    const stmt = db.prepare('SELECT id, username, password_hash FROM admins WHERE username = ?');
    const admin = stmt.get(username) as
      | { id: number; username: string; password_hash: string }
      | undefined;

    if (!admin || !verifyPassword(password, admin.password_hash)) {
      reply.code(401).send({ error: '用户名或密码错误' });
      return;
    }

    // 签发 JWT
    const token = signAdminJwt({ adminId: admin.id, username: admin.username });
    reply.send({
      token,
      admin: { id: admin.id, username: admin.username },
    });
  });
}

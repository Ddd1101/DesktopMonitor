import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/**
 * 使用 SHA-256 对明文密码进行哈希（MVP 简化实现，不加盐）
 * @param plain 明文密码
 * @returns 十六进制哈希字符串
 */
export function hashPassword(plain: string): string {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

/**
 * 校验明文密码与哈希是否匹配
 * @param plain 明文密码
 * @param hash 已存储的哈希
 */
export function verifyPassword(plain: string, hash: string): boolean {
  const computed = hashPassword(plain);
  // 使用 timingSafeEqual 防止时序攻击
  try {
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * 为管理员签发 JWT，有效期 24 小时
 */
export function signAdminJwt(payload: { adminId: number; username: string }): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '24h' });
}

/**
 * 为 Agent 签发 JWT，有效期 7 天
 * 注意：实际使用时会用 agent.jwt_secret 单独签名以便单独吊销
 */
export function signAgentJwt(payload: { deviceId: string }, secret: string = config.jwtSecret): string {
  return jwt.sign(payload, secret, { expiresIn: '7d' });
}

/**
 * 校验管理员 JWT，成功返回 payload，失败返回 null
 */
export function verifyAdminToken(token: string): { adminId: number; username: string } | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (typeof decoded.adminId !== 'number' || typeof decoded.username !== 'string') {
      return null;
    }
    return { adminId: decoded.adminId, username: decoded.username };
  } catch {
    return null;
  }
}

/**
 * 校验 Agent JWT，成功返回 payload，失败返回 null
 * @param token JWT 字符串
 * @param secret 该 Agent 的独立密钥（来自 agents.jwt_secret）
 */
export function verifyAgentToken(token: string, secret: string): { deviceId: string } | null {
  try {
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
    if (typeof decoded.deviceId !== 'string') {
      return null;
    }
    return { deviceId: decoded.deviceId };
  } catch {
    return null;
  }
}

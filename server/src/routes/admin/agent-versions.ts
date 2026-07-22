import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { config } from '../../config/index.js';
import { verifyAdminAuth } from '../../utils/adminAuth.js';

// 预编译语句（模块级复用，避免每次请求都 prepare）
const stmtSelectAllVersions = db.prepare(`
  SELECT id, version, file_path, sha256, is_latest, force, created_at
  FROM agent_versions
  ORDER BY created_at DESC
`);
const stmtSelectVersionById = db.prepare(`
  SELECT id, version, file_path, sha256, is_latest, force, created_at
  FROM agent_versions
  WHERE id = ?
`);
const stmtClearLatest = db.prepare(`
  UPDATE agent_versions SET is_latest = 0
`);
const stmtSetLatestById = db.prepare(`
  UPDATE agent_versions SET is_latest = 1 WHERE id = ?
`);
const stmtInsertVersion = db.prepare(`
  INSERT INTO agent_versions (version, file_path, sha256, is_latest, force)
  VALUES (?, ?, ?, ?, ?)
`);
const stmtDeleteVersion = db.prepare(`
  DELETE FROM agent_versions WHERE id = ?
`);
const stmtSelectLatestVersion = db.prepare(`
  SELECT id, version, file_path, sha256, is_latest, force, created_at
  FROM agent_versions
  WHERE is_latest = 1
  LIMIT 1
`);
const stmtInsertCommand = db.prepare(`
  INSERT INTO device_commands (device_id, command, payload, status)
  VALUES (?, ?, ?, 'pending')
`);

// agent_versions 行类型
interface AgentVersionRow {
  id: number;
  version: string;
  file_path: string;
  sha256: string;
  is_latest: number;
  force: number;
  created_at: string;
}

// agent-releases 目录（基于 config.dataDir，运行时 CWD 通常为 server/）
const agentReleasesDir = path.join(config.dataDir, 'agent-releases');

/**
 * 从 @fastify/multipart 的 fields 对象中提取文本字段值
 * 兼容不同版本的封装形式（字符串、{ value } 对象、数组）
 */
function extractFieldValue(field: unknown): string | undefined {
  if (field == null) return undefined;
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) {
    const first = field[0];
    if (first != null && typeof first === 'object' && 'value' in first) {
      const v = (first as { value: unknown }).value;
      return typeof v === 'string' ? v : undefined;
    }
    return undefined;
  }
  if (typeof field === 'object' && 'value' in field) {
    const v = (field as { value: unknown }).value;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * 管理员 Agent 版本管理与设备命令下发路由
 * - POST /api/admin/agent-versions/upload：上传 Agent exe 文件
 * - GET /api/admin/agent-versions：返回所有版本列表（按 created_at DESC）
 * - POST /api/admin/agent-versions/:id/set-latest：设置指定版本为 latest
 * - DELETE /api/admin/agent-versions/:id：删除版本记录与文件
 * - POST /api/admin/devices/:deviceId/restart：下发 restart 命令
 * - POST /api/admin/devices/:deviceId/update：下发 update 命令（携带最新版本信息）
 */
export default async function adminAgentVersionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 上传 Agent exe 文件
   * - multipart 字段：file（exe 文件）、version（版本号）、force（可选，默认 0）
   * - version 与 force 也支持通过 query string 传递（query 优先级低于 form 字段）
   * - 计算 SHA256，落盘到 agent-releases 目录
   * - 事务内清空其他记录 is_latest，插入新记录 is_latest=1
   */
  app.post(
    '/api/admin/agent-versions/upload',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        reply.code(400).send({ error: '未提供文件' });
        return;
      }

      // 优先从 multipart fields 提取，回退到 query string
      const version =
        extractFieldValue(data.fields['version']) ??
        (request.query as { version?: string } | undefined)?.version;
      if (!version) {
        reply.code(400).send({ error: '缺少 version 字段' });
        return;
      }

      const forceStr =
        extractFieldValue(data.fields['force']) ??
        (request.query as { force?: string } | undefined)?.force;
      const force = forceStr != null && Number.parseInt(forceStr, 10) === 1 ? 1 : 0;

      // 确保目录存在
      await fsp.mkdir(agentReleasesDir, { recursive: true });

      // 读取完整 Buffer（受 multipart fileSize 限制，超出会抛 413）
      const buffer = await streamToBuffer(data.file);

      // 计算 SHA256
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      // 落盘：{version}_DesktopMonitorAgent.exe（同版本重复上传将覆盖旧文件）
      const fileName = `${version}_DesktopMonitorAgent.exe`;
      const filePath = path.join(agentReleasesDir, fileName);
      await fsp.writeFile(filePath, buffer);

      // 相对路径（使用正斜杠，便于跨平台 URL 构造）
      const relativePath = path.join('agent-releases', fileName).replace(/\\/g, '/');

      // 事务：先清空所有 is_latest，再插入新记录 is_latest=1
      const insertVersionTx = db.transaction(() => {
        stmtClearLatest.run();
        const result = stmtInsertVersion.run(version, relativePath, sha256, 1, force);
        return result.lastInsertRowid as number;
      });
      const id = insertVersionTx();

      reply.send({
        id,
        version,
        sha256,
        is_latest: 1,
        force,
      });
    },
  );

  /**
   * 返回所有 Agent 版本列表（按 created_at DESC）
   */
  app.get(
    '/api/admin/agent-versions',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const rows = stmtSelectAllVersions.all() as AgentVersionRow[];
      reply.send({
        items: rows.map((row) => ({
          id: row.id,
          version: row.version,
          file_path: row.file_path,
          sha256: row.sha256,
          is_latest: row.is_latest,
          force: row.force,
          created_at: row.created_at,
        })),
      });
    },
  );

  /**
   * 设置指定版本为 latest（其他置 0）
   */
  app.post(
    '/api/admin/agent-versions/:id/set-latest',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const idNum = Number.parseInt(id, 10);
      if (Number.isNaN(idNum)) {
        reply.code(400).send({ error: 'id 必须是整数' });
        return;
      }

      const row = stmtSelectVersionById.get(idNum) as AgentVersionRow | undefined;
      if (!row) {
        reply.code(404).send({ error: '版本不存在' });
        return;
      }

      // 事务：先清空所有 is_latest，再设置目标记录
      const setLatestTx = db.transaction(() => {
        stmtClearLatest.run();
        stmtSetLatestById.run(idNum);
      });
      setLatestTx();

      reply.send({ success: true });
    },
  );

  /**
   * 删除版本记录与文件
   */
  app.delete(
    '/api/admin/agent-versions/:id',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const idNum = Number.parseInt(id, 10);
      if (Number.isNaN(idNum)) {
        reply.code(400).send({ error: 'id 必须是整数' });
        return;
      }

      const row = stmtSelectVersionById.get(idNum) as AgentVersionRow | undefined;
      if (!row) {
        reply.code(404).send({ error: '版本不存在' });
        return;
      }

      // 删除文件（文件不存在不算错误）
      const filePath = path.join(config.dataDir, row.file_path);
      try {
        await fsp.unlink(filePath);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') throw e;
      }

      stmtDeleteVersion.run(idNum);

      reply.send({ success: true });
    },
  );

  /**
   * 下发 restart 命令到指定设备
   */
  app.post(
    '/api/admin/devices/:deviceId/restart',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const result = stmtInsertCommand.run(deviceId, 'restart', null);
      reply.send({ success: true, command_id: result.lastInsertRowid });
    },
  );

  /**
   * 下发 update 命令到指定设备（携带最新版本信息）
   * - 若无 is_latest=1 的版本记录，返回 404
   */
  app.post(
    '/api/admin/devices/:deviceId/update',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      const latest = stmtSelectLatestVersion.get() as AgentVersionRow | undefined;
      if (!latest) {
        reply.code(404).send({ error: '无可用最新版本' });
        return;
      }

      const payload = JSON.stringify({
        version: latest.version,
        sha256: latest.sha256,
        file_path: latest.file_path,
      });

      const result = stmtInsertCommand.run(deviceId, 'update', payload);

      reply.send({
        success: true,
        command_id: result.lastInsertRowid,
        latest: {
          id: latest.id,
          version: latest.version,
          sha256: latest.sha256,
          file_path: latest.file_path,
          force: latest.force,
        },
      });
    },
  );
}

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { verifyAgentAuth } from '../../utils/agentAuth.js';

// 预编译语句（模块级复用，避免每次请求都 prepare）
// 查询设备的待执行命令（按创建时间升序）
const stmtSelectPendingCommands = db.prepare(
  `SELECT id, command, payload FROM device_commands
   WHERE device_id = ? AND status = 'pending'
   ORDER BY created_at ASC`,
);

// 完成命令（带 device_id 条件，确保设备只能完成自己的命令）
const stmtCompleteCommand = db.prepare(
  `UPDATE device_commands
   SET status = 'done', executed_at = datetime('now')
   WHERE id = ? AND device_id = ?`,
);

// 按 id 查询版本（用于下载安装包）
const stmtSelectAgentVersionById = db.prepare(
  'SELECT id, version, file_path, sha256 FROM agent_versions WHERE id = ?',
);

// device_commands 行类型
interface DeviceCommandRow {
  id: number;
  command: string;
  payload: string | null;
}

// agent_versions 行类型
interface AgentVersionRow {
  id: number;
  version: string;
  file_path: string;
  sha256: string;
}

// GET /api/agent/updates/download 的 query 参数类型
interface DownloadQuery {
  version_id?: string;
}

// POST /api/agent/commands/:id/done 的路由参数类型
interface CommandDoneParams {
  id: string;
}

/**
 * Agent 命令与升级路由
 * - GET /api/agent/commands：拉取当前设备的待执行命令列表
 * - POST /api/agent/commands/:id/done：标记指定命令为已完成
 * - GET /api/agent/updates/download：下载指定版本的 Agent 安装包
 *
 * 注意：@fastify/static 在 app.ts 中以 decorateReply: false 注册，
 * 故 reply.sendFile 不可用，下载使用 fs.createReadStream + 手动响应头。
 */
export default async function agentCommandsRoutes(app: FastifyInstance): Promise<void> {
  // 拉取当前设备的待执行命令（按创建时间升序）
  app.get(
    '/api/agent/commands',
    {
      preHandler: [verifyAgentAuth],
    },
    async (request, reply) => {
      const deviceId = request.agent!.deviceId;

      const rows = stmtSelectPendingCommands.all(deviceId) as DeviceCommandRow[];

      const commands = rows.map((r) => ({
        id: r.id,
        command: r.command,
        payload: r.payload,
      }));

      reply.send({ commands });
    },
  );

  // 标记指定命令为已完成（仅允许完成本设备的命令）
  app.post<{
    Params: CommandDoneParams;
  }>(
    '/api/agent/commands/:id/done',
    {
      preHandler: [verifyAgentAuth],
    },
    async (request, reply) => {
      const deviceId = request.agent!.deviceId;
      const commandId = Number(request.params.id);

      if (Number.isNaN(commandId)) {
        reply.code(400).send({ error: '命令 id 不合法' });
        return;
      }

      const result = stmtCompleteCommand.run(commandId, deviceId);

      // changes=0 表示命令不存在或不属于当前设备
      if (result.changes === 0) {
        reply.code(404).send({ error: '命令不存在或不属于当前设备' });
        return;
      }

      reply.send({ success: true });
    },
  );

  // 下载指定版本的 Agent 安装包
  app.get<{
    Querystring: DownloadQuery;
  }>(
    '/api/agent/updates/download',
    {
      preHandler: [verifyAgentAuth],
    },
    async (request, reply) => {
      const versionIdRaw = request.query.version_id;
      const versionId = Number(versionIdRaw);

      if (versionIdRaw === undefined || Number.isNaN(versionId)) {
        reply.code(400).send({ error: '缺少或非法的 version_id 参数' });
        return;
      }

      const versionRow = stmtSelectAgentVersionById.get(versionId) as
        | AgentVersionRow
        | undefined;

      if (!versionRow) {
        reply.code(404).send({ error: '版本不存在' });
        return;
      }

      const filePath = versionRow.file_path;
      if (!fs.existsSync(filePath)) {
        reply.code(404).send({ error: '安装包文件不存在' });
        return;
      }

      const fileName = path.basename(filePath);
      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${fileName}"`)
        .send(fs.createReadStream(filePath));
    },
  );
}

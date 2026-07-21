import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { config } from '../../config/index.js';
import { verifyAgentAuth } from '../../utils/agentAuth.js';
import { subscriptionService } from '../../services/subscription.js';
import { ensureKeyPair } from '../../utils/rsa.js';

// 预编译语句（模块级复用，避免每次上传都 prepare）
const stmtInsertScreenshot = db.prepare(`
  INSERT OR IGNORE INTO screenshots
    (device_id, file_path, taken_at, monitor_index)
  VALUES (?, ?, ?, ?)
`);

// taken_at 字段校验：非空字符串
const takenAtSchema = z.string().min(1);

// 模块级延迟加载私钥（首次请求时加载）
let privateKeyCache: crypto.KeyObject | null = null;

function getPrivateKey(): crypto.KeyObject {
  if (privateKeyCache === null) {
    privateKeyCache = ensureKeyPair().privateKey;
  }
  return privateKeyCache;
}

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
 * Agent 截图上传路由
 * - POST /api/agent/screenshots：multipart 接收图片，落盘并写入 screenshots 表
 */
export default async function agentScreenshotsRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/agent/screenshots',
    {
      preHandler: [verifyAgentAuth],
    },
    async (request, reply) => {
      const deviceId = request.agent!.deviceId;

      // 接收 multipart 文件（任意二进制数据，application/octet-stream）
      const data = await request.file();
      if (!data) {
        reply.code(400).send({ error: '未提供文件' });
        return;
      }

      // 提取并校验 taken_at 表单字段
      const takenAtStr = extractFieldValue(data.fields['taken_at']);
      const takenAtParsed = takenAtSchema.safeParse(takenAtStr);
      if (!takenAtParsed.success) {
        reply.code(400).send({ error: '缺少或无效的 taken_at 字段' });
        return;
      }
      const takenAt = takenAtParsed.data;

      // 提取 monitor_index（可选，默认 1，从 1 开始计数 1=主屏）
      const monitorIndexStr = extractFieldValue(data.fields['monitor_index']);
      let monitorIndex = 1;
      if (monitorIndexStr) {
        const n = Number.parseInt(monitorIndexStr, 10);
        if (Number.isNaN(n) || n < 1) {
          reply.code(400).send({ error: 'monitor_index 必须是 >= 1 的整数' });
          return;
        }
        monitorIndex = n;
      }

      // 校验 taken_at 是有效的 ISO 8601 时间
      const takenAtDate = new Date(takenAt);
      if (Number.isNaN(takenAtDate.getTime())) {
        reply.code(400).send({ error: 'taken_at 不是有效的 ISO 8601 时间' });
        return;
      }

      // 构造文件保存路径: {screenshotsDir}/{deviceId}/{YYYYMMDD}/{timestamp}_m{idx}.jpg
      // 文件名带 monitor_index 后缀，避免多屏同时刻截图互相覆盖
      const yyyyMMdd = takenAtDate.toISOString().slice(0, 10).replace(/-/g, '');
      const timestamp = takenAtDate.getTime();
      const fileName = `${timestamp}_m${monitorIndex}.jpg`;
      const dir = path.join(config.screenshotsDir, deviceId, yyyyMMdd);

      // 自动创建目录（已存在不报错，省去 existsSync）
      await fsp.mkdir(dir, { recursive: true });

      const filePath = path.join(dir, fileName);

      // 读取完整上传的 Buffer 数据
      const encryptedBuffer = await streamToBuffer(data.file);

      // 解析文件格式：[4字节大端RSA块长度][RSA加密块][AES加密数据]
      const rsaBlockLength = encryptedBuffer.readUInt32BE(0);
      const rsaBlock = encryptedBuffer.subarray(4, 4 + rsaBlockLength);
      const aesData = encryptedBuffer.subarray(4 + rsaBlockLength);

      // RSA-OAEP 解密 RSA 块，得到 48 字节（32字节 AES 密钥 + 16字节 IV）
      const aesKeyMaterial = crypto.privateDecrypt(
        {
          key: getPrivateKey(),
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        rsaBlock,
      );
      const aesKey = aesKeyMaterial.subarray(0, 32);
      const iv = aesKeyMaterial.subarray(32, 48);

      // AES-256-CBC 解密 AES 数据，得到原始 JPEG（Node.js crypto 自动处理 PKCS7 padding）
      const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
      const jpegBuffer = Buffer.concat([decipher.update(aesData), decipher.final()]);

      // 解密后的 JPEG 落盘
      await fsp.writeFile(filePath, jpegBuffer);

      // 计算相对路径（使用正斜杠，便于跨平台 URL 构造）
      const relativePath = path
        .join(deviceId, yyyyMMdd, fileName)
        .replace(/\\/g, '/');

      // 写入 screenshots 表（基于 UNIQUE(device_id, taken_at, monitor_index) 去重）
      stmtInsertScreenshot.run(deviceId, relativePath, takenAt, monitorIndex);

      // 构造访问 URL（静态文件服务 /screenshots/* 由 Task 9 注册）
      const url = `/screenshots/${relativePath}`;

      // 推送给 WebSocket 订阅者
      subscriptionService.notifyScreenshotUploaded(deviceId, url, monitorIndex);

      reply.send({ success: true, file_path: relativePath });
    },
  );
}

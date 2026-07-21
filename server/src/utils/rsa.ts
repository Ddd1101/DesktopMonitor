import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

// RSA 密钥文件路径（相对于 dataDir）
const PRIVATE_KEY_PATH = path.join(config.dataDir, 'rsa_private.pem');
const PUBLIC_KEY_PATH = path.join(config.dataDir, 'rsa_public.pem');

/**
 * 生成 RSA-2048 密钥对并保存到磁盘
 * 私钥用 PKCS#8 格式，公钥用 SPKI 格式，均 PEM 编码
 */
export function generateKeyPair(): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } {
  // 确保数据目录存在
  fs.mkdirSync(config.dataDir, { recursive: true });

  // 同步生成 RSA-2048 密钥对
  const { privateKey: privateKeyPem, publicKey: publicKeyPem } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  // 写入磁盘（私钥限制访问权限）
  fs.writeFileSync(PRIVATE_KEY_PATH, privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_PATH, publicKeyPem, { mode: 0o644 });

  return {
    privateKey: crypto.createPrivateKey(privateKeyPem),
    publicKey: crypto.createPublicKey(publicKeyPem),
  };
}

/**
 * 加载私钥（PKCS#8 PEM），返回 crypto.KeyObject
 */
export function loadPrivateKey(): crypto.KeyObject {
  const pem = fs.readFileSync(PRIVATE_KEY_PATH);
  return crypto.createPrivateKey(pem);
}

/**
 * 加载公钥（SPKI PEM），返回 crypto.KeyObject
 */
export function loadPublicKey(): crypto.KeyObject {
  const pem = fs.readFileSync(PUBLIC_KEY_PATH);
  return crypto.createPublicKey(pem);
}

/**
 * 确保密钥对存在：若 rsa_private.pem 不存在则生成，否则加载
 * 返回 { privateKey, publicKey }
 */
export function ensureKeyPair(): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    return generateKeyPair();
  }
  return {
    privateKey: loadPrivateKey(),
    publicKey: loadPublicKey(),
  };
}

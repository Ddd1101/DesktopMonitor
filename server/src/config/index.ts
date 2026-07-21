import dotenv from 'dotenv';

// 加载 .env 环境变量
dotenv.config();

// 全局配置对象，所有配置项均支持通过环境变量覆盖
export const config = {
  // 服务监听端口
  port: Number(process.env.PORT) || 3000,
  // 管理员 JWT 签名密钥
  jwtSecret: process.env.JWT_SECRET || 'default-jwt-secret-change-me',
  // Agent 注册时使用的预置 Token
  agentRegisterToken: process.env.AGENT_REGISTER_TOKEN || 'change-me-please',
  // 默认管理员密码（首次启动时写入）
  adminDefaultPassword: process.env.ADMIN_DEFAULT_PASSWORD || 'admin123',
  // 数据目录
  dataDir: process.env.DATA_DIR || './data',
  // 截图存储目录
  screenshotsDir: process.env.SCREENSHOTS_DIR || './data/screenshots',
  // SQLite 数据库文件路径
  dbPath: process.env.DB_PATH || './data/app.db',
  // 心跳超时时间（秒），超过视为离线
  heartbeatTimeoutSeconds: Number(process.env.HEARTBEAT_TIMEOUT_SECONDS) || 90,
} as const;

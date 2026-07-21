import { buildApp } from './app.js';
import { config } from './config/index.js';

/**
 * 服务端启动入口
 *
 * 职责：
 * 1. 构建 Fastify 实例
 * 2. 监听端口（默认 0.0.0.0:3000）
 * 3. 打印启动日志（端口、默认管理员账号）
 * 4. 监听 SIGINT/SIGTERM 信号，优雅关闭服务
 */
async function main(): Promise<void> {
  const app = await buildApp();

  try {
    // 监听端口，绑定到所有网卡以便容器/局域网访问
    await app.listen({
      port: config.port,
      host: '0.0.0.0',
    });

    // 打印启动信息
    app.log.info('========================================');
    app.log.info(`Desktop Monitor 服务端已启动`);
    app.log.info(`监听端口: ${config.port}`);
    app.log.info(`默认管理员账号: admin`);
    app.log.info(`默认管理员密码: ${config.adminDefaultPassword}`);
    app.log.info(`健康检查: http://localhost:${config.port}/health`);
    app.log.info('========================================');
  } catch (err) {
    app.log.error({ err }, '服务启动失败');
    process.exit(1);
  }

  // 优雅关闭：接收到 SIGINT（Ctrl+C）或 SIGTERM 时关闭服务
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info(`收到 ${signal} 信号，开始优雅关闭...`);
    try {
      await app.close();
      app.log.info('服务已关闭');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, '关闭服务时发生错误');
      process.exit(1);
    }
  };

  for (const signal of signals) {
    process.on(signal, () => void shutdown(signal));
  }
}

// 启动服务
main().catch((err) => {
  // 此处 console 而非 logger，因为 logger 可能尚未初始化
  console.error('启动服务时发生未捕获错误:', err);
  process.exit(1);
});

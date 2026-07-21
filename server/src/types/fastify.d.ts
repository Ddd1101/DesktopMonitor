import 'fastify';

// 扩展 FastifyRequest 类型，挂载鉴权后的上下文信息
declare module 'fastify' {
  interface FastifyRequest {
    // Agent 鉴权后挂载的设备信息
    agent?: { deviceId: string };
    // 管理员鉴权后挂载的管理员信息
    admin?: { adminId: number; username: string };
  }
}

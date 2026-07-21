import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { subscriptionService } from '../../services/subscription.js';

/**
 * WebSocket 监控路由
 * - GET /ws/monitor/:deviceId：客户端订阅指定设备的实时截图推送
 *
 * 注意：此路由不做鉴权（MVP 简化），生产环境应通过 query 参数校验 token
 */
export default async function monitorWsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/ws/monitor/:deviceId',
    { websocket: true },
    (socket: WebSocket, request) => {
      const { deviceId } = request.params as { deviceId: string };

      // 注册订阅（subscriptionService 内部已监听 close/error 自动清理）
      subscriptionService.subscribe(deviceId, socket);

      // 接收消息：仅处理简单的 ping/pong 心跳，其他消息忽略
      socket.on('message', (message: Buffer) => {
        const text = message.toString();
        if (text === 'ping') {
          socket.send('pong');
        }
      });
    },
  );
}

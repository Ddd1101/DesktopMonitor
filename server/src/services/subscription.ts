import type { WebSocket } from '@fastify/websocket';

/**
 * 订阅服务：维护 deviceId → WebSocket 连接集合的映射
 *
 * 当 Agent 上传新截图时，调用 notifyScreenshotUploaded 向所有订阅该设备的连接推送消息
 */
export class SubscriptionService {
  // deviceId → 订阅该设备的 WebSocket 连接集合
  private subscribers: Map<string, Set<WebSocket>> = new Map();

  /**
   * 订阅指定设备的截图推送
   * @param deviceId 设备 ID
   * @param ws WebSocket 连接实例
   */
  subscribe(deviceId: string, ws: WebSocket): void {
    if (!this.subscribers.has(deviceId)) {
      this.subscribers.set(deviceId, new Set());
    }
    this.subscribers.get(deviceId)!.add(ws);

    // 连接关闭时自动清理，避免内存泄漏
    ws.on('close', () => {
      this.unsubscribe(deviceId, ws);
    });
  }

  /**
   * 取消订阅
   * @param deviceId 设备 ID
   * @param ws WebSocket 连接实例
   */
  unsubscribe(deviceId: string, ws: WebSocket): void {
    const set = this.subscribers.get(deviceId);
    if (!set) return;
    set.delete(ws);
    // 当集合为空时清理 Map 中的 key，避免无限增长
    if (set.size === 0) {
      this.subscribers.delete(deviceId);
    }
  }

  /**
   * 通知所有订阅该设备的连接：有新截图上传
   * @param deviceId 设备 ID
   * @param screenshotUrl 截图访问 URL
   */
  notifyScreenshotUploaded(deviceId: string, screenshotUrl: string): void {
    const set = this.subscribers.get(deviceId);
    if (!set || set.size === 0) return;

    const message = JSON.stringify({
      type: 'screenshot' as const,
      deviceId,
      url: screenshotUrl,
      timestamp: new Date().toISOString(),
    });

    // 向所有处于 OPEN 状态的连接推送消息
    for (const ws of set) {
      // WebSocket.OPEN === 1
      if (ws.readyState === 1) {
        try {
          ws.send(message);
        } catch {
          // 单个连接发送失败时忽略，不影响其他连接
          this.unsubscribe(deviceId, ws);
        }
      }
    }
  }
}

// 导出单例，供路由层直接使用
export const subscriptionService = new SubscriptionService();

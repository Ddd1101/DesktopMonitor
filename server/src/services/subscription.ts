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

    // 连接关闭或异常时自动清理，避免内存泄漏
    const cleanup = () => this.unsubscribe(deviceId, ws);
    ws.on('close', cleanup);
    ws.on('error', cleanup);
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
   *
   * 实现背压控制：当某连接 bufferedAmount 超过阈值时视为慢消费者，
   * 关闭连接并取消订阅，避免用户态内存无限堆积导致 OOM。
   *
   * @param deviceId 设备 ID
   * @param screenshotUrl 截图访问 URL
   * @param monitorIndex 显示器索引
   */
  notifyScreenshotUploaded(
    deviceId: string,
    screenshotUrl: string,
    monitorIndex: number = 1,
  ): void {
    const set = this.subscribers.get(deviceId);
    if (!set || set.size === 0) return;

    const message = JSON.stringify({
      type: 'screenshot' as const,
      deviceId,
      url: screenshotUrl,
      monitor_index: monitorIndex,
      timestamp: new Date().toISOString(),
    });

    // 慢消费者阈值：缓冲超过 1MB 视为消费不及，关闭连接避免内存堆积
    const MAX_BUFFERED = 1024 * 1024;

    // 向所有处于 OPEN 状态的连接推送消息
    for (const ws of set) {
      // WebSocket.OPEN === 1
      if (ws.readyState !== 1) continue;
      // 背压检测：慢消费者关闭连接
      if (ws.bufferedAmount > MAX_BUFFERED) {
        try {
          ws.close(1011, 'slow consumer');
        } catch {
          // ignore
        }
        this.unsubscribe(deviceId, ws);
        continue;
      }
      try {
        ws.send(message);
      } catch {
        // 单个连接发送失败时忽略，不影响其他连接
        this.unsubscribe(deviceId, ws);
      }
    }
  }
}

// 导出单例，供路由层直接使用
export const subscriptionService = new SubscriptionService();

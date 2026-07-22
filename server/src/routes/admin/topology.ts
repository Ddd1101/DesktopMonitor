import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { config } from '../../config/index.js';
import { verifyAdminAuth } from '../../utils/adminAuth.js';

// 预编译语句（模块级复用，避免每次请求都 prepare）
const stmtSelectAllDevicesForTopology = db.prepare(`
  SELECT device_id, hostname, ip_address, os_info,
         last_heartbeat_at, monitor_resolutions
  FROM devices
  ORDER BY created_at DESC
`);

// 设备行类型
interface DeviceRow {
  device_id: string;
  hostname: string | null;
  ip_address: string | null;
  os_info: string | null;
  last_heartbeat_at: string | null;
  monitor_resolutions: string | null;
}

/**
 * 将 last_heartbeat_at 字符串解析为毫秒时间戳
 * 心跳写入使用 dayjs 本地时间 ISO 8601 格式（YYYY-MM-DDTHH:mm:ss），
 * 因此按本地时间解析（不追加 Z），与 Date.now() 比较判定在线状态
 */
function parseHeartbeatTs(s: string | null): number {
  if (!s) return 0;
  // 兼容旧格式（空格分隔）：'YYYY-MM-DD HH:MM:SS' -> 'YYYY-MM-DDTHH:MM:SS'
  const iso = s.replace(' ', 'T');
  const ts = new Date(iso).getTime();
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * 获取本机内网 IPv4 地址
 * 过滤回环地址（127.0.0.1）与常见虚拟网卡（VMware/VirtualBox/Hyper-V/Docker/WSL 等）
 * 取首个符合条件的地址；若无匹配则回退到 '127.0.0.1'
 */
function getLocalIPv4(): string {
  const interfaces = os.networkInterfaces();
  // 虚拟网卡关键字（不区分大小写）
  const virtualKeywords = [
    'vmware',
    'virtualbox',
    'vethernet',
    'docker',
    'wsl',
    'virtual',
    'tap',
    'tunnel',
  ];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    const lowerName = name.toLowerCase();
    // 跳过明显的虚拟网卡
    if (virtualKeywords.some((kw) => lowerName.includes(kw))) continue;
    for (const addr of addrs) {
      // 仅取 IPv4，跳过回环
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * 从 ip_address 提取 C 类网段（前 3 段）
 * 例如 "192.168.1.10" -> "192.168.1"
 * 无效或空值返回 "unknown"
 */
function extractSubnet(ip: string | null): string {
  if (!ip) return 'unknown';
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return 'unknown';
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return 'unknown';
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

/**
 * 管理员拓扑数据路由
 * - GET /api/admin/topology：返回按网段分组的设备拓扑数据，含服务器自身信息
 */
export default async function adminTopologyRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/topology',
    {
      preHandler: [verifyAdminAuth],
    },
    async (request, reply) => {
      const rows = stmtSelectAllDevicesForTopology.all() as DeviceRow[];

      const now = Date.now();
      const timeoutMs = config.heartbeatTimeoutSeconds * 1000;
      let online_count = 0;

      // 按 subnet 聚合，保持插入顺序
      const groupMap = new Map<
        string,
        {
          subnet: string;
          label: string;
          devices: Array<{
            device_id: string;
            hostname: string;
            ip_address: string;
            os_info: string;
            is_online: boolean;
            last_heartbeat_at: string;
            monitor_resolutions: { width: number; height: number }[];
          }>;
        }
      >();

      for (const row of rows) {
        const lastTs = parseHeartbeatTs(row.last_heartbeat_at);
        const is_online = lastTs > 0 && now - lastTs < timeoutMs;
        if (is_online) online_count++;

        // 解析 monitor_resolutions JSON 字符串；为空或解析失败时返回空数组
        let monitor_resolutions: { width: number; height: number }[] = [];
        if (row.monitor_resolutions) {
          try {
            const parsed = JSON.parse(row.monitor_resolutions);
            if (Array.isArray(parsed)) {
              monitor_resolutions = parsed;
            }
          } catch {
            monitor_resolutions = [];
          }
        }

        const subnet = extractSubnet(row.ip_address);
        if (!groupMap.has(subnet)) {
          const label = subnet === 'unknown' ? '未知网段' : `${subnet}.0/24`;
          groupMap.set(subnet, { subnet, label, devices: [] });
        }

        groupMap.get(subnet)!.devices.push({
          device_id: row.device_id,
          hostname: row.hostname ?? '',
          ip_address: row.ip_address ?? '',
          os_info: row.os_info ?? '',
          is_online,
          last_heartbeat_at: row.last_heartbeat_at ?? '',
          monitor_resolutions,
        });
      }

      reply.send({
        server: {
          ip: getLocalIPv4(),
          hostname: os.hostname(),
          online_count,
          total_count: rows.length,
        },
        groups: Array.from(groupMap.values()),
      });
    },
  );
}

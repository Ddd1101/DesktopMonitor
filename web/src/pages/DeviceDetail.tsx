// 设备详情页：实时查看（WebSocket）+ 历史截图时间轴 + 活动事件列表
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Empty,
  Image,
  Pagination,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  getDevice,
  getDeviceEvents,
  getDeviceScreenshots,
  type ActivityEvent,
  type Device,
  type Screenshot,
} from '../api/admin';
import PlaybackPanel from '../components/PlaybackPanel';
import DeviceConfigModal from '../components/DeviceConfigModal';

const { Text, Title } = Typography;

// 分页大小
const PAGE_SIZE = 10;

// WebSocket 推送的消息结构
interface WsMessage {
  type: string;
  url?: string;
  monitor_index?: number;
  timestamp?: string;
  [key: string]: unknown;
}

// 实时截图状态（按显示器索引分组）
interface LiveScreenshot {
  url: string;
  timestamp: string;
  monitorIndex: number;
}

export default function DeviceDetail() {
  const { deviceId = '' } = useParams<{ deviceId: string }>();

  // 设备信息（通过设备列表接口筛选得到）
  const [device, setDevice] = useState<Device | null>(null);
  const [deviceLoading, setDeviceLoading] = useState(false);

  // 实时查看相关状态
  const [wsConnected, setWsConnected] = useState(false);
  // 多屏实时截图：monitorIndex → LiveScreenshot
  const [liveScreens, setLiveScreens] = useState<Map<number, LiveScreenshot>>(
    new Map(),
  );
  const [lastUpdateTime, setLastUpdateTime] = useState<string>('');
  const [screenshotCount, setScreenshotCount] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualCloseRef = useRef(false);

  // 历史截图分页
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [screenshotTotal, setScreenshotTotal] = useState(0);
  const [screenshotPage, setScreenshotPage] = useState(1);
  const [screenshotLoading, setScreenshotLoading] = useState(false);

  // 事件列表分页
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [eventTotal, setEventTotal] = useState(0);
  const [eventPage, setEventPage] = useState(1);
  const [eventLoading, setEventLoading] = useState(false);

  // 设备配置 Modal
  const [configOpen, setConfigOpen] = useState(false);

  // 加载设备信息：直接查询单设备详情，避免拉取全量列表
  const loadDevice = async () => {
    setDeviceLoading(true);
    try {
      const d = await getDevice(deviceId);
      setDevice(d);
    } catch (err) {
      console.error('加载设备信息失败', err);
    } finally {
      setDeviceLoading(false);
    }
  };

  // 加载历史截图
  const loadScreenshots = async (page: number) => {
    setScreenshotLoading(true);
    try {
      const data = await getDeviceScreenshots(deviceId, page, PAGE_SIZE);
      setScreenshots(data.items);
      setScreenshotTotal(data.total);
    } catch (err) {
      console.error('加载历史截图失败', err);
    } finally {
      setScreenshotLoading(false);
    }
  };

  // 加载活动事件
  const loadEvents = async (page: number) => {
    setEventLoading(true);
    try {
      const data = await getDeviceEvents(deviceId, page, PAGE_SIZE);
      setEvents(data.items);
      setEventTotal(data.total);
    } catch (err) {
      console.error('加载活动事件失败', err);
    } finally {
      setEventLoading(false);
    }
  };

  // 初始化加载设备信息与第一页数据
  useEffect(() => {
    loadDevice();
    loadScreenshots(1);
    loadEvents(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // 自动刷新：每 30 秒轮询设备信息、历史截图、活动事件（依赖当前页码，翻页时重建定时器）
  useEffect(() => {
    const timer = setInterval(() => {
      loadDevice();
      loadScreenshots(screenshotPage);
      loadEvents(eventPage);
    }, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, screenshotPage, eventPage]);

  // 组件卸载时清理 WebSocket 连接与定时器
  useEffect(() => {
    return () => {
      cleanupWs();
    };
  }, []);

  // 清理 WebSocket 相关资源
  const cleanupWs = () => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  };

  // 建立 WebSocket 连接（含心跳保活 + 断线重连）
  const connectWs = () => {
    manualCloseRef.current = false;

    const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/monitor/${deviceId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      setScreenshotCount(0);
      message.success('实时连接已建立');
      // 心跳保活：每 25 秒发送 ping，防止中间件超时断开
      heartbeatRef.current = setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send('ping');
        }
      }, 25_000);
    };

    ws.onmessage = (event) => {
      // pong 心跳响应，忽略
      if (event.data === 'pong') return;
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        if (msg.type === 'screenshot' && msg.url) {
          const monitorIndex = msg.monitor_index ?? 1;
          const ts = msg.timestamp || dayjs().toISOString();
          setLiveScreens((prev) => {
            const next = new Map(prev);
            next.set(monitorIndex, {
              url: msg.url!,
              timestamp: ts,
              monitorIndex,
            });
            return next;
          });
          setLastUpdateTime(ts);
          setScreenshotCount((c) => c + 1);
        }
      } catch (err) {
        console.error('解析 WebSocket 消息失败', err);
      }
    };

    ws.onerror = () => {
      // 不在此处 message.error，避免重连时刷屏
      console.error('WebSocket 连接异常');
    };

    ws.onclose = () => {
      setWsConnected(false);
      wsRef.current = null;
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      // 非用户主动关闭时自动重连（3 秒后）
      if (!manualCloseRef.current) {
        reconnectRef.current = setTimeout(() => {
          connectWs();
        }, 3_000);
      }
    };
  };

  // 切换实时查看
  const toggleWs = () => {
    // 已连接则断开
    if (wsRef.current) {
      manualCloseRef.current = true;
      cleanupWs();
      setWsConnected(false);
      setLiveScreens(new Map());
      setLastUpdateTime('');
      setScreenshotCount(0);
      return;
    }
    connectWs();
  };

  // 事件表格列定义
  const eventColumns: ColumnsType<ActivityEvent> = [
    {
      title: '应用名',
      dataIndex: 'app_name',
      key: 'app_name',
      width: 120,
    },
    {
      title: '窗口标题',
      dataIndex: 'window_title',
      key: 'window_title',
      ellipsis: true,
    },
    {
      title: '开始时间',
      dataIndex: 'started_at',
      key: 'started_at',
      width: 170,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '结束时间',
      dataIndex: 'ended_at',
      key: 'ended_at',
      width: 170,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '时长(秒)',
      dataIndex: 'duration_seconds',
      key: 'duration_seconds',
      width: 90,
    },
  ];

  return (
    <Spin spinning={deviceLoading}>
      {/* 顶部：设备信息 + 实时查看 */}
      <Card
        title={`设备详情：${deviceId}`}
        extra={
          <Space>
            <Button
              type={wsConnected ? 'default' : 'primary'}
              danger={wsConnected}
              onClick={toggleWs}
            >
              {wsConnected ? '停止实时查看' : '实时查看'}
            </Button>
            <Button onClick={() => setConfigOpen(true)}>配置</Button>
          </Space>
        }
      >
        <Space size="large" wrap>
          <Text>
            主机名：<strong>{device?.hostname || '-'}</strong>
          </Text>
          <Text>
            最后心跳：
            <strong>
              {device?.last_heartbeat_at
                ? dayjs(device.last_heartbeat_at).format('YYYY-MM-DD HH:mm:ss')
                : '-'}
            </strong>
          </Text>
          <Text>
            状态：
            {device?.is_online ? (
              <Tag color="green">在线</Tag>
            ) : (
              <Tag>离线</Tag>
            )}
          </Text>
        </Space>

        {/* 实时画面区：仅连接建立后展示 */}
        {wsConnected && (
          <div style={{ marginTop: 16 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              <Space>
                <Title level={5} style={{ margin: 0 }}>
                  实时画面
                </Title>
                <Tag color="green">
                  {liveScreens.size > 0
                    ? `${liveScreens.size} 屏`
                    : '等待中'}
                </Tag>
                <Text type="secondary">
                  已接收 {screenshotCount} 张
                </Text>
              </Space>
              {lastUpdateTime && (
                <Text type="secondary">
                  最后更新：
                  {dayjs(lastUpdateTime).format('YYYY-MM-DD HH:mm:ss')}
                </Text>
              )}
            </div>

            {liveScreens.size > 0 ? (
              <Space size={12} wrap>
                {Array.from(liveScreens.values())
                  .sort((a, b) => a.monitorIndex - b.monitorIndex)
                  .map((s) => (
                    <div key={s.monitorIndex}>
                      <img
                        src={s.url}
                        alt={`实时画面-显示器${s.monitorIndex}`}
                        style={{
                          maxWidth: '100%',
                          maxHeight: 360,
                          border: '1px solid #d9d9d9',
                          display: 'block',
                        }}
                      />
                      <Tag
                        color="geekblue"
                        style={{ marginTop: 4 }}
                      >
                        显示器 {s.monitorIndex}
                      </Tag>
                      <Text
                        type="secondary"
                        style={{ marginLeft: 8, fontSize: 12 }}
                      >
                        {dayjs(s.timestamp).format('HH:mm:ss')}
                      </Text>
                    </div>
                  ))}
              </Space>
            ) : (
              <Empty description="等待推送实时截图..." />
            )}
          </div>
        )}
      </Card>

      {/* 历史回放 */}
      <Card title="历史回放" style={{ marginTop: 16 }}>
        <PlaybackPanel deviceId={deviceId} />
      </Card>

      {/* 下方：左右分栏，左为历史截图时间轴，右为事件列表 */}
      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={24} md={12}>
          <Card title="历史截图">
            <Spin spinning={screenshotLoading}>
              {screenshots.length === 0 ? (
                <Empty description="暂无截图" />
              ) : (
                (() => {
                  // 按 taken_at 分组，同一时刻的多屏截图放在同一行
                  const groups = new Map<string, Screenshot[]>();
                  for (const s of screenshots) {
                    const key = s.taken_at;
                    if (!groups.has(key)) groups.set(key, []);
                    groups.get(key)!.push(s);
                  }
                  // 每组内按 monitor_index 升序
                  const groupList = Array.from(groups.entries()).map(
                    ([takenAt, items]) => ({
                      takenAt,
                      items: items.sort(
                        (a, b) =>
                          (a.monitor_index ?? 1) - (b.monitor_index ?? 1),
                      ),
                    }),
                  );

                  return (
                    <Timeline
                      items={groupList.map(({ takenAt, items }) => ({
                        children: (
                          <div>
                            <div style={{ marginBottom: 4 }}>
                              <Text type="secondary">
                                {dayjs(takenAt).format(
                                  'YYYY-MM-DD HH:mm:ss',
                                )}
                              </Text>
                              <Tag color="blue" style={{ marginLeft: 8 }}>
                                {items.length} 屏
                              </Tag>
                            </div>
                            <Space size={8} wrap>
                              {items.map((s) => (
                                <div key={s.id}>
                                  <Image
                                    src={s.url}
                                    width={160}
                                    alt={`历史截图-显示器${s.monitor_index ?? 1}`}
                                    style={{
                                      display: 'block',
                                      border: '1px solid #d9d9d9',
                                    }}
                                  />
                                  <Tag
                                    color="geekblue"
                                    style={{ marginTop: 4 }}
                                  >
                                    显示器 {s.monitor_index ?? 1}
                                  </Tag>
                                </div>
                              ))}
                            </Space>
                          </div>
                        ),
                      }))}
                    />
                  );
                })()
              )}
              <Pagination
                current={screenshotPage}
                pageSize={PAGE_SIZE}
                total={screenshotTotal}
                onChange={(page) => {
                  setScreenshotPage(page);
                  loadScreenshots(page);
                }}
                style={{ marginTop: 16, textAlign: 'right' }}
                showSizeChanger={false}
              />
            </Spin>
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <Card title="活动事件">
            <Table
              rowKey="id"
              columns={eventColumns}
              dataSource={events}
              loading={eventLoading}
              size="small"
              pagination={{
                current: eventPage,
                pageSize: PAGE_SIZE,
                total: eventTotal,
                onChange: (page) => {
                  setEventPage(page);
                  loadEvents(page);
                },
                showSizeChanger: false,
              }}
            />
          </Card>
        </Col>
      </Row>

      {/* 设备配置 Modal */}
      <DeviceConfigModal
        deviceId={deviceId}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
      />
    </Spin>
  );
}

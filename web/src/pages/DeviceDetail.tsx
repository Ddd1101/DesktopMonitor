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
  getDeviceEvents,
  getDeviceScreenshots,
  getDevices,
  type ActivityEvent,
  type Device,
  type Screenshot,
} from '../api/admin';

const { Text, Title } = Typography;

// 分页大小
const PAGE_SIZE = 10;

// WebSocket 推送的消息结构
interface WsMessage {
  type: string;
  url?: string;
  timestamp?: string;
  [key: string]: unknown;
}

// 实时截图状态
interface LiveScreenshot {
  url: string;
  timestamp: string;
}

export default function DeviceDetail() {
  const { deviceId = '' } = useParams<{ deviceId: string }>();

  // 设备信息（通过设备列表接口筛选得到）
  const [device, setDevice] = useState<Device | null>(null);
  const [deviceLoading, setDeviceLoading] = useState(false);

  // 实时查看相关状态
  const [wsConnected, setWsConnected] = useState(false);
  const [latestScreenshot, setLatestScreenshot] = useState<LiveScreenshot | null>(
    null,
  );
  const wsRef = useRef<WebSocket | null>(null);

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

  // 加载设备信息：从设备列表中筛选当前设备
  const loadDevice = async () => {
    setDeviceLoading(true);
    try {
      const list = await getDevices();
      setDevice(list.find((d) => d.device_id === deviceId) || null);
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

  // 组件卸载时关闭 WebSocket 连接
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // 切换实时查看：建立或关闭 WebSocket
  const toggleWs = () => {
    // 已存在连接则关闭
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
      setWsConnected(false);
      return;
    }
    // 根据当前页面协议推导 ws/wss，host 复用当前域名（vite 已代理 /ws）
    const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/monitor/${deviceId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => {
      setWsConnected(true);
      message.success('实时连接已建立');
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        // 截图类型消息：更新实时画面
        if (msg.type === 'screenshot' && msg.url) {
          setLatestScreenshot({
            url: msg.url,
            timestamp: msg.timestamp || dayjs().toISOString(),
          });
        }
      } catch (err) {
        console.error('解析 WebSocket 消息失败', err);
      }
    };
    ws.onerror = () => {
      message.error('实时连接异常');
    };
    ws.onclose = () => {
      setWsConnected(false);
      wsRef.current = null;
    };
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
          <Button
            type={wsConnected ? 'default' : 'primary'}
            danger={wsConnected}
            onClick={toggleWs}
          >
            {wsConnected ? '停止实时查看' : '实时查看'}
          </Button>
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
            <Title level={5}>实时画面</Title>
            {latestScreenshot ? (
              <div>
                <img
                  src={latestScreenshot.url}
                  alt="实时截图"
                  style={{
                    maxWidth: '100%',
                    maxHeight: 400,
                    border: '1px solid #d9d9d9',
                  }}
                />
                <div style={{ marginTop: 8 }}>
                  <Text type="secondary">
                    截图时间：
                    {dayjs(latestScreenshot.timestamp).format(
                      'YYYY-MM-DD HH:mm:ss',
                    )}
                  </Text>
                </div>
              </div>
            ) : (
              <Empty description="等待推送实时截图..." />
            )}
          </div>
        )}
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
    </Spin>
  );
}

// 设备列表页：表格展示所有设备，支持刷新与跳转详情
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Space, Spin, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { getDevices, type Device } from '../api/admin';
import DeviceConfigModal from '../components/DeviceConfigModal';

export default function Devices() {
  const navigate = useNavigate();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  // 设备配置 Modal：当前打开的设备 ID，null 表示关闭
  const [configDeviceId, setConfigDeviceId] = useState<string | null>(null);

  // 加载设备列表
  const loadDevices = async () => {
    setLoading(true);
    try {
      const data = await getDevices();
      setDevices(data);
    } catch (err) {
      // 错误提示由响应拦截器统一处理（message.error）
      console.error('加载设备列表失败', err);
    } finally {
      setLoading(false);
    }
  };

  // 进入页面时加载 + 自动刷新（每 30 秒，标签页隐藏时暂停以节省请求）
  useEffect(() => {
    loadDevices();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(loadDevices, 30_000);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // 表格列定义（useMemo 避免每次渲染重建数组导致 Table 无谓重渲染）
  const columns = useMemo<ColumnsType<Device>>(
    () => [
      {
        title: '设备ID',
        dataIndex: 'device_id',
        key: 'device_id',
      },
      {
        title: '主机名',
        dataIndex: 'hostname',
        key: 'hostname',
      },
      {
        title: '最后心跳时间',
        dataIndex: 'last_heartbeat_at',
        key: 'last_heartbeat_at',
        render: (value: string | null) =>
          value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-',
      },
      {
        title: '状态',
        dataIndex: 'is_online',
        key: 'is_online',
        render: (online: boolean) =>
          online ? <Tag color="green">在线</Tag> : <Tag>离线</Tag>,
      },
      {
        title: '操作',
        key: 'action',
        render: (_, record) => (
          <Space size={0}>
            <Button
              type="link"
              onClick={() => navigate(`/devices/${record.device_id}`)}
            >
              查看详情
            </Button>
            <Button
              type="link"
              onClick={() => setConfigDeviceId(record.device_id)}
            >
              配置
            </Button>
          </Space>
        ),
      },
    ],
    // navigate 和 setConfigDeviceId 均为稳定引用，数组实际只构建一次
    [navigate, setConfigDeviceId],
  );

  return (
    <Card
      title="设备管理"
      extra={
        <Button
          icon={<ReloadOutlined />}
          onClick={loadDevices}
          loading={loading}
        >
          刷新
        </Button>
      }
    >
      <Spin spinning={loading}>
        <Table
          rowKey="device_id"
          columns={columns}
          dataSource={devices}
          pagination={{ pageSize: 10 }}
        />
      </Spin>

      {/* 设备配置 Modal */}
      <DeviceConfigModal
        deviceId={configDeviceId ?? ''}
        open={configDeviceId !== null}
        onClose={() => setConfigDeviceId(null)}
      />
    </Card>
  );
}

// 设备列表页：表格展示所有设备，支持刷新与跳转详情
import { useEffect, useState } from 'react';
import { Button, Card, Spin, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { getDevices, type Device } from '../api/admin';

export default function Devices() {
  const navigate = useNavigate();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);

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

  // 进入页面时加载 + 自动刷新（每 30 秒）
  useEffect(() => {
    loadDevices();
    const timer = setInterval(loadDevices, 30_000);
    return () => clearInterval(timer);
  }, []);

  // 表格列定义
  const columns: ColumnsType<Device> = [
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
        <Button
          type="link"
          onClick={() => navigate(`/devices/${record.device_id}`)}
        >
          查看详情
        </Button>
      ),
    },
  ];

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
    </Card>
  );
}

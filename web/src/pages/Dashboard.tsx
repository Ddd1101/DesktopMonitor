// 数据看板：4 个统计卡片 + Top 10 应用使用时长柱状图
import { useEffect, useState } from 'react';
import { Button, Card, Col, Row, Spin, Statistic } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getDashboard, type DashboardData } from '../api/admin';

// 将秒数格式化为 "X 分钟 Y 秒"
function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes} 分钟 ${seconds} 秒`;
}

// 图表数据项
interface ChartDatum {
  app_name: string;
  total_seconds: number;
  minutes: number;
}

// 自定义 Tooltip 内容
function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartDatum }>;
}) {
  if (active && payload && payload.length > 0) {
    const item = payload[0].payload;
    return (
      <div
        style={{
          background: '#fff',
          border: '1px solid #d9d9d9',
          padding: '8px 12px',
        }}
      >
        <div style={{ fontWeight: 600 }}>{item.app_name}</div>
        <div>使用时长：{formatDuration(item.total_seconds)}</div>
      </div>
    );
  }
  return null;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);

  // 加载看板数据
  const loadData = async () => {
    setLoading(true);
    try {
      const result = await getDashboard();
      setData(result);
    } catch (err) {
      // 错误提示由响应拦截器统一处理（message.error）
      console.error('加载看板数据失败', err);
    } finally {
      setLoading(false);
    }
  };

  // 进入页面时加载
  useEffect(() => {
    loadData();
  }, []);

  // 处理图表数据：取 Top 10，并将秒转换为分钟
  const chartData: ChartDatum[] = (data?.top_apps || [])
    .slice(0, 10)
    .map((item) => ({
      app_name: item.app_name,
      total_seconds: item.total_seconds,
      minutes: Math.round((item.total_seconds / 60) * 100) / 100,
    }));

  return (
    <Card
      title="数据看板"
      extra={
        <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>
          刷新
        </Button>
      }
    >
      <Spin spinning={loading}>
        {/* 顶部 4 个统计卡片 */}
        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Card>
              <Statistic
                title="活跃设备数"
                value={data?.active_device_count ?? 0}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card>
              <Statistic
                title="今日截图数"
                value={data?.screenshot_count_today ?? 0}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card>
              <Statistic
                title="在线设备数"
                value={data?.active_device_count ?? 0}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card>
              <Statistic
                title="Top 应用数"
                value={data?.top_apps?.length ?? 0}
              />
            </Card>
          </Col>
        </Row>

        {/* Top 10 应用使用时长柱状图 */}
        <Card title="Top 10 应用使用时长" style={{ marginTop: 16 }}>
          {chartData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
              暂无数据
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={360}>
              <BarChart
                data={chartData}
                margin={{ top: 16, right: 16, bottom: 60, left: 16 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="app_name"
                  angle={-30}
                  textAnchor="end"
                  interval={0}
                />
                <YAxis unit=" 分钟" />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="minutes" fill="#1677ff" name="使用时长(分钟)" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </Spin>
    </Card>
  );
}

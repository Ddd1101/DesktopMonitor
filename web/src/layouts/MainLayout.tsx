// 全局布局：顶栏 + 侧边菜单 + 内容区
import { useMemo, useState } from 'react';
import { Layout, Menu, Button, Space, Typography, message } from 'antd';
import { DashboardOutlined, DesktopOutlined, LogoutOutlined } from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { clearToken } from '../api/client';

const { Header, Sider, Content } = Layout;
const { Title } = Typography;

// 菜单项配置
const MENU_ITEMS = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '数据看板' },
  { key: '/devices', icon: <DesktopOutlined />, label: '设备管理' },
];

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  // 当前选中的菜单项（取路径第一段以匹配子路由，如 /devices/:id）
  const selectedKey = useMemo(() => {
    const path = location.pathname;
    const top = '/' + path.split('/')[1];
    return MENU_ITEMS.some((item) => item.key === top) ? top : '/dashboard';
  }, [location.pathname]);

  // 退出登录：清除 token 并跳转登录页
  const handleLogout = () => {
    clearToken();
    message.success('已退出登录');
    navigate('/login');
  };

  // 点击菜单跳转
  const handleMenuClick = (key: string) => {
    navigate(key);
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="dark"
      >
        <div
          style={{
            height: 56,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            fontSize: collapsed ? 14 : 16,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          {collapsed ? '监控' : '桌面监控系统'}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          onClick={({ key }) => handleMenuClick(key)}
          items={MENU_ITEMS}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <Title level={4} style={{ margin: 0 }}>
            桌面监控系统
          </Title>
          <Space>
            <span>管理员</span>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              onClick={handleLogout}
            >
              退出登录
            </Button>
          </Space>
        </Header>
        <Content style={{ margin: 16, padding: 24, background: '#fff' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

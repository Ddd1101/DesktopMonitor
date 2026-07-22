// 应用路由配置：登录页 + 受保护业务路由
import { createBrowserRouter, Navigate } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import DeviceDetail from './pages/DeviceDetail';
import Topology from './pages/Topology';

// 路由表说明：
// /login                       公开路由
// /                            受保护根路由，渲染 MainLayout 作为外壳
//   /dashboard                 数据看板
//   /devices                   设备列表
//   /devices/:deviceId         设备详情
// *                            未匹配路由重定向到 /dashboard
export const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <MainLayout />
      </ProtectedRoute>
    ),
    children: [
      {
        index: true,
        element: <Navigate to="/dashboard" replace />,
      },
      {
        path: 'dashboard',
        element: <Dashboard />,
      },
      {
        path: 'devices',
        element: <Devices />,
      },
      {
        path: 'devices/:deviceId',
        element: <DeviceDetail />,
      },
      {
        path: 'topology',
        element: <Topology />,
      },
    ],
  },
  {
    path: '*',
    element: <Navigate to="/dashboard" replace />,
  },
]);

export default router;

// 路由权限守卫：未登录用户重定向到登录页
import { Navigate, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { getToken } from '../api/client';

interface ProtectedRouteProps {
  // 受保护的内容；未传时默认渲染 <Outlet /> 以适配嵌套路由
  children?: ReactNode;
}

/**
 * 鉴权路由组件
 * - 无 token：跳转登录页（replace 避免历史栈污染）
 * - 有 token：渲染 children，或默认 <Outlet /> 供嵌套子路由渲染
 */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children ?? <Outlet />}</>;
}

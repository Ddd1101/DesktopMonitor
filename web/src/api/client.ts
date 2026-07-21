// axios 实例与拦截器封装
import axios, { type AxiosError } from 'axios';
import { message } from 'antd';

// token 在 localStorage 中的键名
const TOKEN_KEY = 'admin_token';

/**
 * 保存 token 到 localStorage
 */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * 从 localStorage 读取 token
 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * 清除 localStorage 中的 token
 */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// 创建 axios 实例，baseURL 统一前缀 /api
const apiClient = axios.create({
  baseURL: '/api',
  timeout: 15000,
});

// 请求拦截器：自动携带 JWT
apiClient.interceptors.request.use(
  (config) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// 响应拦截器：统一错误处理
apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ message?: string }>) => {
    const status = error.response?.status;
    // 401：token 失效，清除并跳转登录页
    if (status === 401) {
      clearToken();
      // 避免在登录页重复跳转
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    } else {
      // 其他错误用 antd message 提示
      const msg =
        error.response?.data?.message || error.message || '请求失败，请稍后重试';
      message.error(msg);
    }
    return Promise.reject(error);
  },
);

export default apiClient;

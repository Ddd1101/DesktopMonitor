// 管理员相关 API 封装与类型定义
import apiClient from './client';

// 设备信息
export interface Device {
  device_id: string;
  hostname: string;
  last_heartbeat_at: string | null;
  created_at: string;
  is_online: boolean;
}

// 截图记录
export interface Screenshot {
  id: number;
  device_id: string;
  file_path: string;
  url: string;
  taken_at: string;
  monitor_index: number;
  created_at: string;
}

// 活动事件
export interface ActivityEvent {
  id: number;
  device_id: string;
  app_name: string;
  window_title: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
}

// 看板聚合数据
export interface DashboardData {
  active_device_count: number;
  screenshot_count_today: number;
  top_apps: Array<{ app_name: string; total_seconds: number }>;
}

// 登录返回的管理员信息
export interface AdminInfo {
  id: number;
  username: string;
}

// 登录接口返回结构
export interface LoginResult {
  token: string;
  admin: AdminInfo;
}

// 分页返回结构
export interface Paginated<T> {
  items: T[];
  total: number;
}

// 时间轴分桶聚合结果
export interface TimelineBucket {
  bucket_start: string;
  count: number;
  first_taken_at: string;
  last_taken_at: string;
}

// 回放查询返回结构（带分页元信息）
export interface PlaybackResult {
  items: Screenshot[];
  total: number;
  hasMore: boolean;
}

/**
 * 管理员登录
 */
export async function login(
  username: string,
  password: string,
): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResult>('/admin/login', {
    username,
    password,
  });
  return data;
}

/**
 * 获取设备列表
 * 服务端返回 { items: Device[] }，这里拆包返回数组以便直接用于 antd Table 的 dataSource
 */
export async function getDevices(): Promise<Device[]> {
  const { data } = await apiClient.get<{ items: Device[] }>('/admin/devices');
  return data.items ?? [];
}

/**
 * 获取单个设备详情（避免拉取全量列表后 .find() 筛选）
 */
export async function getDevice(deviceId: string): Promise<Device> {
  const { data } = await apiClient.get<Device>(
    `/admin/devices/${deviceId}`,
  );
  return data;
}

/**
 * 获取设备截图分页列表
 */
export async function getDeviceScreenshots(
  deviceId: string,
  page: number,
  pageSize: number,
): Promise<Paginated<Screenshot>> {
  const { data } = await apiClient.get<Paginated<Screenshot>>(
    `/admin/devices/${deviceId}/screenshots`,
    { params: { page, pageSize } },
  );
  return data;
}

/**
 * 获取回放截图（按时间范围，升序，支持分页）
 * 返回 PlaybackResult，包含 items/total/hasMore，便于增量加载
 */
export async function getPlaybackScreenshots(
  deviceId: string,
  startTime: string,
  endTime: string,
  limit?: number,
  offset?: number,
): Promise<PlaybackResult> {
  const { data } = await apiClient.get<PlaybackResult>(
    `/admin/devices/${deviceId}/screenshots/playback`,
    { params: { startTime, endTime, limit, offset } },
  );
  return data;
}

/**
 * 获取回放时间轴摘要（按 bucketSec 分桶聚合）
 * 用于在回放面板上绘制密度直方图，避免一次拉取全量截图
 */
export async function getPlaybackTimeline(
  deviceId: string,
  startTime: string,
  endTime: string,
  bucketSec?: number,
): Promise<TimelineBucket[]> {
  const { data } = await apiClient.get<{ items: TimelineBucket[] }>(
    `/admin/devices/${deviceId}/screenshots/timeline`,
    { params: { startTime, endTime, bucketSec } },
  );
  return data.items ?? [];
}

/**
 * 获取设备活动事件分页列表
 */
export async function getDeviceEvents(
  deviceId: string,
  page: number,
  pageSize: number,
): Promise<Paginated<ActivityEvent>> {
  const { data } = await apiClient.get<Paginated<ActivityEvent>>(
    `/admin/devices/${deviceId}/events`,
    { params: { page, pageSize } },
  );
  return data;
}

/**
 * 按时间范围查询设备活动事件（升序，最多 1000 条）
 * 复用 /events 接口，但传入 startTime/endTime 参数；用于回放面板叠加事件标记
 */
export async function getEventsByRange(
  deviceId: string,
  startTime: string,
  endTime: string,
): Promise<ActivityEvent[]> {
  const { data } = await apiClient.get<{ items: ActivityEvent[] }>(
    `/admin/devices/${deviceId}/events`,
    { params: { startTime, endTime, pageSize: 1000 } },
  );
  return data.items ?? [];
}

/**
 * 获取看板数据
 */
export async function getDashboard(): Promise<DashboardData> {
  const { data } = await apiClient.get<DashboardData>('/admin/dashboard');
  return data;
}

// 设备配置
export interface DeviceConfig {
  screenshot_quality: number;
  screenshot_max_width: number;
  screenshot_interval_sec: number;
  retention_value: number;
  retention_unit: 'hours' | 'days' | 'months' | 'years';
  updated_at: string;
}

export interface DeviceConfigResponse {
  config: DeviceConfig;
  monitor_resolutions: { width: number; height: number }[];
}

/**
 * 获取设备配置
 */
export async function getDeviceConfig(
  deviceId: string,
): Promise<DeviceConfigResponse> {
  const { data } = await apiClient.get<DeviceConfigResponse>(
    `/admin/devices/${deviceId}/config`,
  );
  return data;
}

/**
 * 更新设备配置
 */
export async function updateDeviceConfig(
  deviceId: string,
  config: Partial<DeviceConfig>,
): Promise<DeviceConfig> {
  const { data } = await apiClient.put<{ success: boolean; config: DeviceConfig }>(
    `/admin/devices/${deviceId}/config`,
    config,
  );
  return data.config;
}

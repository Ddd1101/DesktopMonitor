// 历史回放组件：按时间范围加载截图，支持播放/暂停/倍速/进度条/逐帧
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  DatePicker,
  Empty,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  PauseCircleOutlined,
  PlayCircleOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { getPlaybackScreenshots, type Screenshot } from '../api/admin';

const { Text } = Typography;
const { RangePicker } = DatePicker;

// 回放帧：同一时刻的多屏截图分组
interface PlaybackFrame {
  takenAt: string;
  items: Screenshot[];
}

// 倍速选项
const SPEED_OPTIONS = [
  { label: '0.5x', value: 0.5 },
  { label: '1x', value: 1 },
  { label: '2x', value: 2 },
  { label: '4x', value: 4 },
];

// 可见帧缓冲：当前帧前后各预读 2 帧，避免切换时重新加载/解码图片导致闪烁
// 同时避免一次性渲染所有帧（数百上千张）导致内存爆炸
const VISIBLE_BUFFER = 2;

export default function PlaybackPanel({ deviceId }: { deviceId: string }) {
  const [timeRange, setTimeRange] = useState<[Dayjs, Dayjs]>([
    dayjs().subtract(1, 'hour'),
    dayjs(),
  ]);
  const [frames, setFrames] = useState<PlaybackFrame[]>([]);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [speed, setSpeed] = useState(1);
  const playTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ref 持有最新 frames，供定时器回调读取，避免 frames 变化导致定时器重建
  const framesRef = useRef<PlaybackFrame[]>([]);

  // 加载回放数据
  const loadPlayback = useCallback(async () => {
    if (!timeRange || timeRange.length < 2) {
      message.warning('请选择时间范围');
      return;
    }
    setLoading(true);
    setPlaying(false);
    try {
      // Agent 存储的 taken_at 是本地时间无时区后缀（Python datetime.now().isoformat()）
      // 前端不能用 toISOString()（会转成 UTC），需用 format 输出本地时间
      const startTime = timeRange[0].format('YYYY-MM-DDTHH:mm:ss.SSS');
      const endTime = timeRange[1].format('YYYY-MM-DDTHH:mm:ss.SSS');
      const data = await getPlaybackScreenshots(deviceId, startTime, endTime);
      if (data.length === 0) {
        message.info('该时间范围内无截图数据');
        setFrames([]);
        return;
      }
      // 按 taken_at 分组
      const groupMap = new Map<string, Screenshot[]>();
      for (const s of data) {
        if (!groupMap.has(s.taken_at)) groupMap.set(s.taken_at, []);
        groupMap.get(s.taken_at)!.push(s);
      }
      const grouped: PlaybackFrame[] = Array.from(groupMap.entries()).map(
        ([takenAt, items]) => ({
          takenAt,
          items: items.sort(
            (a, b) => (a.monitor_index ?? 1) - (b.monitor_index ?? 1),
          ),
        }),
      );
      setFrames(grouped);
      setCurrentIdx(0);
      message.success(`已加载 ${grouped.length} 帧截图`);
    } catch (err) {
      console.error('加载回放数据失败', err);
      message.error('加载回放数据失败');
    } finally {
      setLoading(false);
    }
  }, [deviceId, timeRange]);

  // 同步 framesRef，供定时器回调读取最新帧数
  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);

  // 播放/暂停控制
  useEffect(() => {
    if (playing && framesRef.current.length > 0) {
      // 基础间隔 2 秒/帧，倍速越高间隔越短
      const interval = 2000 / speed;
      playTimerRef.current = setInterval(() => {
        setCurrentIdx((prev) => {
          if (prev >= framesRef.current.length - 1) {
            // 播放到最后一帧，自动停止
            setPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, interval);
    } else {
      if (playTimerRef.current) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    }
    return () => {
      if (playTimerRef.current) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [playing, speed]);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (playTimerRef.current) {
        clearInterval(playTimerRef.current);
      }
    };
  }, []);

  const togglePlay = () => {
    if (frames.length === 0) return;
    if (currentIdx >= frames.length - 1) {
      // 已到最后一帧，重新从头播放
      setCurrentIdx(0);
    }
    setPlaying((p) => !p);
  };

  const prevFrame = () => {
    setPlaying(false);
    setCurrentIdx((i) => Math.max(0, i - 1));
  };

  const nextFrame = () => {
    setPlaying(false);
    setCurrentIdx((i) => Math.min(frames.length - 1, i + 1));
  };

  // 只渲染当前帧 ± VISIBLE_BUFFER 范围内的帧，避免一次性挂载数千张图片导致内存爆炸
  // 预读范围内的图片在切换前已被浏览器加载解码，避免切换闪烁
  const visibleFrames = useMemo(() => {
    const start = Math.max(0, currentIdx - VISIBLE_BUFFER);
    const end = Math.min(frames.length, currentIdx + VISIBLE_BUFFER + 1);
    return frames
      .slice(start, end)
      .map((frame, i) => ({ frame, absIdx: start + i }));
  }, [frames, currentIdx]);

  return (
    <div>
      {/* 时间范围选择 + 加载按钮 */}
      <Space style={{ marginBottom: 16 }} wrap>
        <RangePicker
          showTime
          format="YYYY-MM-DD HH:mm"
          value={timeRange}
          onChange={(val) => {
            if (val && val[0] && val[1]) {
              setTimeRange([val[0], val[1]]);
            }
          }}
        />
        <Button type="primary" loading={loading} onClick={loadPlayback}>
          加载回放
        </Button>
        {frames.length > 0 && (
          <Text type="secondary">
            共 {frames.length} 帧 · 当前第 {currentIdx + 1} 帧
          </Text>
        )}
      </Space>

      <Spin spinning={loading}>
        {frames.length === 0 ? (
          <Empty description="选择时间范围并点击「加载回放」" />
        ) : (
          <>
            {/* 回放画面：只渲染当前帧 ± 2 帧缓冲，避免切换时重新加载/解码图片导致闪烁 */}
            <div style={{ marginBottom: 12 }}>
              {visibleFrames.map(({ frame, absIdx }) => (
                <div
                  key={absIdx}
                  style={{ display: absIdx === currentIdx ? 'block' : 'none' }}
                >
                  <Space size={12} wrap>
                    {frame.items.map((s) => (
                      <div key={s.monitor_index ?? 1}>
                        <img
                          src={s.url}
                          alt={`回放-显示器${s.monitor_index ?? 1}`}
                          loading={absIdx === currentIdx ? 'eager' : 'lazy'}
                          decoding="async"
                          style={{
                            maxWidth: '100%',
                            maxHeight: 320,
                            border: '1px solid #d9d9d9',
                            display: 'block',
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
                  <div style={{ marginTop: 8 }}>
                    <Text type="secondary">
                      截图时间：
                      {dayjs(frame.takenAt).format(
                        'YYYY-MM-DD HH:mm:ss',
                      )}
                    </Text>
                  </div>
                </div>
              ))}
            </div>

            {/* 播放控制栏 */}
            <Space style={{ marginBottom: 8 }}>
              <Button
                icon={<StepBackwardOutlined />}
                onClick={prevFrame}
                disabled={currentIdx === 0}
              />
              <Button
                type="primary"
                icon={
                  playing ? (
                    <PauseCircleOutlined />
                  ) : (
                    <PlayCircleOutlined />
                  )
                }
                onClick={togglePlay}
              >
                {playing ? '暂停' : '播放'}
              </Button>
              <Button
                icon={<StepForwardOutlined />}
                onClick={nextFrame}
                disabled={currentIdx >= frames.length - 1}
              />
              <Select
                value={speed}
                onChange={setSpeed}
                options={SPEED_OPTIONS}
                style={{ width: 80 }}
              />
            </Space>

            {/* 进度条 */}
            <input
              type="range"
              min={0}
              max={frames.length - 1}
              value={currentIdx}
              onChange={(e) => {
                setPlaying(false);
                setCurrentIdx(Number(e.target.value));
              }}
              style={{ width: '100%', cursor: 'pointer' }}
            />
          </>
        )}
      </Spin>
    </div>
  );
}

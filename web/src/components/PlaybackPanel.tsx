// 历史回放组件：按时间范围加载截图，支持播放/暂停/倍速/进度条/逐帧/事件联动
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Col,
  DatePicker,
  Empty,
  Image,
  Radio,
  Result,
  Row,
  Select,
  Skeleton,
  Slider,
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
import {
  getEventsByRange,
  getPlaybackScreenshots,
  getPlaybackTimeline,
  type ActivityEvent,
  type Screenshot,
  type TimelineBucket,
} from '../api/admin';

const { Text } = Typography;
const { RangePicker } = DatePicker;

// 回放帧：同一时刻的多屏截图分组
interface PlaybackFrame {
  takenAt: string;
  items: Screenshot[];
}

type PlayMode = 'fixed' | 'realtime';
type DisplayMode = 'side-by-side' | 'focus';

// 倍速选项
const SPEED_OPTIONS = [
  { label: '0.5x', value: 0.5 },
  { label: '1x', value: 1 },
  { label: '2x', value: 2 },
  { label: '4x', value: 4 },
];

const PLAY_MODE_OPTIONS = [
  { label: '固定间隔', value: 'fixed' as PlayMode },
  { label: '真实时间', value: 'realtime' as PlayMode },
];

// 可见帧缓冲：当前帧前后各预读 5 帧，避免切换时重新加载/解码图片导致闪烁
const VISIBLE_BUFFER = 5;

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [minutes.toString().padStart(2, '0'), seconds.toString().padStart(2, '0')];
  if (hours > 0) {
    parts.unshift(hours.toString());
  }
  return parts.join(':');
}

export default function PlaybackPanel({ deviceId }: { deviceId: string }) {
  const [timeRange, setTimeRange] = useState<[Dayjs, Dayjs]>([
    dayjs().subtract(1, 'hour'),
    dayjs(),
  ]);
  const [frames, setFrames] = useState<PlaybackFrame[]>([]);
  const [timeline, setTimeline] = useState<TimelineBucket[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [pendingIdx, setPendingIdx] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [playMode, setPlayMode] = useState<PlayMode>('fixed');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('side-by-side');
  const [focusMonitor, setFocusMonitor] = useState<number | undefined>(undefined);
  const [windowHeight, setWindowHeight] = useState(window.innerHeight);
  const [loadedKeys, setLoadedKeys] = useState<Set<string>>(new Set());

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventItemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const togglePlayRef = useRef<() => void>(() => {});
  const prevFrameRef = useRef<() => void>(() => {});
  const nextFrameRef = useRef<() => void>(() => {});
  const goFirstRef = useRef<() => void>(() => {});
  const goLastRef = useRef<() => void>(() => {});

  // 加载回放数据（同时拉取全部分页）
  const loadPlayback = useCallback(
    async (range: [Dayjs, Dayjs]) => {
      setLoading(true);
      setError(false);
      setPlaying(false);
      setFrames([]);
      setTimeline([]);
      setEvents([]);
      setCurrentIdx(0);
      setPendingIdx(null);
      setFocusMonitor(undefined);

      try {
        const startTime = range[0].format('YYYY-MM-DDTHH:mm:ss.SSS');
        const endTime = range[1].format('YYYY-MM-DDTHH:mm:ss.SSS');

        const allItems: Screenshot[] = [];
        let offset = 0;
        const limit = 1000;
        while (true) {
          const { items, hasMore } = await getPlaybackScreenshots(
            deviceId,
            startTime,
            endTime,
            limit,
            offset,
          );
          allItems.push(...items);
          if (!hasMore) break;
          offset += items.length;
          if (items.length === 0) break;
        }

        const groupMap = new Map<string, Screenshot[]>();
        for (const s of allItems) {
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

        // 加载成功后并发拉取时间轴与事件
        Promise.all([
          getPlaybackTimeline(deviceId, startTime, endTime),
          getEventsByRange(deviceId, startTime, endTime),
        ])
          .then(([tl, ev]) => {
            setTimeline(tl);
            setEvents(
              [...ev].sort((a, b) => a.started_at.localeCompare(b.started_at)),
            );
          })
          .catch((err) => {
            console.error('加载时间轴或事件失败', err);
          });

        if (grouped.length === 0) {
          message.info('该时间范围内无截图数据');
        }
      } catch (err) {
        console.error('加载回放数据失败', err);
        setError(true);
        message.error('加载回放数据失败');
      } finally {
        setLoading(false);
      }
    },
    [deviceId],
  );

  // deviceId 变化时重置状态并加载默认最近 1 小时
  useEffect(() => {
    const defaultRange: [Dayjs, Dayjs] = [
      dayjs().subtract(1, 'hour'),
      dayjs(),
    ];
    setTimeRange(defaultRange);
    setFrames([]);
    setTimeline([]);
    setEvents([]);
    setCurrentIdx(0);
    setPendingIdx(null);
    setPlaying(false);
    setError(false);
    setDisplayMode('side-by-side');
    setFocusMonitor(undefined);
    loadPlayback(defaultRange);
  }, [deviceId, loadPlayback]);

  // 窗口高度监听
  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 聚焦模式下确保当前帧包含选中的显示器
  useEffect(() => {
    const frame = frames[currentIdx];
    if (!frame) return;
    if (!frame.items.some((s) => s.monitor_index === focusMonitor)) {
      setFocusMonitor(frame.items[0]?.monitor_index);
    }
  }, [frames, currentIdx, focusMonitor]);

  // 播放控制函数
  const togglePlay = () => {
    if (frames.length === 0) return;
    if (currentIdx >= frames.length - 1) {
      setCurrentIdx(0);
      setPlaying(true);
    } else {
      setPlaying((p) => !p);
    }
  };

  const prevFrame = () => {
    setPlaying(false);
    setCurrentIdx((i) => Math.max(0, i - 1));
    setPendingIdx(null);
  };

  const nextFrame = () => {
    setPlaying(false);
    setCurrentIdx((i) => Math.min(frames.length - 1, i + 1));
    setPendingIdx(null);
  };

  const goFirst = () => {
    setPlaying(false);
    setCurrentIdx(0);
    setPendingIdx(null);
  };

  const goLast = () => {
    setPlaying(false);
    setCurrentIdx(frames.length - 1);
    setPendingIdx(null);
  };

  togglePlayRef.current = togglePlay;
  prevFrameRef.current = prevFrame;
  nextFrameRef.current = nextFrame;
  goFirstRef.current = goFirst;
  goLastRef.current = goLast;

  // 键盘快捷键
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (e.key === ' ') {
        e.preventDefault();
        togglePlayRef.current();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prevFrameRef.current();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        nextFrameRef.current();
      } else if (e.key === 'Home') {
        e.preventDefault();
        goFirstRef.current();
      } else if (e.key === 'End') {
        e.preventDefault();
        goLastRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 播放定时器
  useEffect(() => {
    if (!playing || frames.length === 0 || currentIdx >= frames.length - 1) {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    if (playMode === 'fixed') {
      const interval = 2000 / speed;
      timerRef.current = window.setInterval(() => {
        setCurrentIdx((prev) => {
          const nextIdx = prev + 1;
          if (nextIdx >= frames.length - 1) {
            setPlaying(false);
            return frames.length - 1;
          }
          return nextIdx;
        });
      }, interval);
    } else {
      const scheduleNext = (idx: number) => {
        if (idx >= frames.length - 1) return;
        const currentFrame = frames[idx];
        const nextFrame = frames[idx + 1];
        const delay = Math.min(
          2000,
          Math.max(
            100,
            dayjs(nextFrame.takenAt).diff(dayjs(currentFrame.takenAt)) / speed,
          ),
        );
        timerRef.current = window.setTimeout(() => {
          setCurrentIdx((prev) => {
            const nextIdx = Math.min(prev + 1, frames.length - 1);
            if (nextIdx >= frames.length - 1) {
              setPlaying(false);
            }
            return nextIdx;
          });
        }, delay);
      };
      scheduleNext(currentIdx);
    }

    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [playing, playMode, speed, frames, currentIdx]);

  // 当前帧相关计算
  const currentFrame = frames[currentIdx];
  const firstFrame = frames[0];
  const lastFrame = frames[frames.length - 1];

  const totalDurationMs = useMemo(() => {
    if (!firstFrame || !lastFrame) return 0;
    return dayjs(lastFrame.takenAt).diff(dayjs(firstFrame.takenAt));
  }, [firstFrame, lastFrame]);

  const playedDurationMs = useMemo(() => {
    if (!firstFrame || !currentFrame) return 0;
    return dayjs(currentFrame.takenAt).diff(dayjs(firstFrame.takenAt));
  }, [firstFrame, currentFrame]);

  const currentIndicatorRatio = useMemo(() => {
    if (!firstFrame || !lastFrame || frames.length <= 1) return null;
    const total = dayjs(lastFrame.takenAt).diff(dayjs(firstFrame.takenAt));
    if (total <= 0) return 0;
    const current = dayjs(currentFrame.takenAt).diff(dayjs(firstFrame.takenAt));
    return Math.min(1, Math.max(0, current / total));
  }, [firstFrame, lastFrame, currentFrame, frames.length]);

  // 可见帧缓冲
  const visibleFrames = useMemo(() => {
    const start = Math.max(0, currentIdx - VISIBLE_BUFFER);
    const end = Math.min(frames.length, currentIdx + VISIBLE_BUFFER + 1);
    return frames
      .slice(start, end)
      .map((frame, i) => ({ frame, absIdx: start + i }));
  }, [frames, currentIdx]);

  // 当前可见图片的 key 集合，用于控制加载 Spin
  const visibleKeys = useMemo(() => {
    const set = new Set<string>();
    for (const { frame, absIdx } of visibleFrames) {
      for (const s of frame.items) {
        set.add(`${absIdx}-${s.monitor_index}`);
      }
    }
    return set;
  }, [visibleFrames]);

  useEffect(() => {
    setLoadedKeys((prev) => {
      const next = new Set<string>();
      for (const key of prev) {
        if (visibleKeys.has(key)) next.add(key);
      }
      return next;
    });
  }, [visibleKeys]);

  // 当前高亮事件
  const activeEventId = useMemo(() => {
    if (!currentFrame) return null;
    const t = currentFrame.takenAt;
    const ev = events.find(
      (e) => t >= e.started_at && t <= e.ended_at,
    );
    return ev?.id ?? null;
  }, [currentFrame, events]);

  useEffect(() => {
    if (activeEventId == null) return;
    const el = eventItemRefs.current.get(activeEventId);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeEventId]);

  const applyPreset = (start: Dayjs, end: Dayjs) => {
    const range: [Dayjs, Dayjs] = [start, end];
    setTimeRange(range);
    loadPlayback(range);
  };

  const handleRangeChange = (val: [Dayjs | null, Dayjs | null] | null) => {
    if (val?.[0] && val?.[1]) {
      const range: [Dayjs, Dayjs] = [val[0], val[1]];
      setTimeRange(range);
      loadPlayback(range);
    }
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!firstFrame || !lastFrame || frames.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const total = dayjs(lastFrame.takenAt).diff(dayjs(firstFrame.takenAt));
    const targetTime = dayjs(firstFrame.takenAt).add(total * ratio, 'ms');

    let nearestIdx = 0;
    let minDiff = Infinity;
    frames.forEach((frame, idx) => {
      const diff = Math.abs(dayjs(frame.takenAt).diff(targetTime));
      if (diff < minDiff) {
        minDiff = diff;
        nearestIdx = idx;
      }
    });

    setPlaying(false);
    setCurrentIdx(nearestIdx);
    setPendingIdx(null);
  };

  const copyTimestamp = async () => {
    if (!currentFrame) return;
    const text = dayjs(currentFrame.takenAt).format('YYYY-MM-DD HH:mm:ss');
    try {
      await navigator.clipboard.writeText(text);
      message.success('时间戳已复制');
    } catch {
      message.error('复制失败');
    }
  };

  const mainHeight = Math.min(windowHeight * 0.6, 720);
  const sideBySideMaxHeight = Math.min(windowHeight * 0.4, 400);

  const timelineTotalCount = useMemo(
    () => timeline.reduce((sum, b) => sum + b.count, 0),
    [timeline],
  );
  const timelineMaxCount = useMemo(
    () => timeline.reduce((max, b) => Math.max(max, b.count), 0) || 1,
    [timeline],
  );

  const renderImage = (s: Screenshot, absIdx: number, height?: number) => {
    const key = `${absIdx}-${s.monitor_index}`;
    const loaded = loadedKeys.has(key);
    return (
      <div key={key} style={{ position: 'relative', display: 'inline-block' }}>
        {!loaded && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255,255,255,0.8)',
              zIndex: 1,
            }}
          >
            <Spin size="small" />
          </div>
        )}
        <Image
          src={s.url}
          alt={`回放-显示器${s.monitor_index ?? 1}`}
          style={{
            display: 'block',
            border: '1px solid #d9d9d9',
            maxWidth: '100%',
            maxHeight: height,
          }}
          loading={absIdx === currentIdx ? 'eager' : 'lazy'}
          onLoad={() =>
            setLoadedKeys((prev) => new Set([...Array.from(prev), key]))
          }
          onError={() =>
            setLoadedKeys((prev) => new Set([...Array.from(prev), key]))
          }
        />
        <Tag color="geekblue" style={{ marginTop: 4 }}>
          显示器 {s.monitor_index ?? 1}
        </Tag>
      </div>
    );
  };

  const renderThumbnail = (s: Screenshot, absIdx: number) => {
    const key = `${absIdx}-${s.monitor_index}`;
    const loaded = loadedKeys.has(key);
    const active = focusMonitor === s.monitor_index;
    return (
      <div
        key={key}
        onClick={() => {
          setPlaying(false);
          setFocusMonitor(s.monitor_index);
        }}
        style={{
          position: 'relative',
          cursor: 'pointer',
          border: `2px solid ${active ? '#1677ff' : 'transparent'}`,
          borderRadius: 4,
          padding: 2,
        }}
      >
        {!loaded && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255,255,255,0.8)',
              zIndex: 1,
            }}
          >
            <Spin size="small" />
          </div>
        )}
        <Image
          src={s.url}
          alt={`缩略图-显示器${s.monitor_index ?? 1}`}
          preview={false}
          width={80}
          style={{ display: 'block' }}
          onLoad={() =>
            setLoadedKeys((prev) => new Set([...Array.from(prev), key]))
          }
          onError={() =>
            setLoadedKeys((prev) => new Set([...Array.from(prev), key]))
          }
        />
        <Tag color="geekblue" style={{ marginTop: 2, display: 'block' }}>
          显示器 {s.monitor_index ?? 1}
        </Tag>
      </div>
    );
  };

  return (
    <div>
      {/* 时间范围选择 + 快捷预设 */}
      <Space style={{ marginBottom: 16 }} wrap>
        <RangePicker
          showTime
          format="YYYY-MM-DD HH:mm"
          value={timeRange}
          onChange={(val) =>
            handleRangeChange(val as [Dayjs | null, Dayjs | null] | null)
          }
        />
        <Button
          onClick={() =>
            applyPreset(dayjs().subtract(1, 'hour'), dayjs())
          }
        >
          最近1小时
        </Button>
        <Button
          onClick={() =>
            applyPreset(dayjs().startOf('day'), dayjs().endOf('day'))
          }
        >
          今天
        </Button>
        <Button
          onClick={() =>
            applyPreset(
              dayjs().subtract(1, 'day').startOf('day'),
              dayjs().subtract(1, 'day').endOf('day'),
            )
          }
        >
          昨天
        </Button>
        <Button
          onClick={() =>
            applyPreset(dayjs().subtract(6, 'hour'), dayjs())
          }
        >
          最近6小时
        </Button>
      </Space>

      {/* 主内容区 + 事件侧栏 */}
      <Row gutter={16}>
        <Col flex="auto">
          {loading && <Skeleton active avatar paragraph={{ rows: 2 }} />}

          {!loading && error && (
            <Result
              status="error"
              title="加载失败"
              subTitle="无法获取回放数据，请检查网络或时间范围后重试"
              extra={
                <Button type="primary" onClick={() => loadPlayback(timeRange)}>
                  重试
                </Button>
              }
            />
          )}

          {!loading && !error && frames.length === 0 && (
            <Empty description="该时段无截图">
              <Button
                type="primary"
                onClick={() => {
                  const range: [Dayjs, Dayjs] = [
                    dayjs().subtract(24, 'hour'),
                    dayjs(),
                  ];
                  setTimeRange(range);
                  loadPlayback(range);
                }}
              >
                尝试查看最近 24 小时
              </Button>
            </Empty>
          )}

          {!loading && !error && frames.length > 0 && (
            <>
              {/* 数据密度时间轴 */}
              {timelineTotalCount > 0 && (
                <div
                  onClick={handleTimelineClick}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    height: 24,
                    background: '#f0f0f0',
                    borderRadius: 4,
                    overflow: 'hidden',
                    cursor: 'pointer',
                    marginBottom: 12,
                  }}
                >
                  {timeline.map((bucket, idx) => (
                    <div
                      key={idx}
                      title={`${bucket.bucket_start} 共 ${bucket.count} 张`}
                      style={{
                        height: '100%',
                        width: `${(bucket.count / timelineTotalCount) * 100}%`,
                        backgroundColor: `rgba(22,119,255,${
                          0.2 + 0.8 * (bucket.count / timelineMaxCount)
                        })`,
                      }}
                    />
                  ))}
                  {currentIndicatorRatio != null && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        width: 2,
                        backgroundColor: '#f5222d',
                        left: `${currentIndicatorRatio * 100}%`,
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                </div>
              )}

              {/* 画面展示区 */}
              <div style={{ marginBottom: 12 }}>
                {visibleFrames.map(({ frame, absIdx }) => (
                  <div
                    key={absIdx}
                    style={{
                      display: absIdx === currentIdx ? 'block' : 'none',
                    }}
                  >
                    {displayMode === 'side-by-side' ? (
                      <Image.PreviewGroup>
                        <Space size={12} wrap>
                          {frame.items.map((s) =>
                            renderImage(s, absIdx, sideBySideMaxHeight),
                          )}
                        </Space>
                      </Image.PreviewGroup>
                    ) : (
                      <div style={{ display: 'flex', gap: 16 }}>
                        <div style={{ flex: 1 }}>
                          {(() => {
                            const mainItem =
                              frame.items.find(
                                (s) => s.monitor_index === focusMonitor,
                              ) ?? frame.items[0];
                            return mainItem
                              ? renderImage(mainItem, absIdx, mainHeight)
                              : null;
                          })()}
                        </div>
                        <Space direction="vertical" size={8} align="center">
                          {frame.items.map((s) => renderThumbnail(s, absIdx))}
                        </Space>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* 当前帧信息与帧数 */}
              <Space style={{ marginBottom: 8 }} wrap>
                <Tag color="blue" style={{ cursor: 'pointer' }} onClick={copyTimestamp}>
                  {currentFrame
                    ? dayjs(currentFrame.takenAt).format('YYYY-MM-DD HH:mm:ss')
                    : '-'}
                </Tag>
                <Text type="secondary">
                  共 {frames.length} 帧 · 当前第 {currentIdx + 1} 帧
                </Text>
              </Space>

              {/* 播放控制栏 */}
              <Space style={{ marginBottom: 8 }} wrap>
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
                <Select<PlayMode>
                  value={playMode}
                  onChange={setPlayMode}
                  options={PLAY_MODE_OPTIONS}
                  style={{ width: 110 }}
                />
                <Radio.Group
                  value={displayMode}
                  onChange={(e) =>
                    setDisplayMode(e.target.value as DisplayMode)
                  }
                  options={[
                    { label: '并排', value: 'side-by-side' },
                    { label: '聚焦', value: 'focus' },
                  ]}
                  optionType="button"
                  buttonStyle="solid"
                />
                <Text type="secondary">
                  {formatDuration(playedDurationMs)} /{' '}
                  {formatDuration(totalDurationMs)}
                </Text>
              </Space>

              {/* 进度条 */}
              <Slider
                min={0}
                max={frames.length - 1}
                value={pendingIdx ?? currentIdx}
                tooltip={{
                  formatter: (value) =>
                    dayjs(frames[value ?? currentIdx].takenAt).format(
                      'YYYY-MM-DD HH:mm:ss',
                    ),
                }}
                onChange={(value) => setPendingIdx(value)}
                onAfterChange={(value) => {
                  setPlaying(false);
                  setCurrentIdx(value);
                  setPendingIdx(null);
                }}
              />

              <Text type="secondary" style={{ fontSize: 12 }}>
                Space 播放/暂停 · ←→ 逐帧 · Home/End 跳首末
              </Text>
            </>
          )}
        </Col>

        {!loading && !error && frames.length > 0 && (
          <Col xs={24} md={{ flex: '320px' }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>活动事件</div>
            <div
              style={{
                maxHeight: 'calc(100vh - 240px)',
                overflowY: 'auto',
              }}
            >
              {events.length === 0 ? (
                <Text type="secondary">该时段无事件</Text>
              ) : (
                events.map((event) => (
                  <div
                    key={event.id}
                    ref={(el) => {
                      if (el) {
                        eventItemRefs.current.set(event.id, el);
                      } else {
                        eventItemRefs.current.delete(event.id);
                      }
                    }}
                    style={{
                      padding: '8px 12px',
                      borderBottom: '1px solid #f0f0f0',
                      backgroundColor:
                        activeEventId === event.id ? '#e6f7ff' : undefined,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{event.app_name}</div>
                    <div
                      style={{
                        fontSize: 12,
                        color: '#595959',
                        marginBottom: 4,
                      }}
                    >
                      {event.window_title || '-'}
                    </div>
                    <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                      {dayjs(event.started_at).format('YYYY-MM-DD HH:mm:ss')} -{' '}
                      {dayjs(event.ended_at).format('YYYY-MM-DD HH:mm:ss')}
                    </div>
                  </div>
                ))
              )}
            </div>
          </Col>
        )}
      </Row>
    </div>
  );
}

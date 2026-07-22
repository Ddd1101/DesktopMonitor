// 网络拓扑页：赛博朋克 NOC 风格 —— 深空背景 / 霓虹节点 / HUD 面板 / 扫描线氛围
import { useEffect, useRef, useState } from 'react';
import { Button, Spin, Empty } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Graph } from '@antv/g6';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { getTopology, type TopologyData } from '../api/admin';

// ─── 调色板 ───────────────────────────────────────────────
const C = {
  void: '#060912',
  panel: 'rgba(13, 20, 36, 0.72)',
  panelSolid: '#0d1424',
  cyan: '#00e5ff',
  cyanDim: 'rgba(0, 229, 255, 0.18)',
  green: '#39ff14',
  greenGlow: 'rgba(57, 255, 20, 0.45)',
  red: '#ff3860',
  amber: '#ffb800',
  text: '#e6f1ff',
  textDim: '#7a8ba8',
  border: 'rgba(0, 229, 255, 0.22)',
};

const FONT_DISPLAY = "'Orbitron', 'JetBrains Mono', monospace";
const FONT_MONO = "'JetBrains Mono', 'Courier New', monospace";

// ─── 关键帧与样式（组件内注入，随组件卸载而失效）────────
const PAGE_STYLES = `
  @keyframes topo-fade-up {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes topo-scan {
    0%   { transform: translateY(-100%); opacity: 0; }
    8%   { opacity: 0.55; }
    92%  { opacity: 0.55; }
    100% { transform: translateY(100%); opacity: 0; }
  }
  @keyframes topo-pulse {
    0%, 100% { opacity: 0.85; }
    50%      { opacity: 1; }
  }
  @keyframes topo-blink {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.25; }
  }
  .topo-root { animation: topo-fade-up 0.5s ease-out both; }
  .topo-stat { animation: topo-fade-up 0.6s ease-out both; }
  .topo-pulse-dot { animation: topo-pulse 1.8s ease-in-out infinite; }
  .topo-blink { animation: topo-blink 1.4s steps(2) infinite; }
  .topo-refresh-btn {
    background: rgba(0, 229, 255, 0.08) !important;
    border: 1px solid ${C.cyanDim} !important;
    color: ${C.cyan} !important;
    font-family: ${FONT_MONO} !important;
    letter-spacing: 0.08em !important;
    text-transform: uppercase !important;
    font-size: 12px !important;
  }
  .topo-refresh-btn:hover {
    background: rgba(0, 229, 255, 0.18) !important;
    box-shadow: 0 0 16px ${C.cyanDim} !important;
  }
`;

// HUD 角标：四个角落的 L 形装饰
function CornerBrackets({ color = C.cyan }: { color?: string }) {
  const s: React.CSSProperties = {
    position: 'absolute',
    width: 14,
    height: 14,
    borderColor: color,
    pointerEvents: 'none',
  };
  return (
    <>
      <span style={{ ...s, top: -1, left: -1, borderTop: `2px solid ${color}`, borderLeft: `2px solid ${color}` }} />
      <span style={{ ...s, top: -1, right: -1, borderTop: `2px solid ${color}`, borderRight: `2px solid ${color}` }} />
      <span style={{ ...s, bottom: -1, left: -1, borderBottom: `2px solid ${color}`, borderLeft: `2px solid ${color}` }} />
      <span style={{ ...s, bottom: -1, right: -1, borderBottom: `2px solid ${color}`, borderRight: `2px solid ${color}` }} />
    </>
  );
}

// 单个 HUD 统计读数面板
function StatReadout({
  label,
  value,
  color,
  delay,
  unit,
}: {
  label: string;
  value: number | string;
  color: string;
  delay: number;
  unit?: string;
}) {
  return (
    <div
      className="topo-stat"
      style={{
        position: 'relative',
        flex: 1,
        background: C.panel,
        border: `1px solid ${C.border}`,
        padding: '14px 18px',
        backdropFilter: 'blur(4px)',
        animationDelay: `${delay}ms`,
        overflow: 'hidden',
      }}
    >
      <CornerBrackets color={C.cyan} />
      {/* 顶部细线 */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg, transparent, ${color}, transparent)`, opacity: 0.6 }} />
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.2em', color: C.textDim, textTransform: 'uppercase', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 34, color, textShadow: `0 0 18px ${color}99`, lineHeight: 1 }}>
          {value}
        </span>
        {unit && <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.textDim, textTransform: 'uppercase' }}>{unit}</span>}
      </div>
      {/* 左侧色条 */}
      <span style={{ position: 'absolute', left: 0, top: '20%', bottom: '20%', width: 2, background: color, opacity: 0.7, boxShadow: `0 0 10px ${color}` }} />
    </div>
  );
}

export default function Topology() {
  const navigate = useNavigate();
  const [data, setData] = useState<TopologyData | null>(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await getTopology();
      setData(result);
    } catch (err) {
      console.error('加载拓扑数据失败', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!data || !containerRef.current) return;

    const serverNode = {
      id: 'server',
      data: {
        isServer: true,
        label: data.server.hostname,
        hostname: data.server.hostname,
        ip_address: data.server.ip,
      },
    };

    const combos = data.groups.map((g) => ({
      id: `combo-${g.subnet}`,
      data: { label: g.label, subnet: g.subnet },
    }));

    const deviceNodes = data.groups.flatMap((g) =>
      g.devices.map((d, idx) => ({
        id: d.device_id,
        combo: `combo-${g.subnet}`,
        data: {
          isServer: false,
          is_online: d.is_online,
          label: `${d.hostname}\n${d.ip_address}`,
          hostname: d.hostname,
          ip_address: d.ip_address,
          os_info: d.os_info,
          last_heartbeat_at: d.last_heartbeat_at,
          monitor_resolutions: d.monitor_resolutions,
          sort: idx,
        },
      })),
    );

    const edges = data.groups.map((g) => ({
      source: 'server',
      target: `combo-${g.subnet}`,
    }));

    const graph = new Graph({
      container: containerRef.current,
      width: containerRef.current.clientWidth || 800,
      height: containerRef.current.clientHeight || 600,
      autoFit: 'view',
      background: C.void,
      data: { nodes: [serverNode, ...deviceNodes], edges, combos },
      node: {
        type: 'rect',
        style: (d) => {
          const isServer = !!d.data?.isServer;
          const isOnline = !!d.data?.is_online;
          if (isServer) {
            return {
              size: [180, 58],
              fill: '#1a1208',
              stroke: C.amber,
              lineWidth: 2,
              radius: 4,
              shadowColor: C.amber,
              shadowBlur: 24,
              labelText: (d.data?.label as string) || d.id,
              labelFill: C.amber,
              labelFontSize: 14,
              labelFontWeight: 700,
              labelFontFamily: FONT_DISPLAY,
              labelLineHeight: 16,
            };
          }
          const accent = isOnline ? C.green : C.red;
          return {
            size: [150, 44],
            fill: '#0a1018',
            stroke: accent,
            lineWidth: isOnline ? 1.6 : 1.2,
            lineDash: isOnline ? undefined : [4, 3],
            radius: 3,
            shadowColor: isOnline ? C.greenGlow : 'transparent',
            shadowBlur: isOnline ? 14 : 0,
            labelText: (d.data?.label as string) || d.id,
            labelFill: isOnline ? C.green : C.textDim,
            labelFontSize: 11,
            labelFontWeight: 500,
            labelFontFamily: FONT_MONO,
            labelLineHeight: 13,
          };
        },
      },
      edge: {
        type: 'line',
        style: {
          stroke: C.cyanDim,
          lineWidth: 1,
        },
      },
      combo: {
        type: 'rect',
        style: {
          fill: 'rgba(0, 229, 255, 0.03)',
          stroke: C.cyanDim,
          lineWidth: 1,
          lineDash: [6, 4],
          radius: 6,
          labelText: (d: { data?: { label?: string } }) => `▣ ${d.data?.label ?? ''}`,
          labelFontSize: 12,
          labelFill: C.cyan,
          labelFontWeight: 700,
          labelFontFamily: FONT_MONO,
          labelPosition: 'top',
        },
      },
      layout: { type: 'grid', sortBy: 'data.sort' },
      behaviors: ['drag-element', 'drag-canvas', 'zoom-canvas', 'click-select'],
      plugins: [
        {
          type: 'tooltip',
          getContent: (
            _e: unknown,
            items: Array<{ data?: Record<string, unknown> }>,
          ) => {
            const item = items[0];
            if (!item) return '';
            const d = (item.data || {}) as Record<string, unknown>;
            const isServer = d.isServer as boolean;
            const hostname = (d.hostname as string) || '-';
            const ip = (d.ip_address as string) || '-';
            const osInfo = (d.os_info as string) || '-';
            const isOnline = d.is_online as boolean;
            const lastHeartbeat = d.last_heartbeat_at as string | undefined;
            const resolutions = d.monitor_resolutions as
              | { width: number; height: number }[]
              | undefined;
            const resolutionText =
              resolutions && resolutions.length > 0
                ? resolutions.map((r) => `${r.width}×${r.height}`).join(', ')
                : '-';
            const statusText = isServer ? 'SERVER' : isOnline ? 'ONLINE' : 'OFFLINE';
            const statusColor = isServer ? C.amber : isOnline ? C.green : C.red;
            const heartbeatText = lastHeartbeat
              ? dayjs(lastHeartbeat).format('YYYY-MM-DD HH:mm:ss')
              : '-';
            return `<div style="padding:10px 14px;font-family:${FONT_MONO};font-size:11px;line-height:1.9;background:${C.panelSolid};border:1px solid ${C.border};min-width:200px;">
              <div style="font-family:${FONT_DISPLAY};font-weight:700;font-size:13px;color:${C.cyan};margin-bottom:6px;border-bottom:1px solid ${C.border};padding-bottom:5px;letter-spacing:0.05em;">${hostname}</div>
              <div style="color:${C.textDim};">IP <span style="color:${C.text};float:right;">${ip}</span></div>
              <div style="color:${C.textDim};">OS <span style="color:${C.text};float:right;">${osInfo}</span></div>
              <div style="color:${C.textDim};">STATE <span style="color:${statusColor};float:right;font-weight:700;">${statusText}</span></div>
              ${isServer ? '' : `<div style="color:${C.textDim};">PULSE <span style="color:${C.text};float:right;">${heartbeatText}</span></div>`}
              ${isServer ? '' : `<div style="color:${C.textDim};">DISPLAY <span style="color:${C.text};float:right;">${resolutionText}</span></div>`}
            </div>`;
          },
        },
      ],
    });

    graphRef.current = graph;

    graph.render().then(() => {
      graph.fitView();
      // 字体加载后重绘以正确渲染 Orbitron / JetBrains Mono
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          if (graphRef.current) {
            graphRef.current.draw();
            graphRef.current.fitView();
          }
        });
      }
    });

    graph.on('node:click', (event) => {
      const target = (event as { target: { id?: string } }).target;
      const nodeId = target?.id;
      if (nodeId && nodeId !== 'server') {
        navigate(`/devices/${nodeId}`);
      }
    });

    graph.on('node:dblclick', (event) => {
      const target = (event as { target: { id?: string } }).target;
      const nodeId = target?.id;
      if (nodeId) {
        graph.focusElement(nodeId);
      }
    });

    return () => {
      graph.destroy();
      graphRef.current = null;
    };
  }, [data, navigate]);

  const total = data?.groups.reduce((sum, g) => sum + g.devices.length, 0) ?? 0;
  const online = data?.groups.reduce(
    (sum, g) => sum + g.devices.filter((d) => d.is_online).length,
    0,
  ) ?? 0;
  const stats = {
    total,
    online,
    offline: total - online,
    groups: data?.groups.length ?? 0,
  };
  const serverInfo = data?.server;

  return (
    <div className="topo-root" style={{ margin: -24, padding: 24, minHeight: 'calc(100vh - 64px)', background: C.void, color: C.text, position: 'relative', overflow: 'hidden' }}>
      <style>{PAGE_STYLES}</style>

      {/* ─── 氛围背景层 ─── */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        {/* 网格 */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `linear-gradient(${C.cyanDim} 1px, transparent 1px), linear-gradient(90deg, ${C.cyanDim} 1px, transparent 1px)`,
          backgroundSize: '48px 48px', opacity: 0.5,
        }} />
        {/* 中心径向辉光 */}
        <div style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(ellipse at 50% 45%, rgba(0, 229, 255, 0.10), transparent 60%)`,
        }} />
        {/* 左上 + 右下 角落辉光 */}
        <div style={{ position: 'absolute', top: '-10%', left: '-5%', width: '40%', height: '40%', background: `radial-gradient(circle, rgba(57, 255, 20, 0.06), transparent 70%)` }} />
        <div style={{ position: 'absolute', bottom: '-10%', right: '-5%', width: '40%', height: '40%', background: `radial-gradient(circle, rgba(255, 184, 0, 0.06), transparent 70%)` }} />
      </div>

      {/* 内容层 */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px - 48px)' }}>

        {/* ─── HUD 标题栏 ─── */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <span className="topo-pulse-dot" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: C.green, boxShadow: `0 0 12px ${C.green}` }} />
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: '0.3em', color: C.textDim, textTransform: 'uppercase' }}>
                NET-OPS / SECTOR 01 / LIVE
              </span>
            </div>
            <h1 style={{ fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 30, color: C.cyan, margin: 0, letterSpacing: '0.06em', textShadow: `0 0 24px ${C.cyanDim}` }}>
              NETWORK TOPOLOGY
            </h1>
            <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.textDim, marginTop: 6 }}>
              <span style={{ color: C.textDim }}>SERVER ::</span>{' '}
              <span style={{ color: C.amber }}>{serverInfo?.hostname ?? '—'}</span>{' '}
              <span style={{ color: C.textDim }}>@</span>{' '}
              <span style={{ color: C.text }}>{serverInfo?.ip ?? '—'}</span>
            </div>
          </div>

          <Button
            className="topo-refresh-btn"
            icon={<ReloadOutlined />}
            onClick={loadData}
            loading={loading}
          >
            Rescan
          </Button>
        </div>

        {/* ─── 统计读数面板 ─── */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <StatReadout label="Total Nodes" value={stats.total} color={C.cyan} delay={80} unit="dev" />
          <StatReadout label="Online" value={stats.online} color={C.green} delay={160} unit="active" />
          <StatReadout label="Offline" value={stats.offline} color={C.red} delay={240} unit="down" />
          <StatReadout label="Subnets" value={stats.groups} color={C.amber} delay={320} unit="seg" />
        </div>

        {/* ─── 拓扑画布容器 ─── */}
        <div style={{ position: 'relative', flex: 1, minHeight: 420, border: `1px solid ${C.border}`, background: C.void, overflow: 'hidden' }}>
          <CornerBrackets color={C.cyan} />

          {/* 扫描线 */}
          <div style={{
            position: 'absolute', left: 0, right: 0, top: 0, height: '40%', zIndex: 2, pointerEvents: 'none',
            background: `linear-gradient(to bottom, transparent, ${C.cyanDim}, transparent)`,
            animation: 'topo-scan 7s linear infinite',
          }} />

          {/* 左下角坐标读数 */}
          <div style={{ position: 'absolute', left: 10, bottom: 8, zIndex: 3, fontFamily: FONT_MONO, fontSize: 10, color: C.textDim, pointerEvents: 'none', lineHeight: 1.6 }}>
            <div>SYS<span className="topo-blink" style={{ color: C.green }}> ●</span> OK</div>
            <div>LAT 0.00ms / DRAG·SCROLL·DBLCLICK</div>
          </div>

          {loading ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spin tip="SCANNING NETWORK…" />
            </div>
          ) : data ? (
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
          ) : (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Empty description={<span style={{ color: C.textDim, fontFamily: FONT_MONO, fontSize: 12 }}>NO SIGNAL</span>} />
            </div>
          )}

          {/* ─── HUD 图例 ─── */}
          <div style={{
            position: 'absolute', top: 10, right: 10, zIndex: 3, pointerEvents: 'none',
            background: C.panel, border: `1px solid ${C.border}`, padding: '10px 14px', backdropFilter: 'blur(6px)',
            fontFamily: FONT_MONO, fontSize: 11, color: C.text, minWidth: 150,
          }}>
            <CornerBrackets color={C.cyan} />
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 11, color: C.cyan, letterSpacing: '0.15em', marginBottom: 8, borderBottom: `1px solid ${C.border}`, paddingBottom: 5 }}>
              LEGEND
            </div>
            <LegendRow color={C.amber} label="SERVER" glow />
            <LegendRow color={C.green} label="ONLINE" glow />
            <LegendRow color={C.red} label="OFFLINE" dashed />
          </div>
        </div>
      </div>
    </div>
  );
}

function LegendRow({ color, label, glow, dashed }: { color: string; label: string; glow?: boolean; dashed?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0' }}>
      <span style={{
        display: 'inline-block', width: 16, height: 10,
        background: '#0a1018',
        border: `1.5px solid ${color}`,
        borderStyle: dashed ? 'dashed' : 'solid',
        boxShadow: glow ? `0 0 8px ${color}aa` : 'none',
      }} />
      <span style={{ color: C.textDim }}>{label}</span>
    </div>
  );
}

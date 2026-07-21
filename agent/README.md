# DesktopMonitor Agent

DesktopMonitor Agent 是桌面监控系统的客户端模块，运行在被监控的 Windows 设备上。它负责定期采集屏幕截图、监控前台活动窗口，并将数据缓存到本地 SQLite 后通过 HTTP 上报至服务端，同时支持通过 WebSocket 接收实时推流控制。

## 依赖说明

| 依赖 | 版本要求 | 用途 |
| --- | --- | --- |
| mss | >=9.0.1 | 高性能屏幕截图采集 |
| Pillow | >=10.4.0 | 图像处理与 JPEG 压缩 |
| pywin32 | >=306 | Windows API 调用（前台窗口、进程信息） |
| requests | >=2.32.3 | HTTP 上报与服务端通信 |
| websocket-client | >=1.8.0 | WebSocket 客户端连接 |
| python-dotenv | >=1.0.1 | 加载 `.env` 配置文件 |

> 此外使用 Python 标准库 `sqlite3` 作为本地缓存存储，无需额外安装。

## 安装方式

在 `agent/` 目录下执行：

```bash
pip install -r requirements.txt
```

## 配置方式

1. 复制 `.env.example` 为 `.env`：

   ```bash
   cp .env.example .env
   ```

2. 根据实际环境修改 `.env` 中的各项配置：
   - `SERVER_URL`：服务端地址
   - `AGENT_REGISTER_TOKEN`：Agent 注册预置 Token（需与服务端 `AGENT_REGISTER_TOKEN` 保持一致）
   - `SCREENSHOT_INTERVAL`：截图采集间隔（秒）
   - `WINDOW_SAMPLE_INTERVAL`：活动窗口采样间隔（秒）
   - `EVENT_AGGREGATE_INTERVAL`：活动事件聚合周期（秒）
   - `UPLOAD_INTERVAL`：上传器轮询间隔（秒）
   - `LOG_LEVEL`：日志级别（DEBUG / INFO / WARNING / ERROR）

## 启动方式

在 `agent/` 目录下执行：

```bash
python -m src.main
```

## 目录结构说明

```
agent/
├── README.md              # 本说明文档
├── requirements.txt       # Python 依赖清单
├── .env.example           # 环境变量示例配置
├── src/                   # 源码目录
│   ├── __init__.py        # 包初始化文件
│   ├── main.py            # 程序入口（后续 Task 15 实现）
│   ├── config/            # 配置加载模块
│   ├── collectors/        # 数据采集器（屏幕截图、活动窗口）
│   ├── uploader/          # 数据上报器（HTTP / WebSocket）
│   ├── storage/           # 本地 SQLite 缓存
│   └── utils/             # 通用工具模块
└── data/                  # 运行时数据目录（SQLite 数据库、截图缓存）
```

## 平台支持

**仅支持 Windows 平台**：Agent 依赖 `pywin32` 调用 Windows API 获取前台窗口标题与进程信息，无法在 Linux/macOS 上运行。

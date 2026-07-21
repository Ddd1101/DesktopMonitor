# 员工桌面监控软件

## 项目简介

一款面向企业内部的员工桌面监控软件，通过 Agent 采集桌面活动与截图，由 Server 集中存储与分发，Web 端提供实时查看与数据看板，用于工作效率统计与合规审计。

## 技术栈

| 模块 | 技术栈 |
| --- | --- |
| Agent | Python（mss / Pillow / pywin32 / requests / websocket-client） |
| Server | Node.js + TypeScript + Fastify（better-sqlite3 / JWT / pino / zod） |
| Web | React + TypeScript + Vite（Ant Design / axios / react-router-dom / recharts） |
| Storage | SQLite + 本地文件存储（截图） |

## 目录结构

```
DesktopMonitor/
├── agent/          # Python 客户端 Agent（屏幕采集、活动监控、断网续传）
├── server/         # Node.js + TypeScript 服务端（API、WebSocket、SQLite）
├── web/            # React + TypeScript Web 管理端（设备列表、实时查看、看板）
├── docs/           # 设计文档（架构、部署等）
└── .trae/          # Trae 规范与任务文件
```

## 快速开始

### 1. 服务端启动

```bash
cd server
cp .env.example .env          # Windows: copy .env.example .env
# 按需修改 .env 中的 JWT_SECRET、AGENT_REGISTER_TOKEN、ADMIN_DEFAULT_PASSWORD
npm install
npm run dev                   # 开发模式（热重载），或 npm start 运行生产构建
```

默认监听端口 3000，启动后会自动创建 SQLite 数据库与默认管理员账号。

### 2. Agent 启动

```bash
cd agent
cp .env.example .env          # Windows: copy .env.example .env
# 修改 .env 中的 SERVER_URL 与 AGENT_REGISTER_TOKEN（与服务端一致）
python -m venv .venv
.venv\Scripts\activate        # Windows 激活虚拟环境
pip install -r requirements.txt
python -m src.main
```

Agent 启动后会自动注册到服务端，并开始采集屏幕截图与活动窗口数据。首次启动时会自动写入注册表实现开机自启。

### 3. Web 端启动

```bash
cd web
npm install
npm run dev                   # 开发模式，浏览器访问 http://localhost:5173
```

生产构建使用 `npm run build`，产物在 `web/dist/`，可由 Nginx 或服务端 `@fastify/static` 托管。详细部署方式见 [docs/deploy.md](docs/deploy.md)。

## 默认账号

| 用途 | 账号 | 密码 / Token | 说明 |
| --- | --- | --- | --- |
| 管理员登录 | `admin` | `admin123` | 首次启动时自动创建，可通过服务端 `ADMIN_DEFAULT_PASSWORD` 环境变量修改 |
| Agent 注册 | — | `change-me-please` | Agent 与服务端需保持一致，可通过 `AGENT_REGISTER_TOKEN` 环境变量修改 |

> ⚠️ 生产环境部署前，**必须**修改 `JWT_SECRET`、`AGENT_REGISTER_TOKEN`、`ADMIN_DEFAULT_PASSWORD` 三项配置，避免使用默认值。

## 文档链接

- [架构设计](docs/architecture.md)
- [部署指南](docs/deploy.md)
- [服务端说明](server/README.md)
- [Agent 说明](agent/README.md)

## 安全合规声明

- 本软件仅用于员工工作效率统计与合规审计，**不得用于非工作目的的监控**。
- 在部署与使用前，**必须取得员工的明确授权**，并遵循所在地区与国家的法律法规（如《个人信息保护法》《网络安全法》等）。
- 采集的数据（截图、活动事件）应严格限制访问权限，仅授权管理员可查看，并按需设置合理的保留期限与销毁机制。
- 严禁将采集的数据用于非法用途或对外泄露，违者由相关责任人承担法律后果。

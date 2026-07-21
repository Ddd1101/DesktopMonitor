# Desktop Monitor 服务端

桌面活动监控系统的服务端，负责接收 Agent 上报的活动事件与截图，提供管理员查询接口与实时 WebSocket 推流能力。

## 技术栈

- **运行时**：Node.js（建议 18+）
- **开发语言**：TypeScript（strict 模式）
- **Web 框架**：Fastify
- **数据库**：SQLite（better-sqlite3）
- **实时通信**：@fastify/websocket
- **数据校验**：zod
- **鉴权**：jsonwebtoken（JWT）

## 依赖说明

| 依赖 | 用途 |
| --- | --- |
| fastify | Web 框架 |
| @fastify/cors | 跨域支持 |
| @fastify/multipart | 文件上传（截图） |
| @fastify/websocket | WebSocket 实时推流 |
| @fastify/static | 截图静态文件服务 |
| better-sqlite3 | SQLite 驱动 |
| jsonwebtoken | JWT 签发与校验 |
| pino | 日志 |
| zod | 请求体校验 |
| dotenv | 环境变量加载 |

## 安装

```bash
npm install
```

## 配置

复制 `.env.example` 为 `.env` 并按需修改：

```bash
cp .env.example .env
```

主要配置项：

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| PORT | 服务监听端口 | 3000 |
| JWT_SECRET | JWT 签名密钥 | default-jwt-secret-change-me |
| AGENT_REGISTER_TOKEN | Agent 注册预置 Token | change-me-please |
| ADMIN_DEFAULT_PASSWORD | 默认管理员密码（首次启动写入） | admin123 |
| DATA_DIR | 数据目录 | ./data |
| SCREENSHOTS_DIR | 截图存储目录 | ./data/screenshots |
| DB_PATH | SQLite 文件路径 | ./data/app.db |
| HEARTBEAT_TIMEOUT_SECONDS | 心跳超时秒数 | 90 |

## 开发

```bash
npm run dev
```

使用 `tsx watch` 实现热重载，源码修改后自动重启。

## 构建

```bash
npm run build
```

编译输出到 `dist/` 目录。

## 启动

```bash
npm start
```

运行编译后的 `dist/index.js`。

## 默认管理员

- 用户名：`admin`
- 密码：`admin123`

> 生产环境请务必通过 `ADMIN_DEFAULT_PASSWORD` 修改默认密码，并通过 `JWT_SECRET` 修改密钥。

## API 端点列表

### 管理员接口（需在 Authorization 头携带 `Bearer <token>`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/login` | 管理员登录，返回 JWT |
| GET | `/api/admin/devices` | 设备列表（含在线状态） |
| GET | `/api/admin/devices/:deviceId/screenshots` | 设备截图分页查询 |
| GET | `/api/admin/devices/:deviceId/events` | 设备活动事件分页查询 |
| GET | `/api/admin/dashboard` | 看板数据（活跃设备数、今日截图数、Top10 应用） |

### Agent 接口（需在 Authorization 头携带 `Bearer <token>`，注册接口除外）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/agent/register` | Agent 注册，返回 deviceId 与 JWT |
| POST | `/api/agent/events` | 批量上报活动事件 |
| POST | `/api/agent/screenshots` | 上传截图（multipart） |
| POST | `/api/agent/heartbeat` | 上报心跳 |

### WebSocket 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET（WS） | `/ws/monitor/:deviceId` | 订阅指定设备的实时截图推送 |

### 其他

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/screenshots/*` | 截图静态文件访问 |

## 目录结构

```
server/
├── src/
│   ├── app.ts              # Fastify 实例组装
│   ├── index.ts            # 服务启动入口
│   ├── config/             # 配置加载
│   ├── db/                 # 数据库初始化
│   ├── routes/             # 路由
│   │   ├── admin/          # 管理员路由
│   │   ├── agent/          # Agent 路由
│   │   └── ws/             # WebSocket 路由
│   ├── services/           # 服务（订阅推送）
│   ├── utils/              # 工具（鉴权、密码）
│   └── types/              # 类型声明
├── data/                   # 运行时数据（SQLite + 截图）
├── .env.example            # 环境变量模板
├── package.json
└── tsconfig.json
```

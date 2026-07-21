# 部署指南

本文档描述 DesktopMonitor 各模块的部署方式，涵盖服务端、Agent 客户端与 Web 管理端。

## 1. 环境要求

| 模块 | 运行环境 | 备注 |
| --- | --- | --- |
| 服务端 | Node.js 18+，npm 或 pnpm | 推荐 18.x LTS 或更高 |
| Agent | Windows 10+，Python 3.10+ | 仅支持 Windows |
| Web 端（开发） | Node.js 18+ | Vite 开发服务器 |
| Web 端（生产） | 任意静态文件服务器 | Nginx / Caddy / `@fastify/static` |
| 数据库 | SQLite | 随服务端自动创建，无需单独安装 |

## 2. 服务端部署

### 2.1 进入目录

```bash
cd server
```

### 2.2 配置环境变量

复制 `.env.example` 为 `.env` 并修改关键配置：

```bash
cp .env.example .env
```

`.env` 关键配置项：

| 环境变量 | 是否必改 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `JWT_SECRET` | **必改** | JWT 签名密钥，使用随机长字符串 | `default-jwt-secret-change-me` |
| `AGENT_REGISTER_TOKEN` | **必改** | Agent 注册预置 Token，需与 Agent 端一致 | `change-me-please` |
| `ADMIN_DEFAULT_PASSWORD` | **必改** | 默认管理员密码（首次启动写入） | `admin123` |
| `PORT` | 可选 | 服务监听端口 | `3000` |
| `DATA_DIR` | 可选 | 数据目录 | `./data` |
| `SCREENSHOTS_DIR` | 可选 | 截图存储目录 | `./data/screenshots` |
| `DB_PATH` | 可选 | SQLite 文件路径 | `./data/app.db` |
| `HEARTBEAT_TIMEOUT_SECONDS` | 可选 | 心跳超时秒数 | `90` |

### 2.3 安装依赖

```bash
npm install
```

### 2.4 开发模式

```bash
npm run dev
```

使用 `tsx watch` 实现热重载，源码修改后自动重启。

### 2.5 生产构建

```bash
npm run build
```

编译输出到 `dist/` 目录。

### 2.6 生产启动

```bash
npm start
```

运行编译后的 `dist/index.js`。建议配合 `pm2` 或 `systemd` 进行进程管理：

```bash
# 使用 pm2
pm2 start dist/index.js --name desktop-monitor-server
pm2 save
pm2 startup
```

### 2.7 反向代理建议（Nginx）

```nginx
server {
  listen 80;
  server_name monitor.example.com;

  location /api/ {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location /screenshots/ {
    proxy_pass http://localhost:3000;
  }

  location /ws/ {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

## 3. Agent 部署

### 3.1 进入目录

```bash
cd agent
```

### 3.2 配置环境变量

复制 `.env.example` 为 `.env` 并修改：

```bash
cp .env.example .env
```

`.env` 关键配置项：

| 环境变量 | 是否必改 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `SERVER_URL` | **必改** | 服务端地址 | `http://localhost:3000` |
| `AGENT_REGISTER_TOKEN` | **必改** | 与服务端一致 | `change-me-please` |
| `SCREENSHOT_INTERVAL` | 可选 | 截图采集间隔（秒） | `30` |
| `WINDOW_SAMPLE_INTERVAL` | 可选 | 活动窗口采样间隔（秒） | `1` |
| `EVENT_AGGREGATE_INTERVAL` | 可选 | 活动事件聚合周期（秒） | `30` |
| `UPLOAD_INTERVAL` | 可选 | 上传器轮询间隔（秒） | `60` |
| `LOG_LEVEL` | 可选 | 日志级别（DEBUG / INFO / WARNING / ERROR） | `INFO` |

### 3.3 创建虚拟环境

```bash
python -m venv .venv
```

### 3.4 激活虚拟环境（Windows）

```bash
.venv\Scripts\activate
```

### 3.5 安装依赖

```bash
pip install -r requirements.txt
```

### 3.6 启动

```bash
python -m src.main
```

### 3.7 开机自启

Agent 启动时会自动将自身写入注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，下次开机时自动启动。如需关闭自启，删除该注册表项即可。

### 3.8 打包为单文件 exe（可选）

使用 PyInstaller 打包为单 exe，便于分发部署：

```bash
pyinstaller --onefile --noconsole --name DesktopMonitorAgent src/main.py
```

打包产物位于 `dist/DesktopMonitorAgent.exe`。如需包含 `.env` 配置文件，将其放在 exe 同级目录。

## 4. Web 端部署

### 4.1 开发模式

```bash
cd web
npm install
npm run dev
```

默认端口 5173，浏览器访问 http://localhost:5173。

### 4.2 生产构建

```bash
cd web
npm run build
```

构建产物位于 `web/dist/`。

### 4.3 部署方式

#### 方式 1：Nginx 部署 + 反向代理（推荐）

将 `dist/` 部署到 Nginx，配置 `/api`、`/screenshots`、`/ws` 反向代理到服务端：

```nginx
server {
  listen 80;
  server_name monitor.example.com;

  location / {
    root /path/to/web/dist;
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location /screenshots/ {
    proxy_pass http://localhost:3000;
  }

  location /ws/ {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

#### 方式 2：服务端直接托管（`@fastify/static`）

将 `web/dist/` 拷贝到服务端目录，由服务端通过 `@fastify/static` 直接托管前端静态文件，无需独立 Nginx。该方式适合小型部署。

## 5. 首次启动验证流程

按以下顺序启动并验证各模块：

1. **启动服务端**
   - 执行 `npm run dev` 或 `npm start`
   - 检查日志显示 `Server listening` 与默认管理员账号信息

2. **验证服务端可用**
   ```bash
   curl http://localhost:3000/health
   ```
   返回正常状态即代表服务可用。

3. **启动 Agent**
   - 执行 `python -m src.main`
   - 检查日志显示"注册成功"与分配的设备 ID

4. **启动 Web 端**
   - 执行 `npm run dev`
   - 浏览器访问 http://localhost:5173

5. **登录验证**
   - 使用 `admin / admin123` 登录
   - 进入"设备管理"页面，应能看到刚启动的 Agent 设备在线

6. **实时查看验证**
   - 等待约 30 秒（默认截图间隔）
   - 进入"实时查看"，应能看到 Agent 上报的截图

## 6. 运维与监控

### 6.1 日志位置

| 模块 | 日志位置 |
| --- | --- |
| 服务端 | `server/logs/`（Fastify pino 日志） |
| Agent | `agent/data/agent.log` |
| Web 端 | 浏览器控制台（生产环境无服务端日志） |

### 6.2 数据库备份

定期备份 `server/data/app.db`，建议使用 `sqlite3` 命令进行热备份：

```bash
sqlite3 server/data/app.db ".backup server/data/app.db.bak"
```

或使用文件系统级定期备份（需停机或使用快照）。

### 6.3 截图清理

定期清理 `server/data/screenshots/` 下的老旧数据，示例脚本（Linux/cron）：

```bash
# 删除 30 天前的截图
find server/data/screenshots -type f -mtime +30 -delete
# 删除空目录
find server/data/screenshots -type d -empty -delete
```

Windows 计划任务可使用 PowerShell：

```powershell
Get-ChildItem -Path "server\data\screenshots" -Recurse -File |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
  Remove-Item -Force
```

### 6.4 性能监控

- 服务端使用 Fastify 内置的 pino 日志，可接入 ELK（Elasticsearch + Logstash + Kibana）或 Loki 进行日志聚合
- 监控指标建议关注：
  - 服务端 CPU / 内存占用
  - SQLite 文件大小
  - 截图目录磁盘占用
  - WebSocket 连接数
  - HTTP 请求 QPS 与错误率

## 7. 常见问题排查

### 7.1 Agent 无法注册

**现象**：Agent 日志显示注册失败。

**排查**：
- 检查 Agent `.env` 中的 `AGENT_REGISTER_TOKEN` 与服务端是否一致
- 检查 Agent `.env` 中的 `SERVER_URL` 是否正确，服务端是否可达
- 使用 `curl` 测试服务端连通性：
  ```bash
  curl http://<server-url>/health
  ```

### 7.2 截图上传失败

**现象**：Agent 日志显示上传 4xx/5xx 错误。

**排查**：
- 检查服务端磁盘空间是否充足
- 检查 `server/data/screenshots/` 目录的写权限
- 检查服务端日志是否有异常堆栈

### 7.3 WebSocket 连接失败

**现象**：Web 端实时查看无法显示新截图。

**排查**：
- 检查反向代理（Nginx）是否配置了 `Upgrade`、`Connection` 头
- 检查浏览器控制台是否有 WebSocket 错误
- 确认服务端 `/ws/monitor/:deviceId` 路由可访问

### 7.4 Web 端 401 未授权

**现象**：Web 端请求返回 401。

**排查**：
- JWT 已过期（默认 24 小时），重新登录即可
- 检查服务端 `JWT_SECRET` 是否被修改（修改后旧 token 全部失效）

### 7.5 Agent 占用资源高

**现象**：Agent 进程 CPU 或内存占用过高。

**排查**：
- 调大 `SCREENSHOT_INTERVAL`（如从 30 秒改为 60 秒）
- 调大 `WINDOW_SAMPLE_INTERVAL`（如从 1 秒改为 3 秒）
- 检查本地 `pending_*` 表是否积压过多未上传记录
- 检查网络是否稳定，上传器是否能正常消费队列

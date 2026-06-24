# GLM2API 部署指南

## 前置要求

- Node.js 18+（推荐 20+）
- npm 10+
- （可选）Docker 20+

## 方式一：本地运行

1. **克隆仓库**
   ```bash
   git clone https://github.com/yourname/glm2api.git
   cd glm2api
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **配置环境变量**
   复制 `.env.example` 为 `.env`，并根据需要修改：
   ```bash
   cp .env.example .env
   ```
   主要配置项：
   - `REFRESH_TOKEN`：智谱 refresh token（必填），多个用逗号分隔
   - `API_KEY`：客户端认证密钥（必填）
   - `PORT`：监听端口，默认 3099
   - `MAX_CONCURRENT_PER_TOKEN`：每个 token 最大并发数，默认 2

4. **启动服务**
   ```bash
   npm start
   ```
   开发模式（自动重启）：
   ```bash
   npm run dev
   ```

服务默认运行在 `http://localhost:3099`。

## 方式二：Docker

1. **准备环境变量**
   创建 `.env` 文件，填入必要配置。

2. **构建并启动**
   ```bash
   docker-compose up -d
   ```

3. **查看日志**
   ```bash
   docker-compose logs -f
   ```

4. **停止服务**
   ```bash
   docker-compose down
   ```

默认映射宿主机 `3099` 端口到容器内 `3099`。

## 方式三：Vercel 部署

1. Fork 本仓库到你的 GitHub。
2. 在 Vercel 中导入项目。
3. 配置环境变量（至少设置 `REFRESH_TOKEN` 和 `API_KEY`）。
4. 部署。

**注意**：Vercel 上流式响应可能受 Serverless 函数超时限制，建议配置较长的超时时间。

## 配置说明

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `3099` |
| `API_KEY` | 客户端认证密钥 | 无（必须设置） |
| `REFRESH_TOKEN` | 逗号分隔的 refresh token 列表 | 无（必须设置） |
| `MAX_CONCURRENT_PER_TOKEN` | 每个 token 最大并发请求数 | `2` |
| `TOKEN_DEAD_THRESHOLD` | 连续失败次数阈值，标记为 dead | `5` |
| `HEALTH_CHECK_INTERVAL` | 健康检查间隔（秒） | `600` |
| `LOG_LEVEL` | 日志级别（info/debug） | `info` |
| `ADMIN_KEY` | 管理面板访问密钥 | 无（可选） |

### 获取 Refresh Token

1. 登录智谱清言 Web 端（chatglm.cn）。
2. 打开开发者工具（F12），在 Application/Storage 中找到 `refresh_token` 值。
3. 将其填入 `REFRESH_TOKEN` 环境变量。

## 运维建议

- 使用进程管理工具（如 PM2）保持服务持续运行。
- 定期检查日志，监控令牌状态。
- 建议使用反向代理（如 Nginx）处理 HTTPS 和负载均衡。

## 故障排除

- **认证失败**：检查 `API_KEY` 是否与请求头一致。
- **令牌失效**：检查 `REFRESH_TOKEN` 是否有效，可尝试重新获取。
- **端口占用**：修改 `PORT` 环境变量。
- **日志错误**：查看控制台输出或日志文件，定位具体错误。

## 更多信息

- API 文档：[API.md](API.md)
- 项目主页：[README.md](../README.md)

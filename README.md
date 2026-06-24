<p align="center">
  <img src="admin/favicon.svg" width="128" height="128" alt="GLM2API icon" />
</p>

# GLM2API

[![License](https://img.shields.io/github/license/yourname/glm2api.svg)](LICENSE)
![Stars](https://img.shields.io/github/stars/yourname/glm2api.svg)
![Forks](https://img.shields.io/github/forks/yourname/glm2api.svg)

语言 / Language: [中文](README.md)

将智谱 GLM Web Chat 服务封装为 OpenAI 兼容的 API 代理，支持工具调用（function calling）、思考输出（reasoning）、多模态图像输入、多令牌轮换。

> **重要免责声明**
>
> 本仓库仅供学习、研究、个人实验和内部验证使用，不提供任何形式的商业授权、适用性保证或结果保证。
>
> 作者及仓库维护者不对因使用、修改、分发、部署或依赖本项目而产生的任何直接或间接损失、账号封禁、数据丢失、法律风险或第三方索赔负责。
>
> 请勿将本项目用于违反服务条款、协议、法律法规或平台规则的场景。商业使用前请自行确认 `LICENSE` 以及你是否获得了作者的书面许可。

## 目录

- [核心能力](#核心能力)
- [快速开始](#快速开始)
  - [方式一：本地源码运行](#方式一本地源码运行)
  - [方式二：Docker 运行](#方式二docker-运行)
- [配置说明](#配置说明)
- [API 使用](#api-使用)
- [管理面板](#管理面板)
- [项目结构](#项目结构)
- [免责声明](#免责声明)

## 核心能力

| 能力 | 说明 |
| --- | --- |
| OpenAI 兼容 | `GET /v1/models`、`POST /v1/chat/completions` |
| 工具调用 | 支持标准 function calling，自动解析并转发工具调用 |
| 思考输出 | 支持 `reasoning_content` 字段，保留 GLM 的思考过程 |
| 多令牌轮换 | 可配置多个 refresh token，自动轮换避免限流 |
| 多模态图像输入 | 支持 base64 编码图片或图片 URL，自动上传至 GLM |
| 管理面板 | `/admin` 提供令牌管理、状态查看，支持视觉能力标记和重复检测 |
| 性能监控 | 内置 TTFB 和 token 速度记录 |

## 快速开始

### 方式一：本地源码运行

**前置要求**：Node.js 18+，npm

```bash
# 1. 克隆仓库
git clone https://github.com/yourname/glm2api.git
cd glm2api

# 2. 安装依赖
npm install

# 3. 配置
cp .env.example .env
# 编辑 .env，填入你的智谱 refresh token

# 4. 启动
npm start
# 或开发模式（自动重启）
npm run dev
```

默认本地访问地址：`http://localhost:3099`

### 方式二：Docker 运行

```bash
# 1. 准备环境变量和配置文件
cp .env.example .env

# 2. 编辑 .env，填入你的智谱 refresh token

# 3. 构建并启动
docker-compose up -d

# 4. 查看日志
docker-compose logs -f
```

默认 `docker-compose.yml` 会把宿主机 `3099` 映射到容器内的 `3099`。

## 配置说明

`README` 只保留快速入口，完整字段请以 [.env.example](.env.example) 为模板。

常用环境变量：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `3099` |
| `API_KEY` | 客户端认证密钥 | 无（必须设置） |
| `REFRESH_TOKEN` | 逗号分隔的 refresh token 列表 | 无（必须设置） |
| `MAX_CONCURRENT_PER_TOKEN` | 每个 token 最大并发请求数 | `2` |
| `TOKEN_DEAD_THRESHOLD` | 连续失败次数阈值，达到后标记为 dead | `5` |
| `HEALTH_CHECK_INTERVAL` | 健康检查间隔（秒） | `600` |
| `LOG_LEVEL` | 日志级别（info/debug） | `info` |

## API 使用

### 发送聊天请求（纯文本）

```bash
curl http://localhost:3099/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "messages": [
      {"role": "system", "content": "你是一个有用的助手。"},
      {"role": "user", "content": "你好！"}
    ],
    "stream": false
  }'
```

### 发送图片（多模态）

**方式一：Base64 编码**
```bash
curl http://localhost:3099/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "这张图片里有什么？"},
          {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ..."}}
        ]
      }
    ],
    "stream": false
  }'
```

**方式二：图片 URL**
```bash
curl http://localhost:3099/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "描述这张图片"},
          {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
        ]
      }
    ],
    "stream": false
  }'
```

### 列出模型

```bash
curl http://localhost:3099/v1/models \
  -H "Authorization: Bearer your-api-key"
```

### 支持参数

- `model`: `glm-5.2`
- `messages`: 标准 OpenAI 消息数组，支持 system/user/assistant/tool 角色，content 可为字符串或多模态数组
- `tools`: 工具定义数组（OpenAI function calling 格式）
- `tool_choice`: `auto` / `none` / `required` / 指定工具名
- `stream`: `true` 或 `false`

## 管理面板

访问 `/admin` 可查看和管理令牌池状态：
- 查看所有已添加的令牌及其状态（活跃/失效）
- 每个令牌的并发请求数、错误计数
- **视觉能力标记**：所有令牌均标记为支持视觉
- **重复检测**：添加令牌时自动检测是否已存在，避免重复

## 项目结构

```
.
├── src/
│   ├── index.js          # 入口，路由注册
│   ├── chat.js           # 与 GLM API 交互（含多模态文件上传）
│   ├── openai.js         # OpenAI 兼容处理
│   ├── anthropic.js      # Anthropic 格式支持（可选）
│   ├── dsml.js           # ⭐ 提示词系统核心
│   ├── tool_interceptor.js # 工具调用拦截与修复
│   ├── auth.js           # 令牌管理与刷新
│   ├── image.js          # 图片处理
│   ├── queue.js          # 请求队列
│   ├── session.js        # 会话管理
│   ├── metrics.js        # 性能指标
│   └── logger.js         # 日志
├── admin/                # 管理面板静态文件
├── docs/                 # 项目文档
│   ├── API.md            # API 接口文档
│   ├── DEPLOY.md         # 部署指南
│   ├── ARCHITECTURE.md   # 架构说明
│   ├── CONTRIBUTING.md   # 贡献指南
│   └── TESTING.md        # 测试指南
├── .env                  # 配置文件
├── Dockerfile            # Docker 构建
└── docker-compose.yml    # Docker Compose
```

## 文档索引

| 文档 | 说明 |
| --- | --- |
| [README.en.md](README.en.md) | 英文项目总览 |
| [API.md](API.md) | API 接口文档（中文） |
| [API.en.md](API.en.md) | API Reference (English) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构与项目结构（中文） |
| [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md) | Architecture (English) |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署指南（中文） |
| [docs/DEPLOY.en.md](docs/DEPLOY.en.md) | Deployment Guide (English) |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 贡献指南（中文） |
| [docs/CONTRIBUTING.en.md](docs/CONTRIBUTING.en.md) | Contributing Guide (English) |
| [docs/TESTING.md](docs/TESTING.md) | 测试指南 |

## 免责声明

本项目基于逆向方式实现，仅供学习、研究、个人实验和内部验证使用，不提供任何商业授权、稳定性保证或可用性保证。
作者及仓库维护者不对因使用、修改、分发、部署或依赖本项目而产生的任何直接或间接损失、账号封禁、数据丢失、法律风险或第三方索赔负责。

请勿将本项目用于违反服务条款、协议、法律法规或平台规则的场景。商业使用前请自行确认 `LICENSE` 以及你是否获得了作者的书面许可。

## License

MIT

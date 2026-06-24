# GLM 2API

将智谱GLM Web Chat服务封装为OpenAI兼容的API代理，支持工具调用（function calling）、思考输出（reasoning）、多模态图像输入、多令牌轮换。

## 功能特性

- ✅ **OpenAI 兼容接口**：`/v1/chat/completions` 和 `/v1/models`
- ✅ **工具调用**：支持标准 function calling，自动解析并转发工具调用
- ✅ **思考输出**：支持 `reasoning_content` 字段，保留 GLM 的思考过程
- ✅ **多令牌轮换**：可配置多个 refresh token，自动轮换避免限流
- ✅ **多模态图像输入**：支持 base64 编码图片或图片 URL，自动上传至 GLM
- ✅ **管理面板**：`/admin` 提供令牌管理、状态查看，支持视觉能力标记和重复检测
- ✅ **性能监控**：内置 TTFB 和 token 速度记录

## 快速开始

### 安装

```bash
npm install
```

### 配置

复制 `.env.example` 为 `.env` 并填写：

```env
# 至少一个智谱 refresh token（从 chatglm.cn 获取），多个用逗号分隔
REFRESH_TOKEN=token1,token2

# API 密钥（客户端调用时需提供）
API_KEY=your-secret-key

# 可选：端口（默认 3099）
PORT=3099

# 可选：每个 token 最大并发数（默认 2）
MAX_CONCURRENT_PER_TOKEN=2

# 可选：token 健康检查间隔（秒，默认 600）
HEALTH_CHECK_INTERVAL=600
```

### 启动

```bash
npm start
# 或开发模式（自动重启）
npm run dev
```

服务默认运行在 `http://localhost:3099`。

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

支持两种方式传入图片：

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

支持参数：
- `model`: `glm-5.2`
- `messages`: 标准 OpenAI 消息数组，支持 system/user/assistant/tool 角色，content 可为字符串或多模态数组
- `tools`: 工具定义数组（OpenAI function calling 格式）
- `tool_choice`: `auto` / `none` / `required` / 指定工具名
- `stream`: `true` 或 `false`

### 列出模型

```bash
curl http://localhost:3099/v1/models \
  -H "Authorization: Bearer your-api-key"
```

## 提示词系统（核心架构）

本项目在 `src/dsml.js` 中实现了一套专为 GLM 优化的提示词构建系统，核心目标是在完整保留用户原始系统提示的前提下，安全地注入工具调用能力，并强制模型输出结构化 JSON，确保解析稳定且规避 WAF 规则。

### 设计原则

1. **中立附加模式（Neutral Addendum Pattern）**：将工具说明以 Markdown JSON 代码块附加，不使用 XML 标签（如 `<tool_calls>`），避免触发 WAF 拦截。
2. **分层组装**：提示词按 `[SYSTEM]` → `[DATA: AVAILABLE TOOLS]` → `[DATA: FORMAT PRIMER]`（伪造示例）→ `[DATA: CONVERSATION HISTORY]` 顺序组装，最后以 `### Assistant:` 引导输出。
3. **强制 JSON 输出**：所有响应必须封装在 `TOOL_DISPATCH` JSON 数组中，纯文本通过 `Speak` 工具发出，多工具调用并列。

### 核心处理阶段

#### Phase 1: 工具压缩（`compressTools`）
- **去噪**：移除工具描述中的 XML 示例块（如 `<example>...</example>`），减少干扰。
- **截断**：将描述截断为前 300 字符，避免冗长内容消耗 token 并混淆模型。
- **输出格式**：生成 `Tool: xxx\nDescription: xxx\nParameters: {...}` 的压缩文本。

#### Phase 2: 历史清理（`processMessages`）
- **工具结果截断**：仅保留最近 2 条 `tool`/`function` 消息的结果，更早的替换为 `[result omitted]`。
- **子代理日志隔离**：检测包含 `[Called tools:]` 或长内容含 `---` 的日志，用 `<subagent_history_log>` 包裹，防止模型模仿子代理日志格式。
- **Assistant 消息重格式化**：将历史中的 assistant 响应重新包装成 `TOOL_DISPATCH` JSON 格式，保持格式一致性。
- **移除系统提醒**：删除 `<system-reminder>` 标签内容。

#### Phase 3: 沙盒式提示构建（`buildPrompt`）
按层组装：
1. `[SYSTEM]` — 用户原始系统提示（persona）。
2. `[DATA: AVAILABLE TOOLS]` — 压缩后的工具定义，并附加 `tool_choice` 强制指令（如 `MUST call tool`）。
3. `[DATA: FORMAT PRIMER]` — 伪造示例对话（见 `buildFakeHistory`），通过例子教学 JSON 格式。
4. `[DATA: CONVERSATION HISTORY]` — 清理后的真实对话历史。
5. 结尾引导：`### Assistant:` 引导模型开始输出。

### 格式教学：伪造示例对话（`buildFakeHistory`）

系统在真实历史**之前**注入一段伪造对话，向模型展示：
- **身份声明**：用 `Speak` 工具输出 "我是智谱清言..."。
- **日期查询**：展示如何用 `Speak` 回答简单问题。
- **工具链演示**：展示如何一次调用多个工具（如 `Bash` 写入、查找、读取）。

伪造示例让模型通过例子学会输出格式，比直接指令更有效。

### 工具调用解析与修复（`openai.js`）

提示词构建后，输出解析依赖 `extractToolCallsUnified` 和 `repairBrokenOutput`：
1. **正则解析**：尝试从模型输出中提取 `TOOL_DISPATCH` 数组。
2. **修复代理**：若解析失败，将原始输出发给模型自身，让其修正（`repairBrokenOutput`）。
3. **安全网**：若修复仍失败，将原始内容包装为 `Speak` 工具调用，确保不丢失内容。

### 关键函数

| 函数 | 作用 |
|------|------|
| `compressTools(tools)` | 压缩工具列表，去噪并提取名称 |
| `processMessages(messages)` | 清理并格式化对话历史，隔离子代理日志 |
| `buildPrompt({ messages, tools, toolChoice, thinkingEnabled, isJsonTask })` | 构建标准提示（沙箱式） |
| `detectJsonTask(messages)` | 检测是否要求 JSON 输出，调整提示 |
| `buildFakeHistory()` | 生成格式示例的伪造对话（动态日期） |

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 监听端口 | `3099` |
| `API_KEY` | 客户端认证密钥 | 无（必须设置） |
| `REFRESH_TOKEN` | 逗号分隔的 refresh token 列表 | 无（必须设置） |
| `MAX_CONCURRENT_PER_TOKEN` | 每个 token 最大并发请求数 | `2` |
| `TOKEN_DEAD_THRESHOLD` | 连续失败次数阈值，达到后标记为 dead | `5` |
| `HEALTH_CHECK_INTERVAL` | 健康检查间隔（秒） | `600` |
| `LOG_LEVEL` | 日志级别（info/debug） | `info` |

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
├── .env                  # 配置文件
├── Dockerfile            # Docker 构建
└── docker-compose.yml    # Docker Compose
```

## 注意事项

- 本项目依赖 `chatglm.cn` 的私有 API，**仅用于学习和研究目的**，请勿滥用。
- 多令牌轮换可提高并发能力，但需注意每个 token 的速率限制。
- 工具调用修复（`repairBrokenOutput`）会在解析失败时自动尝试修复模型输出，提高稳定性。

## License

MIT

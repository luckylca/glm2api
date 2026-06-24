# GLM2API API 文档

语言 / Language: [中文](API.md) | [English](API.en.md)

本文档描述了 GLM2API 的 API 行为。

- [基础信息](#基础信息)
- [认证](#认证)
- [端点](#端点)
  - [列出模型](#列出模型)
  - [聊天补全](#聊天补全)
  - [管理面板](#管理面板)
- [错误码](#错误码)
- [cURL 示例](#curl-示例)

## 基础信息

| 项目 | 详情 |
| --- | --- |
| Base URL | `http://localhost:3099` 或你的部署域名 |
| 默认 Content-Type | `application/json` |

- 所有 JSON 请求体必须为有效 UTF-8；格式错误的字节序列会被拒绝并返回 `400 invalid json`。

## 认证

业务端点 (`/v1/*`) 接受以下头部格式：

| 方式 | 示例 |
| --- | --- |
| Bearer Token | `Authorization: Bearer <API_KEY>` |
| API Key Header | `x-api-key: <API_KEY>` |

**认证行为**：

- Token 在环境变量 `API_KEY` 中配置 → 认证通过
- 否则返回 `401`

## 端点

### 列出模型

**GET** `/v1/models`

无需认证。返回当前支持的模型列表（目前仅 `glm-5.2`）。

**响应**：

```json
{
  "object": "list",
  "data": [
    {"id": "glm-5.2", "object": "model", "created": 1677610602, "owned_by": "zhipu"}
  ]
}
```

### 聊天补全

**POST** `/v1/chat/completions`

**请求头**：

```http
Authorization: Bearer your-api-key
Content-Type: application/json
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | ✅ | 模型 ID，固定为 `glm-5.2` |
| `messages` | array | ✅ | OpenAI 风格消息列表 |
| `stream` | boolean | ❌ | 默认 `false` |
| `tools` | array | ❌ | 工具调用模式 |
| `tool_choice` | string/object | ❌ | `auto` / `none` / `required` / 指定函数 |
| `temperature` | number | ❌ | 温度参数 |
| `max_tokens` | integer | ❌ | 最大生成 token 数 |

#### 非流式响应

```json
{
  "id": "<session_id>",
  "object": "chat.completion",
  "created": 1738400000,
  "model": "glm-5.2",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "final response",
        "reasoning_content": "reasoning trace (when thinking is enabled)"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

#### 流式响应 (`stream=true`)

SSE 格式：每帧为 `data: <json>\n\n`，终止于 `data: [DONE]`。

```text
data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"index":0}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"reasoning_content":"..."},"index":0}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"..."},"index":0}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{...}}

data: [DONE]
```

**字段说明**：

- 首个 delta 包含 `role: assistant`
- 启用思考时，流可能输出 `delta.reasoning_content`
- 文本输出 `delta.content`
- 最后一帧包含 `finish_reason` 和 `usage`

#### 工具调用

当请求包含 `tools` 时，GLM2API 会进行防泄漏处理。

**非流式**：如果检测到工具调用，返回 `message.tool_calls`，`finish_reason=tool_calls`，`message.content=null`。

```json
{
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_xxx",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\":\"beijing\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

**流式**：一旦匹配到高置信度的工具调用特征，GLM2API 立即发出 `delta.tool_calls`，然后持续发送参数增量。

### 管理面板

**GET** `/admin`

访问管理面板，需要 Admin 认证（通过环境变量 `ADMIN_KEY` 配置）。

## 错误码

兼容路由 (`/v1/*`) 使用统一的错误格式：

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "code": "invalid_request",
    "param": null
  }
}
```

| 状态码 | 含义 |
| --- | --- |
| `401` | 认证失败（无效的 API Key） |
| `429` | 请求过多（限流或队列满） |
| `503` | 模型不可用或上游错误 |

## cURL 示例

### OpenAI 非流式

```bash
curl http://localhost:3099/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

### OpenAI 流式

```bash
curl http://localhost:3099/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "messages": [{"role": "user", "content": "Explain quantum entanglement"}],
    "stream": true
  }'
```

### 工具调用

```bash
curl http://localhost:3099/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "messages": [{"role": "user", "content": "What is the weather in Beijing?"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get weather for a city",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {"type": "string", "description": "City name"}
            },
            "required": ["city"]
          }
        }
      }
    ]
  }'
```

## 更多信息

- 部署指南：[docs/DEPLOY.md](docs/DEPLOY.md)
- 项目主页：[README.md](README.md)

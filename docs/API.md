# GLM2API API 文档

## 概述

GLM2API 提供 OpenAI 兼容的 API 接口，用于与智谱 GLM Web Chat 服务交互。

## 基础信息

- **Base URL**: `http://localhost:3099`
- **认证**: 通过 `Authorization: Bearer <API_KEY>` 请求头，或 `x-api-key` 请求头
- **Content-Type**: `application/json`

## 端点

### 列出模型

**GET** `/v1/models`

返回可用模型列表（目前仅 `glm-5.2`）。

**示例**：
```bash
curl http://localhost:3099/v1/models \
  -H "Authorization: Bearer your-api-key"
```

### 聊天补全

**POST** `/v1/chat/completions`

发送聊天请求，支持流式和非流式。

**请求体参数**：

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `model` | string | 是 | 模型 ID，固定为 `glm-5.2` |
| `messages` | array | 是 | 消息列表，支持 system/user/assistant/tool 角色 |
| `stream` | boolean | 否 | 是否流式输出，默认 false |
| `tools` | array | 否 | 工具定义（OpenAI function calling 格式） |
| `tool_choice` | string/object | 否 | `auto`/`none`/`required` 或指定工具名 |
| `temperature` | number | 否 | 温度参数，0-2 |
| `max_tokens` | integer | 否 | 最大生成 token 数 |

**消息格式**：

- **纯文本**：`{"role": "user", "content": "你好"}`
- **多模态**：`{"role": "user", "content": [{"type": "text", "text": "描述图片"}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}]}`

**工具调用示例**：
```json
{
  "model": "glm-5.2",
  "messages": [{"role": "user", "content": "北京天气如何？"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "获取城市天气",
      "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"]
      }
    }
  }],
  "tool_choice": "auto"
}
```

**响应格式**：

非流式响应为标准 OpenAI Chat Completion 格式，包含 `choices`、`usage` 等字段。若启用思考输出，会在 `choices[0].message` 中包含 `reasoning_content` 字段。

流式响应为 SSE 事件流，每个事件包含 `delta` 增量内容。

## 管理面板

**GET** `/admin`

访问管理面板，用于查看和管理令牌池状态。需要 Admin 认证（通过环境变量 `ADMIN_KEY` 配置）。

## 错误码

| 状态码 | 描述 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 认证失败（API Key 无效） |
| 429 | 请求过多（令牌限流或队列满） |
| 500 | 服务器内部错误 |

## 更多信息

- 部署指南：[DEPLOY.md](DEPLOY.md)
- 项目主页：[README.md](../README.md)

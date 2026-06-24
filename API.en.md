# GLM2API API Reference

Language: [中文](API.md) | [English](API.en.md)

This document describes the actual behavior of GLM2API.

- [Basics](#basics)
- [Authentication](#authentication)
- [Endpoints](#endpoints)
  - [List Models](#list-models)
  - [Chat Completions](#chat-completions)
  - [Admin Panel](#admin-panel)
- [Error Codes](#error-codes)
- [cURL Examples](#curl-examples)

## Basics

| Item | Details |
| --- | --- |
| Base URL | `http://localhost:3099` or your deployment domain |
| Default Content-Type | `application/json` |

- All JSON request bodies must be valid UTF-8; malformed byte sequences are rejected with `400 invalid json`.

## Authentication

Business endpoints (`/v1/*`) accept the following headers:

| Method | Example |
| --- | --- |
| Bearer Token | `Authorization: Bearer <API_KEY>` |
| API Key Header | `x-api-key: <API_KEY>` |

**Auth behavior**:

- Token matches the configured `API_KEY` in environment → authenticated
- Otherwise returns `401`

## Endpoints

### List Models

**GET** `/v1/models`

No auth required. Returns the currently supported model list (currently only `glm-5.2`).

**Response**:

```json
{
  "object": "list",
  "data": [
    {"id": "glm-5.2", "object": "model", "created": 1677610602, "owned_by": "zhipu"}
  ]
}
```

### Chat Completions

**POST** `/v1/chat/completions`

**Headers**:

```http
Authorization: Bearer your-api-key
Content-Type: application/json
```

**Request body**:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `model` | string | ✅ | Model ID, fixed to `glm-5.2` |
| `messages` | array | ✅ | OpenAI-style messages |
| `stream` | boolean | ❌ | Default `false` |
| `tools` | array | ❌ | Function calling schema |
| `tool_choice` | string/object | ❌ | `auto` / `none` / `required` / specify function |
| `temperature` | number | ❌ | Temperature parameter |
| `max_tokens` | integer | ❌ | Max generation tokens |

#### Non-Stream Response

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

#### Streaming (`stream=true`)

SSE format: each frame is `data: <json>\n\n`, terminated by `data: [DONE]`.

```text
data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"index":0}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"reasoning_content":"..."},"index":0}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"..."},"index":0}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{...}}

data: [DONE]
```

**Field notes**:

- First delta includes `role: assistant`
- When thinking is enabled, the stream may emit `delta.reasoning_content`
- Text emits `delta.content`
- Last chunk includes `finish_reason` and `usage`

#### Tool Calls

When `tools` is present, GLM2API performs anti-leak handling.

**Non-stream**: If detected, returns `message.tool_calls`, `finish_reason=tool_calls`, `message.content=null`.

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

**Stream**: Once high-confidence toolcall features are matched, GLM2API emits `delta.tool_calls` immediately, then keeps sending argument deltas.

### Admin Panel

**GET** `/admin`

Access the admin panel; requires Admin authentication (configured via `ADMIN_KEY` environment variable).

## Error Codes

Compatible routes (`/v1/*`) use the unified error format:

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

| Code | Meaning |
| --- | --- |
| `401` | Authentication failed (invalid API Key) |
| `429` | Too many requests (rate limited or queue full) |
| `503` | Model unavailable or upstream error |

## cURL Examples

### OpenAI Non-Stream

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

### OpenAI Stream

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

### Tool Calling

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

## More Information

- Deployment Guide: [docs/DEPLOY.md](docs/DEPLOY.md)
- Project Home: [README.md](README.md)

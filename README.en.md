<p align="center">
  <img src="admin/favicon.svg" width="128" height="128" alt="GLM2API icon" />
</p>

# GLM2API

[![License](https://img.shields.io/github/license/yourname/glm2api.svg)](LICENSE)
![Stars](https://img.shields.io/github/stars/yourname/glm2api.svg)
![Forks](https://img.shields.io/github/forks/yourname/glm2api.svg)

Language: [中文](README.md) | [English](README.en.md)

Convert Zhipu GLM Web Chat service into an OpenAI-compatible API proxy, supporting function calling, reasoning output, multimodal image input, and multi-token rotation.

> **Important Disclaimer**
>
> This repository is provided for learning, research, personal experimentation, and internal validation only. It does not grant any commercial authorization and comes with no warranty of fitness, stability, or results.
>
> The author and repository maintainers are not responsible for any direct or indirect loss, account suspension, data loss, legal risk, or third-party claims arising from use, modification, distribution, deployment, or reliance on this project.
>
> Do not use this project in ways that violate service terms, agreements, laws, or platform rules. Before any commercial use, review the `LICENSE`, the relevant terms, and confirm that you have the author's written permission.

## Table of Contents

- [Key Capabilities](#key-capabilities)
- [Quick Start](#quick-start)
  - [Option 1: Local Run](#option-1-local-run)
  - [Option 2: Docker](#option-2-docker)
- [Configuration](#configuration)
- [API Usage](#api-usage)
- [Admin Panel](#admin-panel)
- [Project Structure](#project-structure)
- [Disclaimer](#disclaimer)

## Key Capabilities

| Capability | Details |
| --- | --- |
| OpenAI compatible | `GET /v1/models`, `POST /v1/chat/completions` |
| Tool calling | Standard function calling, auto-parsing and forwarding |
| Reasoning output | Supports `reasoning_content` field, preserving GLM's thinking process |
| Multi-token rotation | Configure multiple refresh tokens for auto-rotation to avoid rate limiting |
| Multimodal image input | Supports base64-encoded images or image URLs, auto-upload to GLM |
| Admin panel | `/admin` provides token management, status view, vision capability marking, and duplicate detection |
| Performance monitoring | Built-in TTFB and token speed recording |

## Quick Start

### Option 1: Local Run

**Prerequisites**: Node.js 18+, npm

```bash
# 1. Clone the repository
git clone https://github.com/yourname/glm2api.git
cd glm2api

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# Edit .env and fill in your Zhipu refresh token

# 4. Start
npm start
# or development mode (auto-restart)
npm run dev
```

Default local URL: `http://localhost:3099`

### Option 2: Docker

```bash
# 1. Prepare environment variables
cp .env.example .env

# 2. Edit .env and fill in your Zhipu refresh token

# 3. Build and start
docker-compose up -d

# 4. View logs
docker-compose logs -f
```

The default `docker-compose.yml` maps host port `3099` to container port `3099`.

## Configuration

`README` keeps only the onboarding path. Use [.env.example](.env.example) as the template for all fields.

Common environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Listening port | `3099` |
| `API_KEY` | Client authentication key | None (required) |
| `REFRESH_TOKEN` | Comma-separated list of refresh tokens | None (required) |
| `MAX_CONCURRENT_PER_TOKEN` | Max concurrent requests per token | `2` |
| `TOKEN_DEAD_THRESHOLD` | Consecutive failure count to mark dead | `5` |
| `HEALTH_CHECK_INTERVAL` | Health check interval (seconds) | `600` |
| `LOG_LEVEL` | Log level (info/debug) | `info` |

## API Usage

### Send chat request (plain text)

```bash
curl http://localhost:3099/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "stream": false
  }'
```

### Send image (multimodal)

**Method 1: Base64 encoding**
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
          {"type": "text", "text": "What's in this image?"},
          {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ..."}}
        ]
      }
    ],
    "stream": false
  }'
```

**Method 2: Image URL**
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
          {"type": "text", "text": "Describe this image"},
          {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
        ]
      }
    ],
    "stream": false
  }'
```

### List models

```bash
curl http://localhost:3099/v1/models \
  -H "Authorization: Bearer your-api-key"
```

### Supported parameters

- `model`: `glm-5.2`
- `messages`: Standard OpenAI messages array, supports system/user/assistant/tool roles, content can be string or multimodal array
- `tools`: Tool definitions (OpenAI function calling format)
- `tool_choice`: `auto` / `none` / `required` / specify tool name
- `stream`: `true` or `false`

## Admin Panel

Access `/admin` to view and manage token pool status:
- View all added tokens and their status (active/inactive)
- Concurrency and error counts per token
- **Vision capability marking**: All tokens are marked as vision-capable
- **Duplicate detection**: Automatically detects duplicates when adding tokens

## Project Structure

```
.
├── src/
│   ├── index.js          # Entry, route registration
│   ├── chat.js           # GLM API interaction (including multimodal file upload)
│   ├── openai.js         # OpenAI compatibility handling
│   ├── anthropic.js      # Anthropic format support (optional)
│   ├── dsml.js           # ⭐ Prompt system core
│   ├── tool_interceptor.js # Tool call interception and repair
│   ├── auth.js           # Token management and refresh
│   ├── image.js          # Image processing
│   ├── queue.js          # Request queue
│   ├── session.js        # Session management
│   ├── metrics.js        # Performance metrics
│   └── logger.js         # Logging
├── admin/                # Admin panel static files
├── .env                  # Configuration file
├── Dockerfile            # Docker build
└── docker-compose.yml    # Docker Compose
```

## Disclaimer

This project is built through reverse engineering and is provided for learning, research, personal experimentation, and internal validation only. No commercial authorization is granted, and no warranty of stability, fitness, or results is provided.
The author and repository maintainers are not responsible for any direct or indirect loss, account suspension, data loss, legal risk, or third-party claims arising from use, modification, distribution, deployment, or reliance on this project.

Do not use this project in ways that violate service terms, agreements, laws, or platform rules. Before any commercial use, review the `LICENSE`, the relevant terms, and confirm that you have the author's written permission.

## License

MIT

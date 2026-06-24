# GLM2API Deployment Guide

Language: [中文](DEPLOY.md) | [English](DEPLOY.en.md)

This guide covers all deployment methods for GLM2API.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Option 1: Local Run](#option-1-local-run)
- [Option 2: Docker](#option-2-docker)
- [Option 3: Vercel](#option-3-vercel)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- Node.js 18+ (20+ recommended)
- npm 10+
- Docker (optional)

## Option 1: Local Run

```bash
# Clone
git clone https://github.com/yourname/glm2api.git
cd glm2api

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your Zhipu refresh token

# Start
npm start
# Or development mode (auto-restart)
npm run dev
```

Default URL: `http://localhost:3099`

## Option 2: Docker

```bash
# Prepare .env
cp .env.example .env
# Edit .env

# Build and run
docker-compose up -d

# View logs
docker-compose logs -f
```

Default host port mapping: `3099:3099`.

## Option 3: Vercel

1. Fork this repository.
2. Import the project on Vercel.
3. Set environment variables (at least `REFRESH_TOKEN` and `API_KEY`).
4. Deploy.

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Listening port | `3099` |
| `API_KEY` | Client authentication key | Required |
| `REFRESH_TOKEN` | Comma-separated refresh tokens | Required |
| `MAX_CONCURRENT_PER_TOKEN` | Max concurrent requests per token | `2` |
| `TOKEN_DEAD_THRESHOLD` | Failures before marking dead | `5` |
| `HEALTH_CHECK_INTERVAL` | Health check interval (seconds) | `600` |
| `LOG_LEVEL` | Log level (info/debug) | `info` |

## Troubleshooting

- **Auth failed**: Check `API_KEY` matches request header.
- **Invalid token**: Re-fetch refresh token from Zhipu web.
- **Port in use**: Change `PORT` environment variable.
- **Log errors**: Check console output.

## More Information

- API Reference: `API.md`
- Project Home: `README.md`

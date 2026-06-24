# GLM2API 测试指南

语言 / Language: [中文](TESTING.md) | [English](TESTING.en.md)

本文档介绍 GLM2API 的测试方法。

## 单元测试

目前项目未包含正式的单元测试套件。你可以通过手动测试验证功能。

## 端到端测试

使用 `curl` 或 Postman 对 API 进行端到端测试。

### 测试聊天补全

```bash
curl http://localhost:3099/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

### 测试流式输出

```bash
curl http://localhost:3099/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"Tell me a joke"}],"stream":true}'
```

### 测试工具调用

参考 `API.md` 中的工具调用示例。

## 管理面板测试

访问 `http://localhost:3099/admin`，登录后测试令牌管理功能。

## 性能测试

可使用 `wrk` 或 `artillery` 进行负载测试。示例：

```bash
wrk -t2 -c10 -d30s -s post.lua http://localhost:3099/v1/chat/completions
```

## 故障排除

- 确保 `.env` 中的 `REFRESH_TOKEN` 有效。
- 查看控制台日志以定位错误。
- 检查令牌状态是否健康。

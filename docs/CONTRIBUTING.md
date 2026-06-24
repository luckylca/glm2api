# 贡献指南

语言 / Language: [中文](CONTRIBUTING.md) | [English](CONTRIBUTING.en.md)

感谢你对 GLM2API 的关注与贡献！

## 开发环境设置

### 前置要求

- Node.js 18+（推荐 20+）
- npm 10+

### 后端开发

```bash
# 1. 克隆仓库
git clone https://github.com/yourname/glm2api.git
cd glm2api

# 2. 安装依赖
npm install

# 3. 配置
cp .env.example .env
# 编辑 .env，填入你的智谱 refresh token

# 4. 启动开发模式（自动重启）
npm run dev
# 本地访问 http://localhost:3099
```

## 代码规范

- **JavaScript**：使用 ESLint 默认配置，保持现有代码风格。
- **提交信息**：使用语义化前缀：`feat:`、`fix:`、`docs:`、`refactor:`、`style:`、`perf:`、`chore:`。

## 提交 PR

1. Fork 仓库
2. 创建分支（如 `feature/xxx` 或 `fix/xxx`）
3. 提交更改
4. 推送分支
5. 发起 Pull Request

## 运行测试

```bash
# 运行单元测试（若有）
npm test
```

## 问题反馈

请使用 [GitHub Issues](https://github.com/yourname/glm2api/issues) 并附上：

- 复现步骤
- 相关日志输出
- 运行环境信息（OS、Node 版本）

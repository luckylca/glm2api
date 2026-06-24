# Contributing Guide

Language: [中文](CONTRIBUTING.md) | [English](CONTRIBUTING.en.md)

Thank you for your interest in GLM2API!

## Development Environment Setup

### Prerequisites

- Node.js 18+ (20+ recommended)
- npm 10+

### Backend Development

```bash
# 1. Clone the repository
git clone https://github.com/yourname/glm2api.git
cd glm2api

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# Edit .env and fill in your Zhipu refresh token

# 4. Start development mode (auto-restart)
npm run dev
# Local access http://localhost:3099
```

## Code Style

- **JavaScript**: Use ESLint defaults; follow existing style.
- **Commit messages**: Use semantic prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `style:`, `perf:`, `chore:`.

## Submitting a PR

1. Fork the repository
2. Create a branch (e.g., `feature/xxx` or `fix/xxx`)
3. Commit changes
4. Push the branch
5. Open a Pull Request

## Running Tests

```bash
# Run unit tests (if any)
npm test
```

## Reporting Issues

Please use [GitHub Issues](https://github.com/yourname/glm2api/issues) and include:

- Steps to reproduce
- Relevant logs
- Environment details (OS, Node version)

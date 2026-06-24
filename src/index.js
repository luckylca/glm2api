import { config } from 'dotenv';
import { readFileSync } from 'fs';
config();

import express from 'express';
import { initTokenPool, getPoolInfo, getTotalCapacity, addTokenToPool, deleteTokenFromPool, startHealthCheck } from './auth.js';
import { handleOpenAICompletion, handleOpenAIModels } from './openai.js';
import { handleGLMCompletion } from './glm.js';
import { handleAnthropicMessages, handleAnthropicModels, handleAnthropicCountTokens } from './anthropic.js';
import { handleImageGeneration } from './image.js';
import { getQueueInfo } from './queue.js';
import { requestLogger, getRecentLogs, getLogStats, readHistoricalLogs, readChatLogs, listLogDates } from './logger.js';
import { getMetrics, getTimeseries } from './metrics.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const VERSION = pkg.version;
const startTime = Date.now();

// Session cache removed — GLM 5.2 doesn't use server-side sessions
function getSessionInfo() { return { count: 0, sessions: [], ttl: 0 }; }

const app = express();
const PORT = process.env.PORT || 3099;

app.use(express.json({ limit: '50mb' }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-API-Key, Anthropic-Version, Anthropic-Beta, X-Requested-With');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-RateLimit-Requests-Remaining');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Request logging
app.use(requestLogger('glm2api'));

// API Key auth middleware
app.use((req, res, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();

  if (req.method === 'OPTIONS') return next();

  if ((req.method === 'GET' || req.method === 'HEAD') &&
      (req.path === '/' || req.path === '/healthz' || req.path === '/admin' || req.path === '/admin/chat' || req.path === '/performance' || req.path === '/v1/models' || req.path === '/anthropic/v1/models')) {
    return next();
  }

  const bearer = req.headers['authorization'];
  if (bearer === `Bearer ${apiKey}`) return next();

  const xApiKey = req.headers['x-api-key'];
  if (xApiKey === apiKey) return next();

  res.status(401).json({ error: { message: 'Invalid API key' } });
});

// OpenAI format
app.post('/v1/chat/completions', handleOpenAICompletion);
app.get('/v1/models', handleOpenAIModels);

// GLM native format (backward compatibility)
app.post('/api/v0/chat/completion', handleGLMCompletion);

// Anthropic Messages API
app.get('/anthropic/v1/models', handleAnthropicModels);
app.post('/anthropic/v1/messages', handleAnthropicMessages);
app.post('/anthropic/v1/messages/count_tokens', handleAnthropicCountTokens);

app.post('/v1/messages', handleAnthropicMessages);
app.post('/messages', handleAnthropicMessages);
app.post('/v1/messages/count_tokens', handleAnthropicCountTokens);
app.post('/messages/count_tokens', handleAnthropicCountTokens);

// Image generation (OpenAI format)
app.post('/v1/images/generations', handleImageGeneration);

// Root → admin panel
app.get('/', (req, res) => res.redirect('/admin'));
app.head('/', (req, res) => res.status(200).end());

// Health check
app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    version: VERSION,
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
  });
});

// Admin panel
app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, 'admin', 'index.html'));
});

app.get('/admin/chat', (req, res) => {
  res.sendFile(join(__dirname, 'admin', 'chat.html'));
});

app.get('/admin/api/stats', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  res.json({
    status: 'ok',
    version: VERSION,
    uptimeSeconds,
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
    logStats: getLogStats(),
  });
});

app.get('/admin/api/logs', (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 50, 200);
  res.json({ logs: getRecentLogs(count), stats: getLogStats() });
});

app.get('/admin/api/logs/dates', (req, res) => {
  res.json({ dates: listLogDates() });
});

app.get('/admin/api/logs/history', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: { message: 'date param required (YYYY-MM-DD)' } });
  const count = Math.min(parseInt(req.query.count) || 100, 10000);
  res.json({ logs: readHistoricalLogs(date, count) });
});

app.get('/admin/api/logs/chats', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const count = Math.min(parseInt(req.query.count) || 100, 10000);
  res.json({ chats: readChatLogs(date, count), total: count });
});

app.get('/admin/api/settings', (req, res) => {
  res.json({
    settings: [
      { key: 'PORT', value: process.env.PORT || '3000', desc: 'Server port' },
      { key: 'API_KEY', value: process.env.API_KEY ? '******' : '(not set)', desc: 'API access key' },
      { key: 'GLM_TOKENS', value: process.env.GLM_TOKENS ? `${process.env.GLM_TOKENS.split(',').length} keys` : '(not set)', desc: 'GLM 5.2 API keys' },
      { key: 'MAX_CONCURRENT_PER_TOKEN', value: process.env.MAX_CONCURRENT_PER_TOKEN || '2', desc: 'Max concurrent per key' },
      { key: 'TOKEN_DEAD_THRESHOLD', value: process.env.TOKEN_DEAD_THRESHOLD || '5', desc: 'Token dead threshold' },
      { key: 'HEALTH_CHECK_INTERVAL', value: process.env.HEALTH_CHECK_INTERVAL || '600', desc: 'Health check interval (sec)' },
      { key: 'IDLE_THRESHOLD', value: process.env.IDLE_THRESHOLD || '1800', desc: 'Idle threshold (sec)' },
      { key: 'MERGE_THINKING', value: process.env.MERGE_THINKING || 'false', desc: 'Merge thinking content' },
      { key: 'HTTPS_PROXY', value: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '(not set)', desc: 'HTTPS proxy' },
      { key: 'LOG_DIR', value: process.env.LOG_DIR || '(default)', desc: 'Log directory' },
    ]
  });
});

app.post('/admin/api/token/add', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: { message: 'token required' } });
  }
  try {
    const added = await addTokenToPool(token);
    res.json({ success: true, dead: added.dead });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Token login removed — GLM uses API keys directly
app.post('/admin/api/token/login', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: { message: 'token required (paste GLM API key directly)' } });
  }
  try {
    const added = await addTokenToPool(token);
    res.json({ success: true, token: token.slice(0, 12) + '...', dead: added.dead });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.delete('/admin/api/token/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ error: { message: 'Invalid token id' } });
  }
  const result = deleteTokenFromPool(id);
  if (result.success) {
    res.json(result);
  } else {
    res.status(404).json(result);
  }
});

// Token lookup stub (GLM doesn't support email lookup)
app.post('/admin/api/token/lookup', async (req, res) => {
  res.json({ success: true, email: null, nickname: null, note: 'Email lookup not supported for GLM API keys' });
});

// Performance monitoring
app.get('/performance', (req, res) => {
  res.sendFile(join(__dirname, 'performance', 'index.html'));
});

app.get('/performance/api/metrics', (req, res) => {
  res.json(getMetrics());
});

app.get('/performance/api/timeseries', (req, res) => {
  const range = req.query.range || '6h';
  const points = getTimeseries(range);
  const pool = getPoolInfo();
  const totalCap = getTotalCapacity();
  const queue = getQueueInfo();
  res.json({ points, pool, totalCapacity: totalCap, queue });
});

app.listen(PORT, async () => {
  console.log(`GLM 5.2 API Proxy running on http://localhost:${PORT}`);
  console.log(`OpenAI format:     POST /v1/chat/completions`);
  console.log(`Anthropic format:  POST /anthropic/v1/messages`);
  console.log(`GLM compat:   POST /api/v0/chat/completion`);
  console.log(`Models:            GET /v1/models | GET /anthropic/v1/models`);
  console.log(`Admin panel:       http://localhost:${PORT}/admin`);

  if (!process.env.API_KEY) {
    console.warn('\n  WARNING: API_KEY is not set — admin endpoints are UNAUTHENTICATED.\n' +
      '   Set API_KEY in .env before exposing this service on a public network.\n');
  }

  await initTokenPool();
  startHealthCheck();
});

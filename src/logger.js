// Request logger — writes all requests + full conversations to disk
// Usage: import { requestLogger, getRecentLogs, getLogStats, readHistoricalLogs, listLogDates } from './logger.js';
//        app.use(requestLogger('glm2api'));

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, resolve, relative } from 'path';
import { recordRequest } from './metrics.js';

const MEMORY_LIMIT = 1000;
const recentLogs = [];
let totalLogged = 0;
let logDir = process.env.LOG_DIR || './logs';
let serviceName = 'default';

// Strict YYYY-MM-DD only. Anything else (e.g. "../../etc/passwd") falls back to
// today, closing the path-traversal vector that flowed from req.query.date.
function sanitizeDate(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Date().toISOString().slice(0, 10);
}

// Defence in depth: reject any resolved path that escapes logDir (e.g. via a
// symlink or a future change to the join logic).
function assertWithinLogDir(targetPath) {
  const root = resolve(logDir);
  const rel = relative(root, resolve(targetPath));
  if (rel.startsWith('..') || resolve(targetPath) === root) {
    throw new Error('path escapes log directory');
  }
}

function getLogPath(date) {
  const safeDate = sanitizeDate(date);
  const dir = join(logDir, serviceName);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${safeDate}.jsonl`);
  assertWithinLogDir(p);
  return p;
}

function getChatLogPath(date) {
  const safeDate = sanitizeDate(date);
  const dir = join(logDir, serviceName, 'chats');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${safeDate}.jsonl`);
  assertWithinLogDir(p);
  return p;
}

function writeLog(entry) {
  try {
    appendFileSync(getLogPath(), JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('Log write failed:', e.message);
  }
}

function writeChatLog(entry) {
  try {
    appendFileSync(getChatLogPath(), JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('Chat log write failed:', e.message);
  }
}

export function logChatEntry(entry) {
  writeChatLog(entry);
}

export function requestLogger(name) {
  serviceName = name || serviceName;
  if (process.env.LOG_DIR) logDir = process.env.LOG_DIR;

  return (req, res, next) => {
    const start = Date.now();
    const isChat = req.path === '/v1/chat/completions' || req.path === '/api/v0/chat/completion'
      || req.path === '/anthropic/v1/messages' || req.path === '/v1/messages' || req.path === '/messages';
    const messages = req.body?.messages || null;
    const model = req.body?.model || '-';
    const stream = req.body?.stream || false;

    // Capture response body
    const chunks = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = function (chunk, ...args) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalWrite(chunk, ...args);
    };

    res.end = function (chunk, ...args) {
      if (chunk) chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalEnd(chunk, ...args);
    };

    res.on('finish', () => {
      const duration = Date.now() - start;
      const entry = {
        time: new Date().toISOString(),
        method: req.method,
        path: req.path,
        model,
        status: res.statusCode,
        duration,
      };

      console.log(`[${entry.time}] ${entry.method} ${entry.path} model=${entry.model} ${entry.status} ${entry.duration}ms`);

      // Record to metrics collector
      recordRequest(model, duration, res.statusCode);

      // Write request log (metadata only)
      writeLog(entry);
      totalLogged++;

      // Keep recent in memory
      if (recentLogs.length >= MEMORY_LIMIT) recentLogs.shift();
      recentLogs.push(entry);

      // Write full chat log for chat endpoints
      if (isChat && messages && res.statusCode === 200) {
        const prompt = res.locals?.chatPrompt || '';
        let assistantContent = '';
        let reasoningContent = '';
        const isAnthropic = req.path.includes('/messages');

        if (stream) {
          if (isAnthropic) {
            // Parse Anthropic SSE stream (event: / data: format)
            // Each writeAnthropicSSE call is one res.write, so chunks have full SSE frames.
            let currentEvent = '';
            let toolName = '';
            let toolInputAcc = '';
            for (const chunk of chunks) {
              const lines = chunk.split('\n');
              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  currentEvent = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                  try {
                    const data = JSON.parse(line.slice(6));
                    if (currentEvent === 'content_block_start') {
                      if (data.content_block?.type === 'tool_use') {
                        toolName = data.content_block.name || '';
                        toolInputAcc = '';
                      }
                    } else if (currentEvent === 'content_block_delta') {
                      if (data.delta?.type === 'text_delta') {
                        assistantContent += data.delta.text || '';
                      } else if (data.delta?.type === 'thinking_delta') {
                        reasoningContent += data.delta.thinking || '';
                      } else if (data.delta?.type === 'input_json_delta') {
                        toolInputAcc += data.delta.partial_json || '';
                      }
                    } else if (currentEvent === 'content_block_stop') {
                      // Flush completed tool_use block
                      if (toolName) {
                        assistantContent += (assistantContent ? '\n' : '') + `[Tool: ${toolName}] ${toolInputAcc}`;
                        toolName = '';
                        toolInputAcc = '';
                      }
                    }
                  } catch {}
                }
              }
            }
          } else {
            // Parse OpenAI SSE stream — capture content, reasoning_content, and tool_calls
            for (const chunk of chunks) {
              const lines = chunk.split('\n');
              for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try {
                    const data = JSON.parse(line.slice(6));
                    const delta = data.choices?.[0]?.delta;
                    if (delta?.content) assistantContent += delta.content;
                    if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
                    // Capture tool_calls deltas — accumulate function name + arguments
                    if (delta?.tool_calls) {
                      for (const tc of delta.tool_calls) {
                        if (tc.function?.name) {
                          assistantContent += (assistantContent ? '\n' : '') + `[Tool: ${tc.function.name}] `;
                        }
                        if (tc.function?.arguments) {
                          assistantContent += tc.function.arguments;
                        }
                      }
                    }
                  } catch {}
                }
              }
            }
          }
        } else {
          if (isAnthropic) {
            try {
              const body = chunks.join('');
              const json = JSON.parse(body);
              const content = json.content || [];
              for (const block of content) {
                if (block.type === 'text') assistantContent += (assistantContent ? '\n' : '') + (block.text || '');
                else if (block.type === 'thinking') reasoningContent += (reasoningContent ? '\n' : '') + (block.thinking || '');
                else if (block.type === 'tool_use') assistantContent += (assistantContent ? '\n' : '') + `[Tool: ${block.name}]`;
              }
            } catch {}
          } else {
            try {
              const body = chunks.join('');
              const json = JSON.parse(body);
              const msg = json.choices?.[0]?.message;
              assistantContent = msg?.content || '';
              reasoningContent = msg?.reasoning_content || '';
            } catch {}
          }
        }

        writeChatLog({
          time: entry.time,
          model,
          stream,
          duration,
          messages,
          prompt,
          response: assistantContent,
          reasoning: reasoningContent || undefined,
          raw: res.locals?.chatRawContent || undefined,
          uploadedFiles: res.locals?.chatUploadedFiles || undefined,
          repair: res.locals?.chatRepair || undefined,
        });
      }
      // Image generation logging
      if (req.path === '/v1/images/generations' && res.statusCode === 200) {
        try {
          const body = chunks.join('');
          const json = JSON.parse(body);
          const imageUrls = (json.data || []).map(item => item.url).filter(Boolean);
          const prompt = req.body?.prompt || '';
          writeChatLog({
            time: entry.time,
            model: req.body?.model || 'cogview',
            stream: false,
            duration,
            messages: [{ role: 'user', content: prompt }],
            prompt: prompt,
            response: JSON.stringify(json), // 记录完整响应 JSON
            images: imageUrls,
            type: 'image',
          });
        } catch (e) {
          console.error('Image log error:', e.message);
        }
      }
    });

    next();
  };
}

export function getRecentLogs(count = 50) {
  return recentLogs.slice(-count);
}

export function getLogStats() {
  const now = Date.now();
  const last5min = recentLogs.filter(e => now - new Date(e.time).getTime() < 300000);
  const errors = last5min.filter(e => e.status >= 400);
  const avgDuration = last5min.length
    ? Math.round(last5min.reduce((s, e) => s + e.duration, 0) / last5min.length)
    : 0;
  return {
    totalLogged,
    memoryBuffer: recentLogs.length,
    last5min: last5min.length,
    errors5min: errors.length,
    avgDuration5min: avgDuration,
  };
}

export function readHistoricalLogs(date, count = 100) {
  try {
    const data = readFileSync(getLogPath(date), 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l)).slice(-count);
  } catch {
    return [];
  }
}

export function readChatLogs(date, count = 50) {
  try {
    const data = readFileSync(getChatLogPath(date), 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l)).slice(-count);
  } catch {
    return [];
  }
}

export function listLogDates() {
  try {
    const dir = join(logDir, serviceName);
    return readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort();
  } catch {
    return [];
  }
}

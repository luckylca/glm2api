// Request logger — writes all requests + full conversations to disk
// Usage: import { requestLogger, getRecentLogs, getLogStats, readHistoricalLogs, listLogDates } from './logger.js';
//        app.use(requestLogger('glm2api'));

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, resolve, relative } from 'path';
import { recordRequest } from './metrics.js';
import { getUploadedFileDisplay } from './file_store.js';

const MEMORY_LIMIT = 1000;
const recentLogs = [];
let totalLogged = 0;
let logDir = process.env.LOG_DIR || './logs';
let serviceName = 'default';
const INLINE_TEXT_LIMIT = 128 * 1024;
const TEXT_LIKE_MIME_RE = /^(text\/|application\/(json|xml|javascript|x-javascript|typescript|x-typescript))/i;

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

function truncateForLog(text) {
  const value = String(text || '');
  if (value.length <= INLINE_TEXT_LIMIT) return value;
  return value.slice(0, INLINE_TEXT_LIMIT) + '\n...[truncated]';
}

function decodeBase64Utf8(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    return Buffer.from(raw.trim(), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function extractInlineTextFromSource(source, fallbackName = '') {
  if (!source || typeof source !== 'object') return '';
  if (typeof source.text === 'string' && source.text) return truncateForLog(source.text);
  if (typeof source.data === 'string') {
    const mimeType = String(source.media_type || source.mime_type || '').toLowerCase();
    const lowerName = String(fallbackName || source.filename || source.file_name || '').toLowerCase();
    const looksTextByName = /\.(txt|md|markdown|json|js|ts|tsx|jsx|xml|yaml|yml|csv|log|py|java|go|rs|c|cc|cpp|h|hpp|html|css|sql)$/i.test(lowerName);
    if (TEXT_LIKE_MIME_RE.test(mimeType) || looksTextByName) {
      return truncateForLog(decodeBase64Utf8(source.data));
    }
  }
  return '';
}

function buildDisplayFileEntry({ id = '', name = '', filename = '', bytes = 0, mimeType = '', content = '', source = '' } = {}) {
  const resolvedName = name || filename || 'upload.bin';
  return {
    id,
    name: resolvedName,
    filename: resolvedName,
    bytes,
    mimeType,
    content: truncateForLog(content),
    source,
  };
}

function normalizeMessageContentForLog(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (block.text) parts.push(block.text);
        break;
      case 'tool_use':
        parts.push(`[TOOL USE: ${block.name || ''}]`);
        if (block.input) parts.push(JSON.stringify(block.input));
        break;
      case 'tool_result': {
        const resultContent = Array.isArray(block.content)
          ? normalizeMessageContentForLog(block.content)
          : (typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''));
        parts.push(`[TOOL RESULT: ${block.tool_use_id || ''}]`);
        if (resultContent) parts.push(resultContent);
        break;
      }
      case 'document': {
        const title = block.title || block.filename || 'document';
        const body = extractInlineTextFromSource(block.source, title);
        parts.push(`[FILE: ${title}]`);
        if (body) parts.push(body);
        break;
      }
      case 'file': {
        const fileItems = Array.isArray(block.file) ? block.file : [block.file];
        const stored = fileItems.map(item => item?.file_id ? getUploadedFileDisplay(item.file_id) : null).find(Boolean) || null;
        const title = stored?.name || block.filename || block.name || block.file_name || fileItems.find(item => item?.file_name)?.file_name || 'file';
        const body = stored?.content || extractInlineTextFromSource(block.source || block, title);
        parts.push(`[FILE: ${title}]`);
        if (body) parts.push(body);
        break;
      }
      case 'input_file': {
        const stored = block.file_id ? getUploadedFileDisplay(block.file_id) : null;
        const title = stored?.name || block.filename || block.file_name || block.file_id || 'input_file';
        const body = stored?.content || extractInlineTextFromSource(block.source || block, title);
        parts.push(`[FILE: ${title}]`);
        if (body) parts.push(body);
        break;
      }
      case 'image':
      case 'image_url':
        parts.push('[Image]');
        break;
      default:
        if (typeof block.text === 'string' && block.text) parts.push(block.text);
        else parts.push(JSON.stringify(block));
        break;
    }
  }
  return parts.filter(Boolean).join('\n');
}

function normalizeMessagesForLog(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(msg => ({
    ...msg,
    content: normalizeMessageContentForLog(msg?.content),
  }));
}

function extractUploadedFilesFromMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const files = [];
  for (const msg of messages) {
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'document') {
        const title = block.title || block.filename || block.name || block.file_name || 'file';
        const body = extractInlineTextFromSource(block.source || block, title);
        files.push(buildDisplayFileEntry({
          id: block.file_id || '',
          name: title,
          mimeType: block.source?.media_type || block.mime_type || '',
          content: body,
          source: 'request-block',
        }));
        continue;
      }
      if (block.type === 'input_file') {
        const stored = block.file_id ? getUploadedFileDisplay(block.file_id) : null;
        files.push(buildDisplayFileEntry({
          id: block.file_id || stored?.id || '',
          name: stored?.name || block.filename || block.file_name || 'input_file',
          bytes: stored?.bytes || 0,
          mimeType: stored?.mimeType || block.mime_type || '',
          content: stored?.content || extractInlineTextFromSource(block.source || block, block.filename || block.file_name || ''),
          source: stored ? 'stored-upload' : 'request-block',
        }));
        continue;
      }
      if (block.type === 'file') {
        if (block.source) {
          const title = block.filename || block.name || block.file_name || 'file';
          const body = extractInlineTextFromSource(block.source || block, title);
          files.push(buildDisplayFileEntry({
            id: block.file_id || '',
            name: title,
            mimeType: block.source?.media_type || block.mime_type || '',
            content: body,
            source: 'request-block',
          }));
          continue;
        }
        const fileItems = Array.isArray(block.file) ? block.file : [block.file];
        for (const item of fileItems) {
          if (!item || typeof item !== 'object') continue;
          const stored = item.file_id ? getUploadedFileDisplay(item.file_id) : null;
          files.push(buildDisplayFileEntry({
            id: item.file_id || stored?.id || '',
            name: stored?.name || item.file_name || item.filename || 'file',
            bytes: stored?.bytes || 0,
            mimeType: stored?.mimeType || '',
            content: stored?.content || '',
            source: stored ? 'stored-upload' : 'request-file-ref',
          }));
        }
      }
    }
  }
  return files.filter(file => file.name || file.content);
}

function normalizeUploadedFilesForLog(messages, upstreamFiles) {
  const merged = [];
  const indexByKey = new Map();
  const push = (file) => {
    if (!file || typeof file !== 'object') return;
    const key = `${file.id || ''}::${file.name || file.filename || ''}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, merged.length);
      merged.push(file);
      return;
    }
    const existing = merged[existingIndex];
    const existingScore = (existing.content ? 2 : 0) + (existing.mimeType ? 1 : 0);
    const incomingScore = (file.content ? 2 : 0) + (file.mimeType ? 1 : 0);
    if (incomingScore > existingScore) {
      merged[existingIndex] = { ...existing, ...file };
    }
  };

  for (const file of extractUploadedFilesFromMessages(messages)) push(file);

  if (Array.isArray(upstreamFiles)) {
    for (const file of upstreamFiles) {
      const stored = file?.file_id ? getUploadedFileDisplay(file.file_id) : null;
      push(buildDisplayFileEntry({
        id: file?.file_id || stored?.id || '',
        name: stored?.name || file?.file_name || file?.name || '',
        bytes: stored?.bytes || file?.file_size || 0,
        mimeType: stored?.mimeType || '',
        content: stored?.content || '',
        source: stored ? 'stored-upload' : 'upstream-upload',
      }));
    }
  }

  return merged;
}

export function requestLogger(name) {
  serviceName = name || serviceName;
  if (process.env.LOG_DIR) logDir = process.env.LOG_DIR;

  return (req, res, next) => {
    const start = Date.now();
    const isChat = req.path === '/v1/chat/completions' || req.path === '/api/v0/chat/completion'
      || req.path === '/anthropic/v1/messages' || req.path === '/v1/messages' || req.path === '/messages';
    const messages = req.body?.messages || null;
    const displayMessages = normalizeMessagesForLog(messages);
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
          messages: displayMessages,
          prompt,
          response: assistantContent,
          reasoning: reasoningContent || undefined,
          raw: res.locals?.chatRawContent || undefined,
          uploadedFiles: normalizeUploadedFilesForLog(messages, res.locals?.chatUploadedFiles),
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

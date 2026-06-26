import { completion, parseSSEStream } from './chat.js';
import { enqueueRequest, dispatchQueued } from './queue.js';
import { recordTTFB, recordTokenSpeed } from './metrics.js';
import {
  buildPrompt,
  buildPointerPrompt,
  detectJsonTask,
  buildHistoryContextFile,
  buildToolsContextFile,
  CONTEXT_HISTORY_FILENAME,
  CONTEXT_TOOLS_FILENAME,
} from './dsml.js';
import { extractToolCallsUnified, normalizeRepairedCalls, repairBrokenOutput } from './tool_interceptor.js';
import { uploadFileData } from './chat.js';

function resolveModel(model) {
  // Always map to glm-5.2, ignore the requested model name
  return { glmModel: 'glm-5.2', displayModel: 'glm-5.2', isNoThinking: false };
}

function flushSSE(res) {
  if (res.flush) res.flush();
  else if (res._flush) res._flush();
  const socket = res.socket || res._socket;
  if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
}

function countConversationMessages(messages) {
  return messages.filter(msg => msg?.role && msg.role !== 'system').length;
}

function shouldUseContextFiles(messages, tools) {
  if (tools.length > 0) return true;
  return countConversationMessages(messages) > 1;
}

function toDataUrl(mediaType, base64) {
  if (!mediaType || !base64) return '';
  return `data:${mediaType};base64,${base64}`;
}

function toBase64Utf8(text) {
  return Buffer.from(String(text || ''), 'utf8').toString('base64');
}

function normalizeFileBlock(block) {
  const source = block?.source || {};
  const filename = block?.filename || block?.title || block?.name || block?.file_name || 'upload.txt';
  const mimeType = source.media_type || block?.mime_type || 'text/plain';

  if (typeof source.data === 'string' && source.data.trim()) {
    return { type: 'input_file', filename, mime_type: mimeType, data: source.data.trim() };
  }
  if (typeof source.text === 'string' && source.text) {
    return { type: 'input_file', filename, mime_type: mimeType, data: toBase64Utf8(source.text) };
  }
  if (typeof block?.text === 'string' && block.text) {
    return { type: 'input_file', filename, mime_type: mimeType, data: toBase64Utf8(block.text) };
  }
  return null;
}

function normalizeImageBlock(block) {
  const source = block?.source || {};
  if (typeof source.data === 'string' && source.data.trim() && source.media_type) {
    return { type: 'image_url', image_url: { url: toDataUrl(source.media_type, source.data.trim()) } };
  }
  if (typeof source.url === 'string' && source.url) {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return { type: 'text', text: '[Image]' };
}

// 鈹€鈹€ Content normalization (Claude blocks -> text) 鈹€鈹€

function textFromContentBlock(block) {
  if (block.type === 'text') return block.text || '';
  if (block.type === 'image') return '[Image]';
  if (block.type === 'document' || block.type === 'file') {
    const title = block.title || block.filename || block.name || block.file_name || 'file';
    const source = block.source || {};
    if (typeof source.text === 'string' && source.text) {
      return `[FILE: ${title}]\n${source.text}`;
    }
    return `[FILE: ${title}]`;
  }
  if (block.type === 'tool_use') {
    const args = typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {});
    return `<tool_calls>\n[{"name":"${block.name}","arguments":${args}}]\n</tool_calls>`;
  }
  if (block.type === 'tool_result') {
    const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
    return `[TOOL RESULT: ${block.tool_use_id || ''}]\n${content}`;
  }
  return JSON.stringify(block);
}

function normalizeClaudeMessages(messages) {
  const out = [];
  for (const msg of messages) {
    if (!msg || !msg.role) continue;
    const role = msg.role;
    const content = msg.content;

    if (Array.isArray(content)) {
      const textParts = [];
      const richParts = [];
      const toolCalls = [];
      let thinking = '';

      for (const block of content) {
        if (!block || !block.type) continue;
        switch (block.type) {
          case 'text':
            if (block.text) {
              textParts.push(block.text);
              richParts.push({ type: 'text', text: block.text });
            }
            break;
          case 'thinking':
            if (role === 'assistant' && (block.thinking || block.text)) {
              thinking += (thinking ? '\n' : '') + (block.thinking || block.text);
            }
            break;
          case 'document':
          case 'file': {
            const normalizedFile = normalizeFileBlock(block);
            if (normalizedFile) richParts.push(normalizedFile);
            textParts.push(textFromContentBlock(block));
            break;
          }
          case 'tool_use':
            if (role === 'assistant') {
              let args = block.input;
              if (args == null) args = {};
              const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
              toolCalls.push({
                id: block.id || `toolu_${Date.now().toString(36)}_${toolCalls.length}`,
                type: 'function',
                function: { name: block.name, arguments: argsStr },
              });
            } else {
              textParts.push(textFromContentBlock(block));
            }
            break;
          case 'tool_result':
            out.push({
              role: 'tool',
              tool_call_id: block.tool_use_id || '',
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || ''),
            });
            break;
          case 'image':
            textParts.push('[Image]');
            richParts.push(normalizeImageBlock(block));
            break;
          default:
            textParts.push(JSON.stringify(block));
        }
      }

      const entry = { role };
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls;
        entry.content = toolCalls.map(tc =>
          `<tool_calls>\n[{"name":"${tc.function.name}","arguments":${tc.function.arguments}}]\n</tool_calls>`
        ).join('\n');
      } else if (role === 'user' && richParts.some(part => part.type !== 'text')) {
        entry.content = richParts.length > 0 ? richParts : [{ type: 'text', text: textParts.join('\n') }];
      } else {
        entry.content = textParts.join('\n');
      }
      if (role === 'assistant' && thinking) {
        entry.content = `[reasoning_content]\n${thinking}\n[/reasoning_content]\n\n${entry.content}`;
      }
      out.push(entry);
    } else if (typeof content === 'string') {
      out.push({ role, content });
    } else if (content != null) {
      out.push({ role, content: String(content) });
    }
  }
  return out;
}

// 鈹€鈹€ Tool conversion (Anthropic -> OpenAI) 鈹€鈹€

function convertAnthropicTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(t => t && t.name)
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
}

function collectNonTextRichParts(messages) {
  const parts = [];
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (const part of msg.content) {
      if (part?.type && part.type !== 'text') {
        parts.push(part);
      }
    }
  }
  return parts;
}

function writeAnthropicSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  flushSSE(res);
}

// Stream tool_use blocks in Anthropic SSE format
function streamAnthropicToolUse(res, toolCalls) {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const toolId = tc.id || `toolu_${Date.now().toString(36)}_${i}`;
    writeAnthropicSSE(res, 'content_block_start', {
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: toolId, name: tc.name, input: {} },
    });
    const argsStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {});
    writeAnthropicSSE(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: argsStr },
    });
    writeAnthropicSSE(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: i,
    });
  }
}

export async function handleAnthropicMessages(req, res) {
  const { model: claudeModel, messages, system, stream = false } = req.body;
  const anthropicTools = req.body.tools;
  const anthropicToolChoice = req.body.tool_choice;

  if (!claudeModel || !messages || !messages.length) {
    return res.status(400).json({
      error: { type: 'invalid_request_error', message: 'model and messages are required' },
    });
  }

  let resolved;
  try {
    resolved = resolveModel(claudeModel);
  } catch (err) {
    return res.status(400).json({
      error: { type: 'invalid_request_error', message: err.message },
    });
  }

  const { displayModel, isNoThinking } = resolved;
  const thinkingEnabled = !isNoThinking;

  let systemText = '';
  if (typeof system === 'string') systemText = system;
  else if (Array.isArray(system)) {
    systemText = system.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
  }

  let normalizedMessages = normalizeClaudeMessages(messages);
  if (systemText) {
    normalizedMessages = [{ role: 'system', content: systemText }, ...normalizedMessages];
  }

  const tools = convertAnthropicTools(anthropicTools);
  let toolChoice = 'auto';
  if (anthropicToolChoice) {
    if (typeof anthropicToolChoice === 'object') {
      if (anthropicToolChoice.type === 'any') toolChoice = 'required';
      else if (anthropicToolChoice.type === 'tool') toolChoice = anthropicToolChoice;
      else if (anthropicToolChoice.type === 'none') toolChoice = 'none';
    } else if (anthropicToolChoice === 'any') {
      toolChoice = 'required';
    } else {
      toolChoice = anthropicToolChoice;
    }
  }
  const toolCallingEnabled = tools.length > 0 && toolChoice !== 'none';
  const isJsonTask = !toolCallingEnabled && detectJsonTask(normalizedMessages);

  const messageId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const requestStart = Date.now();
  let slot = null;

  try {
    slot = await enqueueRequest(false);
    const richParts = collectNonTextRichParts(normalizedMessages);
    const hasRichContent = richParts.length > 0;
    let result;

    if (hasRichContent) {
      try {
        const historyText = buildHistoryContextFile(normalizedMessages);
        const toolsText = buildToolsContextFile(tools, toolChoice);
        const promptNeedsContextFiles = shouldUseContextFiles(normalizedMessages, tools);
        const attachedFiles = [];

        if (promptNeedsContextFiles && historyText.trim()) {
          const historyFile = await uploadFileData(Buffer.from(historyText, 'utf8'), CONTEXT_HISTORY_FILENAME, 'text/plain; charset=utf-8', slot.token);
          attachedFiles.push(historyFile);
        }
        if (promptNeedsContextFiles && toolsText.trim()) {
          const toolsFile = await uploadFileData(Buffer.from(toolsText, 'utf8'), CONTEXT_TOOLS_FILENAME, 'text/plain; charset=utf-8', slot.token);
          attachedFiles.push(toolsFile);
        }

        const promptWithAttachments = buildPointerPrompt({
          messages: normalizedMessages,
          tools,
          toolChoice,
          thinkingEnabled,
          isJsonTask,
          hasHistoryFile: attachedFiles.some(file => file.file_name === CONTEXT_HISTORY_FILENAME),
          hasToolsFile: attachedFiles.some(file => file.file_name === CONTEXT_TOOLS_FILENAME),
        });

        const richPromptMessages = [{
          role: 'user',
          content: [
            { type: 'text', text: promptWithAttachments },
            ...richParts,
            ...(attachedFiles.length > 0 ? [{ type: 'file', file: attachedFiles }] : []),
          ],
        }];

        res.locals.chatPrompt = promptWithAttachments;
        res.locals.chatUploadedFiles = attachedFiles;
        console.log(`[anthropic] model=${claudeModel} multimodal+prompt richParts=${richParts.length} history=${attachedFiles.some(file => file.file_name === CONTEXT_HISTORY_FILENAME)} tools=${attachedFiles.some(file => file.file_name === CONTEXT_TOOLS_FILENAME)}`);
        result = await completion({ messages: richPromptMessages, accessToken: slot.token, deviceId: slot.deviceId, thinkingEnabled });
      } catch (err) {
        const fallbackPrompt = buildPrompt({ messages: normalizedMessages, tools, toolChoice, thinkingEnabled, isJsonTask });
        const fallbackMessages = [{
          role: 'user',
          content: [
            { type: 'text', text: fallbackPrompt },
            ...richParts,
          ],
        }];
        res.locals.chatPrompt = fallbackPrompt;
        console.warn(`[anthropic] multimodal prompt mode failed, falling back without context files: ${err.message}`);
        result = await completion({ messages: fallbackMessages, accessToken: slot.token, deviceId: slot.deviceId, thinkingEnabled });
      }
      res.locals.chatUploadedFiles = result.uploadedFiles || undefined;
    } else if (shouldUseContextFiles(normalizedMessages, tools)) {
      try {
        const historyText = buildHistoryContextFile(normalizedMessages);
        const toolsText = buildToolsContextFile(tools, toolChoice);
        const attachedFiles = [];

        if (historyText.trim()) {
          const historyFile = await uploadFileData(Buffer.from(historyText, 'utf8'), CONTEXT_HISTORY_FILENAME, 'text/plain; charset=utf-8', slot.token);
          attachedFiles.push(historyFile);
        }
        if (toolsText.trim()) {
          const toolsFile = await uploadFileData(Buffer.from(toolsText, 'utf8'), CONTEXT_TOOLS_FILENAME, 'text/plain; charset=utf-8', slot.token);
          attachedFiles.push(toolsFile);
        }

        const promptWithAttachments = buildPointerPrompt({
          messages: normalizedMessages,
          tools,
          toolChoice,
          thinkingEnabled,
          isJsonTask,
          hasHistoryFile: attachedFiles.some(file => file.file_name === CONTEXT_HISTORY_FILENAME),
          hasToolsFile: attachedFiles.some(file => file.file_name === CONTEXT_TOOLS_FILENAME),
        });

        const pointerMessages = [{
          role: 'user',
          content: [
            { type: 'text', text: promptWithAttachments },
            ...(attachedFiles.length > 0 ? [{ type: 'file', file: attachedFiles }] : []),
          ],
        }];

        res.locals.chatPrompt = promptWithAttachments;
        res.locals.chatUploadedFiles = attachedFiles;
        console.log(`[anthropic] model=${claudeModel} prompt+context-files history=${historyText.trim().length > 0} tools=${toolsText.trim().length > 0}`);
        result = await completion({ messages: pointerMessages, accessToken: slot.token, deviceId: slot.deviceId, thinkingEnabled });
      } catch (err) {
        const prompt = buildPrompt({ messages: normalizedMessages, tools, toolChoice, thinkingEnabled, isJsonTask });
        res.locals.chatPrompt = prompt;
        console.warn(`[anthropic] context-file mode failed, falling back to inline prompt: ${err.message}`);
        result = await completion({ prompt, accessToken: slot.token, deviceId: slot.deviceId, thinkingEnabled });
      }
    } else {
      const prompt = buildPrompt({ messages: normalizedMessages, tools, toolChoice, thinkingEnabled, isJsonTask });
      res.locals.chatPrompt = prompt;
      console.log(`[anthropic] model=${claudeModel} promptLen=${prompt.length}`);
      result = await completion({ prompt, accessToken: slot.token, deviceId: slot.deviceId, thinkingEnabled });
    }

    const { body: streamBody } = result;
    let clientGone = false;
    const onClose = () => {
      clientGone = true;
      try { streamBody.cancel(); } catch {}
    };
    req.on('close', onClose);

    try {
      if (stream) {
        await handleAnthropicStream(res, streamBody, slot, messageId, displayModel, requestStart, toolCallingEnabled, clientGone);
      } else {
        await handleAnthropicNonStream(res, streamBody, slot, messageId, displayModel, requestStart, toolCallingEnabled, clientGone);
      }
    } finally {
      req.off('close', onClose);
      slot.release();
      dispatchQueued();
    }
  } catch (err) {
    console.error('Anthropic error:', err.message);
    if (slot) { slot.release(); dispatchQueued(); }
    if (!res.headersSent) {
      res.status(500).json({ error: { type: 'internal_error', message: err.message } });
    }
  }
}

async function handleAnthropicNonStream(res, streamBody, slot, messageId, model, requestStart, toolCallingEnabled, clientGone) {
  let fullContent = '';
  let fullThinking = '';

  for await (const event of parseSSEStream(streamBody)) {
    if (clientGone) break;
    if (event.type === 'content') fullContent += event.content;
    else if (event.type === 'thinking') fullThinking += event.content;
    else if (event.type === 'conversation_id') slot.conversationId = event.conversationId;
  }

  const totalDuration = Date.now() - requestStart;
  recordTTFB(model, totalDuration);
  if (totalDuration > 0) recordTokenSpeed(model, fullContent.length + fullThinking.length, totalDuration);

  // Parse tool calls from the response
  let extracted = extractToolCallsUnified(fullContent);
  if (!extracted && fullContent) {
    console.log(`[repair] Anthropic non-stream parse failed 鈥?calling repair agent`);
    res.locals.chatRepair = true;
    const repairedContent = await repairBrokenOutput(fullContent, slot);
    if (repairedContent) {
      extracted = extractToolCallsUnified(repairedContent);
    }
  }
  if (!extracted && fullContent) {
    console.log(`[safety-net] Wrapping raw output as Speak`);
    extracted = { toolCalls: [], content: fullContent };
  }

  const content = [];
  if (fullThinking) content.push({ type: 'thinking', thinking: fullThinking });

  if (extracted) {
    // Speak text becomes text content
    if (extracted.content) {
      content.push({ type: 'text', text: extracted.content });
    }
    // Real tools become tool_use blocks
    for (const tc of (extracted.toolCalls || [])) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input,
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: fullContent || 'No response generated.' });
  }

  const hasTools = extracted?.toolCalls?.length > 0;
  res.locals.chatRawContent = fullContent;
  res.json({
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: hasTools ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: fullContent.length },
  });
}

async function handleAnthropicStream(res, streamBody, slot, messageId, model, requestStart, toolCallingEnabled, clientGone) {
  const _socket = res.socket || res.connection;
  if (_socket && typeof _socket.setNoDelay === 'function') _socket.setNoDelay(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  writeAnthropicSSE(res, 'message_start', {
    type: 'message_start',
    message: { id: messageId, type: 'message', role: 'assistant', model, content: [] },
  });
  writeAnthropicSSE(res, 'ping', { type: 'ping' });

  let firstChunkTime = null;
  let contentBuffer = '';
  let thinkingBuffer = '';
  let fullRaw = '';
  let currentBlockType = null;
  let currentBlockIndex = -1;

  const ensureBlock = (blockType) => {
    if (currentBlockType === blockType) return;
    if (currentBlockType !== null) {
      writeAnthropicSSE(res, 'content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
    }
    currentBlockType = blockType;
    currentBlockIndex++;
    writeAnthropicSSE(res, 'content_block_start', {
      type: 'content_block_start',
      index: currentBlockIndex,
      content_block: blockType === 'thinking'
        ? { type: 'thinking', thinking: '' }
        : { type: 'text', text: '' },
    });
  };

  for await (const event of parseSSEStream(streamBody)) {
    if (clientGone) break;

    if (event.type === 'content') {
      if (!firstChunkTime) {
        firstChunkTime = Date.now();
        recordTTFB(model, firstChunkTime - requestStart);
      }
      fullRaw += event.content;
      contentBuffer += event.content;
    } else if (event.type === 'thinking') {
      thinkingBuffer += event.content;
      ensureBlock('thinking');
      writeAnthropicSSE(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: currentBlockIndex,
        delta: { type: 'thinking_delta', thinking: event.content },
      });
    } else if (event.type === 'conversation_id') {
      slot.conversationId = event.conversationId;
    } else if (event.type === 'done') {
      // Close any open block
      if (currentBlockType !== null) {
        writeAnthropicSSE(res, 'content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
        currentBlockType = null;
      }

      // Parse tool calls from buffered content
      let extracted = extractToolCallsUnified(contentBuffer);
      if (!extracted && contentBuffer) {
        console.log(`[repair] Anthropic stream parse failed 鈥?calling repair agent`);
        res.locals.chatRepair = true;
        const repairedContent = await repairBrokenOutput(contentBuffer, slot);
        if (repairedContent) {
          extracted = extractToolCallsUnified(repairedContent);
        }
      }
      if (!extracted && contentBuffer) {
        console.log(`[safety-net] Wrapping raw output as Speak`);
        extracted = { toolCalls: [], content: contentBuffer };
      }

      if (extracted?.toolCalls?.length) {
        // Send Speak text as text content block
        if (extracted.content) {
          writeAnthropicSSE(res, 'content_block_start', {
            type: 'content_block_start',
            index: ++currentBlockIndex,
            content_block: { type: 'text', text: '' },
          });
          writeAnthropicSSE(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'text_delta', text: extracted.content },
          });
          writeAnthropicSSE(res, 'content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
        }
        // Send real tools as tool_use blocks
        for (const tc of extracted.toolCalls) {
          currentBlockIndex++;
          writeAnthropicSSE(res, 'content_block_start', {
            type: 'content_block_start',
            index: currentBlockIndex,
            content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
          });
          const argsStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {});
          writeAnthropicSSE(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'input_json_delta', partial_json: argsStr },
          });
          writeAnthropicSSE(res, 'content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
        }
      } else if (extracted?.content) {
        // Speak-only: send as text
        writeAnthropicSSE(res, 'content_block_start', {
          type: 'content_block_start',
          index: ++currentBlockIndex,
          content_block: { type: 'text', text: '' },
        });
        writeAnthropicSSE(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: currentBlockIndex,
          delta: { type: 'text_delta', text: extracted.content },
        });
        writeAnthropicSSE(res, 'content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
      }

      writeAnthropicSSE(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: extracted?.toolCalls?.length ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: fullRaw.length + thinkingBuffer.length },
      });
      writeAnthropicSSE(res, 'message_stop', { type: 'message_stop' });
      res.locals.chatRawContent = fullRaw;
      res.end();

      const streamDuration = Date.now() - requestStart;
      if (streamDuration > 0) recordTokenSpeed(model, fullRaw.length + thinkingBuffer.length, streamDuration);
      return;
    }
  }

  // Fallback: stream ended without 'done' event
  if (currentBlockType !== null) {
    writeAnthropicSSE(res, 'content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
  }
  writeAnthropicSSE(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: fullRaw.length + thinkingBuffer.length },
  });
  writeAnthropicSSE(res, 'message_stop', { type: 'message_stop' });
  res.locals.chatRawContent = fullRaw;
  res.end();
}

export function handleAnthropicModels(req, res) {
  const data = [{
    id: 'glm-5.2',
    type: 'model',
    object: 'model',
    created: 1700000000,
    display_name: 'GLM 5.2',
  }];
  res.json({
    object: 'list',
    data,
    first_id: data[0]?.id || null,
    last_id: data[data.length - 1]?.id || null,
    has_more: false,
  });
}

export function handleAnthropicCountTokens(req, res) {
  res.json({ input_tokens: 0 });
}


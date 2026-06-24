import { completion, parseSSEStream } from './chat.js';
import { enqueueRequest, dispatchQueued } from './queue.js';
import { recordTTFB, recordTokenSpeed } from './metrics.js';
import { buildPrompt, detectJsonTask } from './dsml.js';
import { extractToolCallsUnified, normalizeRepairedCalls, repairBrokenOutput } from './tool_interceptor.js';

function tryParseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function flushSSE(res) {
  if (res.flush) res.flush();
  else if (res._flush) res._flush();
  const socket = res.socket || res._socket;
  if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
}

// Convert interceptor output (Anthropic-style) to OpenAI tool_calls format
function toOpenAIToolCalls(interceptorCalls) {
  if (!interceptorCalls?.length) return null;
  return interceptorCalls.map(tc => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
    },
  }));
}

function mapModel(model) {
  return { modelType: 'default', isNoThinking: false };
}

function writeSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  flushSSE(res);
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(tool => tool?.type === 'function' && tool.function?.name)
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters || { type: 'object', properties: {} },
      },
    }));
}

function resolveToolChoice(toolChoice) {
  if (!toolChoice || toolChoice === 'auto') return 'auto';
  if (toolChoice === 'required') return 'required';
  if (toolChoice === 'none') return 'none';
  const forcedName = toolChoice?.function?.name;
  if (forcedName) return { type: 'tool', name: forcedName };
  return 'auto';
}

// Stream parsed tool_calls incrementally per the OpenAI streaming protocol
const ARGS_CHUNK_SIZE = 24;
function streamToolCallsIncremental(res, writeOpts, toolCalls) {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    writeSSE(res, {
      ...writeOpts,
      choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }],
    });
    const args = tc.function.arguments || '';
    for (let j = 0; j < args.length; j += ARGS_CHUNK_SIZE) {
      writeSSE(res, {
        ...writeOpts,
        choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(j, j + ARGS_CHUNK_SIZE) } }] }, finish_reason: null }],
      });
    }
  }
}

export async function handleOpenAICompletion(req, res) {
  const { model, messages, stream = false } = req.body;
  const tools = normalizeTools(req.body.tools);
  const toolChoice = resolveToolChoice(req.body.tool_choice ?? 'auto');

  if (!model || !messages || !messages.length) {
    return res.status(400).json({ error: { message: 'model and messages are required' } });
  }

  const { isNoThinking } = mapModel(model);
  const thinkingEnabled = !isNoThinking;
  const toolCallingEnabled = tools.length > 0 && toolChoice !== 'none';
  const isJsonTask = !toolCallingEnabled && detectJsonTask(messages);

  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const requestStart = Date.now();
  let slot = null;

  try {
    slot = await enqueueRequest(false);

    // Check if any message contains image_url
    function hasImageUrl(msgs) {
      for (const m of msgs) {
        if (Array.isArray(m.content)) {
          for (const p of m.content) {
            if (p.type === 'image_url') return true;
          }
        }
      }
      return false;
    }

    const hasImage = hasImageUrl(messages);
    let result;
    if (hasImage) {
      res.locals.chatPrompt = JSON.stringify(messages);
      console.log(`[openai] model=${model} multimodal request`);
      result = await completion({ messages, accessToken: slot.token, deviceId: slot.deviceId, thinkingEnabled });
    } else {
      const prompt = buildPrompt({ messages, tools, toolChoice, thinkingEnabled, isJsonTask });
      res.locals.chatPrompt = prompt;
      console.log(`[openai] model=${model} promptLen=${prompt.length}`);
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
        const _socket = req.socket || req.connection;
        if (_socket && typeof _socket.setNoDelay === 'function') _socket.setNoDelay(true);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        writeSSE(res, {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });

        let firstChunkTime = null;
        let contentBuffer = '';
        let fullRaw = '';

        for await (const event of parseSSEStream(streamBody)) {
          if (clientGone) break;

          if (event.type === 'content') {
            if (!firstChunkTime) {
              firstChunkTime = Date.now();
              recordTTFB(model, firstChunkTime - requestStart);
            }
            fullRaw += event.content;
            if (toolCallingEnabled) {
              contentBuffer += event.content;
              continue;
            }
            writeSSE(res, {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
            });
          } else if (event.type === 'thinking') {
            writeSSE(res, {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
            });
          } else if (event.type === 'done') {
            const writeOpts = {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
            };

            let parsedToolCalls = null;
            if (toolCallingEnabled) {
              let extracted = extractToolCallsUnified(contentBuffer);
              if (!extracted && contentBuffer) {
                console.log(`[repair] Streaming parse failed on ${contentBuffer.length} chars — calling repair agent`);
                res.locals.chatRepair = true;
                const repairedContent = await repairBrokenOutput(contentBuffer, slot);
                if (repairedContent) {
                  extracted = extractToolCallsUnified(repairedContent);
                  if (extracted) console.log(`[repair] Repair succeeded`);
                }
              }
              if (!extracted && contentBuffer) {
                console.log(`[safety-net] Extraction + repair both failed — wrapping raw output as Speak`);
                extracted = { toolCalls: [], content: contentBuffer };
              }
              if (extracted) {
                parsedToolCalls = { toolCalls: toOpenAIToolCalls(extracted.toolCalls), content: extracted.content };
              }
            }

            if (parsedToolCalls?.toolCalls?.length) {
              if (parsedToolCalls.content) {
                writeSSE(res, {
                  ...writeOpts,
                  choices: [{ index: 0, delta: { content: parsedToolCalls.content }, finish_reason: null }],
                });
              }
              streamToolCallsIncremental(res, writeOpts, parsedToolCalls.toolCalls);
              writeSSE(res, {
                ...writeOpts,
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              });
            } else {
              if (parsedToolCalls?.content) {
                writeSSE(res, {
                  ...writeOpts,
                  choices: [{ index: 0, delta: { content: parsedToolCalls.content }, finish_reason: null }],
                });
              } else if (toolCallingEnabled && contentBuffer) {
                writeSSE(res, {
                  ...writeOpts,
                  choices: [{ index: 0, delta: { content: contentBuffer }, finish_reason: null }],
                });
              }
              writeSSE(res, {
                ...writeOpts,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              });
            }
            res.write('data: [DONE]\n\n');
            flushSSE(res);

            const streamDuration = Date.now() - requestStart;
            if (streamDuration > 0) {
              recordTokenSpeed(model, fullRaw.length, streamDuration);
            }
          } else if (event.type === 'conversation_id') {
            slot.conversationId = event.conversationId;
          }
        }
        res.locals.chatRawContent = fullRaw;
        res.end();
      } else {
        // Non-streaming
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

        let extracted = toolCallingEnabled ? extractToolCallsUnified(fullContent) : null;
        if (!extracted && toolCallingEnabled && fullContent) {
          console.log(`[repair] Non-stream parse failed on ${fullContent.length} chars — calling repair agent`);
          res.locals.chatRepair = true;
          const repairedContent = await repairBrokenOutput(fullContent, slot);
          if (repairedContent) {
            extracted = extractToolCallsUnified(repairedContent);
            if (extracted) console.log(`[repair] Repair succeeded`);
          }
        }
        if (!extracted && toolCallingEnabled && fullContent) {
          console.log(`[safety-net] Extraction + repair both failed — wrapping raw output as Speak`);
          extracted = { toolCalls: [], content: fullContent };
        }
        const parsedToolCalls = extracted
          ? { toolCalls: toOpenAIToolCalls(extracted.toolCalls), content: extracted.content }
          : null;
        const hasTools = parsedToolCalls?.toolCalls?.length > 0;
        const hasContent = parsedToolCalls?.content?.length > 0;

        const message = hasTools
          ? {
              role: 'assistant',
              content: parsedToolCalls.content || null,
              tool_calls: parsedToolCalls.toolCalls,
              ...(fullThinking ? { reasoning_content: fullThinking } : {}),
            }
          : {
              role: 'assistant',
              content: hasContent ? parsedToolCalls.content : fullContent,
              ...(fullThinking ? { reasoning_content: fullThinking } : {}),
            };

        const response = {
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message,
            finish_reason: hasTools ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: fullContent.length, total_tokens: fullContent.length },
        };
        res.locals.chatRawContent = fullContent;
        res.json(response);
      }
    } finally {
      req.off('close', onClose);
      slot.release();
      dispatchQueued();
    }
  } catch (err) {
    console.error('Completion error:', err.message);
    if (slot) { slot.release(); dispatchQueued(); }
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      res.end();
    }
  }
}

export function handleOpenAIModels(req, res) {
  const allModels = ['glm-5.2'];
  res.json({
    object: 'list',
    data: allModels.map((id, i) => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'glm',
    })),
  });
}

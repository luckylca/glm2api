import { completion, parseSSEStream } from './chat.js';
import { dispatchQueued } from './queue.js';
import { enqueueRequest } from './queue.js';

function flushSSE(res) {
  if (res.flush) res.flush();
  else if (res._flush) res._flush();
  const socket = res.socket || res._socket;
  if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
}

const MODEL_MAP = {
  'glm-5.2': 'default',
  'glm-5.2-think': 'default',
  'glm-5.2-nothink': 'default',
};

export async function handleGLMCompletion(req, res) {
  const body = req.body;
  const modelType = MODEL_MAP[body.model] || 'default';
  const prompt = body.prompt || '';
  const thinkingEnabled = body.thinking_enabled ?? false;

  if (!prompt) {
    return res.status(400).json({ code: 1, msg: 'prompt is required' });
  }

  let slot = null;
  let onClose = null;

  try {
    slot = await enqueueRequest(false);

    onClose = () => {};
    req.on('close', onClose);

    const socket = req.socket || req.connection;
    if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

    const result = await completion({
      messages: [{ role: 'user', content: prompt }],
      thinkingEnabled,
      accessToken: slot.token,
      deviceId: slot.deviceId,
    });

    const streamBody = result.body;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });

    const reader = streamBody.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        flushSSE(res);
      }
    } finally {
      reader.releaseLock();
    }
    res.end();
  } catch (err) {
    console.error('GLM completion error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ code: 1, msg: err.message });
    } else {
      res.end();
    }
  } finally {
    if (onClose) req.off('close', onClose);
    if (slot) {
      slot.release();
      dispatchQueued();
    }
  }
}

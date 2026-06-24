import { createHash, randomUUID } from 'crypto';
import { basename } from 'path';

const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';
const BASE = 'https://chatglm.cn';
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796';
const REAL_EXP_GROUPS = 'na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,app_welcome_v2:exp:B,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable';

export function generateSign() {
  const e = Date.now();
  const A = e.toString();
  const t = A.length;
  const o = A.split('').map((c) => Number(c));
  const i = o.reduce((sum, v) => sum + v, 0) - o[t - 2];
  const a = i % 10;
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t);
  const nonce = randomUUID().replace(/-/g, '');
  const sign = createHash('md5').update(`${timestamp}-${nonce}-${SIGN_SECRET}`).digest('hex');
  return { timestamp, nonce, sign };
}

export function generateDeviceId() {
  return randomUUID().replace(/-/g, '');
}

// Refresh token → access token
export async function getAccessToken(refreshToken) {
  const sign = generateSign();
  const deviceId = generateDeviceId();

  const res = await fetch(`${BASE}/chatglm/user-api/user/refresh`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${refreshToken}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'App-Name': 'chatglm',
      'Origin': 'https://chatglm.cn',
      'X-App-Fr': 'default',
      'X-App-Platform': 'pc',
      'X-App-Version': '0.0.1',
      'X-Device-Brand': '',
      'X-Device-Id': deviceId,
      'X-Device-Model': '',
      'X-Exp-Groups': REAL_EXP_GROUPS,
      'X-Lang': 'zh',
      'X-Nonce': sign.nonce,
      'X-Request-Id': randomUUID().replace(/-/g, ''),
      'X-Sign': sign.sign,
      'X-Timestamp': sign.timestamp,
    },
  });

  const data = await res.json();
  if (data.code === 0 || data.status === 0) {
    return { accessToken: data.result?.access_token, deviceId };
  }
  throw new Error(`Token refresh failed: ${data.message || data.msg || JSON.stringify(data)}`);
}

// Extract image/file URLs from messages (OpenAI format)
function extractFileUrlsFromMessages(messages) {
  const urls = [];
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          urls.push({ url: part.image_url.url, type: 'image' });
        } else if (part.type === 'file' && part.file?.url) {
          urls.push({ url: part.file.url, type: 'file' });
        }
      }
    }
  }
  return urls;
}

// Upload a file to GLM
async function uploadFile(fileUrl, accessToken) {
  let fileData, filename, mimeType;
  if (fileUrl.startsWith('data:')) {
    // Data URL
    const [header, base64] = fileUrl.split(',');
    const mime = header.match(/:(.+?);/)[1];
    const ext = mime.split('/')[1] || 'bin';
    filename = `upload.${ext}`;
    fileData = Buffer.from(base64, 'base64');
    mimeType = mime;
  } else {
    // Regular URL
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`Failed to fetch file: ${resp.status}`);
    filename = basename(new URL(fileUrl).pathname) || 'file';
    fileData = Buffer.from(await resp.arrayBuffer());
    mimeType = resp.headers.get('content-type') || 'application/octet-stream';
  }

  const form = new FormData();
  const blob = new Blob([fileData], { type: mimeType });
  form.append('file', blob, filename);

  const sign = generateSign();
  const deviceId = generateDeviceId();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'X-Device-Id': deviceId,
    'X-Nonce': sign.nonce,
    'X-Request-Id': randomUUID().replace(/-/g, ''),
    'X-Sign': sign.sign,
    'X-Timestamp': sign.timestamp,
    'Referer': 'https://chatglm.cn/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  };
  const uploadResp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/file_upload', {
    method: 'POST',
    headers,
    body: form,
  });
  const result = await uploadResp.json();
  if (result.status !== 0) {
    throw new Error(`Upload failed: ${JSON.stringify(result)}`);
  }
  return result.result; // { file_id, file_url, width, height, file_name, file_size }
}

// Build GLM-compatible messages with uploaded file references
function buildGlmMessages(messages, uploadedFiles) {
  // Separate files and images
  const fileRefs = [];
  const imageRefs = [];
  for (const file of uploadedFiles) {
    if (file.width !== undefined && file.height !== undefined) {
      imageRefs.push({ ...file, image_url: file.file_url });
    } else {
      fileRefs.push(file);
    }
  }

  // Build text content from all messages
  let fullText = '';
  for (const msg of messages) {
    const role = msg.role.replace('system', '<|sytstem|>').replace('assistant', '<|assistant|>').replace('user', '<|user|>');
    if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
      fullText += `${role}\n${textParts}\n`;
    } else if (typeof msg.content === 'string') {
      fullText += `${role}\n${msg.content}\n`;
    }
  }
  fullText += '<|assistant|>\n';

  const content = [{ type: 'text', text: fullText }];
  if (fileRefs.length > 0) {
    content.push({ type: 'file', file: fileRefs });
  }
  if (imageRefs.length > 0) {
    content.push({ type: 'image', image: imageRefs });
  }
  return [{ role: 'user', content }];
}

// Format messages for chatglm.cn (text-only fallback)
function messagesPrepare(messages) {
  if (messages.length === 1) {
    return [{
      role: 'user',
      content: [{ type: 'text', text: messages[0].content }],
    }];
  }
  const content = messages.reduce((acc, msg) => {
    const role = msg.role.replace('assistant', '♂').replace('user', '♂');
    return (acc += `${role}\n${msg.content}`);
  }, '') + '♂\n';
  return [{ role: 'user', content: [{ type: 'text', text: content }] }];
}

// Send chat request to chatglm.cn
// Accept either `messages` (array of {role,content}) or `prompt` (raw text string).
// When `prompt` is provided, it wraps the text as a single user message for GLM.
// assistantPrefill: injected as an assistant-role message after the user message,
//   tricking GLM into thinking it already committed to a JSON TOOL_DISPATCH format.
export async function completion({ messages, prompt, thinkingEnabled = false, searchEnabled = false, accessToken, deviceId }) {
  const sign = generateSign();
  const devId = deviceId || generateDeviceId();
  const requestId = randomUUID().replace(/-/g, '');

  let chatMessages;
  let uploadedFiles = [];

  if (prompt) {
    chatMessages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
  } else if (messages) {
    // Check for image/file references in messages
    const fileUrls = extractFileUrlsFromMessages(messages);
    if (fileUrls.length > 0) {
      // Upload all files
      for (const { url, type } of fileUrls) {
        try {
          const fileInfo = await uploadFile(url, accessToken);
          uploadedFiles.push(fileInfo);
        } catch (err) {
          console.error(`Failed to upload ${type} from ${url}:`, err.message);
          throw new Error(`File upload failed: ${err.message}`);
        }
      }
      // Build GLM messages with uploaded file refs
      chatMessages = buildGlmMessages(messages, uploadedFiles);
    } else {
      // No files, use text-only fallback
      chatMessages = messagesPrepare(messages);
    }
  } else {
    throw new Error('Either messages or prompt is required');
  }

  const metaData = {
    channel: '',
    draft_id: '',
    if_plus_model: true,
    input_question_type: 'xxxx',
    is_networking: searchEnabled,
    is_test: false,
    platform: 'pc',
    quote_log_id: '',
    cogview: { rm_label_watermark: false },
  };

  if (thinkingEnabled) {
    metaData.chat_mode = 'zero';
    metaData.think = true;
  }

  const res = await fetch(`${BASE}/chatglm/backend-api/assistant/stream`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'App-Name': 'chatglm',
      'Cache-Control': 'no-cache',
      'Origin': 'https://chatglm.cn',
      'Pragma': 'no-cache',
      'Referer': 'https://chatglm.cn/main/alltoolsdetail',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'X-App-Fr': 'default',
      'X-App-Platform': 'pc',
      'X-App-Version': '0.0.1',
      'X-Device-Brand': '',
      'X-Device-Id': devId,
      'X-Device-Model': '',
      'X-Exp-Groups': REAL_EXP_GROUPS,
      'X-Lang': 'zh',
      'X-Nonce': sign.nonce,
      'X-Request-Id': requestId,
      'X-Sign': sign.sign,
      'X-Timestamp': sign.timestamp,
    },
    body: JSON.stringify({
      assistant_id: DEFAULT_ASSISTANT_ID,
      conversation_id: '',
      project_id: '',
      chat_type: 'user_chat',
      messages: chatMessages,
      meta_data: metaData,
    }),
  });

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const text = await res.text();
    throw new Error(`GLM API returned non-SSE response: ${text.substring(0, 300)}`);
  }

  return { body: res.body, conversationId: null };
}

// Parse chatglm.cn SSE stream → standard events
// chatglm.cn sends CUMULATIVE text per logic_id on each update, not deltas.
// We track last emitted content per logic_id and only yield the new portion.
export async function* parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let conversationId = '';
  let buffer = '';
  const lastContent = new Map(); // key: `${type}_${logicId}` → last full text

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;

        try {
          const data = JSON.parse(dataStr);

          if (data.conversation_id && !conversationId) {
            conversationId = data.conversation_id;
            yield { type: 'conversation_id', conversationId };
          }

          if (data.parts) {
            for (const part of data.parts) {
              if (Array.isArray(part.content)) {
                for (const item of part.content) {
                  const logicId = part.logic_id || '';
                  const key = `${item.type}_${logicId}`;
                  const prev = lastContent.get(key) || '';

                  if (item.type === 'text' && item.text && item.text.length > prev.length) {
                    const delta = item.text.slice(prev.length);
                    lastContent.set(key, item.text);
                    yield { type: 'content', content: delta };
                  }
                  if (item.type === 'think' && item.think && item.think.length > prev.length) {
                    const delta = item.think.slice(prev.length);
                    lastContent.set(key, item.think);
                    yield { type: 'thinking', content: delta };
                  }
                }
              }
            }
          }

          if (data.status === 'finish') {
            yield { type: 'done', conversationId };
            return;
          }
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

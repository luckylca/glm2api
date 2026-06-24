import { enqueueRequest, dispatchQueued } from './queue.js';
import crypto from 'node:crypto';

const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';
const ASSISTANT_ID = '65a232c082ff90a2ad2f15e2';
const BASE = 'https://chatglm.cn';
const REAL_EXP_GROUPS = 'na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,app_welcome_v2:exp:B,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable';

function uuid() {
  return crypto.randomUUID();
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function generateSign() {
  const e = Date.now();
  const A = e.toString();
  const t = A.length;
  const o = A.split('').map(c => Number(c));
  const i = o.reduce((sum, v) => sum + v, 0) - o[t - 2];
  const a = i % 10;
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t);
  const nonce = uuid().replace(/-/g, '');
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SECRET}`);
  return { sign, timestamp, nonce };
}

function getHeaders() {
  return {
    'Accept': 'text/event-stream',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'App-Name': 'chatglm',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json',
    'Origin': 'https://chatglm.cn',
    'Pragma': 'no-cache',
    'Referer': 'https://chatglm.cn/main/gdetail/' + ASSISTANT_ID,
    'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'X-App-Platform': 'pc',
    'X-App-Version': '0.0.1',
    'X-App-Fr': 'default',
    'X-Device-Brand': '',
    'X-Device-Model': '',
    'X-Lang': 'zh',
    'X-Exp-Groups': REAL_EXP_GROUPS
  };
}

export async function handleImageGeneration(req, res) {
  const { prompt, n = 1, size, model = 'cogview' } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: { message: 'prompt is required and must be a string' } });
  }

  let slot = null;
  try {
    slot = await enqueueRequest(false);
    const accessToken = slot.token;

    const fullPrompt = prompt.includes('画') ? prompt : `请画：${prompt}`;
    const sign = generateSign();
    const body = {
      assistant_id: ASSISTANT_ID,
      conversation_id: '',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: fullPrompt + '\n' }]
      }],
      meta_data: {
        channel: '',
        draft_id: '',
        if_plus_model: true,
        input_question_type: 'xxxx',
        is_test: false,
        platform: 'pc',
        quote_log_id: '',
        cogview: { rm_label_watermark: false }
      }
    };

    const response = await fetch(`${BASE}/chatglm/backend-api/assistant/stream`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        ...getHeaders(),
        'X-Device-Id': uuid(),
        'X-Nonce': sign.nonce,
        'X-Request-Id': uuid(),
        'X-Sign': sign.sign,
        'X-Timestamp': sign.timestamp
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Image generation request failed: ${response.status} ${errText.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const imageUrls = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const obj = JSON.parse(data);
          // Convert entire object to string and match URLs
          const str = JSON.stringify(obj);
          const urlMatch = str.match(/https?:\/\/[^"'\s<>)]+\.(?:png|jpg|jpeg|webp)(\?[^"'\s<>)]*)?/gi);
          if (urlMatch) {
            for (const u of urlMatch) {
              if (!imageUrls.includes(u)) imageUrls.push(u);
            }
          }
        } catch { /* skip non-JSON */ }
      }
    }

    if (imageUrls.length === 0) {
      throw new Error('No image URLs found in response');
    }

    const data = imageUrls.slice(0, Math.min(n, imageUrls.length)).map(url => ({
      url,
    }));

    res.json({
      created: Math.floor(Date.now() / 1000),
      data,
    });

  } catch (err) {
    console.error('Image generation error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    }
  } finally {
    if (slot) {
      slot.release();
      dispatchQueued();
    }
  }
}

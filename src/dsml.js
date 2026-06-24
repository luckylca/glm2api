// ── Prompt builder & stream interceptor system ─────────────────────────────
// Neutral Addendum Pattern — preserves the client's original system prompt and
// appends tool-calling capability as a Markdown JSON code-block addendum.
// No XML tags, no token markers — WAF-safe.

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Tool schema compression
// ═══════════════════════════════════════════════════════════════════════════

export function compressTools(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    return { compressedStr: 'No tools available.', names: [] };
  }

  const toolNames = [];
  const compressedList = tools.map(t => {
    const isOpenAI = t.type === 'function' && t.function;
    const name = isOpenAI ? t.function.name : t.name;
    let desc = (isOpenAI ? t.function.description : t.description) || 'No description';
    const params = isOpenAI ? t.function.parameters : t.input_schema;

    toolNames.push(name);

    // ── Description de-noising ──
    // Claude Code tools carry huge descriptions with examples and XML
    // instructions aimed at Sonnet/Opus. GLM gets confused by the noise.
    if (desc && typeof desc === 'string') {
      // 1. Strip XML blocks: <example>...</example>, <instructions>...</instructions>, etc.
      desc = desc.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '');
      // 2. Hard truncate at 300 chars — keep the first paragraph only
      if (desc.length > 300) {
        desc = desc.split(/\n# |\n\n/)[0].substring(0, 300) + '...(truncated)';
      }
    }

    return `Tool: ${name}\nDescription: ${desc}\nParameters: ${JSON.stringify(params)}`;
  });

  return {
    compressedStr: compressedList.join('\n\n'),
    names: toolNames,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: History cleaning & truncation
// ═══════════════════════════════════════════════════════════════════════════

// ── Sub-agent log detection ────────────────────────────────────────────────
// Claude Code sub-agents (Explore, Plan, etc.) produce console logs with
// formatting like [Called tools: Glob], --- separators, and narrative text.
// GLM mistakes these for valid conversation formatting and imitates them.
// Detection: content containing sub-agent console markers.
// Quarantine: <subagent_history_log> preserves info while blocking imitation.

function isSubagentLog(content) {
  if (!content || typeof content !== 'string') return false;
  if (/\[Called tool[s]?:/.test(content)) return true;
  if (content.length > 800 && /^---/m.test(content) && /\b(sub.?agent|explore|plan)\b/i.test(content)) return true;
  return false;
}

export function processMessages(messages) {
  if (!messages || messages.length === 0) return '';

  let historyText = '';
  let toolResultCount = 0;

  // Reverse-pass: mark tool results for truncation (keep only last 2)
  const processedMessages = messages.map(m => ({ ...m }));
  for (let i = processedMessages.length - 1; i >= 0; i--) {
    if (processedMessages[i].role === 'tool' || processedMessages[i].role === 'function') {
      toolResultCount++;
      if (toolResultCount > 2) {
        processedMessages[i] = {
          ...processedMessages[i],
          content: '[result omitted]',
        };
      }
    }
  }

  // Forward-pass: build history text
  for (const msg of processedMessages) {
    if (msg.role === 'system') continue; // system prompts go into the header

    if (msg.role === 'user') {
      const content = normalizeContent(msg.content);
      historyText += `\n### User:\n${content}\n`;
    } else if (msg.role === 'tool' || msg.role === 'function') {
      const name = msg.name || msg.tool_call_id || 'tool';
      const content = normalizeContent(msg.content);
      // Quarantine sub-agent console logs to prevent format contamination
      if (isSubagentLog(content)) {
        historyText += `\n### User:\n[Tool Result: ${name}]\n<subagent_history_log>\n${content}\n</subagent_history_log>\n`;
      } else {
        historyText += `\n### User:\n[Tool Result: ${name}]\n${content}\n`;
      }
    } else if (msg.role === 'assistant') {
      historyText += `\n### Assistant:\n`;

      // Gather clean text content
      let cleanText = '';
      if (msg.content && typeof msg.content === 'string') {
        cleanText = msg.content
          .replace(/```json[\s\S]*?```/g, '')
          .replace(/<\|?DSML\|?tool_calls>[\s\S]*?<\/\|?DSML\|?tool_calls>/g, '')
          .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
          .replace(/<invoke[\s\S]*?<\/invoke>/g, '')
          .replace(/<arguments>[\s\S]*?<\/arguments>/g, '')
          .replace(/\[\s*\{\s*"name"[\s\S]*?\]/g, '')
          .trim();
      }

      // Format tool_calls as TOOL_DISPATCH Markdown JSON code block
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const dispatchArr = msg.tool_calls.map(tool => {
          const fnName = tool.function?.name || tool.name || 'unknown';
          let argsObj = {};
          try {
            argsObj = JSON.parse(tool.function?.arguments || '{}');
          } catch {
            argsObj = { raw_args: tool.function?.arguments || '{}' };
          }
          return { tool: fnName, args: argsObj };
        });

        // If cleanText exists and isn't already part of tool_calls, prepend as Speak
        if (cleanText && !cleanText.includes('TOOL_DISPATCH')) {
          dispatchArr.unshift({ tool: 'Speak', args: { text: cleanText } });
        }
        const dispatchWrapper = { TOOL_DISPATCH: dispatchArr };
        historyText += '\n```json\n' + JSON.stringify(dispatchWrapper, null, 2) + '\n```\n';
      } else if (cleanText) {
        // Plain text assistant response: wrap in TOOL_DISPATCH Speak to maintain format consistency
        if (!cleanText.includes('TOOL_DISPATCH')) {
          const fakeJson = { TOOL_DISPATCH: [{ tool: 'Speak', args: { text: cleanText } }] };
          historyText += '\n```json\n' + JSON.stringify(fakeJson, null, 2) + '\n```\n';
        } else {
          historyText += `${cleanText}\n`;
        }
      }
    }
  }

  return historyText;
}

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image_url') return '[Image]';
      if (part.type === 'image') return '[Image]';
      return JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(content);
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Sandwich prompt builder
// ═══════════════════════════════════════════════════════════════════════════

export function detectJsonTask(messages) {
  for (const msg of messages) {
    if (msg.role !== 'system' && msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
    if (/\bjson\b/i.test(content)) return true;
    if (/return\s+.*\bjson\b/i.test(content)) return true;
    if (/\bjson\s+output\b/i.test(content)) return true;
  }
  return false;
}

export function toolChoiceInstruction(toolChoice) {
  if (!toolChoice || toolChoice === 'auto') return '';
  if (toolChoice === 'any' || toolChoice === 'required') return '- For this response, you MUST call at least one tool.\n';
  if (toolChoice === 'none') return '';
  if (typeof toolChoice === 'object' && toolChoice.type === 'tool' && toolChoice.name) {
    return `- For this response, you MUST call ONLY the tool "${toolChoice.name}".\n`;
  }
  return '';
}

// ── File content generators for HISTORY.txt / TOOLS.txt ──




export function buildPrompt({ messages, tools = [], toolChoice = 'auto', thinkingEnabled = false, isJsonTask = false }) {
  const toolsInfo = compressTools(tools);
  const toolCallingEnabled = tools.length > 0 && toolChoice !== 'none';

  // ── Collect system messages (client's original system prompt) ──
  let systemContent = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemContent += (systemContent ? '\n\n' : '') + normalizeContent(msg.content);
    }
  }

  let finalPrompt = '';

  // LAYER 1: [SYSTEM] — Client's native system prompt (persona)
  if (systemContent) {
    finalPrompt += `[SYSTEM]\n${systemContent}\n\n`;
  }

  // LAYER 2: [DATA] — Reference material (tools + history)
  if (toolCallingEnabled) {
    finalPrompt += `[DATA: AVAILABLE TOOLS]\nYour available tools and their JSON schemas:\n\n${toolsInfo.compressedStr}\n\n`;
    const forced = toolChoiceInstruction(toolChoice);
    if (forced) {
      finalPrompt += `${forced}\n`;
    }
  }

  // Inject fake Chinese conversation FIRST — primes JSON format + identity
  if (toolCallingEnabled) {
    finalPrompt += `[DATA: FORMAT PRIMER]\n`;
    for (const msg of buildFakeHistory()) {
      if (msg.role === 'user') {
        finalPrompt += `\n### User:\n${msg.content}\n`;
      } else if (msg.role === 'assistant') {
        finalPrompt += `\n### Assistant:\n${msg.content}\n`;
      }
    }
    finalPrompt += '\n';
  }

  // Real conversation history LAST — so current user question is most recent
  const historyText = processMessages(messages);
  if (historyText) {
    finalPrompt += `[DATA: CONVERSATION HISTORY]\n${historyText}\n`;
  }

  if (toolCallingEnabled) {
    finalPrompt += `\n[CRITICAL INSTRUCTION FOR LOCAL DIRECTORIES]\nYou MUST NOT use 'open_url' to view local paths like C:\\Users\\.... It will fail.\nTo explore the project, you MUST use the 'Glob', 'Bash' (with ls command), or 'Read' tools inside your TOOL_DISPATCH JSON.\n\nPlease generate your JSON payload:\n\n### Assistant:\n`;
  } else if (isJsonTask) {
    finalPrompt += `\n> [System Reminder]: Output pure JSON starting with {. No Markdown wrapping.\n\n### Assistant:\n{`;
  } else {
    finalPrompt += '\n### Assistant:\n';
  }

  return finalPrompt;
}

// ── Pointer Prompt (file upload mode) ───────────────────────────────────


// ── Fake History Primer ─────────────────────────────────────────────────
// Injected before the Gateway Protocol to prime GLM with natural Chinese
// conversation. Includes thinking content to normalize reasoning format.
// Date is filled dynamically.
export function buildFakeHistory() {
  const now = new Date();
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const dateStr = `今天是${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日，${weekdays[now.getDay()]}。`;

  const identityText = '你好！我是智谱清言，您可以叫我"清言"。我是基于智谱AI发布的 GLM-5.2 模型开发的，支持长文本上下文。有什么我可以帮助您的吗？';
  const dateText = dateStr;

  return [
    {
      role: 'user',
      content: '你好，你是谁',
    },
    {
      role: 'assistant',
      content: `\`\`\`json
{
  "TOOL_DISPATCH": [
    {
      "tool": "Speak",
      "args": {
        "text": "${identityText}"
      }
    }
  ]
}
\`\`\``,
    },
    {
      role: 'user',
      content: '今天是什么日期',
    },
    {
      role: 'assistant',
      content: `\`\`\`json
{
  "TOOL_DISPATCH": [
    {
      "tool": "Speak",
      "args": {
        "text": "${dateText}"
      }
    }
  ]
}
\`\`\``,
    },
    {
      role: 'user',
      content: '为了测试本地网关的工具链是否畅通，请你先在当前目录创建一个名为 test_hello.txt 的测试文件，里面写上 "hello world"，然后用 Bash 查找它并读取它的内容。请把这些操作放在一次回复里。',
    },
    {
      role: 'assistant',
      content: `\`\`\`json
{
  "TOOL_DISPATCH": [
    {
      "tool": "Speak",
      "args": {
        "text": "收到，我正在为您执行全链路工具测试：写入、查找并读取测试文件。"
      }
    },
    {
      "tool": "Bash",
      "args": {
        "command": "echo 'hello world' > test_hello.txt && echo '文件创建成功'"
      }
    },
    {
      "tool": "Bash",
      "args": {
        "command": "ls -la test_hello.txt"
      }
    },
    {
      "tool": "Bash",
      "args": {
        "command": "cat test_hello.txt"
      }
    }
  ]
}
\`\`\``,
    },
  ];
}

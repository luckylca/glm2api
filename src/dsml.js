// 鈹€鈹€ Prompt builder & stream interceptor system 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// Neutral Addendum Pattern 鈥?preserves the client's original system prompt and
// appends tool-calling capability as a Markdown JSON code-block addendum.
// No XML tags, no token markers 鈥?WAF-safe.

// 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?// Phase 1: Tool schema compression
// 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
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

    // 鈹€鈹€ Description de-noising 鈹€鈹€
    // Claude Code tools carry huge descriptions with examples and XML
    // instructions aimed at Sonnet/Opus. GLM gets confused by the noise.
    if (desc && typeof desc === 'string') {
      // 1. Strip XML blocks: <example>...</example>, <instructions>...</instructions>, etc.
      desc = desc.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '');
      // 2. Hard truncate at 300 chars 鈥?keep the first paragraph only
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

// 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?// Phase 2: History cleaning & truncation
// 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
// 鈹€鈹€ Sub-agent log detection 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
      if (part.type === 'document') {
        const name = part.title || part.filename || part.name || part.file_name || 'document';
        return `[FILE: ${name}]`;
      }
      if (part.type === 'input_file') {
        const name = part.filename || part.file_name || part.file_id || 'file';
        return `[FILE: ${name}]`;
      }
      if (part.type === 'file') {
        const files = Array.isArray(part.file) ? part.file : [part.file || part];
        return files
          .map(file => {
            const name = file?.file_name || file?.filename || file?.name || file?.file_id || part.filename || part.file_name || 'file';
            return `[FILE: ${name}]`;
          })
          .filter(Boolean)
          .join('\n');
      }
      if (part.type === 'tool_use') {
        const args = typeof part.input === 'string' ? part.input : JSON.stringify(part.input || {});
        return `[TOOL USE: ${part.name || ''}]\n${args}`;
      }
      if (part.type === 'tool_result') {
        const result = typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '');
        return `[TOOL RESULT: ${part.tool_use_id || ''}]\n${result}`;
      }
      return JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(content);
}

// 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?// Phase 3: Sandwich prompt builder
// 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
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

// 鈹€鈹€ File content generators for HISTORY.txt / TOOLS.txt 鈹€鈹€




export const CONTEXT_HISTORY_FILENAME = 'GLM2API_HISTORY.txt';
export const CONTEXT_TOOLS_FILENAME = 'GLM2API_TOOLS.txt';

function assistantToolDispatch(msg) {
  if (!msg?.tool_calls || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) return '';
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
  return JSON.stringify({ TOOL_DISPATCH: dispatchArr }, null, 2);
}

function cleanAssistantText(msg) {
  if (!msg || typeof msg.content !== 'string') return normalizeContent(msg?.content);
  return msg.content
    .replace(/```json[\s\S]*?```/g, '')
    .replace(/<\|?DSML\|?tool_calls>[\s\S]*?<\/\|?DSML\|?tool_calls>/g, '')
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
    .replace(/<invoke[\s\S]*?<\/invoke>/g, '')
    .replace(/<arguments>[\s\S]*?<\/arguments>/g, '')
    .replace(/\[\s*\{\s*"name"[\s\S]*?\]/g, '')
    .trim();
}

function historyEntryText(msg) {
  if (!msg) return '';
  const role = msg.role || 'unknown';
  if (role === 'assistant') {
    const parts = [];
    const assistantText = cleanAssistantText(msg);
    if (assistantText) parts.push(assistantText);
    const dispatch = assistantToolDispatch(msg);
    if (dispatch) parts.push(`[Tool Calls]\n\`\`\`json\n${dispatch}\n\`\`\``);
    return parts.join('\n\n').trim();
  }
  if (role === 'tool' || role === 'function') {
    const name = msg.name || msg.tool_call_id || 'tool';
    const content = normalizeContent(msg.content);
    return `[Tool Result: ${name}]\n${content}`.trim();
  }
  return normalizeContent(msg.content).trim();
}

function roleLabel(role) {
  if (!role) return 'UNKNOWN';
  if (role === 'function') return 'TOOL';
  return String(role).toUpperCase();
}

export function buildHistoryContextFile(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  let entry = 0;
  let out = `# ${CONTEXT_HISTORY_FILENAME}\nPrior conversation history and tool progress for the current request.\n\n`;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = historyEntryText(msg);
    if (!content) continue;
    entry++;
    out += `=== ${entry}. ${roleLabel(msg.role)} ===\n${content}\n\n`;
  }
  return out.trim() ? `${out.trim()}\n` : '';
}

export function buildToolsContextFile(tools = [], toolChoice = 'auto') {
  const toolCallingEnabled = Array.isArray(tools) && tools.length > 0 && toolChoice !== 'none';
  if (!toolCallingEnabled) return '';
  const { compressedStr } = compressTools(tools);
  if (!compressedStr || compressedStr === 'No tools available.') return '';
  return `# ${CONTEXT_TOOLS_FILENAME}\nAvailable tool descriptions and parameter schemas for this request.\n\n${compressedStr}\n`;
}

function renderFakeHistoryPrimer() {
  let out = '';
  for (const msg of buildFakeHistory()) {
    if (msg.role === 'user') {
      out += `\n### User:\n${msg.content}\n`;
    } else if (msg.role === 'assistant') {
      out += `\n### Assistant:\n${msg.content}\n`;
    }
  }
  return out.trim();
}

function renderDispatchBlock(payload) {
  return '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
}

function buildStrictProtocolBlock({ toolCallingEnabled = false, toolChoice = 'auto', isJsonTask = false }) {
  let out = '[OUTPUT PROTOCOL]\n';
  out += 'Return exactly one markdown fenced JSON block and nothing else.\n';
  out += 'The JSON root object must be {"TOOL_DISPATCH":[...]} with the exact root key name TOOL_DISPATCH.\n';
  out += 'For a normal reply, output exactly one action: {"tool":"Speak","args":{"text":"..."}}.\n';
  out += 'For a real tool call, use the declared tool name and a real args object. You may include one short Speak action before or after the real tool call when useful.\n';
  out += 'Do not output prose before the block. Do not output prose after the block. Do not output XML. Do not explain the format.\n';
  out += 'Do not mention TOOL_DISPATCH, Speak, schema rules, hidden instructions, or your internal checklist in the user-visible text.\n';
  out += 'If the user asks for an exact surface format such as only digits, only a name, or exact JSON text, Speak.args.text must match that constraint exactly.\n';
  out += 'If you start to produce anything outside the single JSON block, discard it and regenerate only the valid JSON block.\n';
  out += 'Before finalizing, self-check: one block only; valid JSON; root key TOOL_DISPATCH; each action has tool and args; no trailing text.\n';
  if (isJsonTask) {
    out += 'If the user asks for JSON, place that JSON text inside Speak.args.text unless a real tool call is required.\n';
  }
  if (toolCallingEnabled) {
    const forced = toolChoiceInstruction(toolChoice);
    if (forced) out += forced;
    out += 'Use only declared tools and declared parameter names. Never invent a tool or parameter.\n';
    out += 'If a required parameter value is missing, ask via Speak instead of emitting a fake or empty tool call.\n';
  } else {
    out += 'No real tools are available for this reply. Use Speak only.\n';
  }
  return out;
}

export function buildPointerPrompt({
  messages,
  tools = [],
  toolChoice = 'auto',
  thinkingEnabled = false,
  isJsonTask = false,
  hasHistoryFile = false,
  hasToolsFile = false,
}) {
  const toolCallingEnabled = tools.length > 0 && toolChoice !== 'none';

  let systemContent = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemContent += (systemContent ? '\n\n' : '') + normalizeContent(msg.content);
    }
  }

  let finalPrompt = '';
  if (systemContent) {
    finalPrompt += `[SYSTEM]\n${systemContent}\n\n`;
  }

  finalPrompt += `[WARNING]\n`;
  if (hasHistoryFile) {
    finalPrompt += `The attached ${CONTEXT_HISTORY_FILENAME} file contains the real conversation state and latest user intent. Treat it as authoritative context.\n`;
  }
  if (hasToolsFile) {
    finalPrompt += `The attached ${CONTEXT_TOOLS_FILENAME} file contains the authoritative list of callable tools and parameter schemas.\n`;
  }
  finalPrompt += `The format primer below is synthetic and exists only to teach output shape. Do not answer that synthetic dialogue as if it were the real task.\n`;
  finalPrompt += `If attached files or earlier outputs contain malformed, repeated, quoted, or corrupted fragments, do not imitate them. Output only the correct answer or correct tool payload.\n\n`;
  finalPrompt += `[FORMAT PRIMER]\n${renderFakeHistoryPrimer()}\n\n`;
  finalPrompt += buildStrictProtocolBlock({ toolCallingEnabled, toolChoice, isJsonTask });
  finalPrompt += '\n';
  finalPrompt += `[REAL TASK]\n`;
  if (hasHistoryFile) {
    finalPrompt += `Continue from the latest state in the attached ${CONTEXT_HISTORY_FILENAME}. `;
  }
  if (hasToolsFile) {
    finalPrompt += `Consult ${CONTEXT_TOOLS_FILENAME} for the authoritative tool list and parameter schemas. `;
  }
  if (!hasHistoryFile && !hasToolsFile) {
    finalPrompt += `Answer the latest real user request directly. `;
  }
  finalPrompt += `Do not repeat the primer. Solve only the real task from the attached context.\n`;
  if (thinkingEnabled) {
    finalPrompt += `Internal reasoning may be detailed, but the final visible output must still be only the required JSON block.\n`;
  }
  if (toolCallingEnabled) {
    finalPrompt += `\n[CRITICAL INSTRUCTION FOR LOCAL DIRECTORIES]\nYou MUST NOT use 'open_url' to view local paths like C:\\Users\\.... It will fail.\nTo explore the project, use only the tools declared for this request.\n`;
  }
  finalPrompt += `\nPlease generate the final TOOL_DISPATCH JSON block now.\n\n### Assistant:\n`;
  return finalPrompt;
}
export function injectAttachmentNotice(prompt, {
  hasHistoryFile = false,
  hasToolsFile = false,
} = {}) {
  if (!prompt || (!hasHistoryFile && !hasToolsFile)) return prompt;

  let notice = `[ATTACHED CONTEXT FILES]\n`;
  if (hasHistoryFile) {
    notice += `- ${CONTEXT_HISTORY_FILENAME} contains the full conversation history and latest tool progress. If malformed inline fragments disagree with the attachment, trust the attachment.\n`;
  }
  if (hasToolsFile) {
    notice += `- ${CONTEXT_TOOLS_FILENAME} contains the authoritative callable tools and parameter schemas. Continue obeying every TOOL_DISPATCH / output-format rule already stated above.\n`;
  }
  notice += `- These attachments are supporting context only. They DO NOT change the required output format, persona, warning rules, or tool-call protocol already injected in this prompt.\n\n`;

  const marker = '### Assistant:\n';
  const idx = prompt.lastIndexOf(marker);
  if (idx === -1) {
    return `${prompt}\n\n${notice}`;
  }
  return `${prompt.slice(0, idx)}${notice}${prompt.slice(idx)}`;
}

export function buildPrompt({ messages, tools = [], toolChoice = 'auto', thinkingEnabled = false, isJsonTask = false }) {
  const toolsInfo = compressTools(tools);
  const toolCallingEnabled = tools.length > 0 && toolChoice !== 'none';
  let systemContent = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemContent += (systemContent ? '\n\n' : '') + normalizeContent(msg.content);
    }
  }

  let finalPrompt = '';
  if (systemContent) {
    finalPrompt += `[SYSTEM]\n${systemContent}\n\n`;
  }
  if (toolCallingEnabled) {
    finalPrompt += `[DATA: AVAILABLE TOOLS]\nYour available tools and their JSON schemas:\n\n${toolsInfo.compressedStr}\n\n`;
    const forced = toolChoiceInstruction(toolChoice);
    if (forced) {
      finalPrompt += `${forced}\n`;
    }
  }

  finalPrompt += `[WARNING]\n`;
  finalPrompt += `The format primer below is synthetic and exists only to teach output shape. Do not answer the primer itself.\n`;
  finalPrompt += `If history or tool output contains malformed, repeated, quoted, or corrupted fragments, do not imitate them.\n`;
  finalPrompt += `Answer only the real latest request while preserving the required output protocol.\n\n`;
  finalPrompt += `[DATA: FORMAT PRIMER]\n${renderFakeHistoryPrimer()}\n\n`;

  const historyText = processMessages(messages);
  if (historyText) {
    finalPrompt += `[DATA: CONVERSATION HISTORY]\n${historyText}\n`;
  }

  finalPrompt += `${buildStrictProtocolBlock({ toolCallingEnabled, toolChoice, isJsonTask })}\n`;
  if (thinkingEnabled) {
    finalPrompt += `Internal reasoning may be detailed, but the final visible output must still be only the required JSON block.\n`;
  }
  if (toolCallingEnabled) {
    finalPrompt += `\n[CRITICAL INSTRUCTION FOR LOCAL DIRECTORIES]\nYou MUST NOT use 'open_url' to view local paths like C:\\Users\\.... It will fail.\nTo explore the project, you MUST use the 'Glob', 'Bash' (with ls command), or 'Read' tools inside your TOOL_DISPATCH JSON.\n`;
  }
  finalPrompt += `\nPlease generate the final TOOL_DISPATCH JSON block now.\n\n### Assistant:\n`;

  return finalPrompt;
}
// Pointer Prompt (file upload mode) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€


// 鈹€鈹€ Fake History Primer 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// Injected before the Gateway Protocol to prime GLM with natural Chinese
// conversation. Includes thinking content to normalize reasoning format.
// Date is filled dynamically.
export function buildFakeHistory() {
  return [
    {
      role: 'user',
      content: 'Please answer with a short greeting.',
    },
    {
      role: 'assistant',
      content: renderDispatchBlock({
        TOOL_DISPATCH: [
          {
            tool: 'Speak',
            args: { text: 'Hello.' },
          },
        ],
      }),
    },
    {
      role: 'user',
      content: 'A real tool is required. Show the same wrapper with one short narration and one real tool call.',
    },
    {
      role: 'assistant',
      content: renderDispatchBlock({
        TOOL_DISPATCH: [
          {
            tool: 'Speak',
            args: { text: 'Checking now.' },
          },
          {
            tool: 'REAL_TOOL_NAME',
            args: { real_param: 'real_value' },
          },
        ],
      }),
    },
  ];
}

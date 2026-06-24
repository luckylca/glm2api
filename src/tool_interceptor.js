// ── Tool Call Extractor & Stream Processor ──────────────────────────────
//
// Neutral Addendum Pattern — the prompt uses Markdown ```json code blocks
// for tool calls instead of XML tags. This extractor:
//   1. Captures ```json ... ``` blocks from the model's reply
//   2. Converts them back to standard OpenAI/Anthropic tool-call format
//   3. Strips JSON blocks from natural-language text
//   4. Falls back to bare JSON array repair for legacy model outputs
//
// Also includes a fallback repair agent: when local extraction fails,
// sends the broken output to a fast flash model for JSON repair.

import { completion, parseSSEStream } from './chat.js';
import { logChatEntry } from './logger.js';

function tryParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ── Pre-sanitizer: escape internal double quotes inside JSON string values ─
// Handles cases like: "command": "echo "done killing""
// where the model forgets to escape inner double quotes.
// Strategy: find "key": "value" pairs, then escape any unescaped " inside value.

function preSanitizeJson(jsonStr) {
  // Match "key": "value" — captures the value content between the bounding quotes
  const keyValueRegex = /"\s*:\s*"([\s\S]*?)"\s*[,}\n]/g;

  return jsonStr.replace(keyValueRegex, (match, content, offset, fullStr) => {
    // Determine the prefix (from start of match to start of content) and suffix
    // (closing quote + delimiter) by reconstructing from the match
    const prefixEnd = match.indexOf(content);
    const prefix = match.slice(0, prefixEnd);
    const suffix = match.slice(prefixEnd + content.length);

    // Escape unescaped double quotes inside the value
    let sanitized = content.replace(/(?<!\\)"/g, '\\"');

    // Also fix physical newlines inside the value
    sanitized = sanitized.replace(/\n/g, '\\n').replace(/\r/g, '\\r');

    return prefix + sanitized + suffix;
  });
}

// ── Titanium JSON repair engine ──────────────────────────────────────────
// Fixes three failure modes that GLM triggers on large tool-call payloads:
//  1. Illegal escape sequences (e.g. C:\Users → \U is invalid JSON)
//  2. Physical newlines inside JSON strings (model types a real Enter)
//  3. Truncated JSON — auto-closes unmatched brackets and quotes

function repairBrokenJson(str) {
  let inString = false;
  let isEscaped = false;
  let repaired = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (isEscaped) {
      const validEscapes = ['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'];
      if (!validEscapes.includes(char)) {
        // Fix 1: illegal escape like \U (Windows paths) → \\U
        repaired = repaired.slice(0, -1) + '\\\\' + char;
      } else {
        repaired += char;
      }
      isEscaped = false;
    } else if (char === '"') {
      inString = !inString;
      repaired += char;
    } else if (char === '\\') {
      isEscaped = true;
      repaired += char;
    } else {
      // Fix 2: physical newline/tab inside JSON string → escape sequence
      if (inString && (char === '\n' || char === '\r')) {
        repaired += (char === '\n') ? '\\n' : '\\r';
      } else if (inString && char === '\t') {
        repaired += '\\t';
      } else {
        repaired += char;
      }
    }
  }

  // Fix 3: auto-close truncated JSON
  if (inString) repaired += '"';
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;

  for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';
  for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';

  return repaired;
}

function tryParseJson(value) {
  // Pass 1: direct parse — works for well-formed JSON
  try {
    return JSON.parse(value);
  } catch {}

  // Pass 2: repair physical defects only (illegal escapes, real newlines inside strings,
  //         truncated brackets). Safe — never alters valid JSON structure.
  try {
    const repaired = repairBrokenJson(value);
    return JSON.parse(repaired);
  } catch {}

  // Pass 3: sanitize unescaped double quotes inside string values (e.g. echo "hi")
  //         then repair. This is last-resort because the regex-based sanitizer can
  //         incorrectly identify value boundaries when content contains " characters.
  try {
    const sanitized = preSanitizeJson(value);
    const repaired = repairBrokenJson(sanitized);
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

// Decode XML entities that GLM may occasionally emit inside JSON
export function unescapeXML(str) {
  if (!str) return '';
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Safe arguments parser with JSON state machine + XML fallback rescue.
// GLM sometimes injects real newlines inside JSON strings (e.g. code),
// which breaks JSON.parse. The state machine detects in-string boundaries and
// escapes raw \n/\r before retrying. If that still fails, XML <key>value</key>
// extraction serves as the last-resort fallback.
export function parseSafeArguments(rawArgsString) {
  let cleanStr = unescapeXML(rawArgsString).trim();

  try {
    return JSON.parse(cleanStr);
  } catch (e1) {
    try {
      const repaired = repairBrokenJson(cleanStr);
      return JSON.parse(repaired);
    } catch (e2) {
      console.warn('JSON repair failed, attempting XML fallback rescue...');

      const fallbackObj = {};
      const xmlRegex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;
      let match;
      let found = false;

      while ((match = xmlRegex.exec(cleanStr)) !== null) {
        found = true;
        let value = match[2].trim();
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (!isNaN(Number(value)) && value !== '') value = Number(value);
        fallbackObj[match[1]] = value;
      }

      if (found) return fallbackObj;
      throw new Error('Failed to parse tool arguments: ' + cleanStr);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Markdown JSON code-block extractor (TOOL_DISPATCH format)
//
// Two-pass extraction:
//   Pass 1 (PRIMARY): Greedy lastIndexOf — finds the FIRST ```json and LAST ```
//     to handle nested markdown blocks inside Write/Edit payloads.
//   Pass 2 (FALLBACK): Global regex scan — if Pass 1 yields nothing, scan ALL
//     ```json blocks and merge every TOOL_DISPATCH array found.
//   Content wipe: when tools are extracted, returns '' content so conversational
//     text ("好的，马上创建...") doesn't confuse Claude Code into treating the
//     response as plain chat.
// ═══════════════════════════════════════════════════════════════════════════

function extractSingleBlockGreedy(text) {
  // Find the opening ```json fence (or plain ```)
  const startMatch = text.match(/```(?:json)?[ \t]*\n?/i);
  if (!startMatch) return null;
  const contentStart = startMatch.index + startMatch[0].length;

  // State-machine search for the REAL closing ``` fence.
  // lastIndexOf('```') can hit backtick triples inside JSON string values
  // (e.g. when editing Markdown files that contain code blocks).
  // Walk forward from contentStart, tracking whether we're inside a JSON string.
  let inString = false;
  let escaped = false;
  for (let i = contentStart; i < text.length - 2; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    // Outside a JSON string — check for ``` on its own line
    if (ch === '`' && text[i + 1] === '`' && text[i + 2] === '`') {
      // Make sure it's at the start of a line (possibly with whitespace)
      const before = text.slice(Math.max(0, i - 20), i);
      if (/\n[ \t]*$/.test(before) || i === contentStart) {
        return text.slice(contentStart, i).trim();
      }
    }
  }
  return null;
}

function extractAllBlocksMerged(text) {
  // Use a state-machine approach to find ```json blocks, skipping over
  // backtick triples that appear inside JSON string values.
  const blocks = [];
  let pos = 0;
  while (pos < text.length) {
    const openMatch = text.slice(pos).match(/```(?:json)?[ \t]*\n?/i);
    if (!openMatch) break;
    const contentStart = pos + openMatch.index + openMatch[0].length;

    // State-machine to find closing ```
    let inString = false;
    let escaped = false;
    let found = false;
    for (let i = contentStart; i < text.length - 2; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '`' && text[i + 1] === '`' && text[i + 2] === '`') {
        const before = text.slice(Math.max(0, i - 20), i);
        if (/\n[ \t]*$/.test(before) || i === contentStart) {
          const blockContent = text.slice(contentStart, i).trim();
          const parsed = tryParseJson(blockContent);
          if (parsed && parsed.TOOL_DISPATCH && Array.isArray(parsed.TOOL_DISPATCH)) {
            blocks.push(...parsed.TOOL_DISPATCH);
          }
          pos = i + 3;
          found = true;
          break;
        }
      }
    }
    if (!found) break;
  }
  return blocks.length > 0 ? blocks : null;
}

// ── Speak tool separation ──────────────────────────────────────────────────
// Extracts Speak tool text and filters Speak from the dispatch array.
// Returns { speakText, realDispatches } — speakText is joined Speak args.text,
// realDispatches has everything except Speak.
export function separateSpeakTools(dispatchArray) {
  const speakTexts = [];
  const realDispatches = [];
  for (const action of dispatchArray) {
    if (action && action.tool === 'Speak' && action.args?.text) {
      speakTexts.push(action.args.text);
    } else {
      realDispatches.push(action);
    }
  }
  return { speakText: speakTexts.join('\n'), realDispatches };
}

// Extract dispatch array from parsed JSON — supports both "TOOL_DISPATCH" (new) and
// "TOOL_DISPATCH" (legacy) keys for backward compatibility.
function getDispatchArray(parsed) {
  if (!parsed) return null;
  const arr = parsed.TOOL_DISPATCH;
  return Array.isArray(arr) ? arr : null;
}

function actionsToToolCalls(dispatchArray) {
  const toolCalls = [];
  const META_KEYS = new Set(['tool', 'name', 'args', 'arguments']);
  for (const action of dispatchArray) {
    const fnName = action.name || action.tool;
    // Skip Speak — it's a virtual tool, not a real tool call
    if (fnName === 'Speak') continue;
    if (!fnName) continue;
    let fnArgs = action.arguments || action.args;
    // If args aren't nested, collect all remaining keys as args
    if (fnArgs == null) {
      fnArgs = {};
      for (const key of Object.keys(action)) {
        if (!META_KEYS.has(key)) {
          fnArgs[key] = action[key];
        }
      }
      if (Object.keys(fnArgs).length === 0) fnArgs = null;
    }
    if (fnArgs != null) {
      toolCalls.push({
        id: 'call_' + Math.random().toString(36).substr(2, 9),
        type: 'function',
        function: {
          name: fnName,
          arguments: typeof fnArgs === 'string' ? fnArgs : JSON.stringify(fnArgs),
        },
      });
    }
  }
  return toolCalls;
}

export function extractToolCalls(assistantReplyText) {
  if (!assistantReplyText) return { text: '', tools: [] };

  let allDispatches = null;

  // ── Prefill continuation repair ───────────────────────────────────────
  // When the Assistant Prefilling strategy is used, GLM sees that "it" already
  // opened ```json\n{"TOOL_DISPATCH":[ and continues from there. The response
  // may only contain the array elements + closing brackets, without repeating
  // the TOOL_DISPATCH wrapper. Reconstruct the full JSON block before parsing.
  const trimmed = assistantReplyText.trim();
  if (!/TOOL_DISPATCH/i.test(assistantReplyText) && !/```json/i.test(assistantReplyText)) {
    // Heuristic: response looks like continuation of prefill JSON
    // (starts with {"tool": or {"name": or similar JSON key patterns)
    if (/^\s*[{[]/.test(trimmed)) {
      const prefillPrefix = '```json\n{"TOOL_DISPATCH":[';
      const reconstructed = prefillPrefix + assistantReplyText;
      // Try Pass 1 with the reconstructed text
      const greedyJson = extractSingleBlockGreedy(reconstructed);
      if (greedyJson) {
        const parsed = tryParseJson(greedyJson);
        if (parsed && parsed.TOOL_DISPATCH && Array.isArray(parsed.TOOL_DISPATCH)) {
          allDispatches = parsed.TOOL_DISPATCH;
        }
      }
      // If greedy failed, try Pass 2 with reconstructed text
      if (!allDispatches) {
        allDispatches = extractAllBlocksMerged(reconstructed);
      }
      // Raw JSON fallback for prefill: no ``` fences at all
      if (!allDispatches) {
        const rawReconstructed = '{"TOOL_DISPATCH":[' + assistantReplyText;
        const parsed = tryParseJson(rawReconstructed);
        if (parsed && parsed.TOOL_DISPATCH && Array.isArray(parsed.TOOL_DISPATCH)) {
          allDispatches = parsed.TOOL_DISPATCH;
        }
      }
    }
  }

  // ── Pass 1: Greedy single-block extraction (handles nested ```) ──
  if (!allDispatches) {
    const greedyJson = extractSingleBlockGreedy(assistantReplyText);
    if (greedyJson) {
      const parsed = tryParseJson(greedyJson);
      if (parsed && parsed.TOOL_DISPATCH && Array.isArray(parsed.TOOL_DISPATCH)) {
        allDispatches = parsed.TOOL_DISPATCH;
      }
    }
  }

  // ── Pass 2: Global multi-block merge (fallback for split outputs) ──
  if (!allDispatches) {
    allDispatches = extractAllBlocksMerged(assistantReplyText);
  }

  // ── Raw JSON fallback (no Markdown wrapper at all) ──
  if (!allDispatches) {
    const firstBrace = assistantReplyText.indexOf('{');
    const lastBrace = assistantReplyText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
      const rawJson = assistantReplyText.slice(firstBrace, lastBrace + 1).trim();
      const parsed = tryParseJson(rawJson);
      if (parsed && parsed.TOOL_DISPATCH && Array.isArray(parsed.TOOL_DISPATCH)) {
        allDispatches = parsed.TOOL_DISPATCH;
      }
    }
  }

  // Separate Speak virtual tool from real tool calls
  let speakText = '';
  const foundJson = allDispatches !== null;
  if (allDispatches) {
    const separated = separateSpeakTools(allDispatches);
    speakText = separated.speakText;
    allDispatches = separated.realDispatches.length > 0 ? separated.realDispatches : null;
  }

  const toolCalls = allDispatches ? actionsToToolCalls(allDispatches) : [];

  // Speak text becomes the content (visible to user).
  // When real tools are also present, Speak provides narration ("正在读取文件...").
  // When only real tools (no Speak), wipe content to avoid confusing the client.
  const hasRealTools = toolCalls.length > 0;
  const hasSpeak = speakText.length > 0;
  if (hasSpeak) {
    return { text: speakText, tools: toolCalls, extracted: true };
  }
  return { text: hasRealTools ? '' : assistantReplyText, tools: toolCalls, extracted: foundJson && hasRealTools };
}

// ═══════════════════════════════════════════════════════════════════════════
// Bare JSON tool call detection & repair (legacy fallback)
// ═══════════════════════════════════════════════════════════════════════════

const BARE_JSON_RE = /\[\s*\{\s*"name"\s*:\s*"/;

export function detectBareJsonToolCall(text) {
  if (!text) return -1;
  const match = text.match(BARE_JSON_RE);
  return match ? match.index : -1;
}

export function extractJsonToolCalls(text) {
  if (!text) return null;

  const startIdx = text.search(BARE_JSON_RE);
  if (startIdx === -1) return null;

  const slice = text.slice(startIdx);
  const result = extractCompleteJsonArray(slice);
  if (!result) return null;

  const repaired = repairToolCallJson(result.json);
  if (!repaired) return null;

  const normalized = normalizeRepairedCalls(repaired);
  if (!normalized || !normalized.length) return null;

  const contentBefore = text.slice(0, startIdx).trim();
  const contentAfter = text.slice(startIdx + result.endOffset).trim();

  return {
    toolCalls: normalized,
    content: (contentBefore + '\n' + contentAfter).trim(),
  };
}

function extractCompleteJsonArray(str) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIdx = -1;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }

  if (endIdx === -1) return null;
  return { json: str.slice(0, endIdx), endOffset: endIdx };
}

function repairToolCallJson(jsonStr) {
  let s = jsonStr.trim();
  const parsed = tryParse(s);
  if (parsed) return parsed;

  s = removeDuplicateJsonKeys(s);
  let result = tryParse(s);
  if (result) return result;

  s = fixExtraBraces(s);
  result = tryParse(s);
  if (result) return result;

  s = closeUnclosedStructures(s);
  result = tryParse(s);
  if (result) return result;

  s = extractFirstObject(s);
  if (s) {
    result = tryParse('[' + s + ']');
    if (result) return result;
  }

  return null;
}

function removeDuplicateJsonKeys(jsonStr) {
  const seen = new Set();
  return jsonStr.replace(/"([^"]+)"\s*:\s*/g, (match, key) => {
    if (seen.has(key)) return '';
    seen.add(key);
    return match;
  });
}

function fixExtraBraces(s) {
  let balance = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') balance++;
    else if (ch === '}' || ch === ']') balance--;
  }

  while (balance < 0 && (s.endsWith('}') || s.endsWith(']'))) {
    s = s.slice(0, -1);
    balance++;
  }
  return s;
}

function closeUnclosedStructures(s) {
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }

  return s + '}'.repeat(Math.max(0, openBraces)) + ']'.repeat(Math.max(0, openBrackets));
}

function extractFirstObject(s) {
  const startIdx = s.indexOf('{');
  if (startIdx === -1) return null;

  const slice = s.slice(startIdx);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return slice.slice(0, i + 1);
    }
  }
  return slice + '}'.repeat(Math.max(0, depth));
}

export function normalizeRepairedCalls(parsed) {
  let calls;
  if (Array.isArray(parsed)) {
    calls = parsed;
  } else if (parsed && typeof parsed === 'object') {
    calls = [parsed];
  } else {
    return null;
  }

  return calls
    .map((call, i) => {
      if (!call || typeof call !== 'object') return null;
      const name = call.name;
      if (!name || typeof name !== 'string') return null;

      let args = call.arguments || call.parameters || call.input || {};
      if (typeof args === 'string') {
        const parsedArgs = tryParse(args);
        args = parsedArgs || {};
      }

      if (args.description && typeof args.description === 'string') {
        delete args.description;
      }

      return {
        id: `toolu_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'tool_use',
        name,
        input: args,
      };
    })
    .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified extraction (post-stream): ```json → bare JSON fallback
// ═══════════════════════════════════════════════════════════════════════════

export function extractToolCallsUnified(text) {
  if (!text) return null;

  // Strategy 1: Markdown ```json code block (new format)
  const mdResult = extractToolCalls(text);
  if (mdResult?.extracted) {
    if (mdResult.tools?.length) {
      // Has real tool calls (possibly with Speak content)
      const rawCalls = mdResult.tools.map(t => ({
        name: t.function.name,
        arguments: tryParse(t.function.arguments) || t.function.arguments,
      }));
      const normalized = normalizeRepairedCalls(rawCalls);
      if (normalized?.length) {
        return { toolCalls: normalized, content: mdResult.text || null };
      }
    }
    // Speak-only: JSON was found and parsed, no real tools, text is from Speak
    if (mdResult.text) {
      return { toolCalls: [], content: mdResult.text };
    }
  }

  // Strategy 2: Bare JSON array (legacy fallback)
  const jsonResult = extractJsonToolCalls(text);
  if (jsonResult?.toolCalls?.length) {
    return jsonResult;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Fallback JSON repair agent
// ═══════════════════════════════════════════════════════════════════════════
// When the primary extraction engine fails to parse the model's output
// (broken JSON, plain text without Speak wrapping, etc.), we send the raw
// content to a fast flash model (no-thinking) for repair.
// This adds ~1-2s latency but prevents task interruption.

const REPAIR_PROMPT = `[Gateway JSON Alignment]
You are a high-speed JSON format alignment engine.
Your task is to help format data so it can be correctly processed by the local API gateway.

Guidelines:
1. If the input looks like broken JSON (missing brackets, bad escapes, bad quotes) — repair it first.
2. If the input is plain natural language text — wrap it in the TOOL_DISPATCH Speak format:
   {"TOOL_DISPATCH":[{"tool":"Speak","args":{"text":"THE TEXT"}}]}
3. If the input is a valid JSON array [...] or a JSON object lacking the "TOOL_DISPATCH" key — wrap it under the "TOOL_DISPATCH" key:
   {"TOOL_DISPATCH": <YOUR_ARRAY_OR_OBJECT>}
4. If the input is already a valid JSON object containing the "TOOL_DISPATCH" key — return it as-is.
5. Output ONLY the aligned JSON. No markdown, no explanations, no backticks.
6. Maintain the exact original values and tool names.

Example 1 (valid array lacking wrapper):
Input: [ { "tool": "Speak", "args": { "text": "Hello" } } ]
Output: {"TOOL_DISPATCH":[{"tool":"Speak","args":{"text":"Hello"}}]}

Example 2 (broken JSON):
Input: { "TOOL_DISPATCH": [ { "tool": "Speak", "args": { "text": "Hello" } ] }
Output: {"TOOL_DISPATCH":[{"tool":"Speak","args":{"text":"Hello"}}]}

Please align the following content now:`;

export async function repairBrokenOutput(brokenContent, slot) {
  if (!brokenContent || brokenContent.length < 10) return null;

  const prompt = REPAIR_PROMPT + '\n' + brokenContent;
  const startTime = Date.now();

  try {
    const result = await completion({
      prompt,
      thinkingEnabled: false,
      accessToken: slot.token,
      deviceId: slot.deviceId,
    });

    let fullContent = '';
    for await (const event of parseSSEStream(result.body)) {
      if (event.type === 'error') throw new Error(event.message || `GLM error ${event.code}`);
      if (event.type === 'content') fullContent += event.content;
    }

    const repaired = fullContent.trim();
    if (!repaired) return null;

    // Log the repair agent call
    logChatEntry({
      time: new Date().toISOString(),
      model: 'repair-agent (flash-nothinking)',
      stream: false,
      duration: Date.now() - startTime,
      messages: [],
      prompt,
      response: repaired,
      repairAgent: true,
      raw: fullContent,
    });

    return repaired;
  } catch (err) {
    console.error('[repair] Repair agent failed:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Streaming buffer scanner (legacy, kept for compatibility)
// ═══════════════════════════════════════════════════════════════════════════

export class ToolCallScanner {
  constructor() {
    this.buffer = '';
    this.toolCalls = null;
    this.cleanContent = '';
    this.locked = false;
  }

  feed(chunk) {
    if (this.locked) return;
    this.buffer += chunk;

    const idx = detectBareJsonToolCall(this.buffer);
    if (idx !== -1) {
      const result = extractJsonToolCalls(this.buffer);
      if (result) {
        this.toolCalls = result.toolCalls;
        this.cleanContent = result.content;
        this.locked = true;
      }
    }
  }

  isComplete() { return this.locked; }

  getResult() {
    if (!this.locked) return null;
    return { toolCalls: this.toolCalls, content: this.cleanContent };
  }
}

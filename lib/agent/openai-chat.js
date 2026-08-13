// Chat Completions 适配器：为 runner 提供 chatFn。
//
// 兼容标准 OpenAI 及各类 OpenAI 兼容服务（Chat Completions 接口）。
//
// 统一封装一次 /chat/completions 调用，规范化返回：
//   { content, toolCalls: [{id,name,args}] | null, finishReason, usage, raw: message }
// 当传入 tools 为 null 时不带 tools 字段（供文本降级路径使用）。
//
// 参考文档要点：
// - 认证：走 OpenAI 标准 Authorization: Bearer <token>
// - max_tokens vs max_completion_tokens：gpt-5 及后续版本必须用 max_completion_tokens
// - 未显式配置 max_tokens 时，按当前模型能力取其允许的最大输出上限，避免长规则被截断
// - finish_reason === 'length' 表示输出被 max_tokens 截断

import { ensureModelsLoaded, getModelById } from '../models.js';
import { makeLocalChatFn } from './local-chat.js';

// 找不到模型能力时的兜底上限（足够容纳较长的 css/js 规则）
const FALLBACK_MAX_TOKENS = 8192;
// 输出 tokens 的安全硬上限。原因：
//   1) 模型清单里的 maxToken 有的填的是「上下文窗口」而非「最大输出」（如部分 Claude 填了 1024000），
//      直接拿去当 max_tokens 会触发 400（如 anthropic 实际只允许 128000）。
//   2) 本插件生成的规则（css/js）再长也就上万字符 ≈ 几千 tokens，无需几十万的输出额度。
// 因此对最终下发的 max_tokens 统一钳制到该值，既够用又绝不超过任何主流模型的输出上限。
const SAFE_OUTPUT_CAP = 16384;

/**
 * 判断模型是否属于「必须使用 max_completion_tokens」的系列（gpt-5 及后续）。
 * @param {string} model
 */
function usesMaxCompletionTokens(model) {
  const m = String(model || '').toLowerCase();
  // gpt-5、gpt-5.x、o 系列推理模型等新接口约定使用 max_completion_tokens
  return /(^|[^0-9])gpt-5/.test(m) || /^o\d/.test(m);
}

/**
 * 查询某模型允许的最大输出 tokens。命中清单则返回其 maxToken，否则返回兜底值。
 * 注意：清单值可能偏大（混入了上下文窗口），最终仍会被 SAFE_OUTPUT_CAP 钳制。
 * @param {string} model
 */
function getModelMaxToken(model) {
  const hit = getModelById(model);
  const cap = hit && Number(hit.maxToken) > 0 ? Number(hit.maxToken) : 0;
  return cap > 0 ? cap : FALLBACK_MAX_TOKENS;
}

/**
 * 构造一个绑定了配置的 chatFn。
 * @param {import('../types.js').LlmConfig} cfg
 * @returns {(messages:Array, tools:Array|null, opts?:Object)=>Promise<{content:string,toolCalls:any[]|null,finishReason:string,usage:any,raw:any}>}
 */
export function makeChatFn(cfg) {
  // 本地后端：走 Chrome 内置 AI（Prompt API），无需 API Key
  if (cfg?.backend === 'local') return makeLocalChatFn(cfg);
  if (!cfg.apiKey) throw new Error('未配置 API Key（代理 token），请先在设置页填写。');
  if (!cfg.baseUrl) throw new Error('未配置 BaseURL。');
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const model = cfg.model;

  /**
   * @param {Array} messages
   * @param {Array|null} tools
   * @param {{ signal?: AbortSignal, onDelta?: (text:string, meta?:{reasoning?:boolean})=>void }} [opts] 附加选项
   *onDelta 存在时走流式（SSE），每收到一段文本增量就回调一次（meta.reasoning=true 表示这段是推理模型的思考流，而非正文）；最终仍返回聚合后的完整结果。
   */
  return async function chatFn(messages, tools, opts = {}) {
    // 首次调用前确保模型清单已加载（含远程更新源拉取），保证 maxToken 能力查询正确
    await ensureModelsLoaded();
    const stream = typeof opts.onDelta === 'function';
    const body = { model, messages };

    // 采样参数（仅在有意义时下发，避免与 thinking 模式冲突）
    if (typeof cfg.temperature === 'number') body.temperature = cfg.temperature;
    if (typeof cfg.topP === 'number' && cfg.topP > 0 && cfg.topP < 1) body.top_p = cfg.topP;

    // 最大输出 tokens：按模型选择正确字段
    // 注意：规则里的 css/js 可能很长（数千字），finish 工具的 JSON 参数整体更长。
    // 若上限过小，输出会在中途被截断（finish_reason==='length'），
    // 由于 JSON 里 js 排在 css 之后，往往表现为「css 有值、js 为空」——即用户反馈的 JS 丢失。
    // 策略：
    //   - 未显式配置（0）时，用当前模型允许的输出上限；
    //   - 用户显式配置了值，则以配置为准，但不超过模型能力上限；
    //   - 最终再统一钳到 SAFE_OUTPUT_CAP，规避清单把「上下文窗口」误当「最大输出」导致的400 超限。
    const modelCap = getModelMaxToken(model);
    const configured = Number(cfg.maxTokens) || 0;
    const desired = configured > 0 ? Math.min(configured, modelCap) : modelCap;
    const maxTokens = Math.min(desired, SAFE_OUTPUT_CAP);
    if (usesMaxCompletionTokens(model)) {
      body.max_completion_tokens = maxTokens;
    } else {
      body.max_tokens = maxTokens;
    }

 if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    if (stream) {
      body.stream = true;
   // 有些兼容服务需要显式开启才会返回 usage
      body.stream_options = { include_usage: true };
    }

    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${cfg.apiKey}`,
    };
    let res;
    try {
    res = await fetch(url, {
        method: 'POST',
    headers,
   body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (e) {
      throw new Error(`网络请求失败：${e && e.message ? e.message : e}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM 请求失败(${res.status}): ${extractErrMsg(text)}`);
    }

    if (stream) {
      return parseSseStream(res, opts.onDelta);
    }

    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error('LLM 返回内容不是合法 JSON。');
    }

    const choice = json?.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error('LLM 返回内容为空（无choices.message）。');

    let toolCalls = null;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      toolCalls = msg.tool_calls.map((tc) => {
        const rawArgs = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
        const parsed = safeParseArgs(rawArgs);
        return {
          id: tc.id,
          name: tc.function?.name,
          args: parsed.value,
          argsOk: parsed.ok, // 参数是否被完整、正确地解析出来（供上层判断“产出是否可能丢失/截断”）
          rawArgs, // 原始参数串（解析失败时用于判断模型确实想输出而非真的为空）
        };
      });
    }

    return {
   content: typeof msg.content === 'string' ? msg.content : '',
      toolCalls,
      finishReason: choice?.finish_reason || '',
      usage: json?.usage || null,
      raw: msg,
    };
  };
}

/**
 * 解析 OpenAI 兼容的 SSE 流，聚合出与非流式一致的结果结构。
 * 逐块把文本增量通过 onDelta 回调抛出（用于 UI 流式展示思考内容）。
 * @param {Response} res
 * @param {(text:string)=>void} onDelta
 * @returns {Promise<{content:string,toolCalls:any[]|null,finishReason:string,usage:any,raw:any}>}
 */
async function parseSseStream(res, onDelta) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('当前环境不支持流式读取响应体。');
  const decoder = new TextDecoder('utf-8');

  let content = '';
  let finishReason = '';
  let usage = null;
  // tool_calls 增量聚合：index -> { id, name, argsStr }
  const toolAcc = new Map();
  let buffer = '';

  const handleEvent = (dataStr) => {
    if (dataStr === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(dataStr);
    } catch {
      return; // 忽略无法解析的行
    }
    if (json.usage) usage = json.usage;
    const choice = json?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    // 推理模型（Claude thinking / DeepSeek-R1 / o 系列等）的思考流通常放在
    // reasoning_content（部分服务用 reasoning）字段，与正文 content 分开。
    // 这类内容只用于 UI 展示「思考中」，不能混进 content（否则会污染工具调用/finish 解析）。
    const reasoningPiece =
      (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
      (typeof delta.reasoning === 'string' && delta.reasoning) ||
      '';
    if (reasoningPiece) {
      try {
        onDelta(reasoningPiece, { reasoning: true });
      } catch {
        /* 回调异常不影响流解析 */
      }
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      try {
        onDelta(delta.content, { reasoning: false });
      } catch {
        /* 回调异常不影响流解析 */
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const acc = toolAcc.get(idx) || { id: '', name: '', argsStr: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') acc.argsStr += tc.function.arguments;
        toolAcc.set(idx, acc);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // 按行处理，SSE 事件以空行分隔，数据行以 "data:" 开头
    let nlIdx;
    while ((nlIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        handleEvent(line.slice(5).trim());
      }
    }
  }
  // 处理残留
  const tail = buffer.trim();
  if (tail.startsWith('data:')) handleEvent(tail.slice(5).trim());

  let toolCalls = null;
  if (toolAcc.size) {
    toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc], i) => {
        const rawArgs = acc.argsStr || '';
        const parsed = safeParseArgs(rawArgs);
        return {
          id: acc.id || 'stream-tc-' + i,
          name: acc.name,
          args: parsed.value,
          argsOk: parsed.ok,
          rawArgs,
        };
      })
      .filter((t) => t.name);
    if (!toolCalls.length) toolCalls = null;
  }

  // 构造与非流式一致的 raw.message（供runner 追加 assistant 消息用）
  const raw = {
    role: 'assistant',
    content: content || null,
    tool_calls: toolCalls
      ? [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, acc], i) => ({
          id: acc.id || 'stream-tc-' + i,
          type: 'function',
          function: { name: acc.name, arguments: acc.argsStr || '{}' },
        }))
      : undefined,
  };

  return { content, toolCalls, finishReason, usage, raw };
}

/** 尽力从错误响应体中提取可读信息（对齐 OpenAI error 结构，兜底原文）。 */
function extractErrMsg(text) {
  if (!text) return '(无响应体)';
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message || j?.message || j?.error;
  if (m) return String(m).slice(0, 300);
  } catch {
    // 非 JSON，回退原文
  }
  return String(text).slice(0, 300);
}

/**
 * 解析工具调用的 arguments 字符串。
 *
 * 关键点：finish 这类工具的 arguments 可能是一段很长的 JSON（含大段 css/js）。
 * 当输出被 max_tokens 截断、或个别兼容服务在超长流式分片上出现瑕疵时，
 * 直接 JSON.parse 会失败。历史实现此时静默返回 {}，导致 css/js 被丢弃、
 * 用户以为“生成成功”却什么也没保存。这里改为：
 *   1) 正常解析成功 -> { ok:true, value }
 *   2) 解析失败 -> 尝试「修复截断的 JSON」尽力抢救出字段 -> { ok:false, value }
 *      （ok:false 会向上层传递“产出可能不完整/被截断”的信号）
 *   3) 完全无法解析 -> { ok:false, value:{} }
 *
 * @param {string} s
 * @returns {{ ok: boolean, value: object }}
 */
function safeParseArgs(s) {
  if (!s) return { ok: true, value: {} };
  if (typeof s === 'object') return { ok: true, value: s };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    const repaired = repairTruncatedJson(s);
    if (repaired && typeof repaired === 'object') {
      return { ok: false, value: repaired };
    }
    return { ok: false, value: {} };
  }
}

/**
 * 尽力修复「被截断的 JSON 对象」：常见于输出触达 max_tokens 上限时，
 * 尾部的字符串/对象没有闭合。策略：
 *   - 从头扫描，跟踪字符串状态与括号栈；
 *   - 在扫描到的“最后一个安全位置”截断，然后补齐尚未闭合的引号/括号。
 * 目的不是完美还原，而是把已经生成出来的 css/js 字段尽量捞回来。
 * @param {string} src
 * @returns {object|null}
 */
function repairTruncatedJson(src) {
  const str = String(src).trim();
  const start = str.indexOf('{');
  if (start < 0) return null;

  const stack = []; // 待闭合的括号：'}' 或 ']'
  let inStr = false;
  let escaped = false;
  let result = '';

  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    result += ch;
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      stack.push('}');
    } else if (ch === '[') {
      stack.push(']');
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    }
  }

  // 补齐：先关掉未闭合的字符串（若截断发生在字符串中间，去掉可能残留的半个转义符）
  if (escaped) result = result.slice(0, -1); // 悬空的反斜杠会让补的引号被转义，去掉它
  if (inStr) result += '"';
  // 去掉尾随逗号（如 "a":1, ）避免补括号后仍非法
  result = result.replace(/,\s*$/, '');
  // 依栈补齐所有未闭合的括号
  while (stack.length) result += stack.pop();

  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

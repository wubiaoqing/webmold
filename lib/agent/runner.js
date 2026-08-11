// Agent Harness 内核（与业务完全解耦）
// ------------------------------------------------------------------
// 职责：
//   · 循环控制 + 步数上限
//   · 每步 LLM 调用的 超时 / 重试 / 指数退避
//   · 事件钩子 onEvent（trace / 日志 / UI 流式反馈都挂这里）
//   · 统一的 LLM 调用适配：优先使用 OpenAI 原生 tools 协议，
//     若服务不支持则自动降级为「文本协议」（模型用固定 JSON 输出工具调用）
//   · 错误分类与可注入的恢复策略
//
// 设计原则：本文件不 import 任何业务代码。工具能力通过 ToolRegistry 注入，
// LLM 请求通过 chatFn 注入。将来若要替换为某个开源 agent runtime，
// 只需让其实现相同的 runAgent 契约即可，业务侧零改动。
// ------------------------------------------------------------------

/**
 * @typedef {Object} AgentEvent
 * @property {('start'|'thinking'|'llm_response'|'tool_call'|'tool_result'|'retry'|'finish'|'error')} type
 * @property {number} step
 * @property {any} [data]
 */

/**
 * @typedef {Object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {object} args
 */

/**
 * @typedef {Object} RunnerOptions
 * @property {number} [maxSteps=500] 最大循环步数
 * @property {number} [stepTimeoutMs=180000]  单次 LLM 调用超时
 * @property {number} [maxRetries=2]单步 LLM 调用失败重试次数
 * @property {number} [retryBaseMs=800]      指数退避基数
 * @property {boolean} [useNativeTools=true] 是否使用原生 tools 协议（false 则走文本降级）
 * @property {AbortSignal} [signal] 中断信号：abort 后立即结束整个 agent 循环（透传给 chatFn 取消底层请求）
 */

const DEFAULT_OPTS = {
  maxSteps: 500,
  stepTimeoutMs: 180000,
  maxRetries: 2,
  retryBaseMs: 800,
  useNativeTools: true,
};

/** 带超时的 Promise 包装 */
function withTimeout(promise, ms, label = '操作') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}超时(${ms}ms)`)), ms);
    promise.then(
      (v) => {
  clearTimeout(t);
        resolve(v);
      },
 (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 判断错误是否可重试（网络/5xx/超时可重试；4xx 参数错不重试） */
function isRetryable(err) {
  const msg = String(err?.message || err);
  if (/超时|timeout|network|fetch failed|ECONN|502|503|504|429/i.test(msg)) return true;
  if (/40[0-9]|invalid|unauthorized|api key/i.test(msg)) return false;
  return true; // 未知错误默认重试
}

/** 判断是否为用户主动中断（AbortSignal 触发的错误），这类错误不重试、直接结束 */
function isAbortError(err) {
  return (
    err?.name === 'AbortError' ||
    /aborted|abort|已取消|用户已中断/i.test(String(err?.message || err))
  );
}

/**
 * 运行一个 agent 循环。
 *
 * @param {Object} params
 * @param {(messages:Array, tools:Array|null) => Promise<{content:string, toolCalls:ToolCall[]|null, raw:any}>} params.chatFn
 *        注入的 LLM 调用函数。tools 为 null 时表示走文本降级（不带 tools 字段）。
 * @param {import('./tools.js').ToolRegistry} params.registry  工具注册表
 * @param {Array} params.messages  初始消息（含 system / user）
 * @param {(ev:AgentEvent)=>void} [params.onEvent]  事件回调
 * @param {RunnerOptions} [params.options]
 * @returns {Promise<{result:any, steps:number, messages:Array}>} result 为 finish 工具产出的最终结果
 */
export async function runAgent({ chatFn, registry, messages, onEvent = () => {}, options = {} }) {
  const opts = { ...DEFAULT_OPTS, ...options };
  const toolSchemas = opts.useNativeTools ? registry.toOpenAiTools() : null;
  const signal = opts.signal;

  // 用户中断的统一处理：抛出可识别的 AbortError
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const e = new Error('已取消');
      e.name = 'AbortError';
      throw e;
    }
  };

  onEvent({ type: 'start', step: 0, data: { maxSteps: opts.maxSteps } });

  let step = 0;
  while (step < opts.maxSteps) {
    throwIfAborted();
    step += 1;
    onEvent({ type: 'thinking', step });

    // ---- 带重试的单步 LLM 调用 ----
    let resp;
    let attempt = 0;
    for (;;) {
      try {
        // 流式：每收到一段文本增量就抛出 llm_delta，供UI 实时展示模型的思考内容。
        // reasoning=true 表示这段是推理模型的思考流（reasoning_content），而非正文。
        const onDelta = (text, meta) => {
          onEvent({ type: 'llm_delta', step, data: { delta: text, reasoning: !!(meta && meta.reasoning) } });
        };
        resp = await withTimeout(
          chatFn(messages, toolSchemas, { onDelta, signal }),
        opts.stepTimeoutMs,
          'LLM 调用'
        );
        break;
      } catch (err) {
        // 用户主动中断：不重试，直接结束
        if (isAbortError(err) || signal?.aborted) {
          onEvent({ type: 'error', step, data: { error: '已取消', aborted: true } });
          const e = new Error('已取消');
          e.name = 'AbortError';
          throw e;
        }
     if (attempt < opts.maxRetries && isRetryable(err)) {
   const wait = opts.retryBaseMs * 2 ** attempt;
          onEvent({ type: 'retry', step, data: { attempt: attempt + 1, error: String(err?.message || err), wait } });
          await sleep(wait);
          attempt += 1;
      continue;
}
        onEvent({ type: 'error', step, data: { error: String(err?.message || err) } });
        throw err;
      }
    }

    onEvent({ type: 'llm_response', step, data: { content: resp.content, toolCalls: resp.toolCalls } });

 // ---- 解析工具调用（原生 or 文本降级）----
    const toolCalls = resp.toolCalls && resp.toolCalls.length
? resp.toolCalls
      : parseTextToolCalls(resp.content);

    // 没有工具调用：把这轮回答当作可能的最终输出处理
if (!toolCalls || toolCalls.length === 0) {
      // 尝试从纯文本里解析 finish 结果
      const maybeFinish = tryExtractFinishFromText(resp.content);
      if (maybeFinish) {
        onEvent({ type: 'finish', step, data: maybeFinish });
        // 文本降级：finishReason='length' 同样意味着可能被截断
        return {
          result: maybeFinish,
          meta: { argsOk: true, rawArgs: resp.content || '', finishReason: resp.finishReason || '' },
          steps: step,
          messages,
        };
      }
      // 否则把内容作为 assistant 消息追加，提示模型必须调用工具
      messages.push({ role: 'assistant', content: resp.content || '' });
      messages.push({
        role: 'user',
  content: '请通过调用工具来推进任务；当完成时，调用 finish 工具输出最终的 css/js 规则。',
   });
    continue;
  }

  // 把 assistant 的 tool_calls 追加到对话（原生协议需要）
  appendAssistantToolCalls(messages, resp, toolCalls, opts.useNativeTools);

    // ---- 依次执行工具 ----
    let finished = null;
    let finishedMeta = null;
    for (const call of toolCalls) {
      throwIfAborted();
      onEvent({ type: 'tool_call', step, data: { name: call.name, args: call.args, id: call.id } });

      // finish 是终止工具，直接返回其参数作为结果
      if (call.name === 'finish') {
        finished = call.args;
        // 透传解析元信息：argsOk=false 或 finishReason='length' 意味着产出可能被截断/丢失，
        // 交给上层（agent-service）判断是否要报错，而不是让空 css/js 静默通过。
        finishedMeta = {
          argsOk: call.argsOk !== false,
          rawArgs: call.rawArgs || '',
          finishReason: resp.finishReason || '',
        };
        onEvent({ type: 'tool_result', step, data: { name: 'finish', ok: true } });
        break;
      }

      let toolResult;
    try {
        toolResult = await registry.execute(call.name, call.args);
      } catch (err) {
        toolResult = { ok: false, error: String(err?.message || err) };
  }
      onEvent({ type: 'tool_result', step, data: { name: call.name, id: call.id, result: toolResult } });

      appendToolResult(messages, call, toolResult, opts.useNativeTools);
    }

    if (finished) {
      onEvent({ type: 'finish', step, data: finished });
      return { result: finished, meta: finishedMeta, steps: step, messages };
    }
  }

  const err = new Error(`达到最大步数上限(${opts.maxSteps})仍未完成`);
  onEvent({ type: 'error', step, data: { error: err.message } });
  throw err;
}

// ---------------- 消息拼装（区分原生/降级）----------------

function appendAssistantToolCalls(messages, resp, toolCalls, native) {
  if (native && resp.raw?.tool_calls) {
    messages.push({
      role: 'assistant',
      content: resp.content || null,
      tool_calls: resp.raw.tool_calls,
    });
  } else {
    // 文本降级：把模型上一轮原文作为 assistant 记录，便于其看到自己的决策
    messages.push({ role: 'assistant', content: resp.content || '' });
  }
}

function appendToolResult(messages, call, result, native) {
  const resultStr = JSON.stringify(result).slice(0, 8000);
  if (native) {
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: resultStr,
    });
  } else {
    // 文本降级：用 user 角色回喂工具结果
    messages.push({
      role: 'user',
      content: `【工具 ${call.name} 的执行结果】\n${resultStr}`,
    });
  }
}

// ---------------- 文本降级协议的解析 ----------------
// 约定模型在不支持原生 tools 时，用如下 JSON 表达一次工具调用：
//   {"tool":"query_dom","args":{...}}
// 或表达完成：
//   {"tool":"finish","args":{"title":"","css":"","js":"","explanation":""}}

export function parseTextToolCalls(content) {
  if (!content) return null;
  const obj = safeExtractJson(content);
  if (obj && typeof obj.tool === 'string') {
    return [{ id: 'txt-' + Date.now().toString(36), name: obj.tool, args: obj.args || {} }];
  }
  return null;
}

function tryExtractFinishFromText(content) {
  const obj = safeExtractJson(content);
  if (!obj) return null;
  // 直接是 finish 结果结构
  if (obj.tool === 'finish' && obj.args) return normalizeFinish(obj.args);
  if ('css' in obj || 'js' in obj) return normalizeFinish(obj);
  return null;
}

function normalizeFinish(a) {
  return {
    title: String(a.title || '未命名规则').slice(0, 40),
    css: typeof a.css === 'string' ? a.css : '',
  js: typeof a.js === 'string' ? a.js : '',
    explanation: String(a.explanation || ''),
  };
}

/** 从可能包含 markdown 包裹或多余文字的字符串中提取第一个 JSON 对象 */
export function safeExtractJson(text) {
  if (!text) return null;
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(raw.slice(s, e + 1));
      } catch {
   return null;
      }
    }
    return null;
  }
}

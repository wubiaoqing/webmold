// 本地 AI 后端：Chrome 内置 Prompt API（Gemini Nano），用户无需自配 API Key。
//
// 关键约束与设计：
//   1) Prompt API 无法在 service worker（Web Worker 环境）中运行，官方扩展示例也把调用
//      放在页面上下文（sidepanel）。因此这里通过 chrome.offscreen 的隐藏文档承载实际调用，
//      service worker 侧（agent 运行时）只做消息转发。
//   2) 本地模型不支持原生 function calling：chatFn 永远返回 toolCalls:null，
//      由 runner 自动走「文本降级协议」（模型用固定 JSON 输出工具调用）。
//   3) 本地模型上下文窗口小：对输入做截断保护，避免超窗报错。

const OFFSCREEN_DOC = 'background/offscreen.html';

// service worker 与离屏文档之间的消息协议（与 background/offscreen.js 保持一致）
const OMSG = {
  AVAILABILITY: 'webmold:localai:availability',
  PROMPT: 'webmold:localai:prompt',
  DESTROY: 'webmold:localai:destroy',
};

// 输入截断预算（字符）。本地模型上下文有限，需控制规模。
const MAX_SYSTEM_CHARS = 3200; // system 提示上限
const MAX_PROMPT_CHARS = 4000; // 当前问题（含 DOM 快照/需求）上限
const MAX_HISTORY_ITEMS = 6; // 保留最近 N 条历史消息
const MAX_HISTORY_ITEM_CHARS = 1200; // 单条历史消息上限

function canOffscreen() {
  return (
    typeof chrome !== 'undefined' &&
    !!chrome.runtime?.getContexts &&
    !!chrome.offscreen?.createDocument
  );
}

async function ensureOffscreen() {
  if (!canOffscreen()) {
    throw new Error('当前浏览器不支持本地 AI（需 Chrome 138+）。可改用云端模型并配置 API Key。');
  }
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    const exists = (contexts || []).some(
      (c) => c.documentUrl && c.documentUrl.includes(OFFSCREEN_DOC)
    );
    if (exists) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOC,
      reasons: ['DOM_SCRAPING'],
      justification:
        '在离屏页面中承载 Chrome 内置 AI（Prompt API / Gemini Nano）调用，提供无需 API Key 的本地模型后端',
    });
  } catch (e) {
    throw new Error('无法创建本地 AI 运行环境: ' + (e?.message || e));
  }
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

/**
 * 检测本地 AI 可用性。返回 { status: 'readily'|'after-download'|'no', detail, info }
 * info 附带设备硬件线索（CPU 核心数 / 内存），用于不可用时给出具体提示。
 */
export async function checkLocalAiAvailability() {
  await ensureOffscreen();
  const res = await send(OMSG.AVAILABILITY);
  if (!res || !res.ok) throw new Error(res?.error || '本地 AI 不可用');
  return {
    status: res.status || 'no',
    detail: res.detail || '',
    info: res.info || {},
  };
}

/** 把 runner 的 messages 转成 Prompt API 的 systemPrompt + initialPrompts + prompt */
function toPromptApi(messages) {
  const list = (messages || []).filter((m) => m && typeof m.content === 'string' && m.content);
  let systemPrompt = '';
  const rest = [];
  for (const m of list) {
    if (m.role === 'system') systemPrompt += (systemPrompt ? '\n\n' : '') + m.content;
    else rest.push(m);
  }

  let prompt = '';
  let initialPrompts = [];
  if (rest.length) {
    prompt = rest[rest.length - 1].content;
    const history = rest.slice(0, -1);
    initialPrompts = history.slice(-MAX_HISTORY_ITEMS).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content.slice(0, MAX_HISTORY_ITEM_CHARS),
    }));
  }

  return {
    systemPrompt: systemPrompt.slice(-MAX_SYSTEM_CHARS),
    initialPrompts,
    prompt: prompt.slice(0, MAX_PROMPT_CHARS),
  };
}

/** 构造一个绑定配置的本地 chatFn（与云端 makeChatFn 同签名） */
export function makeLocalChatFn(cfg) {
  return async function chatFn(messages, tools, opts = {}) {
    // 本地模型无 function calling：忽略 tools，永远走文本降级
    const { systemPrompt, initialPrompts, prompt } = toPromptApi(messages);

    await ensureOffscreen();

    const signal = opts.signal;
    const onAbort = () => send(OMSG.DESTROY).catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await send(OMSG.PROMPT, {
        systemPrompt,
        initialPrompts,
        prompt,
        temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.5,
      });
      if (!res || !res.ok) {
        const err = new Error(res?.error || '本地 AI 调用失败');
        if (res?.downloadNeeded) err.downloadNeeded = true;
        throw err;
      }
      const content = typeof res.content === 'string' ? res.content : '';
      return {
        content,
        toolCalls: null,
        finishReason: '',
        usage: null,
        raw: { role: 'assistant', content },
      };
    } catch (e) {
      if (signal?.aborted) {
        const ab = new Error('已取消');
        ab.name = 'AbortError';
        throw ab;
      }
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

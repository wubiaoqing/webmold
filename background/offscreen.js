// 离屏文档：承载 Chrome 内置 AI（Prompt API / Gemini Nano）调用。
//
// 说明：Prompt API 无法在 service worker（Web Worker 环境）中运行，因此由
// service worker 通过 chrome.offscreen 创建本隐藏页面，并经消息转发完成调用。
// 消息协议与 lib/agent/local-chat.js 中的 OMSG 保持一致。

let currentSession = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg && msg.type) {
    case 'webmold:localai:availability':
      handleAvailability()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true; // 异步响应

    case 'webmold:localai:prompt':
      handlePrompt(msg)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;

    case 'webmold:localai:destroy':
      destroySession();
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

function detectApi() {
  if (typeof LanguageModel === 'undefined') {
    throw new Error('当前浏览器不支持内置 AI（需 Chrome 138 及以上，且设备满足硬件要求）');
  }
  return LanguageModel;
}

function destroySession() {
  if (currentSession) {
    try {
      currentSession.destroy();
    } catch {
      /* ignore */
    }
    currentSession = null;
  }
}

/**
 * 构造本地模型的输出约束 schema。
 * 约束模型只输出如下形态的 JSON 对象（工具名被 enum 白名单强制，仅 tool+args 两个字段）：
 *   {"tool":"query_dom","args":{...}}   —— 调用某个工具
 *   {"tool":"finish","args":{...}}       —— 完成（rule/answer 两种模式，闲聊走 finish 的 mode="answer"）
 *
 * 关键设计（针对本地小模型对结构化输出的理解偏差）：
 *   · 只保留 tool + args 两个字段，且 required 强制二者必填、additionalProperties 禁止额外字段。
 *     之前多出的顶层 answer 字段会让小模型误以为「可以边调工具边写答案」，把最终 CSS 塞进
 *     answer 却被 runner 丢弃，导致既不 finish 又反复调工具的死循环。
 *   · 若实现不支持 required/additionalProperties 而报错，外层 handlePrompt 会降级为不带约束调用。
 * @param {string[]} toolNames
 * @returns {object|null} 无工具名时不返回约束
 */
function buildToolResponseConstraint(toolNames) {
  const names = Array.isArray(toolNames) ? toolNames.filter(Boolean) : [];
  if (!names.length) return null;
  return {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: names },
      args: { type: 'object' },
    },
    required: ['tool', 'args'],
    additionalProperties: false,
  };
}

async function handleAvailability() {
  const LM = detectApi();
  let status = 'unavailable';
  let detail = '';
  try {
    // 与 create()/prompt() 保持一致的 options：均不指定 expectedInputLanguages，使用默认。
    // 之前这里传了 ['zh','en'] 而 create 没传，两者不一致会导致误报「不支持」。
    // 返回值枚举：available / downloadable / downloading / unavailable。
    status = await LM.availability();
  } catch (e) {
    detail = String(e?.message || e);
  }

  // 注意：不要用 navigator.storage.estimate() 推算「磁盘可用空间」——它返回的是
  // 存储配额（quota）而非物理磁盘剩余空间，会严重低估并误报「磁盘不足」。
  // 磁盘是否达标只能到 chrome://on-device-internals 查看。
  return {
    ok: true,
    status,
    detail,
    info: {
      platform: (typeof navigator !== 'undefined' && navigator.userAgentData?.platform) || '',
      cpuCores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0,
      deviceMemory: (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0,
    },
  };
}

async function handlePrompt({ systemPrompt, initialPrompts, prompt, temperature, toolNames }) {
  const LM = detectApi();
  const createOpts = {};
  if (systemPrompt) createOpts.systemPrompt = systemPrompt;
  if (Array.isArray(initialPrompts) && initialPrompts.length) {
    createOpts.initialPrompts = initialPrompts;
  }
  // Prompt API 要求：temperature 与 topK 必须「同时提供，或都不提供」。
  // 只传其一会报错 "must either specify both topK and temperature, or neither of them"。
  if (typeof temperature === 'number') {
    createOpts.temperature = temperature;
    createOpts.topK = 40;
  }

  // 本地模型无 function calling。用 responseConstraint（JSON Schema）强制模型输出约定的
  // 工具调用 JSON，从根上避免「模型吐出的 JSON 格式不合规 → 解析失败 → 死循环」。
  const constraint = buildToolResponseConstraint(toolNames);

  try {
    destroySession();
    const session = await LM.create(createOpts);
    currentSession = session;

    let content;
    if (constraint) {
      try {
        content = await session.prompt(prompt || '', { responseConstraint: constraint });
      } catch (e) {
        // responseConstraint 在部分旧版本 / 环境可能不被支持，或对 required/additionalProperties
        // 等关键字报错：一律降级为不带约束的普通调用，仍由 runner 侧文本容错解析 + 兜底处理。
        if (/constraint|not support|unsupported|invalid|schema|propert|required|additional/i.test(String(e?.message || e))) {
          content = await session.prompt(prompt || '');
        } else {
          throw e;
        }
      }
    } else {
      content = await session.prompt(prompt || '');
    }

    return { ok: true, content };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/download|not available|unavailable|not found|not ready/i.test(msg)) {
      return {
        ok: false,
        error: '本地模型尚未就绪（可能需先下载），请到设置页点击「检测本地 AI」',
        downloadNeeded: true,
      };
    }
    throw e;
  } finally {
    destroySession();
  }
}

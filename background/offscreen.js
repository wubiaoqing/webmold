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

async function handleAvailability() {
  const LM = detectApi();
  let status = 'no';
  let detail = '';
  try {
    // 与 create()/prompt() 保持一致的 options：均不指定 expectedInputLanguages，使用默认。
    // 之前这里传了 ['zh','en'] 而 create 没传，两者不一致会导致误报「不支持」。
    status = await LM.availability();
  } catch (e) {
    detail = String(e?.message || e);
  }
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

async function handlePrompt({ systemPrompt, initialPrompts, prompt, temperature }) {
  const LM = detectApi();
  const createOpts = {};
  if (systemPrompt) createOpts.systemPrompt = systemPrompt;
  if (Array.isArray(initialPrompts) && initialPrompts.length) {
    createOpts.initialPrompts = initialPrompts;
  }
  if (typeof temperature === 'number') createOpts.temperature = temperature;

  try {
    destroySession();
    const session = await LM.create(createOpts);
    currentSession = session;
    const content = await session.prompt(prompt || '');
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

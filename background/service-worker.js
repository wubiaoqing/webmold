// Background Service Worker（MV3, module）
// 职责：
//  1) 消息中枢：侧边栏/内容脚本 <-> 存储 / Agent
//  2) 页面加载/路由变化时自动应用规则
//     - CSS：转发给内容脚本注入（隔离世界，不受 CSP 限制）
//     - JS：chrome.scripting.executeScript(world:'MAIN')（绕过页面 CSP）
//  3) 驱动 Agent：注入工具执行器、运行 agent、把过程事件转发给侧边栏
//  4) 打开侧边栏

import { MSG, AGENT_TOOL, AGENT_LIFECYCLE, AGENT_ASK, BRIDGE, domainFromUrl, uid } from '../lib/types.js';
import { getLlmConfig, getRulesByDomain, addHistorySession } from '../lib/storage.js';
import { runCustomizeAgent } from '../lib/agent/agent-service.js';
import { makeChatFn } from '../lib/agent/openai-chat.js';

// ---------- 侧边栏 ----------
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId });
});
chrome.runtime.onInstalled.addListener((details) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // 仅在「首次安装」时打开欢迎页做上手引导；版本更新（update）不打扰用户
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }).catch(() => {});
  }
});

// ---------- 规则匹配与应用 ----------
/**
 * 判断规则的 URL 匹配条件是否命中当前页面 URL（不考虑 enabled 状态）。
 * enabled 由调用方按需另行判断：CSS 需连同被禁用规则一起下发以便撤销，JS 仅执行启用项。
 */
function urlMatches(rule, url) {
  switch (rule.matchType) {
    case 'exact':
      return url === rule.matchValue;
    case 'prefix':
      return url.startsWith(rule.matchValue);
    case 'all':
    default:
      return true;
  }
}

async function applyRulesToTab(tabId, url) {
  const domain = domainFromUrl(url);
  if (!domain) return;
  // 取该域名下所有 URL 匹配的规则（不按 enabled 过滤）。这样：
  // - 启用的规则由 content-script 注入 CSS；
  // - 「刚被禁用」的规则也会一并下发，content-script 据 rule.enabled=false 移除其已注入的 CSS，
  //   从而实现「关闭开关即时撤销页面上的 CSS 效果」。若只发启用规则，被禁用规则的旧 CSS 将残留。
  const urlMatched = (await getRulesByDomain(domain)).filter((r) => urlMatches(r, url));

  // CSS：把所有 URL 匹配、且带 css 的规则（含被禁用的）声明式下发，由 content-script 决定注入/移除。
  const cssRules = urlMatched.filter((r) => r.css);
  // intro：本次 URL 匹配且启用的规则清单（含标题、是否含 JS），供 content-script 判断
  // 「这条规则给页面加了新 UI，且用户还没被引导过」，进而做一次醒目的首次出现引导。
  const introRules = urlMatched
    .filter((r) => r.enabled)
    .map((r) => ({ id: r.id, title: r.title || '', hasJs: !!r.js, hasCss: !!r.css }));
  if (cssRules.length || introRules.length) {
    try {
      await chrome.tabs.sendMessage(tabId, {
 type: MSG.APPLY_RULES,
        rules: cssRules,
  introRules,
      });
    } catch {
/* 内容脚本未就绪，忽略 */
    }
  }

  // JS：只执行「启用」的规则。已执行的 JS 副作用无法在运行时撤销，禁用 JS 规则需刷新页面（sidepanel 会提示）。
  const jsRules = urlMatched.filter((r) => r.enabled && r.js);
  if (jsRules.length) {
    // 用户 JS 可能调用 window.webmold.ask，注入前先装好桥接
    await ensureBridge(tabId);
    for (const rule of jsRules) {
      try {
    await chrome.scripting.executeScript({
      target: { tabId },
  world: 'MAIN',
          func: runUserJs,
args: [rule.id, rule.js],
      });
      } catch (e) {
        console.warn('[WebMold] 注入 JS 失败:', rule.id, e);
      }
    }
  }
}

/** 在指定标签页主世界安装 window.webmold 桥接（幂等） */
async function ensureBridge(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: installBridge,
      args: [{ REQ: BRIDGE.REQ, RES: BRIDGE.RES }, BRIDGE.MAX_PROMPT],
    });
  } catch (e) {
    console.warn('[WebMold] 注入桥接失败:', e);
  }
}

/** 在页面主世界执行用户 JS（带 ruleId 去重） */
function runUserJs(ruleId, code) {
  try {
    window.__webmold_applied__ = window.__webmold_applied__ || {};
    if (window.__webmold_applied__[ruleId]) return;
    window.__webmold_applied__[ruleId] = true;
    new Function(code)();
  } catch (e) {
    console.error('[WebMold] 用户脚本执行出错:', ruleId, e);
  }
}

/**
 * 在页面主世界安装 window.webmold 桥接对象，供用户定制脚本调用大模型。
 * 通过 window.postMessage 与隔离世界的内容脚本通信，真正的模型调用在 background 完成，
 * 页面全程接触不到 apiKey。此函数会被序列化注入，故所有依赖（标记/上限）由 args 传入。
 * @param {{REQ:string,RES:string}} bridge postMessage 协议标记
 * @param {number} maxPrompt prompt+context 字符上限
 */
function installBridge(bridge, maxPrompt) {
  if (window.webmold && window.webmold.__installed) return;

  const pending = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__webmold !== bridge.RES || typeof d.id !== 'string') return;
    const resolver = pending.get(d.id);
    if (!resolver) return;
    pending.delete(d.id);
 if (d.ok) resolver.resolve(d.text);
    else resolver.reject(new Error(d.error || '调用大模型失败'));
  });

  /**
   * 向大模型提问。返回一段文本回答。
   * @param {string} prompt 问题/指令
   * @param {{ context?: string, timeoutMs?: number }} [opts] 可选：附加上下文、超时
   * @returns {Promise<string>}
   */
  function ask(prompt, opts) {
    return new Promise((resolve, reject) => {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        reject(new Error('prompt 不能为空'));
     return;
      }
      const options = opts || {};
      let context = options.context;
      if (context != null && typeof context !== 'string') {
        try {
          context = JSON.stringify(context);
    } catch {
context = String(context);
        }
      }
      // 前端也做一次截断，避免明显超量
      const p = prompt.slice(0, maxPrompt);
      const c = context ? String(context).slice(0, maxPrompt) : '';

      const id = 'ask-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000;
      const timer = setTimeout(() => {
    if (pending.has(id)) {
   pending.delete(id);
   reject(new Error('调用大模型超时'));
        }
   }, timeoutMs);
      pending.set(id, {
   resolve: (v) => {
        clearTimeout(timer);
  resolve(v);
        },
     reject: (e) => {
          clearTimeout(timer);
   reject(e);
        },
      });
      window.postMessage({ __webmold: bridge.REQ, id, prompt: p, context: c }, '*');
    });
  }

  window.webmold = Object.freeze({ __installed: true, ask });
}

/** 预览用：主世界执行 JS（不去重） */
function previewUserJs(code) {
  try {
    new Function(code)();
  } catch (e) {
    console.error('[WebMold] 预览脚本执行出错:', e);
  }
}

/**
 * Agent 的 try_run_js 执行体：在主世界试跑，捕获 return 值与 console 输出、错误。
 * 注意：函数体会被序列化注入，不能引用外部变量。
 */
function agentTryRunJs(code) {
  const logs = [];
  const origLog = console.log;
  try {
    console.log = (...a) => {
      try {
      logs.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));
      } catch {
        logs.push('[unserializable log]');
      }
      origLog.apply(console, a);
    };
    const fn = new Function(code + '\n//# sourceURL=webmold-agent-tryrun');
    const rv = fn();
    let returnValue;
    try {
      returnValue = JSON.parse(JSON.stringify(rv ?? null));
    } catch {
 returnValue = String(rv);
    }
  return { ok: true, returnValue, logs: logs.slice(0, 50) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), logs: logs.slice(0, 50) };
  } finally {
console.log = origLog;
  }
}

// ---------- Agent 工具执行器（注入给 agent-service） ----------
function buildExecutors(tabId) {
  // 只读工具：转发给内容脚本执行
  const viaContent = (tool) => async (args) => {
    try {
    const res = await chrome.tabs.sendMessage(tabId, {
        type: MSG.EXEC_AGENT_TOOL,
tool,
        args,
    });
      return res || { ok: false, error: '内容脚本无响应' };
    } catch (e) {
 return { ok: false, error: '无法与页面通信: ' + (e?.message || e) };
 }
  };

  return {
    [AGENT_TOOL.QUERY_DOM]: viaContent(AGENT_TOOL.QUERY_DOM),
    [AGENT_TOOL.GET_TEXT]: viaContent(AGENT_TOOL.GET_TEXT),
    [AGENT_TOOL.GET_ATTRS]: viaContent(AGENT_TOOL.GET_ATTRS),
    [AGENT_TOOL.APPLY_CSS]: viaContent(AGENT_TOOL.APPLY_CSS),
    // try_run_js：主世界执行，带超时（scripting 无原生超时，用 Promise.race 兜底）
    [AGENT_TOOL.TRY_RUN_JS]: async ({ code }) => {
      if (typeof code !== 'string' || !code.trim()) {
        return { ok: false, error: 'code 为空' };
      }
    const exec = chrome.scripting
        .executeScript({
          target: { tabId },
  world: 'MAIN',
          func: agentTryRunJs,
          args: [code],
        })
   .then((r) => r?.[0]?.result ?? { ok: false, error: '无返回' });
      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve({ ok: false, error: 'try_run_js 执行超时(8s)' }), 8000)
      );
      try {
    return await Promise.race([exec, timeout]);
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
 }
    },

    // ask_user_question：需求有歧义时暂停并问用户。它不能同步返回，而是把问题推给
    // sidepanel（AGENT_ASK.QUESTION 事件），并在 pendingAsks 登记 resolver；runner 的
    // await 会一直挂着，直到用户经 SUBMIT_USER_ANSWER 回答后放行，或超时兜底。
    [AGENT_TOOL.ASK_USER]: ({ question, options, allowText }) => {
      const q = typeof question === 'string' ? question.trim() : '';
      if (!q) return Promise.resolve({ ok: false, error: 'question 为空' });
      // 规整选项：去空、去重、限长，最多 4 个
      const opts = Array.isArray(options)
        ? [...new Set(options.map((o) => String(o == null ? '' : o).trim()).filter(Boolean))].slice(
            0,
            4
          )
        : [];
      const allowFree = allowText !== false; // 默认允许自由输入

      const askId = 'ask-' + uid();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pendingAsks.has(askId)) {
            pendingAsks.delete(askId);
            // 超时不报错，返回一个「未响应」结果，让 agent 自行按合理默认继续，避免任务永久卡死
            emitAgentEvent(tabId, {
              type: AGENT_ASK.ANSWERED,
              data: { askId, answer: '(用户未在限定时间内回答)' },
            });
            resolve({
              answered: false,
              timedOut: true,
              answer: '',
              note: '用户未在限定时间内回答，请按最合理的默认方案继续。',
            });
          }
        }, ASK_USER_TIMEOUT_MS);

        pendingAsks.set(askId, { resolve, timer, tabId });

        // 把问题作为一种过程事件推给 sidepanel（并缓存进 task.events，便于关闭再打开时恢复待答状态）
        emitAgentEvent(tabId, {
          type: AGENT_ASK.QUESTION,
          data: { askId, question: q, options: opts, allowText: allowFree },
        });
      });
    },
  };
}

// ---------- 会话状态（按 tabId 隔离） ----------
// 用途：
//  1) sessions：本轮 session 内的多轮对话历史（用户需求 + 模型产出摘要），
//     让第2 次及以后的生成能带上之前的上下文。
//  2) runningTasks：每个 tab 当前/最近一次生成任务的完整状态，包括：
//     - controller：AbortController，用于「停止生成」；
//     - status：'running' | 'done' | 'failed' | 'aborted'；
//     - prompt：本轮用户输入（供 sidepanel 重连时重建用户气泡）；
//     - events：本轮已产生的 agent 过程事件流（供 sidepanel 重连时回放进度）；
//     - result / error：终态数据。
//     关键点：任务完全在 background 里跑，不依赖 sidepanel 是否打开；sidepanel 关闭再打开
//     时通过 GET_TASK_STATE 拉取此状态即可恢复 UI，从而实现「收起侧边栏不中断任务」。
const sessions = new Map(); // tabId -> Array<{role:'user'|'assistant', content:string}>
const runningTasks = new Map(); // tabId -> Task（见上）

// ask_user_question 挂起表：askId -> { resolve, timer, tabId }
// agent 调用该工具时不能同步返回，而是把问题推给 sidepanel 并在此登记一个 resolver；
// 待用户在 sidepanel 里选择/输入后经 SUBMIT_USER_ANSWER 回来，用askId 找到 resolver 放行，
// 工具随即返回、runner 的 await 解除、agent 带着答案继续下一步。
const pendingAsks = new Map();

// 用户未响应的兜底超时：避免 agent 因用户一直不回答而永久挂起，进而长期占用保活闹钟。
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 放行并清除某个 tab 上所有挂起的 ask_user_question（任务中断/tab 关闭时调用），
 * 让对应工具调用以「中断」结果返回，从而解除 runner 的 await，不至于永久悬挂。
 * @param {number} tabId
 * @param {string} [note] 返回给工具的说明
 */
function resolvePendingAsksForTab(tabId, note = '本次生成已结束') {
  for (const [askId, entry] of pendingAsks) {
    if (entry.tabId !== tabId) continue;
    clearTimeout(entry.timer);
    pendingAsks.delete(askId);
    try {
      entry.resolve({ answered: false, aborted: true, answer: '', note });
    } catch {
      /* ignore */
    }
  }
}

const MAX_HISTORY_MESSAGES = 12; // 历史最多保留的消息条数（约 6 轮问答），超出丢弃最旧的
const MAX_TASK_EVENTS = 500; // 单个任务缓存的事件上限，避免长时间运行内存膨胀

// ---------- Service Worker 保活 ----------
// MV3 的 SW 在无事件约 30s 后会被回收，正在跑的 agent 循环会随之被杀（即「收起侧边栏后任务中断」）。
// 用 chrome.alarms 周期唤醒 SW：只要还有任务在 running，就保持一个 30s 的闹钟持续把 SW 唤醒，
// 从而让后台 agent 循环能连续跑到finish。任务全部结束后清除闹钟，避免不必要的唤醒。
const KEEPALIVE_ALARM = 'webmold-keepalive';

function hasRunningTask() {
  for (const t of runningTasks.values()) {
    if (t && t.status === 'running') return true;
  }
  return false;
}

function ensureKeepAlive() {
  try {
    // periodInMinutes 最小为 0.5（30s），足够在回收前把 SW 唤醒
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } catch {
    /* ignore */
  }
}

function maybeStopKeepAlive() {
  if (hasRunningTask()) return;
  try {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  } catch {
    /* ignore */
  }
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // 醒来时若已无任务在跑，顺手清掉闹钟
  maybeStopKeepAlive();
});

function getHistory(tabId) {
  return sessions.get(tabId) || [];
}

/** 把本轮的用户需求与最终产出摘要追加进会话历史，并做长度裁剪 */
function pushHistory(tabId, userPrompt, result) {
  const hist = sessions.get(tabId) || [];
  hist.push({ role: 'user', content: String(userPrompt || '').slice(0, 2000) });
  let summary;
  if (result?.mode === 'answer') {
    // 问答类产出：只保留问题与答案摘要，避免把长答案塞进后续每一轮上下文
    summary =
      `问答：${String(userPrompt || '').slice(0, 100)}` +
      `\n回答：${String(result?.answer || result?.explanation || '').slice(0, 500)}`;
  } else {
    // 规则类产出：只放标题/说明/代码长度，避免把大段 css/js 塞进后续每一轮上下文
    summary =
      `已生成规则：${result?.title || '未命名规则'}` +
      (result?.explanation ? `\n说明：${String(result.explanation).slice(0, 500)}` : '') +
      `\n（含 CSS ${((result?.css || '').length)} 字、JS ${((result?.js || '').length)} 字）`;
  }
  hist.push({ role: 'assistant', content: summary });
  // 只保留最近 N 条
  while (hist.length > MAX_HISTORY_MESSAGES) hist.shift();
  sessions.set(tabId, hist);
}

function clearSession(tabId) {
  sessions.delete(tabId);
  // 若该 tab 有已结束（非 running）的任务记录，一并清除，避免下次打开又回放上一轮结果
  const task = runningTasks.get(tabId);
  if (task && task.status !== 'running') {
    runningTasks.delete(tabId);
  }
}

// 标签页关闭时清理其会话与运行中的任务，避免泄漏
chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  resolvePendingAsksForTab(tabId, '标签页已关闭');
  const task = runningTasks.get(tabId);
  if (task) {
    try {
      task.controller?.abort();
    } catch {
      /* ignore */
    }
    runningTasks.delete(tabId);
  }
  maybeStopKeepAlive();
});

// ---------- 自动应用触发 ----------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) applyRulesToTab(tabId, tab.url);
});
chrome.webNavigation?.onHistoryStateUpdated?.addListener((d) => {
  if (d.frameId === 0) applyRulesToTab(d.tabId, d.url);
});

// ---------- Agent 事件转发到侧边栏 ----------
// 事件既转发给 sidepanel（若打开），也缓存进对应任务的 events，
// 以便 sidepanel 关闭后重新打开时能回放本轮完整进度。
function emitAgentEvent(tabId, ev) {
  const task = runningTasks.get(tabId);
  if (task) {
    task.events.push(ev);
    if (task.events.length > MAX_TASK_EVENTS) {
      task.events.splice(0, task.events.length - MAX_TASK_EVENTS);
    }
  }
  // 带上 tabId，便于 sidepanel 过滤只属于当前 tab 的事件
  chrome.runtime.sendMessage({ type: MSG.AGENT_EVENT, tabId, event: ev }).catch(() => {});
}

/**
 * 把一轮已结束的任务落库为历史会话（供sidepanel 之后回放查看）。
 * 在background 完成，因此无论 sidepanel 是否打开都不会漏记。
 * @param {object} task runningTasks 里的任务对象
 * @param {'done'|'failed'|'aborted'} status
 */
async function persistHistory(task, status) {
  if (!task || !task.domain) return;
  try {
    await addHistorySession({
      id: uid(),
      domain: task.domain,
      prompt: task.prompt || '',
      events: Array.isArray(task.events) ? task.events : [],
      result: status === 'done' ? task.result || null : null,
      status,
      error: task.error || '',
      createdAt: Date.now(),
    });
  } catch (e) {
    console.warn('[WebMold] 历史会话落库失败:', e);
  }
}

/**
 * 在background 后台独立运行一次生成任务，直到 finish/失败/中断。
 * 该函数不 await在消息处理里，因此 sidepanel 关闭也不影响它继续跑；
 * 过程与终态都通过 emitAgentEvent 推送并缓存进 task.events。
 */
async function runGenerateTask({ tabId, prompt, pageContext, existingRule, options, task }) {
  try {
    const cfg = await getLlmConfig();
    const executors = buildExecutors(tabId);

    // 自动识别：非手动编辑态（未显式传 existingRule）时，取当前域名下已有规则作为候选，
    // 交给 agent 判断本次需求是否为修改某条已有规则。
    let candidateRules;
    if (!existingRule) {
      const domain = domainFromUrl(pageContext?.url || '');
      if (domain) {
        const rules = await getRulesByDomain(domain);
        candidateRules = rules.map((r) => ({
          id: r.id,
          title: r.title,
          prompt: r.prompt,
          css: r.css,
          js: r.js,
        }));
      }
    }

    const history = getHistory(tabId);

    const result = await runCustomizeAgent({
      cfg,
      userPrompt: prompt,
      pageContext,
      executors,
      existingRule,
      candidateRules,
      history,
      signal: task.controller.signal,
      onEvent: (ev) => emitAgentEvent(tabId, ev),
      options: options || {},
    });

    // 成功：写入会话历史、更新任务终态、推送 done 事件（供 sidepanel 拿到结果并收尾气泡）
    pushHistory(tabId, prompt, result);
    task.status = 'done';
    task.result = result;
    emitAgentEvent(tabId, { type: AGENT_LIFECYCLE.DONE, result });
    await persistHistory(task, 'done');
  } catch (e) {
    if (task.controller.signal.aborted || e?.name === 'AbortError') {
      task.status = 'aborted';
      task.error = '已取消生成';
      emitAgentEvent(tabId, { type: AGENT_LIFECYCLE.ABORTED });
      await persistHistory(task, 'aborted');
    } else {
      task.status = 'failed';
      task.error = e?.message || String(e);
      emitAgentEvent(tabId, { type: AGENT_LIFECYCLE.FAILED, error: task.error });
      await persistHistory(task, 'failed');
    }
  } finally {
    // 任务结束：放行该tab 上可能残留的挂起提问（防止失败/异常路径下resolver 悬挂），
    // 再视情况停止保活闹钟。
    resolvePendingAsksForTab(tabId, '本次生成已结束');
    // 任务结束：若无其它任务在跑则停止保活闹钟
    maybeStopKeepAlive();
  }
}

// ---------- 用户定制脚本的一次性问答（供 window.webmold.ask 使用） ----------
/**
 * 用 background 持有的 apiKey 调一次模型，返回纯文本答案。
 * 不走 agent 循环，也不带工具；system 提示让模型作为“网页助手”简洁作答。
 * @param {string} prompt
 * @param {string} [context]
 */
async function askLlmOnce(prompt, context) {
  const p = typeof prompt === 'string' ? prompt.trim() : '';
  if (!p) throw new Error('prompt 不能为空');

  const cfg = await getLlmConfig();
  const chatFn = makeChatFn(cfg);

  const maxLen = BRIDGE.MAX_PROMPT;
  const userContent = context
    ? `${p.slice(0, maxLen)}\n\n【页面上下文】\n${String(context).slice(0, maxLen)}`
    : p.slice(0, maxLen);

  const messages = [
    {
      role: 'system',
   content:
 '你是嵌入网页的智能助手，会收到用户的问题以及可选的“页面上下文”。' +
    '请基于上下文用简洁、直接的自然语言作答；若上下文不足以回答，就据实说明。不要输出与问题无关的内容。',
    },
    { role: 'user', content: userContent },
  ];

  // 一次性问答，不传 tools
  const res = await chatFn(messages, null);
  return (res && typeof res.content === 'string' ? res.content : '').trim();
}

// ---------- 消息处理 ----------
// 关键：必须「按消息类型」精确决定监听器的返回值——
//   · 同步就能回复的分支：同步调用 sendResponse 后返回 false，让通道立即关闭；
//   · 需要 await 才能回复的分支：进入 async 流程并返回 true，声明「稍后异步回复」。
// 切勿对所有消息无条件 return true。那会让 Chrome 为每条消息都保持通道打开等待，
// 而同步分支其实早已回复；一旦发送方（尤其 sidepanel）在这段间隙关闭，通道销毁，
// 就会报「message channel closed before a response was received」。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // ===== 同步回复分支：立即 sendResponse 并 return false（通道随即关闭）=====
    case MSG.GENERATE_RULE: {
      // 侧边栏请求：运行 agent 生成规则。
      // 关键：立即返回「已启动」，任务在 background 后台独立运行，不依赖 sidepanel 是否保持打开。
      // 过程/终态都通过 emitAgentEvent 推送并缓存，sidepanel 关闭再打开时可用 GET_TASK_STATE 恢复。
      const { tabId, prompt, pageContext, existingRule, options } = msg;
      if (tabId == null) {
        sendResponse({ ok: false, error: '缺少 tabId' });
        return false;
      }

      // 若该 tab 上已有正在跑的生成，先中断旧的，避免并发
      const prevTask = runningTasks.get(tabId);
      if (prevTask && prevTask.status === 'running') {
        try {
          prevTask.controller?.abort();
        } catch {
          /* ignore */
        }
        // 旧任务可能正挂在 ask_user_question 上，一并放行避免悬挂
        resolvePendingAsksForTab(tabId, '已开始新的生成');
      }

      const controller = new AbortController();
      // 初始化本轮任务状态并保活；agent 事件写入 task.events
      const task = {
        controller,
        status: 'running',
        prompt: String(prompt || ''),
        domain: domainFromUrl(pageContext?.url || ''),
        existing: !!existingRule,
        events: [],
        result: null,
        error: '',
        startedAt: Date.now(),
      };
      runningTasks.set(tabId, task);
      ensureKeepAlive();

      // 立即回执：告知 sidepanel 任务已在后台启动（不在此等待结果）
      sendResponse({ ok: true, started: true });

      // 后台独立跑 agent；完成/失败/中断都通过事件推送
      runGenerateTask({ tabId, prompt, pageContext, existingRule, options, task });
      return false;
    }

    case MSG.GET_TASK_STATE: {
      // sidepanel 打开/重连时拉取该 tab 的任务状态，用于恢复「进行中/已完成」的对话 UI
      const { tabId } = msg;
      const task = tabId != null ? runningTasks.get(tabId) : null;
      if (!task) {
        sendResponse({ ok: true, task: null });
      } else {
        sendResponse({
          ok: true,
          task: {
            status: task.status,
            prompt: task.prompt,
            events: task.events,
            result: task.result,
            error: task.error,
          },
        });
      }
      return false;
    }

    case MSG.CANCEL_GENERATE: {
      const { tabId } = msg;
      const task = tabId != null ? runningTasks.get(tabId) : null;
      if (task && task.status === 'running') {
        try {
          task.controller?.abort();
        } catch {
          /* ignore */
        }
        // 若正挂在 ask_user_question 上，放行以解除等待，让中断即时生效
        resolvePendingAsksForTab(tabId, '已停止生成');
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: '当前没有正在运行的生成' });
      }
      return false;
    }

    case MSG.CLEAR_SESSION: {
      const { tabId } = msg;
      if (tabId != null) clearSession(tabId);
      sendResponse({ ok: true });
      return false;
    }

    case MSG.SUBMIT_USER_ANSWER: {
      // sidepanel 回传用户对某次 ask_user_question 的选择/输入：找到挂起的 resolver 放行，
      // 工具随即返回该答案，agent 继续下一步。
      const { askId, answer } = msg;
      const entry = askId != null ? pendingAsks.get(askId) : null;
      if (!entry) {
        // 可能已超时/已被中断/重复提交，幂等处理
        sendResponse({ ok: false, error: '该提问已失效' });
        return false;
      }
      clearTimeout(entry.timer);
      pendingAsks.delete(askId);
      const finalAnswer = typeof answer === 'string' ? answer.trim() : '';
      // 通知 sidepanel 收尾这条提问项的UI（禁用选项、标记已回答）
      emitAgentEvent(entry.tabId, {
        type: AGENT_ASK.ANSWERED,
        data: { askId, answer: finalAnswer },
      });
      try {
        entry.resolve({ answered: true, answer: finalAnswer });
      } catch {
        /* ignore */
      }
      sendResponse({ ok: true });
      return false;
    }

    // ===== 异步回复分支：进入 async 流程并 return true =====
    case MSG.RULES_UPDATED:
    case MSG.APPLY_RULES:
    case MSG.PREVIEW_RULE:
    case MSG.ASK_LLM:
    case MSG.CLEAR_PREVIEW: {
      (async () => {
        try {
          switch (msg.type) {
            case MSG.RULES_UPDATED: {
              const tabId = sender.tab?.id;
              const url = msg.url || sender.tab?.url;
              if (tabId != null && url) await applyRulesToTab(tabId, url);
              sendResponse({ ok: true });
              break;
            }

            case MSG.APPLY_RULES: {
              const { tabId, url } = msg;
              if (tabId != null && url) await applyRulesToTab(tabId, url);
              sendResponse({ ok: true });
              break;
            }

            case MSG.PREVIEW_RULE: {
              const { tabId, rule } = msg;
              if (tabId != null) {
                if (rule.css !== undefined) {
                  await chrome.tabs.sendMessage(tabId, { type: MSG.PREVIEW_RULE, rule }).catch(() => {});
                }
                if (rule.js) {
                  await ensureBridge(tabId);
                  await chrome.scripting
                    .executeScript({ target: { tabId }, world: 'MAIN', func: previewUserJs, args: [rule.js] })
                    .catch(() => {});
                }
              }
              sendResponse({ ok: true });
              break;
            }

            case MSG.ASK_LLM: {
              // 来自用户定制脚本（经内容脚本转发）的一次性问答
              const text = await askLlmOnce(msg.prompt, msg.context);
              sendResponse({ ok: true, text });
              break;
            }

            case MSG.CLEAR_PREVIEW: {
              const { tabId } = msg;
              if (tabId != null) {
                await chrome.tabs.sendMessage(tabId, { type: MSG.CLEAR_PREVIEW }).catch(() => {});
              }
              sendResponse({ ok: true });
              break;
            }
          }
        } catch (e) {
          // 通道可能已关闭（发送方在回复前销毁），此时 sendResponse 会抛错，吞掉即可。
          try {
            sendResponse({ ok: false, error: e?.message || String(e) });
          } catch {
            /* 通道已关闭，忽略 */
          }
        }
      })();
      return true; // 声明稍后异步回复
    }

    default:
      // 未知消息：同步回复错误并立即关闭通道，不占用异步等待。
      sendResponse({ ok: false, error: 'unknown message' });
      return false;
  }
});

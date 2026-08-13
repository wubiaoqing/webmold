// 内容脚本：在 document_start 尽早运行。
// 职责：
//  1) 向 background 请求当前页面匹配的规则，并应用（CSS 直接注入；JS 交由 background 用 scripting 在主世界执行）
//  2) 采集页面上下文（供侧边栏生成规则时使用）
//  3) 处理预览（临时应用/清除，不落库）
//
// 注意：内容脚本运行在隔离世界（isolated world），注入 CSS 不受页面 CSP 限制；
// 但注入并执行页面级 JS 需要主世界（MAIN world），因此 JS 通过 background 的
// chrome.scripting.executeScript({ world: 'MAIN' }) 执行，以绕过页面 CSP。

// 幂等守卫：内容脚本既由 manifest 静态注入，也可能被侧边栏用 chrome.scripting现场补注入
// （用于页面在插件更新前打开、旧脚本缺少新消息处理的场景）。重复注入会因顶层 const 重声明
// 而抛 SyntaxError，故用页面级标记确保整段逻辑只初始化一次。
if (window.__WEBMOLD_CONTENT_LOADED__) {
  // 已加载过，直接跳过后续初始化
} else {
  window.__WEBMOLD_CONTENT_LOADED__ = true;

const MSG = {
  APPLY_RULES: 'APPLY_RULES',
  GET_PAGE_CONTEXT: 'GET_PAGE_CONTEXT',
  START_PICK_ELEMENT: 'START_PICK_ELEMENT',
  STOP_PICK_ELEMENT: 'STOP_PICK_ELEMENT',
  ELEMENT_PICKED: 'ELEMENT_PICKED',
  PREVIEW_RULE: 'PREVIEW_RULE',
  CLEAR_PREVIEW: 'CLEAR_PREVIEW',
  RULES_UPDATED: 'RULES_UPDATED',
  EXEC_AGENT_TOOL: 'EXEC_AGENT_TOOL',
  ASK_LLM: 'ASK_LLM',
};

// 页面桥接协议标记（须与 lib/types.js 的 BRIDGE 一致）
const BRIDGE = {
  REQ: 'WEBMOLD_BRIDGE_ASK_REQ',
  RES: 'WEBMOLD_BRIDGE_ASK_RES',
};

// agent 工具名（须与 lib/types.js 的 AGENT_TOOL 保持一致）
const AGENT_TOOL = {
  QUERY_DOM: 'query_dom',
  GET_TEXT: 'get_text',
  GET_ATTRS: 'get_attributes',
  APPLY_CSS: 'preview_css',
};

const STYLE_ID_PREFIX = 'webmold-style-';
const PREVIEW_STYLE_ID = 'webmold-preview-style';
const AGENT_CSS_ID = 'webmold-agent-css';

/** 注入或更新一段 CSS，用 ruleId 做标识便于去重/移除 */
function injectCss(ruleId, css) {
  if (!css) return;
  const id = STYLE_ID_PREFIX + ruleId;
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
  el.id = id;
    el.setAttribute('data-webmold', '1');
    (document.head || document.documentElement).appendChild(el);
  }
  el.textContent = css;
}

function removeCss(ruleId) {
  const el = document.getElementById(STYLE_ID_PREFIX + ruleId);
  if (el) el.remove();
}

/** 应用一批规则：CSS 就地注入，JS 请求 background 执行 */
function applyRules(rules) {
  for (const rule of rules) {
    if (!rule.enabled) {
      removeCss(rule.id);
      continue;
    }
    if (rule.css) injectCss(rule.id, rule.css);
    // JS 由 background 执行，此处只需保证 background 已被通知（见 service-worker）
  }
}

/** 采集页面上下文：标题 + 结构摘要（用于辅助 LLM 生成精准选择器） */
function collectPageContext() {
  return {
    url: location.href,
    title: document.title,
    domSnapshot: buildDomSnapshot(),
  };
}

/**
 * 构建一个精简的 DOM 结构摘要，帮助 LLM 理解页面。
 * 只保留标签名、id、前两个 class、role/aria-label，限制总长度。
 */
function buildDomSnapshot(maxChars = 6000) {
  const parts = [];
  const walk = (node, depth) => {
    if (parts.join('').length > maxChars) return;
    if (node.nodeType !== 1) return; // 只看元素
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return;
    const id = node.id ? `#${node.id}` : '';
    const cls =
      node.classList && node.classList.length
        ? '.' + [...node.classList].slice(0, 2).join('.')
        : '';
    const role = node.getAttribute && node.getAttribute('role');
    const aria = node.getAttribute && node.getAttribute('aria-label');
    const label = [role ? `role=${role}` : '', aria ? `aria=${aria}` : '']
   .filter(Boolean)
      .join(' ');
    parts.push('  '.repeat(depth) + `<${tag}${id}${cls}${label ? ' ' + label : ''}>`);
    if (depth < 6) {
      const children = [...node.children].slice(0, 12);
      for (const c of children) walk(c, depth + 1);
  }
  };
  if (document.body) walk(document.body, 0);
  return parts.join('\n').slice(0, maxChars);
}

// ---------- 首次出现引导 ----------
// 目的：Agent 用 JS 给页面新增的 UI（按钮/面板等，统一带 data-webmold="1"），用户第一次
// 往往很难注意到它在哪。这里在规则「首次」应用到本机时，找到该规则新增的元素，做一次醒目的
// 高亮光圈 + 指向气泡，并附「知道了」；用户看到后引导消失，且此后同一条规则永不再打扰。
//
// 关键约束：
//  - 只引导一次：用 chrome.storage.local 的 webmold_introduced（{[ruleId]:true}）持久化标记。
//  - 只引导「可能新增了 UI」的规则：以带 js 为主（纯隐藏类 CSS 无新元素可指，不打扰）。
//  - JS 新增元素常是异步/延迟出现（MutationObserver 等），故用观察者 + 超时兜底来等元素出现。
//  - UI 用 Shadow DOM 隔离，既不被页面/规则自身 CSS 污染，也不会被 Agent 的选择器误伤。

const INTRODUCED_KEY = 'webmold_introduced';
const INTRO_HOST_ID = 'webmold-intro-host';
const INTRO_WAIT_MS = 8000; // 等待 JS 新增元素出现的最长时间
const INTRO_AUTO_DISMISS_MS = 12000; // 引导自动消失时间
const PREVIEW_INTRO_WAIT_MS = 2500; // 预览引导等待 JS 元素出现的时间（预览 JS 立即执行，短等即可）

let _introBusy = false; // 同一时刻只引导一条，避免多条规则争抢/叠加
let _previewIntroCanceled = false; // 清除预览时取消尚在等待中的预览引导

/** 读取已引导规则集合 */
function getIntroducedSet() {
  return new Promise((resolve) => {
  try {
      chrome.storage.local.get(INTRODUCED_KEY, (data) => {
        void chrome.runtime.lastError;
  resolve((data && data[INTRODUCED_KEY]) || {});
      });
    } catch {
      resolve({});
}
  });
}

/** 标记某规则已引导（持久化，确保只提示一次） */
function markIntroduced(ruleId) {
  try {
    chrome.storage.local.get(INTRODUCED_KEY, (data) => {
      void chrome.runtime.lastError;
      const map = (data && data[INTRODUCED_KEY]) || {};
map[ruleId] = true;
      chrome.storage.local.set({ [INTRODUCED_KEY]: map }, () => {
        void chrome.runtime.lastError;
      });
    });
  } catch {
    /* 存储不可用则忽略：最坏情况是下次可能再引导一次，不影响功能 */
  }
}

/**
 * 记录引导开始前页面上已存在的 data-webmold 元素，用于之后甄别「本次规则新增的元素」。
 * 返回一个 WeakSet 快照。
 */
function snapshotExistingWebmoldEls() {
  const set = new WeakSet();
  try {
    document.querySelectorAll('[data-webmold]').forEach((el) => set.add(el));
  } catch {
  /* ignore */
  }
  return set;
}

/**
 * 等待「本次规则新增的、可见的」data-webmold 元素出现。
 * 排除引导自身宿主与拾取覆盖层；优先取视口内、面积最大的一个作为引导目标。
 * @param {WeakSet} preexisting 引导前已存在的元素集合
 * @param {number} [timeoutMs] 等待上限，默认 INTRO_WAIT_MS
 * @returns {Promise<Element|null>}
 */
function waitForNewWebmoldEl(preexisting, timeoutMs) {
  const pick = () => {
    let best = null;
    let bestScore = -1;
    let nodes;
    try {
      nodes = document.querySelectorAll('[data-webmold]');
    } catch {
      return null;
    }
    for (const el of nodes) {
      if (preexisting.has(el)) continue; // 引导前就有的，不是本次新增
      if (el.id === INTRO_HOST_ID || el.id === PICK_OVERLAY_ID || el.id === PICK_TIP_ID) continue;
      // 跳过我们自己注入的 style 标签（不可见、无法指向）
      if (el.tagName === 'STYLE' || el.tagName === 'LINK') continue;
   let r;
      try {
  r = el.getBoundingClientRect();
      } catch {
   continue;
      }
      if (r.width <= 0 || r.height <= 0) continue; // 不可见
      // 打分：视口内优先，其次面积适中（避免选到整页容器）
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const inView = r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
   const area = r.width * r.height;
    // 面积太大的（超过视口 80%）多半是容器，降权
      const tooBig = area > vw * vh * 0.8;
      const score = (inView ? 1000 : 0) - (tooBig ? 500 : 0) - Math.abs(area - 20000) / 10000;
if (score > bestScore) {
  bestScore = score;
        best = el;
      }
    }
    return best;
  };

  return new Promise((resolve) => {
    const now = pick();
    if (now) return resolve(now);
    let done = false;
    const finish = (el) => {
      if (done) return;
      done = true;
      try {
        obs.disconnect();
      } catch {
   /* ignore */
  }
      clearTimeout(timer);
      resolve(el);
    };
    const obs = new MutationObserver(() => {
  const el = pick();
      if (el) finish(el);
    });
    try {
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => finish(null), timeoutMs || INTRO_WAIT_MS);
  });
}

/**
 * 对一批规则做首次出现引导。逐条筛选未引导过、可能新增 UI 的规则，
 * 每次只引导一条（引导中会置忙），成功展示后即标记为已引导。
 * @param {Array<{id:string,title?:string,hasJs?:boolean,hasCss?:boolean}>} introRules
 */
async function maybeIntroduceRules(introRules) {
  if (!Array.isArray(introRules) || !introRules.length) return;
  if (_introBusy) return;

  const introduced = await getIntroducedSet();
  // 候选：未引导过、且含 JS（可能新增了可交互 UI）。纯 CSS 规则通常是隐藏/微调外观，
  // 没有「新出现的东西」需要用户去找，故不打扰。
  const candidate = introRules.find((r) => r && r.id && r.hasJs && !introduced[r.id]);
  if (!candidate) return;

  _introBusy = true;
  try {
    const preexisting = snapshotExistingWebmoldEls();
    const target = await waitForNewWebmoldEl(preexisting);
    // 无论是否找到目标，都标记为已引导：找到就指向它；没找到（可能规则未真正产出可见 UI）
    // 也不必反复尝试打扰用户。
    markIntroduced(candidate.id);
    if (target) showIntroFor(target, candidate.title);
  } finally {
    _introBusy = false;
  }
}

/**
 * 预览时的即时引导：用户点「预览」后立即高亮本次规则新增的 UI。
 * 与首次出现引导不同：不检查/写入「已引导」标记（预览不消耗正式引导），
 * 只要预览的 JS 可能新增元素就尝试引导，让用户立刻看到效果在哪。
 * @param {{id?:string,title?:string,js?:string,css?:string}} [rule]
 */
async function maybePreviewIntroduce(rule) {
  if (_introBusy) return; // 正在展示其它引导，跳过本次预览引导
  if (!rule || !rule.js) return; // 纯 CSS 规则通常无可指的新 UI，不打扰
  _introBusy = true;
  _previewIntroCanceled = false;
  try {
    const preexisting = snapshotExistingWebmoldEls();
    const target = await waitForNewWebmoldEl(preexisting, PREVIEW_INTRO_WAIT_MS);
    if (target && !_previewIntroCanceled) showIntroFor(target, rule.title, true);
  } finally {
    _introBusy = false;
  }
}

/**
 * 针对目标元素展示引导：一个覆盖在目标上方的脉冲高亮光圈 + 一张指向气泡卡片（含「知道了」）。
 * 全部放进 Shadow DOM，避免样式互相污染，也不被规则/页面 CSS 命中。
 * 目标滚动出视口/点击「知道了」/超时后自动收起。
 * @param {Element} target
 * @param {string} [title] 规则标题，用于气泡文案
 * @param {boolean} [preview] 是否为预览引导（文案不同，且不持久化）
 */
function showIntroFor(target, title, preview) {
  // 先移除可能残留的旧引导
  const old = document.getElementById(INTRO_HOST_ID);
  if (old) old.remove();

  const host = document.createElement('div');
  host.id = INTRO_HOST_ID;
  host.setAttribute('data-webmold', '1');
  Object.assign(host.style, {
  position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    pointerEvents: 'none', // 宿主本身不拦截页面交互；卡片/按钮单独开启
  });
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .ring {
      position: fixed;
      box-sizing: border-box;
      border: 2px solid #4f8cff;
      border-radius: 8px;
      box-shadow: 0 0 0 4px rgba(79,140,255,0.25), 0 0 0 9999px rgba(17,24,39,0.35);
      pointer-events: none;
      transition: all 0.2s ease-out;
      animation: wm-pulse 1.6s ease-in-out infinite;
    }
    @keyframes wm-pulse {
      0%,100% { box-shadow: 0 0 0 4px rgba(79,140,255,0.25), 0 0 0 9999px rgba(17,24,39,0.35); }
      50%     { box-shadow: 0 0 0 8px rgba(79,140,255,0.45), 0 0 0 9999px rgba(17,24,39,0.35); }
    }
    .card {
      position: fixed;
      max-width: 260px;
background: #1f2937;
      color: #fff;
      font: 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      padding: 12px 14px;
      border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.35);
      pointer-events: auto;
    }
    .card .t { font-weight: 700; margin-bottom: 4px; display:flex; align-items:center; gap:6px; }
    .card .t .badge {
 display:inline-block; font-size:11px; font-weight:600;
      background:#4f8cff; color:#fff; border-radius:4px; padding:1px 6px;
    }
    .card .d { opacity: 0.92; margin-bottom: 10px; word-break: break-word; }
    .card .ok {
      appearance:none; border:none; cursor:pointer;
      background:#4f8cff; color:#fff; font-size:12px; font-weight:600;
      padding:6px 14px; border-radius:6px;
    }
    .card .ok:hover { background:#3a78f0; }
  `;
  shadow.appendChild(style);

  const ring = document.createElement('div');
  ring.className = 'ring';
  shadow.appendChild(ring);

  const card = document.createElement('div');
  card.className = 'card';
  const t = document.createElement('div');
  t.className = 't';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = 'WebMold';
  const tText = document.createElement('span');
  tText.textContent = '这是为你定制的功能';
  t.append(badge, tText);
  const d = document.createElement('div');
  d.className = 'd';
  // 文案含规则标题（来自模型/用户，用 textContent 防 XSS）
  d.textContent = preview
    ? (title
        ? `「${title}」预览已应用，高亮位置就是新增的功能，满意后再点保存。`
        : '预览已应用，高亮位置就是新增的功能，满意后再点保存。')
    : (title
        ? `「${title}」已生效，就在高亮位置，点这里试试吧。`
        : '这是插件按你的需求新增的功能，就在高亮位置，去试试吧。');
  const ok = document.createElement('button');
  ok.className = 'ok';
  ok.type = 'button';
  ok.textContent = '知道了';
  card.append(t, d, ok);
  shadow.appendChild(card);

  document.documentElement.appendChild(host);

  // 定位：光圈罩住目标，卡片放在目标下方（空间不足则放上方/贴边）
  const reposition = () => {
    let r;
    try {
      r = target.getBoundingClientRect();
    } catch {
    cleanup();
      return;
    }
    // 目标已不可见或移出视口太远则收起
    if (r.width <= 0 || r.height <= 0) {
      cleanup();
    return;
    }
    const pad = 4;
    ring.style.top = `${r.top - pad}px`;
    ring.style.left = `${r.left - pad}px`;
    ring.style.width = `${r.width + pad * 2}px`;
    ring.style.height = `${r.height + pad * 2}px`;

    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    // 先渲染后量卡片尺寸
    const cr = card.getBoundingClientRect();
    let top = r.bottom + 10;
    if (top + cr.height > vh - 8) top = Math.max(8, r.top - cr.height - 10); // 下方放不下改上方
let left = r.left;
    if (left + cr.width > vw - 8) left = Math.max(8, vw - cr.width - 8);
    card.style.top = `${Math.max(8, top)}px`;
    card.style.left = `${left}px`;
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
  window.removeEventListener('scroll', onScrollResize, true);
    window.removeEventListener('resize', onScrollResize, true);
    clearTimeout(autoTimer);
host.remove();
  };
  const onScrollResize = () => reposition();

  ok.addEventListener('click', cleanup);
  window.addEventListener('scroll', onScrollResize, true);
  window.addEventListener('resize', onScrollResize, true);
  const autoTimer = setTimeout(cleanup, INTRO_AUTO_DISMISS_MS);

  // 首次定位（放到下一帧，确保卡片已布局出尺寸）
  requestAnimationFrame(reposition);
  // 若目标不在视口，平滑滚动到可见处再定位
  try {
    const r0 = target.getBoundingClientRect();
    const vh0 = window.innerHeight || document.documentElement.clientHeight;
    if (r0.top < 0 || r0.bottom > vh0) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(reposition, 400);
    }
  } catch {
    /* ignore */
  }
}

// ---------- 元素拾取模式 ----------
// 用户在侧边栏点「选择元素」后，页面进入拾取模式：
//  - 鼠标悬停时蓝色高亮候选元素；
//  - 单击切换选中/取消该元素（可连续多选，已选元素以绿色标记框标出），
//    生成稳定的 CSS 选择器 + 结构摘要；
//  - Esc 或再次点击侧边栏按钮完成选择，一次性把全部已选元素回传给侧边栏作为对话上下文。
// 拾取全程只做「观察」，不修改页面业务DOM（高亮/标记用覆盖层实现，随用随清）。

const PICK_OVERLAY_ID = 'webmold-pick-overlay';
const PICK_TIP_ID = 'webmold-pick-tip';
const PICK_SELECTED_ID = 'webmold-pick-selected';
let picking = false;
let pickHoverEl = null;
let pickedEls = []; // 已选中的元素引用（用于绿色标记框定位）
let pickedInfos = []; // 与 pickedEls 一一对应的元素摘要（describePicked 结果）

/** 转义 CSS 标识符中的特殊字符，供拼接选择器时使用 */
function cssEscapeIdent(str) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(str);
  return String(str).replace(/([^\w-])/g, '\\$1');
}

/**
 * 为元素生成一个尽量稳定、唯一的 CSS 选择器。
 * 策略：优先用 id；否则从元素向上逐级构造 tag +稳定 class + :nth-of-type，
 * 直到选择器在文档中唯一或到达 body。
 */
function buildSelector(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) {
    const byId = `#${cssEscapeIdent(el.id)}`;
    try {
      if (document.querySelectorAll(byId).length === 1) return byId;
    } catch {
      /* 忽略无效 id */
    }
  }
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      part = `#${cssEscapeIdent(node.id)}`;
      parts.unshift(part);
      break; // id 足够定位，向上不再追加
    }
    // 选用一个「看起来稳定」的 class（排除明显的动态/状态类）
    const stableClass = [...(node.classList || [])].find(
      (c) => c && !/^(is-|has-|active|hover|focus|selected|open)/.test(c) && !/\d{3,}/.test(c)
    );
    if (stableClass) part += `.${cssEscapeIdent(stableClass)}`;
    // 同级同类型里的序号，增强唯一性
    const parent = node.parentElement;
    if (parent) {
      const sameType = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (sameType.length > 1) {
        const idx = sameType.indexOf(node) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(part);
    const candidate = parts.join(' > ');
    try {
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    } catch {
      /* 选择器暂不唯一，继续向上 */
    }
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/** 采集被选中元素的摘要（选择器 + 精简 outerHTML + 文本 + 位置），作为对话上下文 */
function describePicked(el) {
  const selector = buildSelector(el);
  // outerHTML 可能很长：去掉子孙里的 script/style，并整体截断
  let outer = '';
  try {
    const clone = el.cloneNode(true);
    clone.querySelectorAll && clone.querySelectorAll('script,style,svg,noscript').forEach((n) => n.remove());
    outer = clone.outerHTML || '';
    // 若过长，仅保留开标签+ 省略提示，避免灌爆上下文
    if (outer.length > 2000) {
      const openTag = outer.slice(0, outer.indexOf('>') + 1);
      outer = `${openTag} … (内容过长已省略) …</${el.tagName.toLowerCase()}>`;
    }
  } catch {
    outer = '';
  }
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  let rect;
  try {
    const r = el.getBoundingClientRect();
    rect = { w: Math.round(r.width), h: Math.round(r.height) };
  } catch {
    rect = undefined;
  }
  return {
    selector,
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    className: el.className && typeof el.className === 'string' ? el.className : undefined,
    text,
    outerHTML: outer,
    rect,
  };
}

/** 创建/获取高亮覆盖层（绝对定位，不干扰页面交互，pointer-events:none） */
function ensurePickOverlay() {
  let ov = document.getElementById(PICK_OVERLAY_ID);
  if (!ov) {
    ov = document.createElement('div');
    ov.id = PICK_OVERLAY_ID;
    ov.setAttribute('data-webmold', '1');
    Object.assign(ov.style, {
      position: 'fixed',
      zIndex: '2147483646',
      pointerEvents: 'none',
      border: '2px solid #4f8cff',
      background: 'rgba(79,140,255,0.15)',
      borderRadius: '3px',
      transition: 'all 0.05s ease-out',
      display: 'none',
      boxSizing: 'border-box',
    });
    document.documentElement.appendChild(ov);
  }
  return ov;
}

/** 创建/获取顶部操作提示条 */
function ensurePickTip() {
  let tip = document.getElementById(PICK_TIP_ID);
  if (!tip) {
    tip = document.createElement('div');
    tip.id = PICK_TIP_ID;
    tip.setAttribute('data-webmold', '1');
    Object.assign(tip.style, {
      position: 'fixed',
      zIndex: '2147483647',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      pointerEvents: 'none',
      background: '#1f2937',
      color: '#fff',
      font: '12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      padding: '6px 12px',
      borderRadius: '6px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
      whiteSpace: 'nowrap',
    });
    document.documentElement.appendChild(tip);
  }
  return tip;
}

/** 按当前已选数量刷新提示条文案 */
function updatePickTip() {
  const tip = document.getElementById(PICK_TIP_ID);
  if (!tip) return;
  const n = pickedEls.length;
  tip.textContent = n
    ? `WebMold：已选 ${n} 个元素，点击可继续添加/取消，按 Esc 完成`
    : 'WebMold：点击元素选中（可多选），再点一下取消，按 Esc 完成';
}

/** 创建/获取「已选元素」标记容器（内含多个绿色标记框，pointer-events:none） */
function ensurePickSelected() {
  let box = document.getElementById(PICK_SELECTED_ID);
  if (!box) {
    box = document.createElement('div');
    box.id = PICK_SELECTED_ID;
    box.setAttribute('data-webmold', '1');
    Object.assign(box.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      zIndex: '2147483645',
      pointerEvents: 'none',
    });
    document.documentElement.appendChild(box);
  }
  return box;
}

/** 把每个已选元素的绿色标记框对齐到元素当前位置（页面滚动/尺寸变化后调用） */
function refreshSelectedMarkers() {
  const box = ensurePickSelected();
  const used = [];
  for (let i = 0; i < pickedEls.length; i++) {
    const el = pickedEls[i];
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch {
      continue;
    }
    if (!r || r.width <= 0 || r.height <= 0) continue; // 隐藏/移除的元素跳过
    let mk = box.children[i];
    if (!mk) {
      mk = document.createElement('div');
      Object.assign(mk.style, {
        position: 'fixed',
        boxSizing: 'border-box',
        border: '2px solid #22c55e',
        background: 'rgba(34,197,94,0.12)',
        borderRadius: '3px',
        transition: 'all 0.05s ease-out',
      });
      box.appendChild(mk);
    }
    Object.assign(mk.style, {
      display: 'block',
      top: `${r.top}px`,
      left: `${r.left}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    used.push(mk);
  }
  // 移除多余的标记框（取消选中的）
  while (box.children.length > used.length) box.lastChild.remove();
}

let _markerRaf = 0;
/** 节流调度：滚动/悬停高频事件下用 rAF 合并标记框刷新 */
function scheduleRefreshMarkers() {
  if (_markerRaf) return;
  _markerRaf = requestAnimationFrame(() => {
    _markerRaf = 0;
    refreshSelectedMarkers();
  });
}

/** 点击元素：切换选中/取消选中，并立即采集摘要 */
function togglePickElement(el) {
  const idx = pickedEls.indexOf(el);
  if (idx >= 0) {
    pickedEls.splice(idx, 1);
    pickedInfos.splice(idx, 1);
  } else {
    pickedEls.push(el);
    pickedInfos.push(describePicked(el));
  }
  refreshSelectedMarkers();
  updatePickTip();
}

/** 完成/取消拾取：把全部已选元素回传给侧边栏，并清理拾取态 */
function finishPick(cancelled) {
  const elements = cancelled ? [] : pickedInfos.slice();
  stopPickElement();
  try {
    chrome.runtime.sendMessage({
      type: MSG.ELEMENT_PICKED,
      elements,
      cancelled: !!cancelled,
      pageUrl: location.href,
    });
  } catch {
    /* 侧边栏可能已关闭，忽略 */
  }
}

function positionOverlayTo(el) {
  const ov = ensurePickOverlay();
  const r = el.getBoundingClientRect();
  ov.style.display = 'block';
  ov.style.top = `${r.top}px`;
  ov.style.left = `${r.left}px`;
  ov.style.width = `${r.width}px`;
  ov.style.height = `${r.height}px`;
}

const onPickMouseMove = (e) => {
  if (!picking) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // 已选元素的标记框区域也允许穿透定位到底下元素，故只跳过悬停层/提示条
  if (!el || el.id === PICK_OVERLAY_ID || el.id === PICK_TIP_ID) return;
  if (el !== pickHoverEl) {
    pickHoverEl = el;
    positionOverlayTo(el);
  }
  scheduleRefreshMarkers(); // 滚动/移动时同步标记框位置
};

const onPickScroll = () => {
  if (!picking) return;
  scheduleRefreshMarkers();
};

const onPickResize = () => {
  if (!picking) return;
  scheduleRefreshMarkers();
};

const onPickClick = (e) => {
  if (!picking) return;
  e.preventDefault();
  e.stopPropagation();
  const el = pickHoverEl || document.elementFromPoint(e.clientX, e.clientY);
  if (!el || el.id === PICK_OVERLAY_ID || el.id === PICK_TIP_ID || el.id === PICK_SELECTED_ID) return;
  togglePickElement(el); // 多选：切换选中态，不退出拾取模式
};

const onPickKeydown = (e) => {
  if (!picking) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    // 有已选元素则提交，无则视为取消
    finishPick(pickedEls.length === 0);
  }
};

function startPickElement() {
  if (picking) return;
  picking = true;
  pickHoverEl = null;
  pickedEls = [];
  pickedInfos = [];
  ensurePickOverlay();
  ensurePickTip();
  ensurePickSelected();
  updatePickTip();
  // 捕获阶段监听，尽量抢在页面自身处理之前
  document.addEventListener('mousemove', onPickMouseMove, true);
  document.addEventListener('click', onPickClick, true);
  document.addEventListener('keydown', onPickKeydown, true);
  document.addEventListener('scroll', onPickScroll, true);
  window.addEventListener('resize', onPickResize);
}

function stopPickElement() {
  picking = false;
  pickHoverEl = null;
  pickedEls = [];
  pickedInfos = [];
  document.removeEventListener('mousemove', onPickMouseMove, true);
  document.removeEventListener('click', onPickClick, true);
  document.removeEventListener('keydown', onPickKeydown, true);
  document.removeEventListener('scroll', onPickScroll, true);
  window.removeEventListener('resize', onPickResize);
  const ov = document.getElementById(PICK_OVERLAY_ID);
  if (ov) ov.remove();
  const tip = document.getElementById(PICK_TIP_ID);
  if (tip) tip.remove();
  const sel = document.getElementById(PICK_SELECTED_ID);
  if (sel) sel.remove();
}

// ---------- Agent 只读工具执行端 ----------
// 这些工具运行在内容脚本的隔离世界，仅做 DOM 只读观察与临时 CSS 预览。
// try_run_js（需主世界）不在此处，由 background 用 chrome.scripting 执行。

function describeElement(el) {
  const attrs = {};
  for (const a of el.attributes || []) {
    // 只保留有辨识度的属性，避免超长
    if (['class', 'id', 'role', 'aria-label', 'href', 'src', 'type', 'name', 'title'].includes(a.name) ||
        a.name.startsWith('data-')) {
      attrs[a.name] = String(a.value).slice(0, 120);
    }
  }
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    class: el.className && typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
    attrs,
    textPreview: text,
    rect: (() => {
      try {
  const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
      } catch {
     return undefined;
      }
    })(),
  };
}

function toolQueryDom({ selector, limit = 10 }) {
  try {
    const nodes = [...document.querySelectorAll(selector)];
    return {
      ok: true,
      count: nodes.length,
 elements: nodes.slice(0, Math.min(limit, 20)).map(describeElement),
 };
  } catch (e) {
    return { ok: false, error: '选择器无效或查询失败: ' + e.message };
  }
}

function toolGetText({ selector, limit = 5 }) {
  try {
    const nodes = [...document.querySelectorAll(selector)];
    return {
      ok: true,
      count: nodes.length,
   texts: nodes
        .slice(0, Math.min(limit, 20))
        .map((n) => (n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200)),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function toolGetAttrs({ selector }) {
  try {
    const el = document.querySelector(selector);
    if (!el) return { ok: true, found: false };
    const attrs = {};
    for (const a of el.attributes || []) attrs[a.name] = String(a.value).slice(0, 200);
    return { ok: true, found: true, tag: el.tagName.toLowerCase(), attrs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function toolApplyCss({ css }) {
  try {
    let el = document.getElementById(AGENT_CSS_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = AGENT_CSS_ID;
      el.setAttribute('data-webmold', '1');
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = css || '';
    return { ok: true, applied: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 分发 agent 只读工具调用 */
function execAgentTool(name, args) {
  switch (name) {
    case AGENT_TOOL.QUERY_DOM:
      return toolQueryDom(args);
    case AGENT_TOOL.GET_TEXT:
      return toolGetText(args);
    case AGENT_TOOL.GET_ATTRS:
      return toolGetAttrs(args);
    case AGENT_TOOL.APPLY_CSS:
      return toolApplyCss(args);
    default:
   return { ok: false, error: '内容脚本不支持的工具: ' + name };
  }
}

// ---------- 消息处理 ----------
// 说明：本监听器所有分支都是「同步」调用 sendResponse。同步回复完成后必须返回
// undefined（即不 return true），让 Chrome 立刻关闭消息通道。
// 反例：若在同步 sendResponse 后仍 return true，Chrome 会以为「稍后还会异步回复」而
// 保持通道打开等待，一旦发送方（background 常用 .catch() 不等回复、或页面/侧边栏关闭）
// 撤走通道，就会报「message channel closed before a response was received」。
// 因此：同步分支一律不返回 true；未知消息也返回 undefined，交由其它监听器处理。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case MSG.APPLY_RULES:
      applyRules(msg.rules || []);
      // 首次出现引导：对本次启用、且可能给页面加了新 UI 的规则，若用户还没被引导过，
      // 就在页面上做一次醒目的高亮+气泡指引，帮用户找到插件定制出来的功能。
      maybeIntroduceRules(msg.introRules || []);
      sendResponse({ ok: true });
      break;

    case MSG.GET_PAGE_CONTEXT:
      sendResponse(collectPageContext());
      break;

    case MSG.START_PICK_ELEMENT:
      startPickElement();
      sendResponse({ ok: true });
      break;

    case MSG.STOP_PICK_ELEMENT:
      // 再次点击侧边栏按钮视为完成：提交本次选中的全部元素（未选任何元素则视为取消）
      finishPick(pickedEls.length === 0);
      sendResponse({ ok: true });
      break;

    case MSG.PREVIEW_RULE: {
      // 预览：临时注入 CSS（JS 预览由 background 在主世界执行）
      const { css } = msg.rule || {};
      let el = document.getElementById(PREVIEW_STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = PREVIEW_STYLE_ID;
        el.setAttribute('data-webmold', '1');
        (document.head || document.documentElement).appendChild(el);
      }
      el.textContent = css || '';
      // 预览即时引导：等 JS 新增的 data-webmold 元素出现并高亮，让用户立刻看到效果位置
      maybePreviewIntroduce(msg.rule || {});
      sendResponse({ ok: true });
      break;
    }

    case MSG.CLEAR_PREVIEW: {
      const el = document.getElementById(PREVIEW_STYLE_ID);
      if (el) el.remove();
      const agentCss = document.getElementById(AGENT_CSS_ID);
      if (agentCss) agentCss.remove();
      // 取消尚在等待中的预览引导，并移除已展示的引导宿主
      _previewIntroCanceled = true;
      const intro = document.getElementById(INTRO_HOST_ID);
      if (intro) intro.remove();
      sendResponse({ ok: true });
      break;
    }

    case MSG.EXEC_AGENT_TOOL: {
      // agent 只读工具在此执行；返回结果给 background（同步执行、同步回复）
      const result = execAgentTool(msg.tool, msg.args || {});
      sendResponse(result);
      break;
    }

    default:
      // 非本脚本处理的消息：不占用通道，交给其它监听器
      break;
  }
  // 所有分支均为同步回复，返回 undefined 让通道立即关闭，避免挂起告警。
  return undefined;
});

// ---------- 页面桥接：用户定制脚本 -> 大模型 ----------
// 用户定制脚本运行在主世界（MAIN），无法直接访问 chrome.runtime，也不能持有 apiKey。
// 它通过 window.postMessage 发出 BRIDGE.REQ 请求，这里在隔离世界里接住，转发给
// background（由 background 用 apiKey 调模型），再把结果 postMessage 回主世界。
// 安全：只接受来自本窗口自身、且带 BRIDGE.REQ 标记的消息。
window.addEventListener('message', (event) => {
  // 必须来自同一窗口（主世界与隔离世界共享同一 window），拒绝跨窗口/跨源注入
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__webmold !== BRIDGE.REQ || typeof data.id !== 'string') return;

  const reply = (payload) => {
    window.postMessage({ __webmold: BRIDGE.RES, id: data.id, ...payload }, event.origin || '*');
  };

  let settled = false;
  const done = (payload) => {
 if (settled) return;
    settled = true;
 reply(payload);
  };

  try {
    chrome.runtime.sendMessage(
      {
  type: MSG.ASK_LLM,
     prompt: data.prompt,
        context: data.context,
     pageUrl: location.href,
  },
      (res) => {
        // 扩展上下文失效等情况
        if (chrome.runtime.lastError) {
   done({ ok: false, error: chrome.runtime.lastError.message || '扩展通信失败' });
          return;
        }
        if (res && res.ok) done({ ok: true, text: res.text });
  else done({ ok: false, error: (res && res.error) || '未知错误' });
      }
    );
  } catch (e) {
    done({ ok: false, error: '无法与扩展通信: ' + (e && e.message ? e.message : e) });
  }
});

// 页面加载后主动请求一次规则应用（background 会读取存储并回推）
function requestApply() {
  // 提供回调并读取 lastError：background(SW) 可能休眠/未及时回复，若不消费 lastError
  // 会在控制台产生「message channel closed」告警。这里只是「通知」，回复与否都无所谓。
  chrome.runtime.sendMessage({ type: MSG.RULES_UPDATED, url: location.href }, () => {
    void chrome.runtime.lastError;
  });
}

// document_start 时 body 可能尚未就绪，等 DOM 可用再请求
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', requestApply, { once: true });
} else {
  requestApply();
}
// 兜底：确保尽早触发一次
requestApply();

} // end幂等守卫 else 块

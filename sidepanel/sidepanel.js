// 侧边栏逻辑：需求输入 -> 调 background 生成 -> 预览 -> 保存 -> 管理规则

import { MSG, AGENT_LIFECYCLE, AGENT_ASK, uid, domainFromUrl } from '../lib/types.js';
import {
  getRulesByDomain,
  getLlmConfig,
  upsertRule,
  deleteRule,
  toggleRule,
  getHistoryByDomain,
  deleteHistorySession,
  clearHistoryByDomain,
} from '../lib/storage.js';

const $ = (id) => document.getElementById(id);

const els = {
  domainBadge: $('domainBadge'),
  settingsBtn: $('settingsBtn'),
  helpBtn: $('helpBtn'),
  setupBanner: $('setupBanner'),
  setupBtn: $('setupBtn'),
  promptInput: $('promptInput'),
  generateBtn: $('generateBtn'),
  pickElementBtn: $('pickElementBtn'),
  pickedChip: $('pickedChip'),
  pickedText: $('pickedText'),
  clearPickBtn: $('clearPickBtn'),
  stopBtn: $('stopBtn'),
  newSessionBtn: $('newSessionBtn'),
  genStatus: $('genStatus'),
  conversation: $('conversation'),
  // 整页滚动容器（对话区、结果区、规则列表都在其中）
  mainContent: document.querySelector('main.content'),
  historyBtn: $('historyBtn'),
  backToLiveBtn: $('backToLiveBtn'),
  historyPanel: $('historyPanel'),
  historyList: $('historyList'),
  clearHistoryBtn: $('clearHistoryBtn'),
  resultPanel: $('resultPanel'),
  resultTitle: $('resultTitle'),
  resultExplain: $('resultExplain'),
  cssCode: $('cssCode'),
  jsCode: $('jsCode'),
  matchType: $('matchType'),
previewBtn: $('previewBtn'),
  clearPreviewBtn: $('clearPreviewBtn'),
saveBtn: $('saveBtn'),
  cancelEditBtn: $('cancelEditBtn'),
  refreshBtn: $('refreshBtn'),
  ruleList: $('ruleList'),
  emptyHint: $('emptyHint'),
};

let currentTab = null; // { id, url }
let currentDomain = '';
let editingRuleId = null; // 若在编辑已有规则
// 用户在页面上选中的元素（作为对话上下文），null 表示未选。结构见 content-script describePicked()
let selectedElement = null;
// 是否正处于「选择元素」拾取模式
let pickingElement = false;
// 是否处于「历史会话回放」只读视图；此时暂停实时事件渲染，避免串入历史内容。
let viewingHistory = false;
// 对话区是否处于「自动跟随」状态：Agent 输出时自动滚到底部；用户手动向上滚动后暂停，
// 直到用户重新滚回底部再恢复。默认跟随。
let autoFollow = true;

// 判断元素当前是否已贴近底部（留一点容差，兼容子像素/惯性滚动）
function isNearBottom(el, threshold = 24) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/**
 * 仅在「自动跟随」状态下把最新内容带到可视区。
 * Agent 运行中有多层可滚动容器，需全部跟随，否则内容会“卡”在中间：
 *  1) 正在流式输出的思考流（think-stream，max-height:220px）
 *  2) 运行过程列表（agent-trace，max-height:260px）
 *  3) 对话区（conversation，max-height:420px）
 *  4) 整页容器（main.content）：对话较短未溢出时，实际溢出的是整页
 */
function scrollConversationToBottom() {
  if (!autoFollow) return;
  // 当前思考项的思考流容器跟随滚动（实时“吐出”的内容所在）
  if (_thinkingItem) {
    const st = _thinkingItem.querySelector('.think-stream');
    if (st) st.scrollTop = st.scrollHeight;
  }
  // 运行过程列表跟随滚动
  if (_currentTrace) _currentTrace.scrollTop = _currentTrace.scrollHeight;
  // 对话区滚到底
  els.conversation.scrollTop = els.conversation.scrollHeight;
  // 整页容器：对话区底部若超出可视区，则往下滚动到其底部可见（不打扰上方历史）
  if (els.mainContent) {
    const convRect = els.conversation.getBoundingClientRect();
    const viewRect = els.mainContent.getBoundingClientRect();
    if (convRect.bottom > viewRect.bottom) {
      els.mainContent.scrollTop += convRect.bottom - viewRect.bottom + 8;
    }
  }
}

// ---------- 初始化 ----------
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  applyTabInfo(tab);
  bindEvents();
  await checkSetup();
  await renderRuleList();
  //侧边栏可能是「收起后重新打开」：拉取后台任务状态，恢复进行中/已完成的对话 UI
  await restoreTaskState();
}

/**
 * 根据一个 tab 更新当前绑定的 tab / 域名 / 徽标 / 生成按钮可用性。
 * 仅更新状态，不做列表刷新与对话重建（那些由调用方按场景决定）。
 * @param {chrome.tabs.Tab|undefined} tab
 * @returns {boolean} 是否为受支持的 http(s) 页面
 */
function applyTabInfo(tab) {
  if (tab && tab.url && /^https?:/.test(tab.url)) {
    currentTab = { id: tab.id, url: tab.url };
    currentDomain = domainFromUrl(tab.url);
    els.domainBadge.textContent = currentDomain || '—';
    els.generateBtn.disabled = false;
    return true;
  }
  currentTab = tab && tab.id != null ? { id: tab.id, url: tab.url || '' } : null;
  currentDomain = '';
  els.domainBadge.textContent = '不支持的页面';
  els.generateBtn.disabled = true;
  return false;
}

/**
 * 浏览器激活的 tab 发生变化（切tab / 同tab 内跳转到新域名）时调用：
 * 重新绑定 currentTab/currentDomain，清空上一 tab 的对话与结果区，
 * 再按新 tab 刷新规则列表并恢复其后台任务状态，避免上下文停留在旧 tab。
 * @param {chrome.tabs.Tab|undefined} tab
 */
async function switchToTab(tab) {
  const prevTabId = currentTab && currentTab.id;
  const prevDomain = currentDomain;
  applyTabInfo(tab);

  // 同一个 tab 且域名未变，无需重置（例如仅 hash/query 变化的同站跳转）
  if (currentTab && currentTab.id === prevTabId && currentDomain === prevDomain) {
    return;
  }

  // 切换到了不同的 tab / 不同域名：清空当前对话与结果区，退出历史回放态
  editingRuleId = null;
  els.resultPanel.classList.add('hidden');
  els.conversation.innerHTML = '';
  _currentTrace = null;
  activeTurn = null;
  // 已选元素属于旧页面，切换后应清空并退出可能存在的拾取模式
  if (pickingElement) {
    try {
      if (prevTabId != null) await chrome.tabs.sendMessage(prevTabId, { type: MSG.STOP_PICK_ELEMENT });
    } catch {
      /* 忽略 */
    }
    pickingElement = false;
    els.pickElementBtn.classList.remove('picking');
    els.pickElementBtn.textContent = '选择元素';
  }
  selectedElement = null;
  renderPickedChip();
  viewingHistory = false;
  els.backToLiveBtn.classList.add('hidden');
  els.historyBtn.classList.remove('hidden');
  els.historyPanel && els.historyPanel.classList.add('hidden');
  setGenerating(false);

  await checkSetup();
  await renderRuleList();
  // 恢复新 tab 自己的后台任务状态（它可能正有生成任务在跑）
  await restoreTaskState();
  setStatus('');
}

/**
 * 恢复后台任务状态到对话 UI。
 *侧边栏被收起时页面会销毁，但生成任务仍在 background 后台跑（见 service-worker 的保活）；
 * 重新打开时通过 GET_TASK_STATE 拉回本轮的用户输入、过程事件与结果，重建对话气泡：
 *  - running：重建进行中气泡并回放已发生的过程，继续等待后续实时事件；
 *  - done/failed/aborted：直接回放并展示终态。
 */
async function restoreTaskState() {
  if (!currentTab) return;
  let resp;
  try {
    resp = await sendMsg({ type: MSG.GET_TASK_STATE, tabId: currentTab.id });
  } catch {
    return;
  }
  const task = resp && resp.ok ? resp.task : null;
  if (!task) return;

  // 重建这轮的用户气泡 + 助手气泡，并回放已缓存的过程事件
  const turn = startTurn(task.prompt || '');
  const events = Array.isArray(task.events) ? task.events : [];
  for (const ev of events) {
    // 跳过终态生命周期事件，终态在下方按task.status 统一处理，避免重复收尾
    if (
      ev &&
      (ev.type === AGENT_LIFECYCLE.DONE ||
        ev.type === AGENT_LIFECYCLE.FAILED ||
        ev.type === AGENT_LIFECYCLE.ABORTED)
    ) {
      continue;
    }
    renderAgentEvent(ev);
  }

  if (task.status === 'running') {
    // 任务仍在后台跑：保持进行中 UI，继续接收实时事件
    activeTurn = turn;
    setGenerating(true);
    setStatus('Agent 运行中…（任务在后台继续，可随时收起侧边栏）');
  } else if (task.status === 'done') {
    setGenerating(false);
    await handleTaskDone(turn, task.result);
  } else if (task.status === 'aborted') {
    setGenerating(false);
    finishTurn(turn, { state: 'error', title: '已停止', summary: '已手动停止本次生成' });
    setStatus('上次生成已停止', '');
  } else if (task.status === 'failed') {
    setGenerating(false);
    finishTurn(turn, { state: 'error', title: '生成失败', summary: task.error || '生成失败' });
    setStatus(task.error || '上次生成失败', 'error');
  }
}

/**
 * 检查是否已配置模型（至少要有 API Key）。
 * 未配置时展示顶部引导提示条，避免用户盲目点「生成」后撞上模糊的接口错误。
 */
async function checkSetup() {
  try {
    const cfg = await getLlmConfig();
    const configured = !!(cfg && cfg.apiKey && cfg.apiKey.trim());
    els.setupBanner.classList.toggle('hidden', configured);
  } catch {
    // 读取失败时保守地展示提示条
    els.setupBanner.classList.remove('hidden');
  }
}

function bindEvents() {
  els.settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  // 帮助按钮：在新标签页打开欢迎页（含三步用法与使用案例）
  els.helpBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }).catch(() => {});
  });
  els.setupBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.generateBtn.addEventListener('click', onGenerate);
  els.pickElementBtn.addEventListener('click', onTogglePickElement);
  els.clearPickBtn.addEventListener('click', clearSelectedElement);
  els.stopBtn.addEventListener('click', onStop);
  els.newSessionBtn.addEventListener('click', onNewSession);
  els.historyBtn.addEventListener('click', toggleHistoryPanel);
  els.backToLiveBtn.addEventListener('click', exitHistoryReplay);
  els.clearHistoryBtn.addEventListener('click', async () => {
    if (!currentDomain) return;
    if (!confirm('清空本站全部历史会话？')) return;
    await clearHistoryByDomain(currentDomain);
    await renderHistoryList();
    setStatus('已清空本站历史会话', 'ok');
  });

  // 输入框回车发送：Enter 提交，Shift+Enter 换行（输入法组词中的回车不触发）
  els.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!els.generateBtn.disabled) onGenerate();
}
  });
  els.previewBtn.addEventListener('click', onPreview);
  els.clearPreviewBtn.addEventListener('click', onClearPreview);
  els.saveBtn.addEventListener('click', onSave);
  els.cancelEditBtn.addEventListener('click', closeEditor);
  els.refreshBtn.addEventListener('click', renderRuleList);

  // 代码 tab 切换
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
   document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
      const tab = t.dataset.tab;
    els.cssCode.classList.toggle('hidden', tab !== 'css');
   els.jsCode.classList.toggle('hidden', tab !== 'js');
    });
  });

  // 折叠/展开当前轮的运行过程：委托到每轮助手气泡内的折叠按钮
  els.conversation.addEventListener('click', (e) => {
    const btn = e.target.closest('.trace-toggle');
    if (!btn) return;
    const wrap = btn.closest('.trace-wrap');
    const list = wrap && wrap.querySelector('.agent-trace');
    if (!list) return;
    const collapsed = list.classList.toggle('hidden');
    const label = btn.querySelector('.tt-label');
    if (label) label.textContent = collapsed ? '展开运行过程' : '收起运行过程';
    const arrow = btn.querySelector('.tt-arrow');
    if (arrow) arrow.textContent = collapsed ? '▸' : '▾';
  });

  // 自动跟随：用户主动向上滚动（滚轮上滑 / 触屏下滑查看上文 / 键盘上翻）即暂停跟随；
  // 一旦滚回底部（scroll 事件判定 isNearBottom）立即恢复。
  // 程序滚动总是把内容带到最新底部，isNearBottom 恒为 true，不会被误判成用户上滚，
  // 因此无需再用标记区分程序滚动与用户滚动（避免程序滚动被吞导致跟随失效）。
  els.conversation.addEventListener(
    'wheel',
    (e) => {
      if (e.deltaY < 0) autoFollow = false;
    },
    { passive: true }
  );
  els.conversation.addEventListener('scroll', () => {
    if (isNearBottom(els.conversation)) autoFollow = true;
  });
  if (els.mainContent) {
    // 触屏滑动：手指下移 = 查看更早内容，暂停跟随
    let touchY = 0;
    els.mainContent.addEventListener(
      'touchstart',
      (e) => {
        touchY = e.touches[0].clientY;
      },
      { passive: true }
    );
    els.mainContent.addEventListener(
      'touchmove',
      (e) => {
        const dy = e.touches[0].clientY - touchY;
        if (dy > 0) autoFollow = false;
        touchY = e.touches[0].clientY;
      },
      { passive: true }
    );
    // 对话较短、整页容器可滚动时，滚回底部同样恢复跟随
    els.mainContent.addEventListener('scroll', () => {
      if (isNearBottom(els.mainContent)) autoFollow = true;
    });
  }
  // 键盘滚动（↑/PageUp/Home）也会暂停跟随（输入框内不受影响）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') {
      const tag = (e.target && e.target.tagName) || '';
      if (!/INPUT|TEXTAREA|SELECT/.test(tag)) autoFollow = false;
    }
  });

  // 监听 background 转发的 agent 过程事件（仅处理属于当前 tab 的事件）
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.AGENT_EVENT) {
      if (msg.tabId != null && currentTab && msg.tabId !== currentTab.id) return;
      // 正在查看历史会话（只读回放）时，暂不渲染实时事件，避免串入历史视图
      if (viewingHistory) return;
      renderAgentEvent(msg.event);
    }
    // 用户在页面上完成了元素选择（或按 Esc 取消）
    if (msg && msg.type === MSG.ELEMENT_PICKED) {
      pickingElement = false;
      els.pickElementBtn.classList.remove('picking');
      els.pickElementBtn.textContent = '选择元素';
      if (msg.cancelled || !msg.element) {
        setStatus('已取消选择元素', '');
        return;
      }
      selectedElement = msg.element;
      renderPickedChip();
      setStatus('已选中元素，将作为对话上下文', 'ok');
    }
  });

  // 从设置页填完 Key 切回侧边栏时，自动复检并隐藏提示条
  window.addEventListener('focus', () => {
    checkSetup();
  });

  // 跟随浏览器当前激活的标签页：切tab / 同 tab 内跳转到新地址时，
  // 重新把侧边栏上下文（域名、规则、后台任务）绑定到新页面，避免停留在上一个 tab。
  const syncActiveTab = async (tabId) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      await switchToTab(tab);
    } catch {
      // tab 可能已关闭，忽略
    }
  };

  // 切换激活的标签页
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    syncActiveTab(tabId);
  });

  // 同一标签页内地址变化（如站内跳转、SPA 改URL、页面加载完成拿到 url）
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab || !tab.active) return;
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    //仅当域名确实变化时才重置，避免同站内跳转清空正在进行的对话
    if (currentTab && tabId === currentTab.id) {
      const newDomain = tab.url ? domainFromUrl(tab.url) : '';
      if (newDomain === currentDomain) {
        // 域名没变，仅刷新 url 引用即可
        currentTab.url = tab.url || currentTab.url;
        return;
      }
    }
    switchToTab(tab);
  });

  // 窗口焦点切换时，校正到该窗口当前激活的 tab
  chrome.windows &&
    chrome.windows.onFocusChanged.addListener(async (windowId) => {
      if (windowId === chrome.windows.WINDOW_ID_NONE) return;
      try {
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        if (tab) await switchToTab(tab);
      } catch {
        // 忽略
      }
    });
}

// ---------- 生成 ----------
/** 切换「生成中」UI：生成中禁用生成按钮、显示停止按钮 */
function setGenerating(on) {
  els.generateBtn.disabled = on;
  els.stopBtn.classList.toggle('hidden', !on);
  els.newSessionBtn.disabled = on;
}

async function onGenerate() {
  const prompt = els.promptInput.value.trim();
  if (!prompt) {
  setStatus('请先描述你的需求', 'error');
    return;
  }
  if (!currentTab) return;

  // 若正处于历史回放（只读视图），先退出并清空对话区，避免新一轮混入历史内容
  if (viewingHistory) {
    viewingHistory = false;
    els.backToLiveBtn.classList.add('hidden');
    els.historyBtn.classList.remove('hidden');
    els.conversation.innerHTML = '';
    _currentTrace = null;
    activeTurn = null;
  }

  setStatus('正在采集页面上下文…');
  setGenerating(true);
  // 新起一轮问答：先把用户气泡与「进行中」的助手气泡放入对话区，
  // 本轮的 Agent 运行过程会渲染进这条助手气泡内部。
  const turn = startTurn(prompt);
  activeTurn = turn; // 记录当前进行中的轮次，终态事件到达时据此收尾
  els.promptInput.value = '';

  // 记录本轮是否处于编辑态，供拿到结果后判断（结果经事件异步回来）
  turn.editingRuleId = editingRuleId;

  try {
    const pageContext = await getPageContext();
    // 编辑态：把当前编辑区里的规则内容作为基础，让 agent 做增量修改
    const existingRule = editingRuleId
      ? {
          title: els.resultTitle.value.trim(),
          css: els.cssCode.value,
          js: els.jsCode.value,
        }
      : undefined;
    setStatus(editingRuleId ? 'Agent 修改中…' : 'Agent 运行中…');
    // 仅负责「启动」任务；结果不在这里 await，而是由 AGENT_EVENT 的终态事件驱动。
    // 这样即便侧边栏被收起（本页面销毁），后台任务仍会继续跑并把结果缓存下来。
    const resp = await sendMsg({
      type: MSG.GENERATE_RULE,
      tabId: currentTab.id,
      prompt,
      pageContext,
      existingRule,
    });
    if (!resp || !resp.ok) {
      throw new Error((resp && resp.error) || '启动生成失败');
    }
    // 已在后台启动，等待事件推送最终结果（done/failed/aborted）
  } catch (e) {
    // 仅「启动阶段」的本地错误（如采集上下文异常）在此收尾
    setStatus(e.message || '生成失败', 'error');
    addTrace('error', '✕', `失败：${e.message || e}`);
    finishTurn(turn, {
      state: 'error',
      title: '生成失败',
      summary: e.message || String(e),
    });
    if (activeTurn === turn) activeTurn = null;
    setGenerating(false);
  }
}

/**
 * 处理任务成功终态：填充结果区、识别编辑态、收尾助手气泡。
 * 供「事件驱动」与「打开时状态恢复」两条路径共用。
 * @param {object} turn startTurn 返回值（含 editingRuleId 快照）
 * @param {object} result 后台返回的规则结果
 */
async function handleTaskDone(turn, result) {
  const { title, explanation, targetRuleId } = result || {};
  let css = typeof result?.css === 'string' ? result.css : '';
  let js = typeof result?.js === 'string' ? result.js : '';

  const wasEditing = turn && turn.editingRuleId;
  let matchedTitle = '';
  // 修改规则时的「原规则」：用于对模型未返回的那一类代码做兜底，
  // 避免模型只改了 CSS（或只改了 JS）却把另一类返回空串，导致保存后原有 JS/CSS 丢失。
  let baseRule = null;

  // 自动识别：非手动编辑态时，若 agent 判断这是在修改某条已有规则，
  // 就把它切换成对该规则的编辑态，保存时直接覆盖原规则（而非新建一条）。
  if (!wasEditing && targetRuleId) {
    const list = await getRulesByDomain(currentDomain);
    const matched = list.find((r) => r.id === targetRuleId);
    if (matched) {
      editingRuleId = targetRuleId;
      baseRule = matched;
      els.matchType.value = matched.matchType || 'all';
      matchedTitle = matched.title || '未命名规则';
      setStatus(`已识别为修改规则「${matchedTitle}」，可预览后保存`, 'ok');
    } else {
      setStatus('生成完成，可预览后保存', 'ok');
    }
  } else {
    if (wasEditing) {
      editingRuleId = wasEditing;
      // 手动编辑态：以编辑区当前内容作为原规则基准
      baseRule = { css: els.cssCode.value, js: els.jsCode.value };
    }
    setStatus(wasEditing ? '修改完成，可预览后保存' : '生成完成，可预览后保存', 'ok');
  }

  // 修改场景下的兜底：模型只返回了一类代码时，另一类保留原规则内容，防止被空串覆盖丢失。
  if (baseRule) {
    if (!css && baseRule.css) css = baseRule.css;
    if (!js && baseRule.js) js = baseRule.js;
  }

  fillResult({ title, css, js, explanation });

  finishTurn(turn, {
    state: 'done',
    title: title || '未命名规则',
    summary: matchedTitle
      ? `已修改规则「${matchedTitle}」。${explanation || ''}`.trim()
      : explanation || '已生成规则，可在下方预览后保存。',
    css,
    js,
  });
}

/** 停止当前生成：通知 background abort */
async function onStop() {
  if (!currentTab) return;
  els.stopBtn.disabled = true;
  setStatus('正在停止…');
  await sendMsg({ type: MSG.CANCEL_GENERATE, tabId: currentTab.id });
  // 真正的 UI 收尾由 background 推送的 ABORTED 终态事件处理；这里仅恢复按钮可用
  els.stopBtn.disabled = false;
}

// ---------- 历史会话 ----------
/**
 * 若历史面板正打开，刷新列表（供任务完成后即时看到新历史）。
 * 历史会话的落库在 background 完成，不依赖 sidepanel 是否打开。
 */
async function refreshHistoryIfOpen() {
  if (!els.historyPanel.classList.contains('hidden')) {
    await renderHistoryList();
  }
}

/** 打开/关闭历史会话面板 */
async function toggleHistoryPanel() {
  const willShow = els.historyPanel.classList.contains('hidden');
  els.historyPanel.classList.toggle('hidden', !willShow);
  if (willShow) {
    await renderHistoryList();
    els.historyPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/** 渲染本站历史会话列表 */
async function renderHistoryList() {
  if (!currentDomain) return;
  const list = await getHistoryByDomain(currentDomain);
  els.historyList.innerHTML = '';
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '暂无历史会话';
    els.historyList.appendChild(li);
    return;
  }
  for (const s of list) {
    els.historyList.appendChild(renderHistoryItem(s));
  }
}

const STATUS_ICON = { done: '✓', failed: '✕', aborted: '■' };
const STATUS_TEXT = { done: '已完成', failed: '失败', aborted: '已停止' };

function renderHistoryItem(s) {
  const li = document.createElement('li');
  li.className = 'history-item ' + (s.status || 'done');

  const top = document.createElement('div');
  top.className = 'hi-top';

  const st = document.createElement('span');
  st.className = 'hi-status';
  st.textContent = STATUS_ICON[s.status] || '✓';

  const p = document.createElement('div');
  p.className = 'hi-prompt';
  p.textContent = s.prompt || '(无输入)';
  p.title = s.prompt || '';

  const del = document.createElement('button');
  del.className = 'hi-del';
  del.textContent = '✕';
  del.title = '删除这条历史';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await deleteHistorySession(currentDomain, s.id);
    await renderHistoryList();
    setStatus('已删除该历史会话', 'ok');
  });

  top.append(st, p, del);

  const meta = document.createElement('div');
  meta.className = 'hi-meta';
  const time = s.createdAt ? new Date(s.createdAt).toLocaleString() : '';
  meta.textContent = `${STATUS_TEXT[s.status] || '已完成'} · ${time}`;

  li.append(top, meta);
  // 点击整条：在对话区回放该历史会话
  li.addEventListener('click', () => replayHistorySession(s));
  return li;
}

/**
 * 在对话区回放一条历史会话的完整对话过程（用户输入 + Agent 过程 + 结果）。
 * 进入「只读回放」视图：暂停实时事件渲染，顶部给出返回入口。
 */
function replayHistorySession(s) {
  viewingHistory = true;
  activeTurn = null; // 回放期间不接收实时事件
  els.conversation.innerHTML = '';

  // 顶部提示条
  const tip = document.createElement('div');
  tip.className = 'conv-replay-tip';
  const time = s.createdAt ? new Date(s.createdAt).toLocaleString() : '';
  tip.textContent = `正在查看历史会话（${time}），点右上角「返回」回到当前会话`;
  els.conversation.appendChild(tip);

  // 重建这一轮的用户气泡 + 助手气泡，并回放过程事件
  const turn = startTurn(s.prompt || '');
  const events = Array.isArray(s.events) ? s.events : [];
  for (const ev of events) {
    if (
      ev &&
      (ev.type === AGENT_LIFECYCLE.DONE ||
        ev.type === AGENT_LIFECYCLE.FAILED ||
        ev.type === AGENT_LIFECYCLE.ABORTED)
    ) {
      continue;
    }
    renderAgentEvent(ev);
  }

  // 收尾气泡（根据终态）
  if (s.status === 'done' && s.result) {
    const { title, css, js, explanation } = s.result;
    finishTurn(turn, {
      state: 'done',
      title: title || '未命名规则',
      summary: explanation || '已生成规则。',
      css,
      js,
    });
  } else if (s.status === 'aborted') {
    finishTurn(turn, { state: 'error', title: '已停止', summary: s.error || '已手动停止本次生成' });
  } else if (s.status === 'failed') {
    finishTurn(turn, { state: 'error', title: '生成失败', summary: s.error || '生成失败' });
  } else {
    finishTurn(turn, { state: 'done', title: '已完成', summary: '' });
  }

  // 展示返回入口
  els.backToLiveBtn.classList.remove('hidden');
  els.historyBtn.classList.add('hidden');
  setStatus('历史会话（只读）', '');
  els.conversation.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 退出历史回放，返回当前会话（重新拉取后台任务状态恢复实时视图） */
async function exitHistoryReplay() {
  viewingHistory = false;
  els.backToLiveBtn.classList.add('hidden');
  els.historyBtn.classList.remove('hidden');
  els.conversation.innerHTML = '';
  _currentTrace = null;
  activeTurn = null;
  setStatus('', '');
  await restoreTaskState();
}

/** 新对话：清空本次会话的多轮上下文，并重置输入/结果区 */
async function onNewSession() {
  if (currentTab) {
    await sendMsg({ type: MSG.CLEAR_SESSION, tabId: currentTab.id });
  }
  editingRuleId = null;
  els.promptInput.value = '';
  els.resultPanel.classList.add('hidden');
  els.conversation.innerHTML = '';
  _currentTrace = null;
  activeTurn = null;
  // 清空已选元素上下文
  selectedElement = null;
  renderPickedChip();
  // 退出可能存在的历史回放态
  viewingHistory = false;
  els.backToLiveBtn.classList.add('hidden');
  els.historyBtn.classList.remove('hidden');
  setStatus('已开始新对话（已清空上下文）', 'ok');
}

// ---------- 会话对话（一问一答） ----------
/**
 * 开启新一轮问答：向对话区追加「用户气泡 + 进行中的助手气泡」。
 * 助手气泡内含一个可折叠的运行过程列表，本轮的 Agent 事件都渲染进这里。
 * @param {string} prompt 用户本轮输入
 * @returns {{ root: HTMLElement, assistant: HTMLElement, trace: HTMLOListElement }}
 */
function startTurn(prompt) {
  const turn = document.createElement('div');
  turn.className = 'turn';

  // 用户气泡
  const user = document.createElement('div');
  user.className = 'bubble user';
  user.textContent = prompt;

  // 助手气泡（进行中）
  const assistant = document.createElement('div');
  assistant.className = 'bubble assistant pending';
  assistant.innerHTML =
    '<div class="a-head"><span class="a-dot spin">◔</span><span class="a-title">正在生成…</span></div>' +
    '<div class="trace-wrap">' +
    '<button class="trace-toggle" type="button"><span class="tt-arrow">▾</span><span class="tt-label">收起运行过程</span></button>' +
    '<ol class="agent-trace"></ol>' +
    '</div>';

  turn.append(user, assistant);
  els.conversation.appendChild(turn);
  // 新一轮问答开始：无论之前是否暂停跟随，都恢复自动跟随并滚到底部。
  autoFollow = true;
  scrollConversationToBottom();

  // 后续Agent 事件写入这条助手气泡内的 trace 列表
  _currentTrace = assistant.querySelector('.agent-trace');

  return { root: turn, assistant, trace: _currentTrace, prompt };
}

/**
 * 收尾一轮问答：更新助手气泡的状态点、标题与摘要，运行过程自动折叠。
 * @param {{assistant: HTMLElement}} turn startTurn 的返回值
 * @param {{state:'done'|'error', title:string, summary?:string, css?:string, js?:string}} data
 */
function finishTurn(turn, data) {
  if (!turn || !turn.assistant) return;
  const a = turn.assistant;
  a.classList.remove('pending');
  a.classList.add(data.state === 'error' ? 'error' : 'done');

  const dot = a.querySelector('.a-dot');
  if (dot) {
    dot.classList.remove('spin');
    dot.textContent = data.state === 'error' ? '✕' : '✓';
  }
  const titleEl = a.querySelector('.a-title');
  if (titleEl) titleEl.textContent = data.title || (data.state === 'error' ? '生成失败' : '已完成');

  // 摘要（说明）
  const head = a.querySelector('.a-head');
  if (data.summary) {
    const sum = document.createElement('div');
    sum.className = 'a-summary' + (data.state === 'error' ? ' error-text' : '');
    sum.textContent = data.summary;
    head.after(sum);
  }

  // 代码规模徽标
  const cssLen = (data.css || '').length;
  const jsLen = (data.js || '').length;
  if (cssLen || jsLen) {
    const badges = document.createElement('div');
    badges.className = 'a-badges';
    if (cssLen) {
      const b = document.createElement('span');
      b.className = 'a-badge';
      b.textContent = `CSS ${cssLen} 字`;
      badges.appendChild(b);
    }
    if (jsLen) {
      const b = document.createElement('span');
      b.className = 'a-badge';
      b.textContent = `JS ${jsLen} 字`;
      badges.appendChild(b);
    }
    const traceWrap = a.querySelector('.trace-wrap');
    if (traceWrap) traceWrap.before(badges);
    else a.appendChild(badges);
  }

  // 运行过程默认折叠，保持对话区清爽
  const list = a.querySelector('.agent-trace');
  if (list) list.classList.add('hidden');
  const label = a.querySelector('.tt-label');
  if (label) label.textContent = '展开运行过程';
  const arrow = a.querySelector('.tt-arrow');
  if (arrow) arrow.textContent = '▸';

  // 本轮结束，后续若没有新轮则不再有当前 trace
  _currentTrace = null;
  scrollConversationToBottom();
}

// ---------- Agent 过程渲染 ----------
// 当前轮的运行过程列表（<ol>），由 startTurn 设置；Agent 事件都写入这里。
let _currentTrace = null;
// 当前进行中的问答轮次（startTurn 返回值）；终态事件（done/failed/aborted）据此收尾。
let activeTurn = null;

function addTrace(cls, icon, html) {
  const target = _currentTrace;
  if (!target) return null; // 没有进行中的轮次（例如事件迟到），忽略
  const li = document.createElement('li');
  li.className = 'trace-item ' + cls;
  const ic = document.createElement('span');
  ic.className = 'ic';
  // icon 是本模块内部固定的标记/图标（含少量受控 HTML，如加载动画），用 innerHTML 渲染
  ic.innerHTML = icon;
  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = html;
  li.append(ic, body);
  target.appendChild(li);
  scrollConversationToBottom();
  return li;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function preview(obj, max = 400) {
  let s;
  try {
    s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  } catch {
    s = String(obj);
  }
  if (s.length > max) s = s.slice(0, max) + '…';
  return esc(s);
}

let _thinkingItem = null;
let _thinkBuf = ''; // 当前思考步的推理流（reasoning_content）累积
let _replyBuf = ''; // 当前思考步的正文（content）累积

/** 组合展示文本：推理流在前，正文在后 */
function composeThinkText() {
  return [_thinkBuf, _replyBuf].filter((s) => s && s.trim()).join('\n');
}

/**
 * 收尾当前思考项：停止 spin 动画、把“思考中…”改为“已思考”。
 * 若这一步既没有思考流也没有正文（常见于 GPT-5 等推理模型：思考在服务端进行、不返回明文），
 * 则用 placeholder 兜底展示这一步实际做了什么，避免留下空白。
 * @param {string} [placeholder] 无思考文案时的占位说明
 */
function finalizeThinking(placeholder) {
  if (!_thinkingItem) return;
  const ic = _thinkingItem.querySelector('.ic');
  if (ic) ic.innerHTML = '◆';
  const head = _thinkingItem.querySelector('.think-head');
  if (head) head.textContent = head.textContent.replace('思考中…', '思考完成');
  const streamEl = _thinkingItem.querySelector('.think-stream');
  if (streamEl && !streamEl.textContent.trim()) {
    if (placeholder) {
      streamEl.classList.add('think-placeholder');
      streamEl.textContent = placeholder;
    } else {
      streamEl.remove();
    }
  }
  _thinkingItem = null;
  _thinkBuf = '';
  _replyBuf = '';
}

function renderAgentEvent(ev) {
  switch (ev.type) {
    case 'start':
      addTrace('thinking', '●', `Agent 启动（最多 ${ev.data?.maxSteps ?? '?'} 步）`);
      break;
    case 'thinking':
      _thinkBuf = '';
      _replyBuf = '';
    _thinkingItem = addTrace(
     'thinking',
      '<span class="spin">◔</span>',
        `<div class="think-head">第 ${ev.step} 步：思考中…</div><div class="think-stream"></div>`
      );
  break;
    case 'llm_delta': {
      // 流式追加模型输出到当前思考项：区分推理流（reasoning）与正文（content）
      const piece = ev.data?.delta || '';
      if (!piece) break;
      if (ev.data?.reasoning) _thinkBuf += piece;
      else _replyBuf += piece;
      if (_thinkingItem) {
        const streamEl = _thinkingItem.querySelector('.think-stream');
        if (streamEl) {
    streamEl.textContent = composeThinkText();
          scrollConversationToBottom();
        }
      }
      break;
    }
    case 'tool_call': {
      const reason = ev.data?.args?.reason;
      // 无思考文案时，用「这步准备调什么工具、为什么」作占位，避免空白
      finalizeThinking(
        reason
          ? `（未返回思考过程）${reason}`
          : `（未返回思考过程）准备调用工具 ${ev.data?.name || ''}`.trim()
      );
// 展示时把 reason 单独拎出来，剩余参数折叠在下面（避免重复）
      let rest = ev.data?.args;
      if (rest && typeof rest === 'object' && 'reason' in rest) {
     rest = { ...rest };
 delete rest.reason;
   }
   const hasRest = rest && typeof rest === 'object' && Object.keys(rest).length > 0;
      addTrace(
      'tool',
        '⚙',
        (reason ? `<div class="reason">${esc(reason)}</div>` : '') +
          `调用工具 <span class="tname">${esc(ev.data?.name)}</span>` +
   (hasRest ? `<pre>${preview(rest)}</pre>` : '')
      );
      break;
    }
    case 'tool_result':
    addTrace(
        'result',
        '✓',
        `<span class="tname">${esc(ev.data?.name)}</span> 结果` +
          (ev.data?.result !== undefined ? `<pre>${preview(ev.data.result)}</pre>` : '')
      );
      break;
    case 'retry':
    addTrace(
        'retry',
        '↻',
        `第 ${ev.step} 步失败，重试（第 ${ev.data?.attempt} 次，等待 ${ev.data?.wait}ms）：${esc(
       ev.data?.error
        )}`
   );
      break;
    case 'finish':
      finalizeThinking('（未返回思考过程）整理并输出最终规则');
      addTrace('finish', '★', `完成：${esc(ev.data?.title || '')}`);
   break;
    case 'error':
      addTrace('error', '✕', `出错：${esc(ev.data?.error)}`);
      break;
    // ---- Agent 主动提问：渲染成一组可点选项（可选自由输入），用户回答后回发 background ----
    case AGENT_ASK.QUESTION:
      finalizeThinking('（未返回思考过程）需要向你确认一个问题');
      renderAskQuestion(ev.data || {});
      break;
    case AGENT_ASK.ANSWERED:
      markAskAnswered(ev.data || {});
      break;
    // ---- 任务终态事件：由 background 推送，驱动 UI 收尾（不依赖 sendMsg 回调） ----
    case AGENT_LIFECYCLE.DONE: {
      const turn = activeTurn;
      activeTurn = null;
      setGenerating(false);
      if (turn) handleTaskDone(turn, ev.result);
      // 历史会话由 background 落库（不依赖 sidepanel 是否打开）；这里刷新列表以便即时可见
      refreshHistoryIfOpen();
      break;
    }
    case AGENT_LIFECYCLE.FAILED: {
      const turn = activeTurn;
      activeTurn = null;
      setGenerating(false);
      setStatus(ev.error || '生成失败', 'error');
      if (turn) {
        finishTurn(turn, { state: 'error', title: '生成失败', summary: ev.error || '生成失败' });
      }
      refreshHistoryIfOpen();
      break;
    }
    case AGENT_LIFECYCLE.ABORTED: {
      const turn = activeTurn;
      activeTurn = null;
      setGenerating(false);
      setStatus('已停止生成', '');
      if (turn) {
        finishTurn(turn, { state: 'error', title: '已停止', summary: '已手动停止本次生成' });
      }
      refreshHistoryIfOpen();
      break;
    }
    default:
      break;
  }
}

/**
 * 渲染一条Agent 提问：问题文本 + 若干候选选项按钮（+ 可选自由输入框）。
 * 用户点击某选项或提交输入后，把答案回发 background（SUBMIT_USER_ANSWER），
 * 由 background 解除挂起的工具调用、让 agent 继续。
 * 用 askId 标记该卡片，收到 ANSWERED 事件时据此收尾（禁用交互、显示已选答案）。
 * 历史回放（只读）时只展示问题与选项，不提供交互。
 * @param {{askId?:string, question?:string, options?:string[], allowText?:boolean}} data
 */
function renderAskQuestion(data) {
  const { askId, question, options, allowText } = data;
  const li = addTrace('ask', '？', '');
  if (!li) return;
  const body = li.querySelector('.body');
  if (!body) return;
  if (askId) li.dataset.askId = askId;

  const wrap = document.createElement('div');
  wrap.className = 'ask-wrap';

  const qEl = document.createElement('div');
  qEl.className = 'ask-question';
  qEl.textContent = question || '请确认';
  wrap.appendChild(qEl);

  const readOnly = viewingHistory; // 历史回放不可交互

  const optsEl = document.createElement('div');
  optsEl.className = 'ask-options';
  const list = Array.isArray(options) ? options : [];
  for (const opt of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ask-opt';
    b.textContent = opt;
    if (readOnly) {
      b.disabled = true;
    } else {
      b.addEventListener('click', () => submitAskAnswer(askId, opt, li));
    }
    optsEl.appendChild(b);
  }
  wrap.appendChild(optsEl);

  // 自由输入（默认允许）
  if (allowText !== false && !readOnly) {
    const form = document.createElement('div');
    form.className = 'ask-text';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '或输入你的想法后回车…';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'ask-send';
    send.textContent = '发送';
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      submitAskAnswer(askId, v, li);
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    form.append(input, send);
    wrap.appendChild(form);
  }

  body.appendChild(wrap);
  scrollConversationToBottom();
}

/**
 * 提交用户对某次提问的回答：立即在 UI 上锁定该卡片（防重复点击），并回发 background。
 * @param {string} askId
 * @param {string} answer
 * @param {HTMLElement} li 该提问卡片的 <li>
 */
function submitAskAnswer(askId, answer, li) {
  if (!askId) return;
  // 先本地锁定，避免用户连点导致重复提交（真正收尾以 ANSWERED 事件为准）
  lockAskCard(li, answer);
  sendMsg({ type: MSG.SUBMIT_USER_ANSWER, askId, answer });
}

/** 锁定提问卡片：禁用所有按钮/输入，追加“已回答：xxx”，避免重复回答 */
function lockAskCard(li, answer) {
  if (!li || li.dataset.answered === '1') return;
  li.dataset.answered = '1';
  li.querySelectorAll('button, input').forEach((el) => {
    el.disabled = true;
  });
  const wrap = li.querySelector('.ask-wrap');
  if (wrap && !wrap.querySelector('.ask-answered')) {
    const ans = document.createElement('div');
    ans.className = 'ask-answered';
    ans.textContent = `已回答：${answer || ''}`;
    wrap.appendChild(ans);
  }
}

/**
 * 收到 background 的 ANSWERED 事件后收尾对应提问卡片。
 * 覆盖两种来路：本端提交（已由 lockAskCard 锁过，这里幂等）、或超时/其它端回答。
 * @param {{askId?:string, answer?:string}} data
 */
function markAskAnswered(data) {
  const { askId, answer } = data;
  if (!askId || !_currentTrace) return;
  const li = _currentTrace.querySelector(`li[data-ask-id="${cssEscape(askId)}"]`);
  if (li) lockAskCard(li, answer || '');
}

/** 简易 CSS 属性选择器转义（askId 为受控格式，这里做基础防护） */
function cssEscape(s) {
  if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(s);
  return String(s).replace(/["\\\]]/g, '\\$&');
}

/** 从内容脚本采集页面上下文 */
async function getPageContext() {
  let ctx;
  try {
    ctx = await chrome.tabs.sendMessage(currentTab.id, {
      type: 'GET_PAGE_CONTEXT',
    });
  } catch {
    ctx = null;
  }
  ctx = ctx || { url: currentTab.url, title: '', domSnapshot: '' };
  // 若用户显式选中了某个元素，作为聚焦上下文一并带上
  if (selectedElement) ctx.selectedElement = selectedElement;
  return ctx;
}

// ---------- 选择元素作为上下文 ----------
/** 切换「选择元素」拾取模式：通知内容脚本进入/退出拾取 */
async function onTogglePickElement() {
  if (!currentTab) return;
  if (pickingElement) {
    // 再次点击视为取消
    pickingElement = false;
    els.pickElementBtn.classList.remove('picking');
    els.pickElementBtn.textContent = '选择元素';
    try {
      await chrome.tabs.sendMessage(currentTab.id, { type: MSG.STOP_PICK_ELEMENT });
    } catch {
      /* 忽略 */
    }
    setStatus('已退出选择模式', '');
    return;
  }
  try {
    await sendToContentWithInject(currentTab.id, { type: MSG.START_PICK_ELEMENT });
    pickingElement = true;
    els.pickElementBtn.classList.add('picking');
    els.pickElementBtn.textContent = '选择中…';
    setStatus('请在页面上点击一个元素，按 Esc 取消', '');
  } catch (e) {
    // 受限页面（chrome://、扩展商店、about: 等）无法注入内容脚本
    const restricted = /chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|chromewebstore/.test(
      currentTab.url || ''
    );
    setStatus(
      restricted ? '当前是浏览器受限页面，无法选择元素' : '无法在当前页面选择元素，请刷新页面后重试',
      'error'
    );
    console.warn('[WebMold] 进入选择模式失败:', e);
  }
}

/**
 * 向内容脚本发送消息；若因内容脚本未就绪（页面在插件更新前打开等）而失败，
 * 则用 chrome.scripting 现场注入内容脚本后重试一次。受限页面注入会抛错，向上传递。
 */
async function sendToContentWithInject(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // 内容脚本可能尚未注入或为旧版本：主动注入后重试
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content-script.js'],
    });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

/** 渲染已选元素 chip */
function renderPickedChip() {
  if (!selectedElement) {
    els.pickedChip.classList.add('hidden');
    els.pickedText.textContent = '';
    return;
  }
  const label = selectedElement.selector || selectedElement.tag || '已选元素';
  els.pickedText.textContent = label;
  els.pickedText.title = label;
  els.pickedChip.classList.remove('hidden');
}

/** 清除已选元素 */
function clearSelectedElement() {
  selectedElement = null;
  renderPickedChip();
  setStatus('已移除所选元素', '');
}

function fillResult({ title, css, js, explanation }) {
  els.resultTitle.value = title || '';
  els.cssCode.value = css || '';
  els.jsCode.value = js || '';
  els.resultExplain.textContent = explanation || '';
  els.resultPanel.classList.remove('hidden');
}

// ---------- 预览 ----------
async function onPreview() {
  if (!currentTab) return;
  const rule = collectResult();
  await sendMsg({ type: MSG.PREVIEW_RULE, tabId: currentTab.id, rule });
  setStatus('已应用预览（未保存）', 'ok');
}

async function onClearPreview() {
  if (!currentTab) return;
  await sendMsg({ type: MSG.CLEAR_PREVIEW, tabId: currentTab.id });
  setStatus('已清除预览');
}

// ---------- 保存 ----------
async function onSave() {
  if (!currentTab || !currentDomain) return;
  const partial = collectResult();
  if (!partial.css && !partial.js) {
    setStatus('CSS 和 JS 均为空，无需保存', 'error');
    return;
  }

  const now = Date.now();
  let rule;
  if (editingRuleId) {
    const list = await getRulesByDomain(currentDomain);
    rule = list.find((r) => r.id === editingRuleId);
    Object.assign(rule, partial);
  } else {
    rule = {
      id: uid(),
      domain: currentDomain,
      prompt: els.promptInput.value.trim(),
 enabled: true,
      createdAt: now,
      updatedAt: now,
  ...partial,
    };
  }

  await upsertRule(rule);
  // 保存后清除预览并正式应用
  await sendMsg({ type: MSG.CLEAR_PREVIEW, tabId: currentTab.id });
  await sendMsg({ type: MSG.APPLY_RULES, tabId: currentTab.id, url: currentTab.url });

setStatus('已保存并应用', 'ok');
  editingRuleId = null;
  els.resultPanel.classList.add('hidden');
  els.promptInput.value = '';
  await renderRuleList();
}

/** 从结果区收集当前规则字段 */
function collectResult() {
  return {
    title: els.resultTitle.value.trim() || '未命名规则',
    css: els.cssCode.value,
    js: els.jsCode.value,
    matchType: els.matchType.value,
    matchValue:
      els.matchType.value === 'all' ? '' : currentTab ? currentTab.url : '',
  };
}

// ---------- 规则列表 ----------
async function renderRuleList() {
  if (!currentDomain) return;
  const rules = await getRulesByDomain(currentDomain);
  els.ruleList.innerHTML = '';

  if (rules.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '暂无规则';
    els.ruleList.appendChild(li);
    return;
  }

  for (const rule of rules) {
    els.ruleList.appendChild(renderRuleItem(rule));
  }
}

function renderRuleItem(rule) {
  const li = document.createElement('li');
  li.className = 'rule-item';

  const top = document.createElement('div');
  top.className = 'rule-top';

  // 开关
  const sw = document.createElement('label');
  sw.className = 'switch';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = rule.enabled;
  cb.addEventListener('change', async () => {
    const on = cb.checked;
    await toggleRule(currentDomain, rule.id, on);
    await sendMsg({ type: MSG.APPLY_RULES, tabId: currentTab.id, url: currentTab.url });
    // CSS 效果可即时启用/撤销；但 JS 一旦执行，其副作用（改DOM、加监听器等）无法在运行时撤销，
    // 故「禁用含 JS 的规则」时需要刷新页面才能彻底清除已生效的 JS 效果。
    if (!on && rule.js) {
      setStatus('已停用（含脚本，刷新页面后其效果才会完全消失）', 'ok');
    } else {
      setStatus(on ? '已启用' : '已停用', 'ok');
    }
  });
  const slider = document.createElement('span');
  slider.className = 'slider';
  sw.append(cb, slider);

const title = document.createElement('div');
  title.className = 'rule-title';
  title.textContent = rule.title;

  top.append(sw, title);

  const meta = document.createElement('div');
  meta.className = 'rule-meta';
  const scope =
  rule.matchType === 'all'
      ? '整站'
      : rule.matchType === 'prefix'
      ? 'URL前缀'
   : '精确URL';
  const kinds = [rule.css && 'CSS', rule.js && 'JS'].filter(Boolean).join('+');
  meta.textContent = `${scope} · ${kinds || '空'}`;

  const actions = document.createElement('div');
  actions.className = 'rule-actions';

  const editBtn = mkBtn('编辑', 'mini', () => loadRuleToEditor(rule));
  const previewBtn = mkBtn('预览', 'mini', () =>
 sendMsg({ type: MSG.PREVIEW_RULE, tabId: currentTab.id, rule })
  );
  const delBtn = mkBtn('删除', 'mini del', async () => {
    if (!confirm(`删除规则「${rule.title}」？`)) return;
    await deleteRule(currentDomain, rule.id);
    await renderRuleList();
    setStatus('已删除', 'ok');
  });

  actions.append(editBtn, previewBtn, delBtn);
  li.append(top, meta, actions);
  return li;
}

function mkBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.className = `btn ${cls}`;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function loadRuleToEditor(rule) {
  editingRuleId = rule.id;
  els.promptInput.value = rule.prompt || '';
fillResult(rule);
  els.matchType.value = rule.matchType || 'all';
  els.resultPanel.scrollIntoView({ behavior: 'smooth' });
  setStatus('已载入规则，修改后保存', 'ok');
}

/** 关闭编辑区块：重置编辑状态、隐藏面板、清空输入并清除页面预览 */
function closeEditor() {
  editingRuleId = null;
  els.resultPanel.classList.add('hidden');
  els.promptInput.value = '';
  els.resultTitle.value = '';
  els.cssCode.value = '';
  els.jsCode.value = '';
  els.resultExplain.textContent = '';
  if (currentTab) {
    sendMsg({ type: MSG.CLEAR_PREVIEW, tabId: currentTab.id });
  }
  setStatus('已关闭编辑');
}

// ---------- 工具 ----------
function setStatus(text, cls = '') {
  els.genStatus.textContent = text;
  els.genStatus.className = 'status ' + cls;
}

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      // 必须主动读取 lastError，否则当通道在收到回复前关闭（如 background 未回复、
      // SW 休眠、上下文销毁）时，Chrome 会在控制台打印
      //「message channel closed before a response was received」告警。
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      resolve(resp || { ok: false });
    });
  });
}

init();

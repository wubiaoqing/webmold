// 存储层：按域名持久化规则，全部存于 chrome.storage.local。

import { STORAGE_KEYS, DEFAULT_LLM_CONFIG } from './types.js';

/**
 * @typedef {import('./types.js').Rule} Rule
 */

class LocalProvider {
  async getAllRules() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.RULES);
    return data[STORAGE_KEYS.RULES] || {};
  }

  async setAllRules(map) {
    await chrome.storage.local.set({ [STORAGE_KEYS.RULES]: map });
  }
}

// ---------- 配置读写 ----------

export async function getLlmConfig() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.LLM);
  return { ...DEFAULT_LLM_CONFIG, ...(data[STORAGE_KEYS.LLM] || {}) };
}

export async function setLlmConfig(cfg) {
  await chrome.storage.local.set({ [STORAGE_KEYS.LLM]: cfg });
}

// ---------- 规则读写（domain 维度） ----------

let _localProvider = new LocalProvider();

/** 获取全部规则表 { domain: Rule[] } */
export async function getAllRules() {
  return _localProvider.getAllRules();
}

/** 获取某域名下的规则 */
export async function getRulesByDomain(domain) {
  const all = await getAllRules();
  return all[domain] || [];
}

/** 写入全部规则表 */
export async function saveAllRules(map) {
  await _localProvider.setAllRules(map);
}

/** 新增或更新一条规则 */
export async function upsertRule(rule) {
  const all = await getAllRules();
  const list = all[rule.domain] || [];
  const idx = list.findIndex((r) => r.id === rule.id);
  rule.updatedAt = Date.now();
  if (idx >= 0) list[idx] = rule;
  else list.push(rule);
  all[rule.domain] = list;
  await saveAllRules(all);
  return rule;
}

/** 删除规则 */
export async function deleteRule(domain, id) {
  const all = await getAllRules();
  const list = all[domain] || [];
  all[domain] = list.filter((r) => r.id !== id);
  if (all[domain].length === 0) delete all[domain];
  await saveAllRules(all);
}

/** 切换启用状态 */
export async function toggleRule(domain, id, enabled) {
  const all = await getAllRules();
  const list = all[domain] || [];
  const rule = list.find((r) => r.id === id);
  if (rule) {
    rule.enabled = enabled;
    rule.updatedAt = Date.now();
    await saveAllRules(all);
  }
}

// ---------- 历史会话读写（domain 维度） ----------
// 说明：历史会话是「一问一答」的完整对话记录（含Agent 过程事件），仅存本地，供回放查看。
//按域名归组，避免不同网站的历史互相混杂。

const MAX_HISTORY_PER_DOMAIN = 50; // 单域名最多保留的历史会话数，超出丢弃最旧的

/** 获取全部历史会话表 { domain: HistorySession[] } */
async function getAllHistory() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  return data[STORAGE_KEYS.HISTORY] || {};
}

async function setAllHistory(map) {
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: map });
}

/** 获取某域名下的历史会话（按最近活跃时间倒序：最新在前） */
export async function getHistoryByDomain(domain) {
  if (!domain) return [];
  const all = await getAllHistory();
  const list = all[domain] || [];
  return [...list].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

/**
 * 落库/追加一条历史会话（按会话 id 归并多轮问答）。
 * 同一个「对话会话」（从一次「新建对话」到下一次「新建对话」之间）的多次问答共享同一 id，
 * 每一轮作为 turns 数组的一项；顶层字段始终是该会话最新一轮的镜像，兼容老代码与列表展示。
 * 老数据（无 turns 字段）会自动升级为单轮 turns。
 */
export async function upsertHistorySession(session) {
  if (!session || !session.domain) return;
  const all = await getAllHistory();
  const list = all[session.domain] || [];

  // 本轮问答快照
  const turn = {
    prompt: session.prompt || '',
    events: Array.isArray(session.events) ? session.events : [],
    trace: Array.isArray(session.trace) ? session.trace : [],
    result: session.result ?? null,
    status: session.status || '',
    error: session.error || '',
    createdAt: session.createdAt || Date.now(),
  };

  const idx = list.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    // 已有会话：追加一轮，顶层字段更新为最新一轮
    const existing = list[idx];
    const turns = Array.isArray(existing.turns)
      ? existing.turns.slice()
      : [sessionToTurn(existing)];
    turns.push(turn);
    list[idx] = {
      id: existing.id,
      domain: existing.domain,
      prompt: turn.prompt,
      events: turn.events,
      trace: turn.trace,
      result: turn.result,
      status: turn.status,
      error: turn.error,
      turns,
      backend: session.backend || existing.backend || '',
      model: session.model || existing.model || '',
      createdAt: existing.createdAt || turn.createdAt, // 会话创建时间保持不变
      updatedAt: Date.now(),
    };
  } else {
    // 新会话：turns 只含本轮
    list.push({
      id: session.id,
      domain: session.domain,
      ...turn,
      turns: [turn],
      backend: session.backend || '',
      model: session.model || '',
      createdAt: turn.createdAt,
      updatedAt: turn.createdAt,
    });
  }

  // 按最近活跃时间倒序，并裁剪数量
  list.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  while (list.length > MAX_HISTORY_PER_DOMAIN) list.pop();
  all[session.domain] = list;
  await setAllHistory(all);
}

/** 老数据（单轮、无 turns 字段）升级为 turns 数组里的单轮对象 */
function sessionToTurn(s) {
  return {
    prompt: s.prompt || '',
    events: Array.isArray(s.events) ? s.events : [],
    trace: Array.isArray(s.trace) ? s.trace : [],
    result: s.result ?? null,
    status: s.status || '',
    error: s.error || '',
    createdAt: s.createdAt || 0,
  };
}

/** 删除某条历史会话 */
export async function deleteHistorySession(domain, id) {
  if (!domain) return;
  const all = await getAllHistory();
  const list = all[domain] || [];
  all[domain] = list.filter((s) => s.id !== id);
  if (all[domain].length === 0) delete all[domain];
  await setAllHistory(all);
}

/** 清空某域名下的全部历史会话 */
export async function clearHistoryByDomain(domain) {
  if (!domain) return;
  const all = await getAllHistory();
  delete all[domain];
  await setAllHistory(all);
}

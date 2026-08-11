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

/** 获取某域名下的历史会话（按时间倒序：最新在前） */
export async function getHistoryByDomain(domain) {
  if (!domain) return [];
  const all = await getAllHistory();
  const list = all[domain] || [];
  return [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** 追加一条历史会话，并按域名做数量裁剪 */
export async function addHistorySession(session) {
  if (!session || !session.domain) return;
  const all = await getAllHistory();
  const list = all[session.domain] || [];
  list.push(session);
  // 只保留最近N条（按 createdAt）
  list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  while (list.length > MAX_HISTORY_PER_DOMAIN) list.shift();
  all[session.domain] = list;
  await setAllHistory(all);
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

// 云厂商模型清单加载器。
//
// 数据源（优先级从高到低）：
//   1) 远程更新源（可选）：设置页配置 JSON 地址后，模型列表可绕过扩展发版独立更新；
//   2) chrome.storage.local 缓存：上次成功拉取的远程快照，离线/慢网时直接可用；
//   3) 内置 lib/providers.json：随包发布，始终兜底。
//
// 配置 JSON 格式：
//   {
//     "version": "1.0.0",              // 版本号（字符串），远程更新时据此判断是否有新版
//     "providers": [                   // 云厂商数组
//       {
//         "id": "tencent-token-plan",  // 厂商标识（保存到 LlmConfig.provider，用于恢复下拉选择）
//         "name": "腾讯云 Token Plan",  // 展示名
//         "baseUrl": "https://...",     // 选中该厂商时自动填入，可手动覆盖
//         "models": [                   // 该厂商支持的模型列表
//           { "model": "...", "alias": "...", "tool": true, "maxToken": 131072 }
//         ]
//       }
//     ]
//   }
//
// 安全约定：清单不内置任何真实密钥（apiKey 一律由用户在设置页填写），
// 否则密钥会随扩展包或远程清单公开泄露、导致额度被盗刷。

import { STORAGE_KEYS } from './types.js';

const BUNDLE_URL = chrome.runtime.getURL('lib/providers.json');

// 当前生效的厂商清单与元信息（同步读取，需先 await ensureModelsLoaded()）
let _providers = [];
let _meta = { source: 'bundle', version: '', updatedAt: 0 };

// 一次性初始化 promise，避免并发重复加载
let _initPromise = null;

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`模型清单拉取失败(${res.status})`);
  return res.json();
}

/** 校验并规范化配置 JSON，返回 providers 数组；结构非法时抛错 */
function normalizeConfig(json) {
  const list = json && Array.isArray(json.providers) ? json.providers : null;
  if (!list || list.length === 0) throw new Error('配置格式错误：缺少有效的 providers 数组');
  return list
    .filter((p) => p && p.id && p.name && Array.isArray(p.models))
    .map((p) => ({
      id: String(p.id),
      name: String(p.name),
      baseUrl: p.baseUrl ? String(p.baseUrl) : '',
      models: p.models
        .filter((m) => m && m.model)
        .map((m) => ({
          model: String(m.model),
          alias: m.alias ? String(m.alias) : String(m.model),
          tool: !!m.tool,
          maxToken: Number(m.maxToken) || 0,
        })),
    }));
}

function applyConfig(providers, source, version, updatedAt) {
  if (!providers.length) return;
  _providers = providers;
  _meta = { source, version: version || '', updatedAt: updatedAt || Date.now() };
}

async function readCache() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.MODELS_CONFIG);
  return data[STORAGE_KEYS.MODELS_CONFIG] || null;
}
async function writeCache(entry) {
  await chrome.storage.local.set({ [STORAGE_KEYS.MODELS_CONFIG]: entry });
}

export async function getModelsSourceUrl() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.MODELS_SOURCE_URL);
  return (data[STORAGE_KEYS.MODELS_SOURCE_URL] || '').trim();
}
export async function setModelsSourceUrl(url) {
  await chrome.storage.local.set({ [STORAGE_KEYS.MODELS_SOURCE_URL]: (url || '').trim() });
}

/** 确保模型清单已加载（幂等）：本地缓存 -> 内置 json ->（可选）后台远程刷新 */
export function ensureModelsLoaded() {
  if (!_initPromise) {
    _initPromise = (async () => {
      // 1) 本地缓存（可能为上次的远程快照，离线可用）
      const cache = await readCache();
      if (cache && Array.isArray(cache.providers) && cache.providers.length) {
        applyConfig(cache.providers, 'remote-cache', cache.version, cache.updatedAt);
      }
      // 2) 内置 json 兜底（未命中远程缓存时使用）
      let bundled = null;
      try {
        const json = await fetchJson(BUNDLE_URL);
        bundled = { version: json.version || '', providers: normalizeConfig(json) };
      } catch (e) {
        console.warn('[WebMold] 内置模型清单加载失败:', e);
      }
      if (bundled && !(cache && cache.remote)) {
        applyConfig(bundled.providers, 'bundle', bundled.version, Date.now());
      }
      // 3) 配置了远程更新源则静默刷新（失败不影响已加载数据）
      const url = await getModelsSourceUrl();
      if (url) {
        checkRemoteUpdate().catch((e) => console.warn('[WebMold] 远程模型清单更新失败:', e));
      }
    })();
  }
  return _initPromise;
}

/** 主动从远程更新源拉取并应用新版本。返回 { ok, updated, version, reason? } */
export async function checkRemoteUpdate() {
  const url = await getModelsSourceUrl();
  if (!url) return { ok: false, updated: false, version: _meta.version, reason: '未配置远程更新源' };
  const json = await fetchJson(url);
  const providers = normalizeConfig(json);
  const version = json.version || '';
  const updated = version !== _meta.version;
  if (updated) {
    applyConfig(providers, 'remote', version, Date.now());
    await writeCache({ remote: true, version, updatedAt: _meta.updatedAt, providers });
  }
  return { ok: true, updated, version };
}

/** 清除远程清单缓存并回退到内置清单（用于用户清空远程源时） */
export async function clearModelsCache() {
  await chrome.storage.local.remove(STORAGE_KEYS.MODELS_CONFIG);
  const json = await fetchJson(BUNDLE_URL);
  applyConfig(normalizeConfig(json), 'bundle', json.version || '', Date.now());
}

// ---------- 同步查询（调用前需 await ensureModelsLoaded()） ----------

/** 当前生效的云厂商清单 */
export function getProviders() {
  return _providers;
}

/** 按厂商标识取厂商配置，未命中返回 null */
export function getProviderById(id) {
  return _providers.find((p) => p.id === id) || null;
}

/** 按厂商标识取该厂商的模型列表 */
export function getModelsByProvider(id) {
  const p = getProviderById(id);
  return p ? p.models : [];
}

/** 扁平模型清单（按模型名查询能力用，如 maxToken） */
export function getModels() {
  return _providers.flatMap((p) => p.models.map((m) => ({ ...m, tag: p.name })));
}

/** 按模型名查模型能力，未命中返回 null */
export function getModelById(model) {
  return getModels().find((it) => it.model === model) || null;
}

/** 当前生效配置的元信息（版本 / 来源 / 更新时间），设置页展示用 */
export function getModelsMeta() {
  return { ..._meta };
}

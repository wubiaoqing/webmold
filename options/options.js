// 设置页逻辑：LLM 配置、数据导入导出

import { getLlmConfig, setLlmConfig, getAllRules, saveAllRules } from '../lib/storage.js';
import { makeChatFn } from '../lib/agent/openai-chat.js';
import {
  ensureModelsLoaded,
  getProviders,
  getProviderById,
  getModelsByProvider,
  getModelsMeta,
  getModelsSourceUrl,
  setModelsSourceUrl,
  checkRemoteUpdate,
  clearModelsCache,
} from '../lib/models.js';

const $ = (id) => document.getElementById(id);

// 填充云厂商下拉（含「自定义 / 其他」项）
function populateProviderSelect(selectedId) {
  const sel = $('providerSelect');
  sel.innerHTML = '';
  const custom = document.createElement('option');
  custom.value = '';
  custom.textContent = '自定义 / 其他';
  sel.appendChild(custom);
  for (const p of getProviders()) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.value = getProviderById(selectedId) ? selectedId : '';
}

// 用指定云厂商的模型清单填充模型下拉（标注是否支持工具）
function populateModelSelect(providerId) {
  const sel = $('modelSelect');
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = providerId ? '— 从模型列表选择 —' : '— 选择云厂商后可见 —';
  sel.appendChild(ph);
  for (const m of getModelsByProvider(providerId)) {
    const opt = document.createElement('option');
    opt.value = m.model;
    opt.textContent = `${m.alias}${m.tool ? ' [工具]' : ''}`;
    sel.appendChild(opt);
  }
}

// 切换云厂商：先清空上一厂商的 BaseURL / API Key / 模型，再填入新厂商默认值；
// 选「自定义 / 其他」则全部留空由用户手填，避免不同厂商的配置残留混用。
function onProviderChange() {
  const pid = $('providerSelect').value;
  const p = getProviderById(pid);
  $('baseUrl').value = p && p.baseUrl ? p.baseUrl : '';
  $('apiKey').value = '';
  $('model').value = '';
  // 重建模型下拉（已含占位项），并同步模型输入框为空
  populateModelSelect(pid);
}

// 若当前 model 命中当前厂商下拉某项则选中，否则下拉留空（视为自定义）
function syncSelectFromModel(model) {
  const sel = $('modelSelect');
  const pid = $('providerSelect').value;
  const hit = getModelsByProvider(pid).some((m) => m.model === model);
  sel.value = hit ? model : '';
}

async function init() {
  // 先加载模型清单（内置 json / 本地缓存 / 远程更新源），再渲染下拉
  await ensureModelsLoaded();
  const llm = await getLlmConfig();
  populateProviderSelect(llm.provider || '');
  populateModelSelect(llm.provider || '');
  // 若当前云厂商有默认配置且用户尚未填写对应字段，则补默认值
  const p = getProviderById(llm.provider);
  $('baseUrl').value = llm.baseUrl || (p && p.baseUrl) || '';
  $('apiKey').value = llm.apiKey || (p && p.apiKey) || '';
  $('model').value = llm.model;
  syncSelectFromModel(llm.model);
  $('temperature').value = llm.temperature;
  $('topP').value = llm.topP ?? 0;
  $('maxTokens').value = llm.maxTokens ?? 0;

  $('modelsSourceUrl').value = await getModelsSourceUrl();
  renderModelsMeta();

  bind();
}

function bind() {
  // 切换云厂商 -> 刷新模型下拉并自动填入默认 BaseURL / API Key
  $('providerSelect').addEventListener('change', onProviderChange);
  // 下拉选择 -> 自动填入自定义输入框；选空则不动，保留用户手填内容
  $('modelSelect').addEventListener('change', (e) => {
    if (e.target.value) $('model').value = e.target.value;
  });
  // 手动改输入框 -> 同步下拉选中态（命中则高亮，未命中显示占位）
  $('model').addEventListener('input', (e) => syncSelectFromModel(e.target.value.trim()));
  $('saveLlm').addEventListener('click', saveLlm);
  $('testLlm').addEventListener('click', testLlm);
  $('checkModelsUpdate').addEventListener('click', checkModelsUpdate);
  $('exportBtn').addEventListener('click', exportRules);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importRules);
}

function collectLlm() {
  return {
    provider: $('providerSelect').value,
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || 'tc-code-latest',
    temperature: parseFloat($('temperature').value) || 0.2,
    topP: parseFloat($('topP').value) || 0,
    maxTokens: parseInt($('maxTokens').value, 10) || 0,
  };
}

async function saveLlm() {
  await setLlmConfig(collectLlm());
  setStatus('llmStatus', '已保存', 'ok');
}

async function testLlm() {
  setStatus('llmStatus', '测试中…');
  try {
    const cfg = collectLlm();
    const chatFn = makeChatFn(cfg);
    // 轻量探活：不跑完整 agent，只发一条消息确认连通与鉴权
    const resp = await chatFn(
      [{ role: 'user', content: '仅回复两个字：可用' }],
      null
    );
    if (resp && typeof resp.content === 'string') {
 setStatus('llmStatus', '连接成功，模型可用', 'ok');
    } else {
      setStatus('llmStatus', '连接成功，但返回内容异常', 'error');
    }
  } catch (e) {
    setStatus('llmStatus', '失败: ' + e.message, 'error');
  }
}

// 展示当前模型清单的来源 / 版本 / 更新时间
function renderModelsMeta() {
  const meta = getModelsMeta();
  const srcLabel = { bundle: '内置清单', 'remote-cache': '远程清单（缓存）', remote: '远程清单' }[meta.source] || meta.source;
  const time = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : '';
  $('modelsStatus').textContent = `当前：${srcLabel}${meta.version ? ' v' + meta.version : ''}${time ? `（更新于 ${time}）` : ''}`;
  $('modelsStatus').className = 'status';
}

// 保存远程更新源并尝试拉取新版本；清空 URL 时回退到内置清单
async function checkModelsUpdate() {
  const url = $('modelsSourceUrl').value.trim();
  await setModelsSourceUrl(url);
  if (!url) {
    await clearModelsCache();
    const llm = await getLlmConfig();
    populateProviderSelect(llm.provider || '');
    populateModelSelect(llm.provider || '');
    setStatus('modelsStatus', '已回退到内置清单', 'ok');
    return;
  }
  setStatus('modelsStatus', '检查更新中…');
  try {
    const r = await checkRemoteUpdate();
    if (r.updated) {
      // 清单已更新：重渲染云厂商与模型下拉
      const llm = await getLlmConfig();
      populateProviderSelect(llm.provider || '');
      populateModelSelect(llm.provider || '');
      setStatus('modelsStatus', `已更新到 v${r.version}`, 'ok');
    } else {
      setStatus('modelsStatus', `已是最新（v${r.version}）`, 'ok');
    }
  } catch (e) {
    setStatus('modelsStatus', '更新失败: ' + e.message, 'error');
  }
}

async function exportRules() {
  const all = await getAllRules();
  const blob = new Blob([JSON.stringify(all, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `webmold-rules-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus('dataStatus', '已导出', 'ok');
}

async function importRules(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('文件格式应为 { domain: Rule[] }');
    }
    const existing = await getAllRules();
    // 简单合并：同域名下按 id 去重，导入者覆盖
    for (const domain of Object.keys(data)) {
      const map = new Map();
      for (const r of existing[domain] || []) map.set(r.id, r);
      for (const r of data[domain] || []) map.set(r.id, r);
      existing[domain] = [...map.values()];
    }
    await saveAllRules(existing);
    setStatus('dataStatus', '导入成功', 'ok');
  } catch (err) {
    setStatus('dataStatus', '导入失败: ' + err.message, 'error');
  } finally {
    e.target.value = '';
  }
}

function setStatus(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = 'status ' + cls;
}

init();

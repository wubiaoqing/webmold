// 核心数据结构定义（以 JSDoc 形式提供类型提示，运行时为纯 JS）

/**
 * 一条定制规则。按域名归组存储。
 * @typedef {Object} Rule
 * @property {string} id 唯一 ID
 * @property {string} domain        归属域名，如 "github.com"
 * @property {string} prompt        用户输入的自然语言需求
 * @property {string} title         规则简短标题（可由 LLM 生成）
 * @property {string} css 要注入的 CSS（可为空字符串）
 * @property {string} js         要注入的 JS（可为空字符串）
 * @property {boolean} enabled      是否启用
 * @property {("all"|"exact"|"prefix")} matchType  URL 匹配方式
 * @property {string} matchValue    匹配值：exact/prefix 时为 URL；all 时忽略
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * LLM 配置。
 * 兼容标准 OpenAI 及各类 OpenAI 兼容服务（Chat Completions 接口）。
 * @typedef {Object} LlmConfig
 * @property {('cloud'|'local')} [backend] 后端类型：cloud=云端 API（需 API Key）；local=Chrome 内置本地 AI（无需 Key）
 * @property {string} baseUrl   Chat Completions 的 BaseURL（末尾不含 /chat/completions）
 * @property {string} apiKey    代理 token / API Key，走 Authorization: Bearer
 * @property {string} model     模型名或私有服务 server:<serverId>
 * @property {string} [provider] 云厂商标识（对应 lib/models.js 中 PROVIDERS 的 id，用于恢复下拉选择；自定义时为空）
 * @property {number} temperature 采样温度
 * @property {number} [topP]    核采样 top_p（0~1，可选）
 * @property {number} [maxTokens] 最大输出 tokens（gpt-5+ 自动映射为 max_completion_tokens）
 */

export const DEFAULT_LLM_CONFIG = {
  // 后端类型：默认云端（可切换为 local 走 Chrome 内置本地 AI）
  backend: 'cloud',
  // 默认对接腾讯云 Token Plan（可手动改为其他 OpenAI 兼容服务）
  provider: 'tencent-token-plan',
  baseUrl: 'https://api.lkeap.cloud.tencent.com/plan/v3',
  apiKey: '',
  model: 'tc-code-latest',
  temperature: 0.2,
  topP: 0,
  maxTokens: 0,
};

export const STORAGE_KEYS = {
  RULES: 'webmold_rules', // { [domain]: Rule[] }
  LLM: 'webmold_llm_config',
  HISTORY: 'webmold_history', // { [domain]: HistorySession[] } —— 历史会话（一问一答的完整对话过程）
  INTRODUCED: 'webmold_introduced', // { [ruleId]: true } —— 已对用户做过「首次出现引导」的规则集合，确保同一条规则只引导一次
  MODELS_CONFIG: 'webmold_models_config', // { remote:true, version, updatedAt, providers[] } —— 远程模型清单缓存（离线/慢网时兜底）
  MODELS_SOURCE_URL: 'webmold_models_source_url', // 模型清单远程更新源 URL（可选，绕过发版更新模型列表）
};

/**
 * 一次历史会话（对应对话区里的「一轮问答」）。
 * @typedef {Object} HistorySession
 * @property {string} id           唯一 ID
 * @property {string} domain       归属域名
 * @property {string} prompt       用户本轮输入
 * @property {Array<Object>} events Agent 过程事件流（用于回放对话过程）
 * @property {Object|null} result  成功时的结果：{ mode:'rule'|'answer', title, css, js, explanation, answer, targetRuleId }
 * @property {("done"|"failed"|"aborted")} status 终态
 * @property {string} error        失败/中断时的说明
 * @property {number} createdAt    完成时间戳
 */

export const MSG = {
  GENERATE_RULE: 'GENERATE_RULE', // 启动 agent 生成规则（立即返回，结果经事件推送）
  CANCEL_GENERATE: 'CANCEL_GENERATE', // 中断当前正在运行的 agent 生成
  CLEAR_SESSION: 'CLEAR_SESSION', // 清空某标签页的会话多轮历史
  GET_TASK_STATE: 'GET_TASK_STATE', // sidepanel 打开/重连时拉取某tab 的当前任务状态（进度/结果），用于恢复 UI
  APPLY_RULES: 'APPLY_RULES',
  GET_RULES_FOR_TAB: 'GET_RULES_FOR_TAB',
  RULES_UPDATED: 'RULES_UPDATED',
PREVIEW_RULE: 'PREVIEW_RULE',
  CLEAR_PREVIEW: 'CLEAR_PREVIEW',
  GET_PAGE_CONTEXT: 'GET_PAGE_CONTEXT',
  START_PICK_ELEMENT: 'START_PICK_ELEMENT', // sidepanel -> content：进入「选择元素」拾取模式
  STOP_PICK_ELEMENT: 'STOP_PICK_ELEMENT', // sidepanel -> content：退出拾取模式
  ELEMENT_PICKED: 'ELEMENT_PICKED', // content -> sidepanel：用户在页面上选中了某元素（含选择器/摘要）
  EXEC_AGENT_TOOL: 'EXEC_AGENT_TOOL', // background -> content：执行一个 agent 工具
  AGENT_EVENT: 'AGENT_EVENT', // background -> sidepanel：agent 过程事件（流式，含 done/failed/aborted 终态）
  ASK_LLM: 'ASK_LLM', // 用户定制脚本 -> content -> background：一次性问答，用 background 的 apiKey 调模型
  SUBMIT_USER_ANSWER: 'SUBMIT_USER_ANSWER', // sidepanel -> background：用户对 ask_user_question 的选择/输入，用于恢复挂起的工具调用
  CHECK_LOCAL_AI: 'CHECK_LOCAL_AI', // options -> background：检测 Chrome 内置本地 AI 可用性（chrome.offscreen 仅 SW 可用）
  TEST_LOCAL_AI: 'TEST_LOCAL_AI', // options -> background：在 SW 中跑一次本地 AI 测试提示（chrome.offscreen 仅 SW 可用）
};

// Agent 任务终态事件的 type（随 AGENT_EVENT 转发），用于让 sidepanel 无需依赖
// sendResponse 回调即可拿到最终结果/错误——即便sidepanel 曾被关闭再打开。
export const AGENT_LIFECYCLE = {
  DONE: '__task_done__', // 成功：event.result = { mode:'rule'|'answer', title, css, js, explanation, answer, targetRuleId }
  FAILED: '__task_failed__', // 失败：event.error
  ABORTED: '__task_aborted__', // 用户中断
};

// Agent 主动向用户提问的过程事件 type（随 AGENT_EVENT 转发）。
// 与终态事件不同，它不结束任务：agent 会挂起等用户在 sidepanel 里选择/输入后（经 SUBMIT_USER_ANSWER）继续。
export const AGENT_ASK = {
  QUESTION: '__ask_question__', // event.data = { askId, question, options:[{value,label}], allowText }
  ANSWERED: '__ask_answered__', // event.data = { askId, answer } —— 用户已回答，供 UI 收尾该提问项
};

// 页面桥接协议：用户定制脚本（MAIN world）与内容脚本（隔离世界）之间通过
// window.postMessage 通信时使用的标记，避免误收其它站点/脚本的消息。
export const BRIDGE = {
  REQ: 'WEBMOLD_BRIDGE_ASK_REQ', // MAIN -> content：请求调模型
  RES: 'WEBMOLD_BRIDGE_ASK_RES', // content -> MAIN：返回结果
  MAX_PROMPT: 8000, // prompt + context 上限（字符），超出截断，避免烧 token / 超上下文
};

// Agent 工具名常量
export const AGENT_TOOL = {
  QUERY_DOM: 'query_dom', // 查询匹配某 selector 的元素信息（只读）
  GET_TEXT: 'get_text', // 获取某 selector 元素的文本（只读）
  GET_ATTRS: 'get_attributes', // 获取某 selector 元素的属性（只读）
  TRY_RUN_JS: 'try_run_js', // 在页面试跑 JS（受限，用于探测/验证）
  APPLY_CSS: 'preview_css', // 临时应用 CSS 观察效果
  ASK_USER: 'ask_user_question', // 需求不明确时暂停并向用户提问，拿到回答后继续
  FINISH: 'finish', // 产出最终规则
};

/** 生成 uuid（浏览器环境） */
export function uid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 从 URL 中提取域名（含处理 www 前缀） */
export function domainFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

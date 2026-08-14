// Agent 业务编排：把「网站定制」这一具体任务，组装成 runner 能跑的输入。
// 负责：构造 system/user 消息、组装 ToolRegistry（执行器由调用方注入）、
// 选择原生/降级协议、启动 runAgent。
//
// 执行器（怎么真正查 DOM、试跑 JS）由 background 注入，保持本模块与运行环境解耦。

import { runAgent } from './runner.js';
import { ToolRegistry } from './tools.js';
import { makeChatFn } from './openai-chat.js';

function buildSystemPrompt(useNativeTools, registry) {
  const base = `你是 WebMold 浏览器扩展内置的网页助手。用户会用自然语言描述需求：可能是想对当前网站做定制（隐藏元素、改样式、加功能），也可能只是向你提问（"这个页面是什么框架？""这个按钮为什么隐藏不了？"）。你需要先判断用户意图，再决定怎么做。

【核心铁律】当用户想修改网页、你最终调用 finish 时（mode="rule"），css 与 js 两个字段【至少一个必须是非空的完整代码】，严禁输出空字符串或省略——空规则对用户毫无价值，会被判定为失败。哪怕代码很简短，也一定要把实际能起作用的 CSS 或 JS 完整写进字段里。

工作方式：
1. 先用只读工具（query_dom / get_text / get_attributes）探明页面真实结构，找到精准且稳定的选择器。不要凭空猜选择器。提问类需求同样可以用这些工具去核实页面情况，不要只靠猜。
2. 需要验证样式效果时，用 preview_css 临时应用观察。
3. 需要探测运行时行为或验证 JS 逻辑时，用 try_run_js 试跑（它有超时、结果会返回给你）。
4. 当你确信方案可行时，调用 finish 输出最终结果。finish 有两种模式：
   · mode="rule"：输出要持久化的 CSS/JS 定制规则（适用于「修改网页」类需求）。
   · mode="answer"：只输出文字回答，不生成规则（适用于「提问/解释/分析」类需求）。
   自行判断该用哪种：用户想改页面 → rule；用户只是问问题 → answer。即使用户只是提问，也请先充分调用工具核实页面真实情况后再回答。

遇到歧义时的澄清（重要）：
- 若用户需求存在【真正的歧义】、且不同的理解会导致产出明显不同，而你又无法通过只读工具自行确认，请调用 ask_user_question 暂停并向用户提问，拿到用户选择后再继续；不要自己瞎猜、也不要把选项塞进最终结果里草草收场。
- 但要克制：凡是能通过 query_dom/get_text 等工具自行查明的、或存在合理默认值的，一律不要问。一次只问一个最关键的问题，给出 2~4 个彼此互斥、含义清晰的候选项。反复无谓地提问会严重打断用户，务必只在确有必要时才问。

每次调用工具（finish 除外）都必须带上 reason 参数：用一句简短的中文说明你为什么现在要调用这个工具（如“先看看顶部广告栏的结构”“验证一下隐藏广告的样式是否生效”）。这句话会直接展示给用户看，务必自然、具体、面向用户，不要写成给自己的备忘。

产出要求：
- CSS 负责外观/隐藏/布局；JS 负责功能/交互/自动化。二者至少一个非空。
- JS 会被包裹在函数中于页面主世界执行，可直接用 document/window；不要用 import/export；操作 DOM 前判空；动态页面用 MutationObserver 等待元素；重复插入前先检查是否已存在；给你创建的元素加 data-webmold="1"；用 try/catch 包裹关键逻辑。
- CSS 用具体选择器，必要时用 !important。
- 选择器要稳定：优先用语义化属性（id、data-*、aria-label、role），谨慎使用可能随构建变化的哈希 class。

大模型能力（重要）：
- 在你产出的 JS 里，页面上已注入全局方法 window.webmold.ask，可让脚本在运行时调用大模型：
    const answer = await window.webmold.ask(prompt, { context });
  · prompt：string，给模型的问题/指令。
  · options.context：可选，string 或对象（对象会自动 JSON 序列化），用于传入页面片段/元素文字等上下文。
  · options.timeoutMs：可选，默认 120000。
  · 返回 Promise<string>（模型的文本回答）。apiKey 由扩展在后台持有，脚本全程接触不到，安全。
- 何时使用：仅当用户需求「运行时需要模型智能」时才用（如：总结/翻译/改写页面文字、根据内容智能生成提示、对用户输入做语义判断等）。若纯靠 CSS/静态 JS 就能满足，请勿调用，避免不必要的 token 消耗。
- 使用规范：ask 是异步的，务必 await 或 .then；调用前给出「处理中」的 UI 反馈，完成后再更新；用 try/catch 兜底失败；context 只传必要的、非敏感的文本，并自行截断到合理长度（如 4000 字符内）；避免在循环/高频事件里无节制调用。
- 典型示例（给每篇文章加“AI 总结”按钮）：
    const btn = document.createElement('button');
    btn.textContent = 'AI 总结';
    btn.dataset.webmold = '1';
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '总结中…';
      try {
    const s = await window.webmold.ask('用三句话总结这篇文章', { context: article.innerText.slice(0, 4000) });
        alert(s);
      } catch (e) { alert('总结失败：' + e.message); }
    finally { btn.disabled = false; btn.textContent = 'AI 总结'; }
    };

安全红线（必须遵守）：
- 探测类工具应尽量只读或可逆，try_run_js 里不要做破坏性或数据外发操作。
- 最终规则绝不能包含窃取用户数据、向外部服务器发送数据、或任何有害逻辑。
- 只完成用户明确表达的定制意图。`;

  if (useNativeTools) return base;

  // 文本降级：追加协议说明
  return `${base}

【重要·工具调用协议】当前不支持函数调用，你必须严格用如下 JSON 格式（且一次只输出一个 JSON，不要有多余文字）来调用工具：
{"tool":"工具名","args":{...参数...}}
完成时输出 finish（二选一）：
- 改网页 → {"tool":"finish","args":{"mode":"rule","title":"...","css":"...","js":"...","explanation":"..."}}
- 纯提问/闲聊/打招呼 → {"tool":"finish","args":{"mode":"answer","answer":"你的完整回答","explanation":"简短说明"}}
【极重要】输出 mode="rule" 的 finish 时，css 和 js 至少一个必须是【非空的完整代码】：把你要隐藏/改样式的完整 CSS、或要执行的完整 JS 原样写进字段里，绝不能写成 "" 空字符串或省略该字段。注意：用户只是打招呼或闲聊（如「你好」）时，不要调用任何工具，直接输出上面的 answer 格式即可。
【输出格式铁律】你只能输出一个 JSON 数据对象（上面这些工具调用或 finish 结果），严禁输出 JSON Schema 定义本身——绝不能出现 type / properties / enum / required 这类「描述结构的字段」。查到所需信息后必须立刻转向 finish，禁止对同一个元素反复执行相同的只读查询。

可用工具：
${registry.toTextProtocolDoc()}`;
}

/**
 * 把用户在页面上「选中的元素」（支持多个）渲染成一段聚焦上下文。
 * 用户显式选择元素通常意味着需求就针对它们，模型应优先围绕这些元素定位与操作。
 * @param {Array<{selector?:string,tag?:string,id?:string,className?:string,text?:string,outerHTML?:string,rect?:{w:number,h:number}}>|{...}} [els]
 * @returns {string}
 */
function selectedElementBlock(els) {
  const list = Array.isArray(els) ? els : els ? [els] : [];
  if (!list.length) return '';
  const single = list.length === 1;
  const head = single
    ? '【用户选中的目标元素】（本次需求很可能就针对它，请优先围绕此元素定位与操作）'
    : `【用户选中的 ${list.length} 个目标元素】（本次需求很可能就针对它们，请优先围绕这些元素定位与操作）`;
  const blocks = list.map((el, i) => {
    const lines = [];
    if (!single) lines.push(`--- 元素 ${i + 1} ---`);
    if (el.selector) lines.push(`CSS 选择器: ${el.selector}`);
    lines.push(`标签: <${el.tag || 'unknown'}>`);
    if (el.id) lines.push(`id: ${el.id}`);
    if (el.className) lines.push(`class: ${el.className}`);
    if (el.rect) lines.push(`尺寸: ${el.rect.w}×${el.rect.h}px`);
    if (el.text) lines.push(`文本: ${el.text}`);
    if (el.outerHTML) lines.push(`结构:\n${el.outerHTML}`);
    return lines.join('\n');
  });
  return [head, ...blocks].join('\n');
}

/**
 * 运行网站定制 agent。
 * @param {Object} params
 * @param {import('../types.js').LlmConfig} params.cfg
 * @param {string} params.userPrompt
 * @param {{url:string,title:string,domSnapshot?:string,selectedElements?:Array<{selector?:string,tag?:string,id?:string,className?:string,text?:string,outerHTML?:string,rect?:{w:number,h:number}}>}} params.pageContext
 * @param {Object} params.executors 工具执行器映射：{ query_dom, get_text, get_attributes, preview_css, try_run_js }
 * @param {{title?:string,css?:string,js?:string}} [params.existingRule] 若为修改已有规则（手动编辑态），传入其当前内容
 * @param {Array<{id:string,title?:string,prompt?:string,css?:string,js?:string}>} [params.candidateRules] 当前域名下的已有规则清单，供模型自动判断本次需求是否为修改某条已有规则
 * @param {Array<{role:string,content:string}>} [params.history] 会话历史（本轮 session 内之前几次的用户需求与产出摘要），用于多轮上下文
 * @param {AbortSignal} [params.signal] 中断信号，透传给 runner/chatFn
 * @param {(ev:any)=>void} [params.onEvent]
 * @param {Object} [params.options] 传给 runner 的选项
 * @returns {Promise<{title:string,css:string,js:string,explanation:string,targetRuleId:string}>}
 */
export async function runCustomizeAgent({ cfg, userPrompt, pageContext, executors, existingRule, candidateRules, history, signal, onEvent, options = {} }) {
  // 默认原生 function calling；本地后端（Chrome 内置 AI）不支持，强制走文本降级协议
  const useNativeTools =
    cfg?.backend === 'local' ? false : options.useNativeTools !== false;
  const registry = new ToolRegistry();
  // finish 不需要执行器（由 runner 处理），其余注入
  registry.registerAll({
    query_dom: executors.query_dom,
    get_text: executors.get_text,
    get_attributes: executors.get_attributes,
    preview_css: executors.preview_css,
    try_run_js: executors.try_run_js,
    ask_user_question: executors.ask_user_question,
  });

  const chatFn = makeChatFn(cfg);

  const contextBlock = [
    `当前网站 URL: ${pageContext.url}`,
    `页面标题: ${pageContext.title}`,
    pageContext.domSnapshot ? `页面结构摘要（截断，仅供参考，请用工具核实）:\n${pageContext.domSnapshot}` : '',
    selectedElementBlock(pageContext.selectedElements),
  ]
    .filter(Boolean)
    .join('\n');

  // 修改模式：把现有规则内容作为基础提供给模型，让它在此之上按新需求改
  const hasExisting =
    existingRule && (existingRule.css || existingRule.js);
  const existingBlock = hasExisting
    ? `\n\n【要修改的现有规则】（这是本条规则当前已保存的内容，请在此基础上按用户的新需求进行修改，保留仍然有效的部分，不要推倒重来）\n标题: ${
existingRule.title || '未命名规则'
      }\n--- 现有 CSS ---\n${existingRule.css || '(空)'}\n--- 现有 JS ---\n${existingRule.js || '(空)'}`
    : '';

  const taskHint = hasExisting
    ? '本次是【修改已有规则】任务：请理解现有规则的作用，再根据用户需求做增量修改，最终通过 finish 输出修改后的【完整 css 与 完整 js】（而非差异）。特别注意：本次若只改动了其中一类（比如只调整 CSS），另一类（JS）也必须把上面「现有规则」里的原内容原样完整回填，绝不能返回空字符串或省略，否则会导致用户已有的 JS/CSS 被清空丢失。'
    : '';

  // 自动识别模式：非手动编辑态且当前域名已有规则时，把规则清单交给模型，
  // 让它自行判断本次需求是「修改某条已有规则」还是「新建」，并在 finish 里通过 targetRuleId 表明。
  const list = Array.isArray(candidateRules) ? candidateRules.filter((r) => r && r.id) : [];
  const enableAutoMatch = !hasExisting && list.length > 0;
  const candidateBlock = enableAutoMatch
    ? `\n\n【当前网站已有规则清单】（共${list.length} 条。请先判断：用户这次的需求是想「修改」下面某一条已有规则，还是「新建」一条全新规则。若是修改某条，请在 finish 时把该规则的 id 填入 targetRuleId，并在其现有 CSS/JS 基础上做增量修改、输出完整结果；若是新建则targetRuleId 留空。）\n${list
        .map(
          (r, i) =>
            `${i + 1}. id=${r.id} | 标题：${r.title || '未命名规则'} | 原始需求：${
              (r.prompt || '').slice(0, 80) || '(无)'
            }\n   现有CSS：${(r.css || '(空)').slice(0, 300)}\n   现有JS：${(r.js || '(空)').slice(0, 300)}`
        )
        .join('\n')}`
    : '';

  const autoMatchHint = enableAutoMatch
    ? '本次可能是新建、也可能是修改上面清单里的某条已有规则。请结合用户需求语义判断：若用户明显是在调整/补充/修复某条已有规则的效果（例如"再把xx也隐藏了""刚才那个按钮改成蓝色"），就视为修改该规则并填 targetRuleId；若是一个与现有规则无关的全新诉求，则新建（targetRuleId 留空）。不要为了复用而勉强套用不相关的规则。\n【极重要】当你判断为「修改某条已有规则」时，finish 必须输出该规则修改后的【完整 CSS 与完整 JS】：本次没有改动的那一类（比如你只调整了 CSS，则JS 部分）也必须把它原有的内容原样完整回填，绝不能返回空字符串或省略——否则会导致用户已有的 JS/CSS 被清空丢失。'
    : '';

  const hints = [taskHint, autoMatchHint].filter(Boolean).join('\n');

  // 会话历史：夹在 system 与当前 user 之间，让模型看到本轮 session 内之前的需求与产出。
  // 仅接受 role 为 user/assistant 的精简消息（不含工具调用细节），避免历史无限膨胀。
  const priorMessages = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
        .map((m) => ({ role: m.role, content: m.content }))
    : [];

  const messages = [
    { role: 'system', content: buildSystemPrompt(useNativeTools, registry) },
    ...priorMessages,
    {
      role: 'user',
      content: `【页面上下文】\n${contextBlock}${existingBlock}${candidateBlock}\n\n【用户需求】\n${userPrompt}${
        hints ? `\n\n【说明】\n${hints}` : ''
      }`,
    },
  ];

  const { result, meta } = await runAgent({
    chatFn,
    registry,
    messages,
    onEvent,
    options: { ...options, useNativeTools, signal },
  });

  // 规范化最终结果
  // mode 由模型通过 finish 决定：'rule'=生成规则（默认），'answer'=纯文字回答
  const mode = result?.mode === 'answer' ? 'answer' : 'rule';
  const normalized = {
    mode,
    title: String(result?.title || '未命名规则').slice(0, 40),
    css: typeof result?.css === 'string' ? result.css : '',
    js: typeof result?.js === 'string' ? result.js : '',
    explanation: String(result?.explanation || ''),
    answer: typeof result?.answer === 'string' ? result.answer : '',
    // 仅当命中候选清单里的真实规则时才回传，避免模型乱填
    targetRuleId:
      enableAutoMatch && result?.targetRuleId && list.some((r) => r.id === result.targetRuleId)
        ? String(result.targetRuleId)
        : '',
  };

  // 纯回答模式：不校验 CSS/JS，直接返回
  if (mode === 'answer') {
    // 若模型忘了填 answer，退而用 explanation 兜底
    if (!normalized.answer && normalized.explanation) normalized.answer = normalized.explanation;
    if (!normalized.answer) {
      const err = new Error('模型未返回回答内容，请重试。');
      err.code = 'FINISH_PARSE_INCOMPLETE';
      throw err;
    }
    return normalized;
  }

  // finish 产出完整性校验：不要让“解析失败/被截断/模型偷懒输出空规则”静默退化成空规则。
  // 判断依据：finish 的参数解析不完整（argsOk=false）、输出被 max_tokens 截断（finishReason='length'），
  // 或模型主动输出了空 css/js（本地小模型常见：满足 JSON 结构约束却未真正生成代码）。
  const truncated = meta && meta.finishReason === 'length';
  const parseIncomplete = meta && meta.argsOk === false;
  const bothEmpty = !normalized.css && !normalized.js;

  if (bothEmpty) {
    // CSS/JS 均为空，无论原因是截断、解析失败还是模型偷懒，都不能保存为规则。
    // 直接报错，让用户知道真实原因并可重试，而不是误以为无事发生。
    const reason = truncated
      ? '模型输出因达到「最大输出长度」被截断，规则内容不完整。'
      : parseIncomplete
        ? '模型输出的规则内容格式不完整，未能解析出 CSS/JS。'
        : '模型返回的规则 CSS 与 JS 均为空（未真正生成代码）。';
    const err = new Error(
      `${reason}请重试；若反复出现，可到设置页调大「最大输出 tokens」后再试。`
    );
    err.code = 'FINISH_PARSE_INCOMPLETE';
    throw err;
  }

  // 有产出但可能被截断：不阻断（保留可用部分），在说明里追加提醒，便于用户核对。
  if (!bothEmpty && (parseIncomplete || truncated)) {
    const note = truncated
      ? '⚠️ 注意：本次输出可能因达到最大长度被截断，请检查 CSS/JS 是否完整。'
      : '⚠️ 注意：本次输出的部分内容解析异常，请检查 CSS/JS 是否完整。';
    normalized.explanation = normalized.explanation
      ? `${normalized.explanation}\n${note}`
      : note;
  }

  return normalized;
}

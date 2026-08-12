// ToolRegistry：工具的 schema 声明 + 执行器注册表
// ------------------------------------------------------------------
// 与 runner 一样，本文件不关心工具「如何」执行（那是 background 的事），
// 只负责：
//   1) 定义每个工具的名称、描述、参数 JSON Schema（供 LLM 理解与原生 tools 协议）
//   2) 提供 execute()，把调用分发给注入进来的执行器函数
//3) 提供 toOpenAiTools() / toTextProtocolDoc() 两种表述，适配原生/降级两条路径
//
// 安全约束在描述里对模型明示，真正的强约束（超时、只读、禁网络）由执行器落实。
// ------------------------------------------------------------------

import { AGENT_TOOL } from '../types.js';

// 所有探测类工具共用的 reason 参数：让模型每次调用都用一句话说明「为什么现在要调这个工具」，
// 便于在 UI 上向用户解释每一步的意图。
const REASON_PROP = {
  reason: {
  type: 'string',
    description: '用一句简短的中文说明你为什么现在要调用这个工具（面向用户展示，如“先看看顶部广告栏的结构”）。',
  },
};

/** 工具定义表（schema 与业务无关，纯声明） */
export const TOOL_DEFS = [
  {
    name: AGENT_TOOL.QUERY_DOM,
    description:
      '只读查询：返回匹配 CSS 选择器的元素信息（数量、每个元素的标签/id/class/关键属性/文本预览）。用于探明页面真实结构，先看后改。',
    parameters: {
      type: 'object',
      properties: {
    selector: { type: 'string', description: 'CSS 选择器，如 "header .ad", "[data-testid=xxx]"' },
     limit: { type: 'integer', description: '最多返回多少个元素，默认 10', default: 10 },
        ...REASON_PROP,
    },
   required: ['selector', 'reason'],
  },
  },
  {
    name: AGENT_TOOL.GET_TEXT,
    description: '只读：获取匹配选择器的元素的可见文本内容（截断）。用于确认内容/定位目标。',
    parameters: {
 type: 'object',
   properties: {
        selector: { type: 'string' },
        limit: { type: 'integer', default: 5 },
        ...REASON_PROP,
      },
      required: ['selector', 'reason'],
 },
  },
  {
    name: AGENT_TOOL.GET_ATTRS,
  description: '只读：获取匹配选择器的第一个元素的全部属性，帮助你找到稳定的选择器锚点。',
 parameters: {
   type: 'object',
      properties: { selector: { type: 'string' }, ...REASON_PROP },
  required: ['selector', 'reason'],
    },
  },
  {
    name: AGENT_TOOL.APPLY_CSS,
    description:
    '临时应用一段 CSS 到当前页面用于观察效果（不落库、可被清除）。返回是否应用成功。用于验证你的样式是否达到预期。',
    parameters: {
      type: 'object',
      properties: { css: { type: 'string' }, ...REASON_PROP },
   required: ['css', 'reason'],
    },
  },
  {
    name: AGENT_TOOL.TRY_RUN_JS,
    description:
'在页面主世界【试跑】一段 JS 用于探测或验证（有超时、结果会返回你）。注意：这是探测手段，代码应尽量只读或可逆；不要在这里做破坏性或持久化操作。返回 { ok, returnValue, logs, error }。',
    parameters: {
type: 'object',
      properties: {
   code: {
   type: 'string',
       description: '要试跑的 JS。可通过 return 返回一个可序列化的值供你观察。',
        },
        ...REASON_PROP,
      },
      required: ['code', 'reason'],
    },
  },
  {
    name: AGENT_TOOL.ASK_USER,
    description:
      '当用户需求存在【真正的歧义】、且不同理解会导致产出明显不同、你无法通过只读工具自行确认时，用它暂停并向用户提问，拿到用户的选择后再继续。' +
      '返回 { answered:true, answer:"用户选择的内容" }。' +
      '请克制使用：能通过 query_dom/get_text 等自行查明的、或能合理默认的，都不要问；一次只问一个最关键的问题，避免打断用户。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要问用户的问题，简洁明确的中文一句话，说明你在纠结什么。',
        },
        options: {
          type: 'array',
          description:
            '供用户点选的候选答案（2~4 个），每个是一句简短、彼此互斥、含义清晰的中文短语。',
          items: { type: 'string' },
        },
        allowText: {
          type: 'boolean',
          description: '是否允许用户不选选项而自由输入文字补充，默认 true。',
          default: true,
        },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: AGENT_TOOL.FINISH,
    description:
      '任务完成时调用，输出最终结果。有两种模式：\n' +
      '1) mode="rule"：输出要持久化的定制规则（css/js），用于「修改网页」类需求。\n' +
      '2) mode="answer"：只输出文字回答，不生成规则，用于「回答问题/解释/分析」类需求。\n' +
      '请根据用户意图自行判断用哪种模式：用户想改页面 → rule；用户只是问问题 → answer。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['rule', 'answer'],
          description:
            '输出模式：rule=生成可保存的 CSS/JS 规则（默认）；answer=只输出文字回答，不生成规则。',
          default: 'rule',
        },
        title: { type: 'string', description: '不超过20字的规则标题（mode=rule 时必填）' },
        css: { type: 'string', description: '最终 CSS，无则空字符串（mode=rule 时使用）' },
        js: { type: 'string', description: '最终 JS，无则空字符串（mode=rule 时使用）' },
        explanation: { type: 'string', description: '用一两句话解释这条规则做了什么（mode=rule 时）或回答用户的问题（mode=answer 时）' },
        answer: { type: 'string', description: '对用户的完整文字回答，支持 Markdown 排版（mode=answer 时使用）' },
        targetRuleId: {
          type: 'string',
          description:
            '若上下文提供了「当前网站已有规则清单」，且你判断本次需求是在修改其中某一条已有规则，则填入该规则的 id（改哪条就填哪条的id）；若本次是新建一条全新规则，则留空或不填。（mode=rule 时使用）',
        },
      },
      required: ['mode', 'explanation'],
    },
  },
];

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, (args:object)=>Promise<any>>} */
    this._executors = new Map();
  }

  /** 注册某工具的执行器 */
  register(name, executor) {
    this._executors.set(name, executor);
    return this;
  }

  /** 批量注册 */
  registerAll(map) {
    for (const [name, fn] of Object.entries(map)) this.register(name, fn);
    return this;
  }

  has(name) {
    return this._executors.has(name);
  }

  /** 执行工具；finish 由 runner 直接处理，这里对未知工具报错 */
  async execute(name, args) {
    const fn = this._executors.get(name);
    if (!fn) return { ok: false, error: `未知或未启用的工具: ${name}` };
    return fn(args || {});
  }

  /** 转成 OpenAI 原生 tools 数组（finish 也作为工具暴露） */
  toOpenAiTools() {
    return TOOL_DEFS.map((d) => ({
      type: 'function',
      function: {
        name: d.name,
      description: d.description,
        parameters: d.parameters,
      },
    }));
  }

  /** 文本降级协议下，供 system prompt 描述可用工具 */
  toTextProtocolDoc() {
    const lines = TOOL_DEFS.map((d) => {
      const props = Object.keys(d.parameters.properties || {}).join(', ');
      return `- ${d.name}(${props}): ${d.description}`;
    });
    return lines.join('\n');
  }
}

# WebMold — 自然语言网站定制 Chrome 插件

用自然语言描述你想对任意网站做的改动，插件内置一个**带工具的 Agent**，在真实页面上"边看边改"，把你的想法翻译成可执行的 CSS/JS 并注入页面，实现功能定制与 UI 定制。所有规则**按网站域名持久化存储**，下次访问自动生效。

## 核心特性

- **Agent 驱动**：不是一次性猜代码，而是一个带工具的 agent 循环——先探测 DOM、试跑验证，再产出规则，复杂网站成功率更高。
- **自然语言驱动**：直接描述需求，如"隐藏顶部广告""加个夜间模式按钮""在每个视频卡片上显示时长"。
- **功能 + UI 双定制**：CSS 负责外观，JS 负责功能，能力上限接近手写脚本。
- **过程可视**：侧边栏实时展示 agent 的思考、工具调用与结果。
- **按域名持久化**：规则以域名为维度保存，支持整站 / URL 前缀 / 精确 URL 三种生效范围。
- **即时预览**：保存前可先预览效果，满意再落库。
- **规则管理**：启用/停用、编辑、删除、导入/导出。
- **OpenAI 兼容**：支持任何兼容 OpenAI Chat Completions 格式的服务；自动适配原生 function calling，不支持时降级为文本协议。
- **本地优先**：规则与历史全部存于浏览器本地（`chrome.storage.local`），默认不上传任何数据。

## 目录结构

```
manifest.json        MV3 配置
background/service-worker.js    消息中枢 / 规则自动应用 / Agent 驱动与工具执行
content/content-script.js       CSS 注入 / 页面上下文采集 / Agent 只读工具执行端 / 预览
sidepanel/    侧边栏 UI：需求输入、Agent 过程展示、规则管理
welcome/           首次安装引导页：三步用法 + 一键跳设置
options/           设置页：模型接入、数据管理
lib/
  types.js         类型、常量、消息与工具名定义
  storage.js          存储层（chrome.storage.local 持久化）
  agent/
    runner.js    ★ Harness 内核：循环/步数/超时/重试/事件/协议适配（与业务解耦、可替换）
    tools.js           ToolRegistry：工具 schema 声明 + 执行器注册表
    openai-chat.js     OpenAI 兼容 chatFn 适配器
    agent-service.js   业务编排：组装 prompt/registry 并驱动 runner
assets/        图标
```

## Agent 架构（可替换的 Harness 内核）

设计上把三层严格解耦，既保证当前可控，又为将来扩展/替换留足空间：

- **Harness 内核（`lib/agent/runner.js`）**：与业务无关的循环控制、步数上限、单步超时/重试/指数退避、事件钩子（trace/日志/UI 都挂这里），以及"原生 tools 协议 / 文本降级协议"的统一适配。将来若要换成某个开源 agent runtime，只需让其实现相同的 `runAgent` 契约，业务侧零改动。
- **工具层（`lib/agent/tools.js` + 各执行端）**：`ToolRegistry` 只声明 schema 与分发，真正的执行由 background 注入——只读工具（`query_dom` / `get_text` / `get_attributes` / `preview_css`）转发给内容脚本；`try_run_js` 用 `chrome.scripting` 在主世界带超时执行。
- **业务编排（`lib/agent/agent-service.js`）**：把"网站定制"这个具体任务组装成 runner 的输入（system prompt、上下文、工具集）。

### Agent 可用工具

| 工具 | 作用 | 执行位置 |
|---|---|---|
| `query_dom` | 只读查询匹配选择器的元素信息 | 内容脚本（隔离世界） |
| `get_text` | 只读获取元素文本 | 内容脚本 |
| `get_attributes` | 只读获取元素属性 | 内容脚本 |
| `preview_css` | 临时应用 CSS 观察效果（可清除） | 内容脚本 |
| `try_run_js` | 主世界试跑 JS 探测/验证（8s 超时，返回值+日志） | background + scripting |
| `finish` | 输出最终规则 | runner 内拦截 |

## 安装（开发者模式）

1. 打开 Chrome，访问 `chrome://extensions`。
2. 右上角开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目根目录。
4. 固定 WebMold 图标到工具栏。

## 使用

>首次安装后会自动弹出**欢迎页**，介绍三步用法并提供「去配置模型」入口；
> 侧边栏在未配置模型时也会顶部提示「还差一步就能用了」，点击即可跳转设置。

1. 点击工具栏的 WebMold 图标先进入**设置页**（或点侧边栏右上角⚙）：
   - **云厂商**：选择「腾讯云 Token Plan」会自动填入 BaseURL 并展示其支持的模型列表，你只需填写自己的 API Key（在腾讯云 Token Plan 控制台获取 `sk-tp-...` 代理 Token）。
   - 也可选「自定义 / 其他」，手动填写任意 OpenAI 兼容服务的 BaseURL / API Key / 模型名称。
   - 点「测试连接」确认可用。
2. 打开任意网站，点击 WebMold 图标打开**侧边栏**。
3. 在输入框描述需求 → 点「生成定制」。可在「Agent 运行过程」区看到它如何探测页面、试跑、最终产出。
4. 查看生成的 CSS/JS（可手动微调）→ 点「预览」查看效果。
5. 选择生效范围 → 点「保存规则」。之后每次访问该网站会自动应用。

## 工作原理

```
用户需求(自然语言)
      │
      ▼
侧边栏采集页面上下文(标题 + DOM 结构摘要) ──GENERATE_RULE(含 tabId)──► background
      │
      ▼
background 组装 Agent：注入工具执行器 + LLM 配置
      │
      ▼
┌──────────── Agent 循环 (runner.js) ────────────┐
│  调用 LLM(带 tools) ──► 模型决定调用工具   │
│      ├─ query_dom/get_text/... ► 内容脚本(只读观察) │
│      ├─ preview_css     ► 内容脚本(临时应用) │
│      ├─ try_run_js        ► 主世界(带超时试跑)  │
│      └─ finish             ► 产出 {css,js,...}  │
│  每步事件 ──AGENT_EVENT──► 侧边栏实时展示            │
└─────────────────────────────────────────────────┘
 │
      ▼
预览 / 保存到 chrome.storage.local（按 domain 归组）
    │
页面加载 / 路由变化时自动应用：
  · CSS → 内容脚本注入（隔离世界，不受页面 CSP 限制）
  · JS  → chrome.scripting.executeScript(world:'MAIN')（绕过页面 CSP）
```

## 安全说明

- API Key、Token 仅存储在浏览器本地（`chrome.storage.local`），不会上传到除你所配置服务外的任何地方。
- 扩展包内不内置任何 API Key，需由每个用户自行在设置页填写。
- Agent 的探测工具默认只读；`try_run_js` 用于探测/验证，有 8 秒超时，system prompt 也明确要求其中不做破坏性或数据外发操作。
- 最终生成的 JS 会在页面主世界执行，等同于运行第三方脚本。**保存前请务必预览并检查生成的代码**。
- system prompt 已明确禁止模型生成窃取数据 / 外发数据 / 有害代码，但仍建议人工确认。

## 可控性与后续扩展

harness 内核集中承载了循环/超时/重试/事件等能力，后续要增强都在 `runner.js` 一处扩展，业务代码不动：

- 加更细的错误分类与重规划策略
- 接入 trace / 可观测
- 增加 checkpoint / 中断恢复
- 需要时整体替换为外部 agent runtime（保持 `runAgent` 契约即可）

## 已知限制

- Service Worker 生命周期限制下，超长 agent 任务需靠持续的网络/消息活动维持存活（当前每步都有活动，通常无碍）。
- 强 SPA 站点的动态加载时机需 agent 在 JS 中自行处理（prompt 已引导使用 MutationObserver）。
- 暂未做 iframe（`all_frames: false`）内的注入。

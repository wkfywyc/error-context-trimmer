# 报错上下文裁剪器 · Error Context Trimmer

> 用「主 Agent + 子 Agent」双层架构，把海量代码上下文裁剪成几行关键证据，再交给 DeepSeek 定位报错根因。

**English**: [README.en.md](README.en.md)

- 适用环境：VS Code **1.85+**（内置 Node 18，原生 `fetch`，无需 axios）
- 模型：DeepSeek **`deepseek-chat`**（OpenAI 兼容的 Function Calling 格式）
- 交互形态：**无额外 UI**，全部过程实时打印到输出面板「报错上下文裁剪器」

---

## 1. 这是什么

你选中一段报错，插件让 **主 Agent（Manager）** 先思考「我需要哪些局部代码证据」，再把任务拆成若干子任务派给 **子 Agent（Worker）**；子 Agent 在自己的上下文里读代码、跑正则，最后**只回传 200 字以内的结论**。主 Agent 拿到结论后继续判断，直到能给出最终诊断。

所有流转（谁在思考、谁在执行、messages 数组长什么样）都会用 `outputChannel.appendLine` 实时打印，便于观察和学习。

## 2. 为什么必须分两层（上下文裁剪原理）

单层 Agent 的死穴：它读进来的原始代码全部堆在自己的 `messages` 里，几轮下来上下文爆炸，而真正有用的往往只有 5 行。双层架构把脏活下放：

```
用户报错
   │
   ▼
┌───────────────────────────────────────────────────┐
│ 主 Agent（Manager）                                │
│ while (turn < mainMaxTurns)                        │
│   ├─ 思考：我现在缺哪块信息？                        │
│   ├─ delegate_task ───────────────────┐            │
│   │                                   │            │
│   │     ┌─────────────────────────────▼─────────┐  │
│   │     │ 子 Agent（Worker）runWorkerAgent()     │  │
│   │     │ while (turn < workerMaxTurns)          │  │
│   │     │   ├─ get_surrounding_code（读局部代码）│  │
│   │     │   ├─ search_regex（正则搜索）          │  │
│   │     │   └─ 只返回精炼结论                    │  │
│   │     └─────────────────────────────┬─────────┘  │
│   │  ◀── messages.push({role:'tool'}) ┘            │
│   └─ 信息够了？→ 输出最终诊断 / 不够？→ 再派一单     │
└───────────────────────────────────────────────────┘
```

- 子 Agent 的 `messages` 是**函数内的局部数组**，返回时随 GC 消失，不会污染主 Agent；
- 主 Agent 的 `messages` 每轮只增加**一条** `role: 'tool'` 消息（= 子 Agent 结论）；
- 于是主 Agent 的上下文增长是 `O(任务数 × 结论长度)`，而不是 `O(读过的全部代码量)`。

## 3. 目录结构

```
error-context-trimmer/
├─ package.json          # 插件清单：命令、配置项、入口
├─ extension.js          # 核心实现（含极详细中文注释）
├─ README.md             # 中文使用说明（本文件）
├─ README.en.md          # English usage
├─ LICENSE               # MIT 许可证
├─ .gitignore
└─ .vscode/launch.json   # F5 调试配置
```

## 4. 安装与运行

### 方式 A：源码调试运行（推荐，当前阶段）

1. 安装 VS Code **1.85 或更高版本**（自带 Node 18，插件依赖原生 `fetch`）。
2. VS Code 菜单：**文件 → 打开文件夹**，选择本项目根目录（包含 `package.json` 的文件夹）。
3. 按 **F5**，会启动一个新的「扩展开发宿主」窗口。
4. 在新窗口里先设置 API Key（见第 5 节），然后按第 6 节使用。

> 调试配置已内置在 `.vscode/launch.json`；若 F5 提示选择环境，选 **VS Code Extension Development**。

### 方式 B：打包成 VSIX 安装（可选）

需要本机有 Node.js / npm：

```bash
npx @vscode/vsce package
code --install-extension error-context-trimmer-0.1.0.vsix
```

`publisher` 当前为占位值 `local-dev`，如需发布到 Marketplace 请先修改 `package.json` 中的 `publisher`。

## 5. 配置

首次使用必须先配置 DeepSeek API Key（三选一，优先级从高到低）：

| 方式 | 操作 |
| --- | --- |
| ① 插件设置 | 命令面板执行 **`报错上下文裁剪器: 设置 DeepSeek API Key`**（或 `Ctrl+,` 搜索 `errorContextTrimmer.apiKey`） |
| ② 环境变量 | 设置 `DEEPSEEK_API_KEY=sk-xxxx` 后重启 VS Code |
| ③ settings.json | `"errorContextTrimmer.apiKey": "sk-xxxx"` |

全部可配置项：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `errorContextTrimmer.apiKey` | `""` | DeepSeek API Key，`sk-` 开头 |
| `errorContextTrimmer.model` | `deepseek-chat` | 模型名。Function Calling 请使用 `deepseek-chat` |
| `errorContextTrimmer.mainMaxTurns` | `8` | 主 Agent 最大循环轮数（防死循环） |
| `errorContextTrimmer.workerMaxTurns` | `5` | 单个子 Agent 最大循环轮数（防死循环） |

> 达到最大轮数时，代码会**关闭工具**并强制模型输出结论，不会无限循环。

## 6. 使用方法

1. 在编辑器里打开出错的源码文件。
2. 选中报错文本（例如浏览器控制台 / 终端里的异常堆栈）。
3. 打开命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`），执行：

   ```
   报错上下文裁剪器: 诊断当前报错（双层 Agent）
   ```

   报错信息的来源优先级：

   | 优先级 | 来源 |
   | --- | --- |
   | ① | 编辑器中**选中的文本** |
   | ② | 当前文件的 **Error 级诊断**（红色波浪线，最多 5 条） |
   | ③ | 弹出输入框，**手动粘贴**报错 |

4. 右下角会出现「双层 Agent 诊断中…」进度通知，完成后弹出提示。
5. 打开输出面板：**视图 → 输出**，下拉选择 **「报错上下文裁剪器」**，即可看到完整流转过程与最终诊断。

> 没有打开任何文件也能直接运行：插件会使用内置的模拟代码 `mock/demo.ts`，方便先跑通全流程。

## 7. 输出面板怎么读

每行都有明确前缀，一眼区分「谁在说话」：

| 前缀 | 含义 |
| --- | --- |
| `[系统]` | 插件启动、模型信息、网络/错误等框架日志 |
| `[主 Agent]` | 主 Agent 的思考、派发任务、最终诊断 |
| `[子 Agent #n]` | 第 n 个子 Agent 的工具调用与结论回传 |
| `messages 快照` | 每轮结束后打印主 Agent 上下文数组的节点摘要与字符数 |

真实运行日志示例（节选）：

```text
──────────────── 报错上下文裁剪器 · 启动 ────────────────
[系统] 模型：deepseek-chat
[主 Agent] 🎯 主 Agent 启动，目标已写入 messages[1]
[主 Agent] 🧠 初始上下文：messages 共 2 条（622 字符）

──────────────── 主 Agent 第 1/8 轮 · 思考中 ────────────────
[主 Agent] 📤 发送 messages（2 条 / 622 字符），可用工具：delegate_task
[主 Agent] 📋 [get_code_context] 决定派发任务：在 mock/demo.ts 读取第 17 行上下 20 行代码…

──────────────── 子 Agent #1 启动 ────────────────
[子 Agent #1] 🧠 已创建独立上下文：messages[0]=system(Worker 角色)，messages[1]=user(任务)
[子 Agent #1] 🔧 调用工具 get_surrounding_code({"line":17,"radius":20})
[子 Agent #1] 📄 工具返回 676 字，预览：【文件】mock/demo.ts …
[子 Agent #1] ✅ 停止调用工具，产出结论（76 字）
[子 Agent #1] ↩️ 回传给主 Agent 的【只有这段文字】，本循环里累积的 5 条消息全部丢弃

[主 Agent] 📥 子 Agent 结论已写入 messages[3]（76 字）
[主 Agent]    ↳ 主 Agent 的上下文只增加了这【一条】结论，子 Agent 内部几十条工具消息没有进来
┌─ messages 快照 · 主 Agent 第 1 轮结束 · 共 4 条 · 1014 字符
│ [0] system      ｜ 你是一个「主 Agent（Manager / 超级指挥者）」…
│ [1] user        ｜ 【用户报错】 TypeError: Cannot read properties of null (reading 'name') …
│ [2] assistant   → 决定调用 [delegate_task]，arguments={"task_type":"get_code_context",…}
│ [3] tool        ← tool_call_id=call_main_1 ｜ 【相关代码】16 | return user.name.trim(); …
└──────────────────────────────────────────────

──────────────── 主 Agent 最终诊断 ────────────────
[主 Agent] 🏁 模型停止调用工具，输出最终诊断（总耗时 2ms，共 2 轮）
## 诊断结论
renderUser 的入参可能为 null。
## 修复建议
1. 调用前判空
2. 入参类型改成 User | null 并强制检查
```

## 8. 工作原理（核心函数）

| 位置 | 作用 |
| --- | --- |
| `callDeepSeek(messages, tools)` | 统一 API 层。Node 18 原生 `fetch` + `AbortController` 60s 超时；主/子 Agent 共用 |
| `DELEGATE_TASK_TOOL` | 主 Agent **唯一**的工具 `delegate_task`，参数 `instruction` + `task_type` |
| `runMainAgent(userGoal)` | 主 Agent 的 `while` 循环（`MAX_TURNS` 防死循环），决定何时派活、何时收尾 |
| `runWorkerAgent(instruction)` | 子 Agent 独立循环：新建 `messages`、调本地工具、返回精炼结论 |
| `executeWorkerTool()` | 子 Agent 的本地工具实现：`get_surrounding_code` / `search_regex` |
| `dumpMessages()` | 打印 messages 快照，便于观察上下文如何增长 |
| `buildDiagnoseGoal()` | 收集报错文本（选区 → 诊断 → 手动输入） |

### Function Calling 协议要点

- 请求体：`{ model, messages, tools, tool_choice: 'auto', temperature, stream: false }`
- 模型返回 `tool_calls` 后，必须把 **assistant 消息原样回填**，再为每个 `tool_call` 补一条
  `{ role: 'tool', tool_call_id: <id>, content: <字符串> }`，否则下一轮直接 400；
- 子 Agent 的工具原始输出**永远**不会进入主 Agent 的 `messages`。

### 当前版本的工具能力（v0.1.0）

| 工具 | 归属 | 说明 |
| --- | --- | --- |
| `delegate_task` | 主 Agent | 派发自包含子任务，等待结论 |
| `get_surrounding_code` | 子 Agent | 读取当前文件指定行上下 N 行（默认 20，最多 60） |
| `search_regex` | 子 Agent | 在**当前文件**内正则搜索，返回行号与整行内容（最多 50 条） |

> 尚未打开任何文件时，`get_surrounding_code` / `search_regex` 使用内置模拟代码。

## 9. 成本、安全与限制

- **调用次数**：一次诊断通常 3～10 次 API 调用（取决于主/子循环轮数），可用 `mainMaxTurns` / `workerMaxTurns` 限制上限。
- **数据范围**：只把「你选中的报错」和「子 Agent 按指令读取的局部代码片段」发送给 DeepSeek，不扫描、不上传整个工程。
- **API Key**：保存在 VS Code 全局设置中（可用环境变量代替），不会写入项目文件。
- **当前限制**：`search_regex` 只在当前打开的文件里搜索；跨文件/全工作区搜索、流式输出、多子 Agent 并发属于后续版本。

## 10. 常见问题

| 问题 | 处理 |
| --- | --- |
| 提示「缺少 DeepSeek API Key」 | 执行 `报错上下文裁剪器: 设置 DeepSeek API Key`，或设置环境变量后重启 VS Code |
| 返回 401 / 402 | Key 错误或账户余额不足，检查 Key 与 DeepSeek 控制台余额 |
| 提示「请求超时」 | 默认 60s 超时；检查网络/代理，或稍后重试 |
| 一直看到 `[子 Agent]` 调用工具 | 子 Agent 在收集证据；达到 `workerMaxTurns` 会自动强制收尾 |
| 诊断没有引用我想要的代码 | 先选中报错再把光标放在出错行附近；子 Agent 默认读光标行上下 20 行 |
| 没有打开文件也能用吗 | 可以，会使用内置模拟代码演示完整流程 |
| 输出面板没弹出 | 执行命令后手动打开：**视图 → 输出**，下拉选择「报错上下文裁剪器」 |

## 11. 后续路线图

- [ ] 子 Agent 全工作区正则搜索（`workspace.findFiles` + 忽略规则）
- [ ] 流式输出（SSE）实时打印 token
- [ ] 主 Agent 一次派发多个子 Agent 并发执行
- [ ] 接入 VS Code 诊断/终端任务，自动获取真实错误堆栈
- [ ] token 用量统计与诊断结果一键复制

## 12. 许可证

[MIT](LICENSE) © 2026 Error Context Trimmer Authors

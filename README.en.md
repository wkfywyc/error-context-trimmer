# Error Context Trimmer

> A two-tier (Manager + Worker) agent that trims a huge code context down to a few pieces of evidence, then lets DeepSeek find the root cause of an error.

**中文**: [README.md](README.md)

- Requirements: VS Code **1.85+** (bundled Node 18 with native `fetch`, no axios)
- Model: DeepSeek **`deepseek-chat`** (OpenAI-compatible Function Calling)
- UI: none — every step is streamed live to the output channel **"报错上下文裁剪器"** (Error Context Trimmer)

---

## 1. What it does

You select an error message. A **Manager agent** decides which local pieces of code it needs, splits the work into sub-tasks, and delegates them to **Worker agents**. Each worker owns an isolated context, reads code / runs regex locally, and returns **only a short conclusion (≤ 200 chars)**. The manager keeps going until it can produce a final diagnosis.

Every step — who is thinking, who is executing, and what the `messages` arrays look like — is printed in real time via `outputChannel.appendLine`, so the whole orchestration is observable.

## 2. Why two tiers (context trimming)

A single agent reads raw code into its own `messages` and quickly blows up its context, while only a few lines usually matter. The two-tier design pushes the dirty work down:

```
error message
   │
   ▼
┌───────────────────────────────────────────────────┐
│ Manager agent                                     │
│ while (turn < mainMaxTurns)                       │
│   ├─ think: which piece of info am I missing?     │
│   ├─ delegate_task ───────────────────┐           │
│   │                                   │           │
│   │     ┌─────────────────────────────▼─────────┐ │
│   │     │ Worker agent: runWorkerAgent()        │ │
│   │     │ while (turn < workerMaxTurns)         │ │
│   │     │   ├─ get_surrounding_code (read code) │ │
│   │     │   ├─ search_regex (regex search)      │ │
│   │     │   └─ return a concise conclusion      │ │
│   │     └─────────────────────────────┬─────────┘ │
│   │  ◀── messages.push({role:'tool'}) ┘           │
│   └─ enough info? → final answer / else delegate  │
└───────────────────────────────────────────────────┘
```

- A worker's `messages` is a **local array**: it is garbage-collected on return and never pollutes the manager.
- The manager grows by **exactly one** `role: 'tool'` message per sub-task (the worker's conclusion).
- So the manager's context grows as `O(tasks × conclusion length)`, not `O(all code read)`.

## 3. Project layout

```
error-context-trimmer/
├─ package.json          # extension manifest: commands, settings, entry point
├─ extension.js          # core implementation (heavily commented)
├─ README.md             # Chinese usage guide
├─ README.en.md          # English usage guide (this file)
├─ LICENSE               # MIT
├─ .gitignore
└─ .vscode/launch.json   # F5 debug configuration
```

## 4. Install & run

### Option A — run from source (recommended for now)

1. Install VS Code **1.85+** (it bundles Node 18, required for native `fetch`).
2. **File → Open Folder…** and choose the project root (the folder containing `package.json`).
3. Press **F5**. A new Extension Development Host window opens.
4. Set your API key (section 5), then follow section 6.

> The debug configuration is already in `.vscode/launch.json`. If VS Code asks for a debugger, pick **VS Code Extension Development**.

### Option B — package as VSIX (optional)

Requires Node.js / npm:

```bash
npx @vscode/vsce package
code --install-extension error-context-trimmer-0.1.0.vsix
```

`publisher` is currently the placeholder `local-dev`; change it in `package.json` before publishing to the Marketplace.

## 5. Configuration

You must configure a DeepSeek API key first (three options, highest priority first):

| Option | How |
| --- | --- |
| ① Extension setting | Command Palette → **`报错上下文裁剪器: 设置 DeepSeek API Key`** (or `Ctrl+,` and search `errorContextTrimmer.apiKey`) |
| ② Environment variable | Set `DEEPSEEK_API_KEY=sk-xxxx`, then restart VS Code |
| ③ settings.json | `"errorContextTrimmer.apiKey": "sk-xxxx"` |

All settings:

| Setting | Default | Description |
| --- | --- | --- |
| `errorContextTrimmer.apiKey` | `""` | DeepSeek API key, starting with `sk-` |
| `errorContextTrimmer.model` | `deepseek-chat` | Model name. Use `deepseek-chat` for Function Calling |
| `errorContextTrimmer.mainMaxTurns` | `8` | Max loop turns for the manager (anti-infinite-loop) |
| `errorContextTrimmer.workerMaxTurns` | `5` | Max loop turns per worker (anti-infinite-loop) |

> When the turn limit is hit, tools are disabled and the model is forced to produce a conclusion — no infinite loops.

## 6. Usage

1. Open the source file that is failing.
2. Select the error text (stack trace from the terminal / browser console).
3. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

   ```
   报错上下文裁剪器: 诊断当前报错（双层 Agent）
   ```

   Error input priority:

   | Priority | Source |
   | --- | --- |
   | ① | **Selected text** in the editor |
   | ② | **Error diagnostics** of the active file (red squiggles, up to 5) |
   | ③ | An input box to **paste** the error manually |

4. A "双层 Agent 诊断中…" progress notification appears; you get a toast when it finishes.
5. Open **View → Output**, choose **"报错上下文裁剪器"** from the dropdown to see the full trace and the final diagnosis.

> It also runs with no file open: a built-in mock source (`mock/demo.ts`) is used so you can try the whole flow immediately.

## 7. Reading the output channel

Every line carries a prefix, so you can always tell who is talking:

| Prefix | Meaning |
| --- | --- |
| `[系统]` | Framework logs: startup, model info, network errors |
| `[主 Agent]` | Manager: thinking, delegating, final diagnosis |
| `[子 Agent #n]` | Worker #n: tool calls and returned conclusions |
| `messages snapshot` | After each turn: the manager's context array summary and char count |

Real log excerpt:

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
```

> Note: the extension's command titles and log lines are currently in Chinese.

## 8. How it works (core functions)

| Where | Purpose |
| --- | --- |
| `callDeepSeek(messages, tools)` | Shared API layer. Native `fetch` + 60 s `AbortController` timeout; used by both tiers |
| `DELEGATE_TASK_TOOL` | The manager's **only** tool: `delegate_task(instruction, task_type)` |
| `runMainAgent(userGoal)` | Manager `while` loop (`MAX_TURNS` guard): decides when to delegate and when to answer |
| `runWorkerAgent(instruction)` | Worker loop: fresh `messages`, local tools, returns one concise conclusion |
| `executeWorkerTool()` | Worker tool implementations: `get_surrounding_code` / `search_regex` |
| `dumpMessages()` | Prints the `messages` snapshot after each turn |
| `buildDiagnoseGoal()` | Collects the error text (selection → diagnostics → manual input) |

### Function Calling protocol notes

- Request body: `{ model, messages, tools, tool_choice: 'auto', temperature, stream: false }`
- After a `tool_calls` response you **must** push the assistant message back verbatim, then answer
  every call with `{ role: 'tool', tool_call_id: <id>, content: <string> }` — otherwise the next request fails with HTTP 400.
- Worker tool output **never** enters the manager's `messages`.

### Tools in v0.1.0

| Tool | Owner | Description |
| --- | --- | --- |
| `delegate_task` | Manager | Delegates a self-contained sub-task and waits for the conclusion |
| `get_surrounding_code` | Worker | Reads ±N lines around a line of the active file (default 20, max 60) |
| `search_regex` | Worker | Regex search inside the **active file**, returns line numbers and line content (max 50) |

> With no file open, the two worker tools fall back to the built-in mock source.

## 9. Cost, privacy & limitations

- **API calls**: a diagnosis typically costs 3–10 calls (depending on loop turns); cap them with `mainMaxTurns` / `workerMaxTurns`.
- **Data scope**: only the selected error text and the local snippets workers were told to read are sent to DeepSeek — no full-workspace upload.
- **API key**: stored in VS Code global settings (or an environment variable), never written into the project.
- **Current limits**: `search_regex` only searches the active file; cross-file search, streaming output and concurrent workers are planned.

## 10. FAQ

| Problem | Fix |
| --- | --- |
| "Missing DeepSeek API Key" | Run `报错上下文裁剪器: 设置 DeepSeek API Key`, or set the env var and restart VS Code |
| HTTP 401 / 402 | Invalid key or insufficient balance — check the key and your DeepSeek console |
| "Request timed out" | 60 s timeout; check network/proxy and retry |
| Workers keep calling tools | They are gathering evidence; `workerMaxTurns` forces a conclusion |
| Diagnosis ignores the code I expected | Select the error text and put the cursor near the failing line; workers read ±20 lines around it |
| Can I run it with no file open? | Yes — the built-in mock source demonstrates the full flow |
| Output panel didn't open | Open **View → Output** and pick "报错上下文裁剪器" |

## 11. Roadmap

- [ ] Workspace-wide regex search for workers (`workspace.findFiles` + ignore rules)
- [ ] Streaming output (SSE) with live tokens
- [ ] Concurrent workers from a single manager turn
- [ ] Integrate VS Code diagnostics / terminal tasks for real stack traces
- [ ] Token accounting and one-click copy of the diagnosis

## 12. License

[MIT](LICENSE) © 2026 Error Context Trimmer Authors

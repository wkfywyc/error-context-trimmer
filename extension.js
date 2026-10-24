/**
 * ============================================================================
 *  报错上下文裁剪器 · 双层 Agent 骨架（Manager + Worker）  v0.1
 * ============================================================================
 *
 *  【这个插件在干什么】
 *  用户选中一段报错 → 主 Agent 思考「我需要哪些局部代码证据」→ 派发子任务给子 Agent
 *  → 子 Agent 去读代码 / 正则搜索 → 只把 200 字以内的结论回传 → 主 Agent 汇总成诊断。
 *  全过程用 outputChannel 实时打印，能清楚看到是谁在说话。
 *
 *  【架构图】
 *
 *         用户报错（选中文本 / 当前文件的红色波浪线 / 手输）
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────┐
 *   │ 主 Agent（Manager，超级指挥者）                        │
 *   │  while (turn < MAX_TURNS)                             │
 *   │    ├─ 思考：我现在缺哪一块信息？                        │
 *   │    ├─ 调用工具 delegate_task ───────────────────┐      │
 *   │    │                                            │      │
 *   │    │      ┌─────────────────────────────────────▼───┐  │
 *   │    │      │ 子 Agent（Worker）runWorkerAgent()       │  │
 *   │    │      │  while (turn < WORKER_MAX_TURNS)         │  │
 *   │    │      │    ├─ get_surrounding_code（读局部代码）  │  │
 *   │    │      │    ├─ search_regex（正则搜索）            │  │
 *   │    │      │    └─ 只返回【精炼结论】                   │  │
 *   │    │      └─────────────────────────────────────┬───┘  │
 *   │    │  ◀─── messages.push({ role:'tool', ... }) ─┘      │
 *   │    └─ 信息够了？→ 输出最终诊断 / 还不够？→ 再派一单       │
 *   └──────────────────────────────────────────────────────┘
 *
 *  【核心思想：上下文裁剪（为什么必须分两层）】
 *  单层 Agent 的痛点是：它读进来的原始代码全部堆在自己的 messages 里，几十轮下来
 *  上下文直接爆炸，且真正有用的往往只有 5 行。双层架构把「脏活」下放：
 *    - 子 Agent 的 messages 里可以有大量工具原始输出；但它是一个【局部变量】，
 *      函数一返回就随 GC 消失，永远不会污染主 Agent。
 *    - 主 Agent 的 messages 里只会多出「一条 tool 消息 = 子 Agent 的结论」。
 *  于是主 Agent 的上下文增长是 O(任务数 × 结论长度)，而不是 O(读过的全部代码量)。
 *
 *  【messages 数组的流转（重点，代码里会反复标注）】
 *  1. 主 Agent 每次请求 DeepSeek 时发送的是【主 messages 数组】：
 *        [system(角色), user(报错), assistant(决定派活), tool(子 Agent 结论), ...]
 *  2. 主 Agent 的 assistant 消息里带 tool_calls=[delegate_task]，API 要求我们必须
 *     补一条 role:'tool'、tool_call_id 完全匹配的消息，否则下一轮直接 400。
 *  3. 子 Agent 内部完全独立地维护【它自己的 messages 数组】：
 *        [system(Worker 角色), user(instruction), assistant(调工具), tool(工具结果), ...]
 *     两个数组之间【没有任何对象引用共享】，唯一的桥就是 runWorkerAgent 的返回值。
 *  4. 因此子 Agent 的 instruction 必须自包含（它看不到主 Agent 说过什么），
 *     而主 Agent 拿到结论后，也只能靠结论本身继续推理。
 *
 *  【Function Calling 格式（DeepSeek 兼容 OpenAI）】
 *  请求：{ model, messages, tools, tool_choice:'auto', temperature, stream:false }
 *  响应：choices[0].message = { role:'assistant', content, tool_calls:[...] }
 *  工具结果：{ role:'tool', tool_call_id:<call.id>, content:'字符串结果' }
 *
 *  运行环境：Node 18+（原生 fetch / AbortController，无需 axios）
 * ============================================================================
 */

'use strict';

const vscode = require('vscode');

// ============================================================================
// ██ 一、全局常量：所有「魔法数字」集中在这里，改行为只改这一块
// ============================================================================

/** DeepSeek 的 Chat Completions 端点（与 OpenAI 完全兼容） */
const API_URL = 'https://api.deepseek.com/chat/completions';

/** 默认模型。注意：Function Calling 请用 deepseek-chat，不要用推理模型 */
const DEFAULT_MODEL = 'deepseek-chat';

/** 主 Agent 最大循环轮数（防死循环，对应需求里的 MAX_TURNS） */
const DEFAULT_MAIN_MAX_TURNS = 8;

/** 单个子 Agent 最大循环轮数（它自己也会多轮调用工具，同样要设上限） */
const DEFAULT_WORKER_MAX_TURNS = 5;

/** 单次 HTTP 请求超时（毫秒）。超时后 AbortController 会中断 fetch */
const API_TIMEOUT_MS = 60_000;

/** 单条工具结果的字符上限：防止子 Agent 的上下文被子 Agent 自己的工具撑爆 */
const MAX_TOOL_RESULT_CHARS = 4000;

// ============================================================================
// ██ 二、OutputChannel 日志：所有流转都打印在这里（不需要任何 UI）
// ============================================================================

/** 全局唯一的输出面板。activate 时创建，deactivate 时销毁 */
let outputChannel = null;

/** 子 Agent 自增编号，只用于日志区分「这是第几个 Worker 在干活」 */
let workerSeq = 0;

/** 懒创建输出面板（所有日志函数都先调它） */
function ensureChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('报错上下文裁剪器');
  }
  return outputChannel;
}

function logRaw(line) {
  ensureChannel().appendLine(line);
}

/** 主 Agent 的独白专用前缀，一眼区分「谁在说话」 */
function logMain(text) {
  logRaw(`[主 Agent] ${text}`);
}

/** 子 Agent 的日志，带 workerId 区分是第几个 Worker */
function logWorker(workerId, text) {
  logRaw(`[子 Agent #${workerId}] ${text}`);
}

/** 框架/系统级日志（网络、命令入口等） */
function logSys(text) {
  logRaw(`[系统] ${text}`);
}

/** 打印一条分隔线，让 OutputChannel 里的每一轮结构清晰 */
function logDivider(title) {
  logRaw('');
  logRaw(`──────────────── ${title} ────────────────`);
}

/** 把任意文本压成一行并截断，用于日志预览（不污染真正发给 API 的内容） */
function clip(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 估算一段 JSON 有多少字符，用来直观展示「主 Agent 的上下文有多大」 */
function charCount(obj) {
  try {
    return JSON.stringify(obj).length;
  } catch (e) {
    return 0;
  }
}

/** 超长工具结果截断（子 Agent 的工具返回值统一过这里） */
function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n……（结果已截断，原始长度 ${s.length} 字）`;
}

// ============================================================================
// ██ 三、配置读取（package.json 里 contributed 的 4 个设置项）
// ============================================================================

function getConfig() {
  return vscode.workspace.getConfiguration('errorContextTrimmer');
}

/** 读取数字型配置，非法值回落到默认值 */
function getNumberSetting(key, fallback) {
  const value = getConfig().get(key);
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

/** API Key 优先级：插件设置 > 环境变量 DEEPSEEK_API_KEY */
function getApiKey() {
  const fromSetting = String(getConfig().get('apiKey') || '').trim();
  if (fromSetting) return fromSetting;
  return String(process.env.DEEPSEEK_API_KEY || '').trim();
}

// ============================================================================
// ██ 四、DeepSeek API 调用层（主 Agent 和子 Agent 共用同一个函数）
// ============================================================================
//
//  注意：主 Agent 和子 Agent 调的是【同一个 API、同一个函数】，区别只在于：
//    - 传进去的 messages 数组不同（各自独立）
//    - 传进去的 tools 不同（主 Agent 只有 delegate_task；子 Agent 只有本地工具）
//  这个函数本身是无状态的，每次调用都是一次「纯函数式」的 HTTP 往返。
//
// ============================================================================
async function callDeepSeek(messages, tools) {
  if (typeof fetch !== 'function') {
    throw new Error('当前运行环境没有原生 fetch，请把 VS Code 升级到 1.85+（内置 Node 18）');
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('缺少 DeepSeek API Key。请执行命令「报错上下文裁剪器: 设置 DeepSeek API Key」，或设置环境变量 DEEPSEEK_API_KEY');
  }

  const model = String(getConfig().get('model') || DEFAULT_MODEL);

  // ---- 组装请求体：DeepSeek 的 Function Calling 就是标准 OpenAI 格式 ----
  const body = {
    model,
    messages,           // ← 谁调用就传谁的 messages 数组，天然隔离
    temperature: 0.2,   // 诊断场景要稳定，温度调低
    stream: false,      // 骨架阶段先用非流式，逻辑最清晰
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto'; // 让模型自己决定「这轮是否调用工具」
  }

  // ---- 超时控制：Node 18 原生 AbortController ----
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`DeepSeek 请求超时（超过 ${API_TIMEOUT_MS}ms）`);
    }
    throw new Error(`网络请求失败：${err && err.message ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    throw new Error(`DeepSeek API 返回 ${response.status}：${raw.slice(0, 300)}`);
  }

  const json = await response.json();
  const message = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!message) {
    throw new Error(`DeepSeek 返回格式异常：${JSON.stringify(json).slice(0, 300)}`);
  }
  return message;
}

// ============================================================================
// ██ 五、assistant 消息回填：把模型回复「原样」塞回 messages 的正确姿势
// ============================================================================
//
//  这是 Function Calling 最容易踩的坑，务必看懂：
//
//  模型这一轮返回了 tool_calls，我们【必须】把这条 assistant 消息原封不动 push 回
//  messages，然后再为每一个 tool_call 补一条 role:'tool' 的响应消息。
//  如果你偷懒只 push tool 消息而不 push assistant(tool_calls)，下一轮 API 会报
//  "tool_call_id not found" 或 400。
//
//  这里做一层「净化」：只保留协议要求的字段（role/content/tool_calls），
//  避免以后换模型（比如带 reasoning_content 的模型）时把非法字段传回去。
//
// ============================================================================
function assistantMessageForReplay(message) {
  const out = {
    role: 'assistant',
    // 只调工具不说话的轮次，content 可能是 null；统一转成空字符串最稳
    content: message.content == null ? '' : String(message.content),
  };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    out.tool_calls = message.tool_calls;
  }
  return out;
}

// ============================================================================
// ██ 六、工具定义（Function Calling 的 schema）
// ============================================================================

// ----------------------------------------------------------------------------
// 6.1 主 Agent 唯一的工具：delegate_task
// ----------------------------------------------------------------------------
//  这就是「双层架构」的入口。主 Agent 没有任何读写文件的能力，
//  它想获取信息，唯一的途径就是调用这个工具，把任务派给子 Agent。
//
//  description 写得越清楚，模型越不会乱派任务 / 越会把 instruction 写完整。
// ----------------------------------------------------------------------------
const DELEGATE_TASK_TOOL = {
  type: 'function',
  function: {
    name: 'delegate_task',
    description: [
      '把一条【自包含】的子任务派发给子 Agent（Worker）执行，并等待它返回精炼结论。',
      '子 Agent 能做的事：读取指定行号附近的代码片段、在当前文件里做正则搜索。',
      '关键：子 Agent 看不到你的对话历史，所以 instruction 必须独立说清要查什么、在哪查、判断标准是什么。',
      '子 Agent 只返回简短结论，不会把原始文件内容给你；信息不够就再派一个新任务。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: '给子 Agent 的完整指令。建议包含：目标、文件/行号范围、要找的具体符号或模式、期望的结论格式。',
        },
        task_type: {
          type: 'string',
          enum: ['get_code_context', 'search_pattern', 'analyze_error'],
          description: '任务类型，方便日志归类：取代码上下文 / 正则搜索 / 结合报错做局部分析。',
        },
      },
      required: ['instruction', 'task_type'],
    },
  },
};

// ----------------------------------------------------------------------------
// 6.2 子 Agent 的工具：真正干脏活的本地工具
// ----------------------------------------------------------------------------
//  注意这里只是「最简模拟版」：
//    - get_surrounding_code 读的是「当前打开的文件」，没打开就用内置 mock 代码；
//    - search_regex 只在当前文件里搜，没有做跨文件搜索。
//  后续你可以把 search_regex 换成 workspace.findFiles + 正则遍历整个工程。
//  因为子 Agent 的原始输出不会被回传给主 Agent，所以这里返回多一点也不怕。
// ----------------------------------------------------------------------------
const WORKER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_surrounding_code',
      description: '读取当前文件指定行号上下各 N 行的代码（默认 N=20），返回带行号的文本。',
      parameters: {
        type: 'object',
        properties: {
          line: { type: 'number', description: '目标行号，从 1 开始。不传则使用当前光标所在行。' },
          radius: { type: 'number', description: '上下各取多少行，默认 20，最大 60。' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_regex',
      description: '在当前文件中用正则表达式搜索，返回命中的行号与整行内容。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript 正则表达式源码（不要带两侧斜杠），例如 "user\\.name" 。' },
          max_results: { type: 'number', description: '最多返回多少条命中，默认 10，最大 50。' },
        },
        required: ['pattern'],
      },
    },
  },
];

// ============================================================================
// ██ 七、System Prompt：把「角色边界」写死
// ============================================================================
//
//  System Prompt 是整条链路里最便宜的「约束」。主 Agent 和子 Agent 各有一份，
//  它们不会看到彼此的 system prompt —— 这正是隔离的基础。
//
// ============================================================================

/** 主 Agent 的角色设定：只思考、只派活、只汇总 */
const MAIN_SYSTEM_PROMPT = `你是一个「主 Agent（Manager / 超级指挥者）」，负责诊断用户遇到的代码报错。

【铁律】
1. 你没有读取文件、搜索代码的能力。你唯一的工具是 delegate_task（派任务给子 Agent）。
2. 每轮先想清楚：要定位这个报错，我现在缺哪一块信息？然后把这一块拆成一个明确的子任务。
3. 子 Agent 只会给你简短结论，不会给你原始文件。信息不够时，就再派一个新任务，不要凭空猜测。
4. 子 Agent 对你来说是无状态的：它看不到你之前派过什么任务。所以每条 instruction 都必须自包含。
5. 一旦你判断信息足够了，立刻停止调用工具，直接输出最终诊断。

【最终诊断输出格式（不再调用工具时）】
## 诊断结论
一句话说明根因。
## 直接原因
结合子 Agent 找到的代码证据，说明为什么会在那一行出错。
## 修复建议
1. 具体改法（能引用代码片段最好）
2. ……
## 置信度
高 / 中 / 低 + 一句话理由`;

/** 子 Agent 的角色设定：只干活、只回结论 */
const WORKER_SYSTEM_PROMPT = `你是一个「子 Agent（Worker）」，只负责执行主 Agent 派给你的一个具体子任务。

【铁律】
1. 你的可用工具只能看到代码的局部片段（这是刻意的上下文裁剪，你不需要看整个工程）。
2. 只调用必要次数的工具，不要重复调用同一个工具；信息够了就立刻停止。
3. 你看不到主 Agent 的对话，也不要假设主 Agent 知道什么。
4. 你中间调用工具的所有原始输出都不会回传给主 Agent —— 只有你的最终结论会。
   所以你必须把关键信息（代码片段、行号、命中结果）压缩进最终结论。

【最终结论格式（不超过 200 字，不再调用工具时输出）】
【相关代码】关键代码片段（最多 10 行，带行号）
【可疑点】最可能的出错原因 1-3 条
【证据】你依据的行号 / 搜索命中结果`;

// ============================================================================
// ██ 八、源码读取：当前编辑器 or 内置 mock 代码
// ============================================================================

/** 没有打开任何文件时使用的模拟代码（让插件开箱即跑，不依赖工作区） */
const MOCK_LINES = [
  '// mock/demo.ts —— 没有打开编辑器时的内置示例代码',
  'interface User {',
  '  id: number;',
  '  name: string;',
  '}',
  '',
  'export async function getUser(id: number): Promise<User> {',
  '  const res = await fetch(`/api/user/${id}`);',
  '  if (!res.ok) {',
  '    throw new Error("HTTP " + res.status);',
  '  }',
  '  const data = await res.json();',
  '  return data.user;            // ← 注意：接口不保证 user 一定存在',
  '}',
  '',
  'export function renderUser(user: User) {',
  '  return user.name.trim();     // ← 报错行：user 为 null/undefined 时读取 name',
  '}',
];

/** 模拟代码的「光标行」（0 基），对应第 17 行 */
const MOCK_CURSOR_LINE = 16;

/**
 * 读取当前上下文源码。
 * 有打开的编辑器就读真实文件；没有就用 MOCK_LINES，保证第一次点命令也能跑通全流程。
 */
function readCurrentSource() {
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.document.isUntitled) {
    return {
      fileName: vscode.workspace.asRelativePath(editor.document.uri, false),
      lines: editor.document.getText().split(/\r?\n/),
      cursorLine: editor.selection.active.line, // 0 基
      isMock: false,
    };
  }
  return {
    fileName: 'mock/demo.ts（当前没有打开任何文件，使用内置模拟代码）',
    lines: MOCK_LINES,
    cursorLine: MOCK_CURSOR_LINE,
    isMock: true,
  };
}

// ============================================================================
// ██ 九、子 Agent 的本地工具实现
// ============================================================================

/** get_surrounding_code 的实现：切出 [line-radius, line+radius] 的代码并加行号 */
function toolGetSurroundingCode(args) {
  const src = readCurrentSource();
  const total = src.lines.length;

  // 解析参数（模型给的参数永远不可信，全部做兜底和夹紧）
  const radiusRaw = Number(args.radius);
  const radius = Number.isFinite(radiusRaw)
    ? Math.min(Math.max(Math.floor(radiusRaw), 1), 60)
    : 20;

  let lineNo = Number(args.line);
  if (!Number.isFinite(lineNo) || lineNo <= 0) lineNo = src.cursorLine + 1; // 转成 1 基
  lineNo = Math.min(Math.max(1, Math.floor(lineNo)), total);

  const start = Math.max(1, lineNo - radius);
  const end = Math.min(total, lineNo + radius);
  const width = String(end).length;

  const body = [];
  for (let i = start; i <= end; i += 1) {
    const marker = i === lineNo ? '>>' : '  '; // >> 标记目标行，方便模型定位
    body.push(`${marker} ${String(i).padStart(width, ' ')} | ${src.lines[i - 1]}`);
  }

  return [
    `【文件】${src.fileName}（共 ${total} 行）`,
    `【范围】第 ${start}-${end} 行；目标行 ${lineNo} 用 >> 标记`,
    ...body,
  ].join('\n');
}

/** search_regex 的实现：在当前文件里逐行跑正则 */
function toolSearchRegex(args) {
  const src = readCurrentSource();
  const pattern = String(args.pattern == null ? '' : args.pattern);
  if (!pattern) return '【参数错误】pattern 不能为空';

  const maxRaw = Number(args.max_results);
  const maxResults = Number.isFinite(maxRaw) ? Math.min(Math.max(Math.floor(maxRaw), 1), 50) : 10;

  let regex;
  try {
    regex = new RegExp(pattern, 'g');
  } catch (err) {
    return `【正则非法】${err.message}`;
  }

  const hits = [];
  for (let i = 0; i < src.lines.length && hits.length < maxResults; i += 1) {
    const line = src.lines[i];
    regex.lastIndex = 0; // 全局正则复用前必须重置 lastIndex
    const matched = regex.exec(line);
    if (matched) {
      hits.push(`L${i + 1} 「${clip(matched[0], 60)}」 → ${clip(line, 120)}`);
    }
  }

  const header = `【文件】${src.fileName}（共 ${src.lines.length} 行）\n【正则】/${pattern}/g`;
  if (hits.length === 0) return `${header}\n【结果】0 命中`;
  return `${header}\n【结果】命中 ${hits.length} 条：\n${hits.join('\n')}`;
}

/**
 * 子 Agent 的工具分发器。
 * 执行完以后把结果转成字符串——因为 role:'tool' 消息的 content 必须是字符串。
 */
function executeWorkerTool(call, workerId) {
  const name = call && call.function ? call.function.name : 'unknown';
  const rawArgs = call && call.function && call.function.arguments ? call.function.arguments : '{}';

  let args = {};
  try {
    args = JSON.parse(rawArgs);
  } catch (err) {
    // 模型偶尔会吐出非法 JSON，直接把错误喂回去让它自己修
    logWorker(workerId, `⚠️ 工具参数不是合法 JSON：${clip(rawArgs, 100)}`);
    return `【工具参数解析失败】${rawArgs.slice(0, 200)}`;
  }

  logWorker(workerId, `🔧 调用工具 ${name}(${clip(rawArgs, 120)})`);

  let result;
  switch (name) {
    case 'get_surrounding_code':
      result = toolGetSurroundingCode(args);
      break;
    case 'search_regex':
      result = toolSearchRegex(args);
      break;
    default:
      result = `【未知工具】${name}`;
  }

  result = truncate(result, MAX_TOOL_RESULT_CHARS);
  logWorker(workerId, `📄 工具返回 ${result.length} 字，预览：${clip(result, 100)}`);
  return result;
}

// ============================================================================
// ██ 十、子 Agent：runWorkerAgent(instruction)
// ============================================================================
//
//  ★★★ 这是全篇最关键的地方：一个子 Agent 就是「一个独立的 while 循环 + 一个独立的
//  messages 数组」。它接收一句 instruction 作为 user 消息，在里面自问自答若干轮，
//  最后 return 一个字符串。这个字符串回去之后，会变成主 Agent messages 里的一条
//  role:'tool' 消息。
//
//  主 messages 数组  ──(trigger)──▶  runWorkerAgent(instruction)
//                                          │
//                                          ├─ 新建 workerMessages = [system, user]
//                                          ├─ while: 调 API → 调本地工具 → 塞结果
//                                          └─ return 精炼结论
//  主 messages 数组  ◀──(结论字符串)────────┘   其余全部丢弃（这就是裁剪）
//
// ============================================================================
async function runWorkerAgent(instruction) {
  const workerId = ++workerSeq;
  const maxTurns = getNumberSetting('workerMaxTurns', DEFAULT_WORKER_MAX_TURNS);
  const startedAt = Date.now();

  logDivider(`子 Agent #${workerId} 启动`);
  logWorker(workerId, `📥 主 Agent 派来的任务：${clip(instruction, 300)}`);

  // ------------------------------------------------------------------------
  // 【子 Agent 的独立上下文】
  // 这个数组和主 Agent 的 messages 没有任何共享引用，是纯粹的新数组。
  // 它只认识两件事：自己是谁（system）、这次要干什么（user=instruction）。
  // ------------------------------------------------------------------------
  const messages = [
    { role: 'system', content: WORKER_SYSTEM_PROMPT },
    { role: 'user', content: instruction },
  ];
  logWorker(workerId, '🧠 已创建独立上下文：messages[0]=system(Worker 角色)，messages[1]=user(任务)');
  logWorker(workerId, '   主 Agent 的对话历史没有传进来，所以 instruction 必须自包含');

  let turn = 0;
  // ★ 子 Agent 自己的防死循环 while 循环
  while (turn < maxTurns) {
    turn += 1;
    logWorker(workerId, `— 第 ${turn}/${maxTurns} 轮：请求 DeepSeek（携带 ${messages.length} 条消息、2 个本地工具）`);

    let message;
    try {
      message = await callDeepSeek(messages, WORKER_TOOLS);
    } catch (err) {
      logWorker(workerId, `❌ API 失败：${err.message}`);
      // 子 Agent 失败不应该炸掉主 Agent：把错误当成「一条结论」回传，让主 Agent 决定下一步
      return `【子 Agent 执行失败】${err.message}`;
    }

    // ① 先把 assistant 消息回填（带 tool_calls 的原样回填，这是协议要求）
    messages.push(assistantMessageForReplay(message));

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    // ② 没有工具调用 = 模型认为任务完成 → 这就是最终结论
    if (toolCalls.length === 0) {
      const conclusion = String(message.content || '').trim() || '（子 Agent 没有返回内容）';
      const cost = Date.now() - startedAt;
      logWorker(workerId, `✅ 停止调用工具，产出结论（${conclusion.length} 字，耗时 ${cost}ms）`);
      logWorker(workerId, `↩️ 回传给主 Agent 的【只有这段文字】，本循环里累积的 ${messages.length} 条消息全部丢弃`);
      logWorker(workerId, `──── 结论原文 ────\n${conclusion}\n────────────────`);
      return conclusion;
    }

    // ③ 有工具调用 → 逐个执行，并把结果作为 role:'tool' 消息塞回去
    logWorker(workerId, `🧰 模型决定调用 ${toolCalls.length} 个工具`);
    for (const call of toolCalls) {
      const toolResult = executeWorkerTool(call, workerId);
      // tool_call_id 必须和 assistant.tool_calls[].id 完全一致，否则下一轮 400
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolResult,
      });
      logWorker(workerId, `📥 工具结果写入 messages[${messages.length - 1}]（此时 worker 上下文共 ${messages.length} 条）`);
    }
  }

  // ------------------------------------------------------------------------
  // 【兜底】子 Agent 也撞到轮数上限了。
  // 做法：把 tools 传空，逼它只能输出文字（模型没有工具可调，只能给结论）。
  // ------------------------------------------------------------------------
  logWorker(workerId, `⚠️ 已达到最大轮数 ${maxTurns}，强制收尾`);
  try {
    const forced = await callDeepSeek(
      [
        ...messages,
        { role: 'user', content: '【系统】已达到最大轮数，禁止再调用任何工具，请立刻输出最终结论。' },
      ],
      [],
    );
    const conclusion = String(forced.content || '').trim() || '（子 Agent 达到轮数上限且无结论）';
    logWorker(workerId, `↩️ 强制收尾结论（${conclusion.length} 字）`);
    return conclusion;
  } catch (err) {
    logWorker(workerId, `❌ 强制收尾失败：${err.message}`);
    return `【子 Agent 达到轮数上限且收尾失败】${err.message}`;
  }
}

// ============================================================================
// ██ 十一、主 Agent：runMainAgent(userGoal)
// ============================================================================
//
//  主 Agent 不读文件、不搜索。它唯一能做的事：
//    1. 把用户报错放进 messages[1]；
//    2. while 循环里让模型决定「这一轮要不要派活」；
//    3. 派活 → 子 Agent 干活 → 结论变成一条 tool 消息回到 messages；
//    4. 模型说「不派了」→ 输出最终诊断。
//
//  注意主 Agent 的 messages 永远不会包含子 Agent 的工具原始输出，
//  只会包含子 Agent 的最终结论 —— 这就是「上下文裁剪器」的核心。
//
// ============================================================================
async function runMainAgent(userGoal) {
  const maxTurns = getNumberSetting('mainMaxTurns', DEFAULT_MAIN_MAX_TURNS);
  const startedAt = Date.now();

  const messages = [
    { role: 'system', content: MAIN_SYSTEM_PROMPT },
    { role: 'user', content: userGoal },
  ];

  logMain('🎯 主 Agent 启动，目标已写入 messages[1]');
  logMain(`🧠 初始上下文：messages 共 ${messages.length} 条（${charCount(messages)} 字符）`);
  logMain('   主 Agent 没有任何文件读取工具，它想拿信息只能派活给子 Agent');

  let turn = 0;
  // ★ 主 Agent 的防死循环 while 循环（需求里要求的 MAX_TURNS 就在这里）
  while (turn < maxTurns) {
    turn += 1;
    logDivider(`主 Agent 第 ${turn}/${maxTurns} 轮 · 思考中`);
    logMain(`📤 发送 messages（${messages.length} 条 / ${charCount(messages)} 字符），可用工具：delegate_task`);

    let message;
    try {
      message = await callDeepSeek(messages, [DELEGATE_TASK_TOOL]);
    } catch (err) {
      logMain(`❌ API 调用失败：${err.message}`);
      throw err; // 交给命令入口统一提示用户（比如 Key 没配）
    }

    // ① 回填 assistant 消息（有 tool_calls 时必须原样回填）
    messages.push(assistantMessageForReplay(message));
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    // ② 没有工具调用 = 模型认为可以下结论了 → 这就是最终诊断
    if (toolCalls.length === 0) {
      const finalAnswer = String(message.content || '').trim();
      const cost = Date.now() - startedAt;
      logDivider('主 Agent 最终诊断');
      logMain(`🏁 模型停止调用工具，输出最终诊断（总耗时 ${cost}ms，共 ${turn} 轮）`);
      logRaw(finalAnswer);
      logRaw('');
      logMain(`📊 全程主 Agent 上下文只增长到 ${messages.length} 条消息（${charCount(messages)} 字符），子 Agent 的中间过程一条都没进来`);
      return finalAnswer;
    }

    if (message.content) {
      logMain(`💭 主 Agent 的自言自语：${clip(message.content, 200)}`);
    }

    // ③ 逐个处理工具调用：每一个 delegate_task 都会真正启动一个子 Agent
    for (const call of toolCalls) {
      if (!call.function || call.function.name !== 'delegate_task') {
        // 理论上不会发生（主 Agent 只有一个工具），但协议要求必须回一条 tool 消息
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `【未知工具】只能用 delegate_task`,
        });
        continue;
      }

      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch (err) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: '【参数解析失败】instruction 必须是合法 JSON 字符串',
        });
        continue;
      }

      const taskType = args.task_type || 'unknown';
      const instruction = String(args.instruction || '').trim();

      logMain(`📋 [${taskType}] 决定派发任务：${clip(instruction, 300)}`);

      // ------------------ 关键调用：进入子 Agent 的世界 ------------------
      const conclusion = await runWorkerAgent(instruction);
      // ------------------------------------------------------------------

      // 子 Agent 的返回值 → 变成主 Agent messages 里的一条 tool 消息
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: conclusion,
      });
      const idx = messages.length - 1;
      logMain(`📥 子 Agent 结论已写入 messages[${idx}]（${conclusion.length} 字）`);
      logMain('   ↳ 主 Agent 的上下文只增加了这【一条】结论，子 Agent 内部几十条工具消息没有进来');
    }

    // 每轮结束 dump 一次主上下文，方便你在 OutputChannel 里肉眼观察数组增长
    dumpMessages(messages, `主 Agent 第 ${turn} 轮结束`);
    logMain(`第 ${turn} 轮结束：messages 共 ${messages.length} 条 / ${charCount(messages)} 字符`);
  }

  // ------------------------------------------------------------------------
  // 【兜底】主 Agent 撞到 MAX_TURNS 还没给出结论。
  // 把 tools 传空，逼它基于已有结论直接收尾，避免死循环。
  // ------------------------------------------------------------------------
  logMain(`⚠️ 已达到最大轮数 ${maxTurns}，强制收尾（关闭工具）`);
  const forced = await callDeepSeek(
    [
      ...messages,
      { role: 'user', content: '【系统】已达到最大轮数，禁止再调用任何工具，请立刻基于目前掌握的信息输出最终诊断。' },
    ],
    [],
  );
  const finalAnswer = String(forced.content || '').trim() || '（达到轮数上限且模型未给出结论）';
  logDivider('主 Agent 最终诊断（强制收尾）');
  logRaw(finalAnswer);
  return finalAnswer;
}

// ============================================================================
// ██ 十二、上下文快照打印：让你肉眼看到 messages 数组长什么样
// ============================================================================
function dumpMessages(messages, tag) {
  logRaw(`┌─ messages 快照 · ${tag} · 共 ${messages.length} 条 · ${charCount(messages)} 字符`);
  messages.forEach((m, i) => {
    if (m.role === 'tool') {
      logRaw(`│ [${i}] tool        ← tool_call_id=${m.tool_call_id} ｜ ${clip(m.content, 80)}`);
    } else if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const names = m.tool_calls.map((c) => (c.function ? c.function.name : '?')).join(', ');
      const argText = m.tool_calls.map((c) => (c.function ? c.function.arguments : '')).join(' | ');
      logRaw(`│ [${i}] assistant   → 决定调用 [${names}]，arguments=${clip(argText, 80)}`);
    } else {
      logRaw(`│ [${i}] ${m.role.padEnd(11)} ｜ ${clip(m.content, 80)}`);
    }
  });
  logRaw('└──────────────────────────────────────────────');
}

// ============================================================================
// ██ 十三、命令入口：决定「用户报错」从哪里来
// ============================================================================

/** 收集报错文本：优先选区 → 当前文件红色波浪线 → 手动输入 */
async function buildDiagnoseGoal() {
  const editor = vscode.window.activeTextEditor;
  let errorText = '';

  // 1) 编辑器里选中的报错文本
  if (editor && !editor.selection.isEmpty) {
    errorText = editor.document.getText(editor.selection).trim();
  }

  // 2) 没选中就自动抓当前文件的第一批 Error 级诊断（红色波浪线）
  if (!errorText && editor) {
    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
    const errors = diagnostics
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
      .slice(0, 5);
    if (errors.length > 0) {
      errorText = errors
        .map((d) => `第 ${d.range.start.line + 1} 行: ${d.message}`)
        .join('\n');
    }
  }

  // 3) 都没有就让用户粘贴
  if (!errorText) {
    errorText = String(
      (await vscode.window.showInputBox({
        title: '报错上下文裁剪器 · 输入报错',
        prompt: '粘贴报错信息（也可以先在编辑器里选中报错再执行命令）',
        ignoreFocusOut: true,
      })) || '',
    ).trim();
  }

  if (!errorText) return null;

  // 把环境信息一起喂给主 Agent，子 Agent 才有「文件 + 行号」的抓手
  const contextLines = [];
  if (editor && !editor.document.isUntitled && editor.document.uri.scheme === 'file') {
    contextLines.push(`当前文件：${vscode.workspace.asRelativePath(editor.document.uri, false)}`);
    contextLines.push(`光标位置：第 ${editor.selection.active.line + 1} 行`);
    if (!editor.selection.isEmpty) {
      contextLines.push(`选中范围：第 ${editor.selection.start.line + 1}-${editor.selection.end.line + 1} 行`);
    }
  } else {
    contextLines.push('当前文件：无（未打开任何文件，子 Agent 将使用内置模拟代码）');
  }

  return `【用户报错】\n${errorText}\n\n【上下文】\n${contextLines.join('\n')}`;
}

/** 命令：诊断当前报错 */
async function commandDiagnose() {
  const channel = ensureChannel();
  channel.clear();
  channel.show(true);

  logDivider('报错上下文裁剪器 · 启动');
  logSys(`模型：${getConfig().get('model') || DEFAULT_MODEL}`);
  logSys('双层架构：主 Agent 只思考派活，子 Agent 负责读代码/搜索，结论回传后主 Agent 汇总');

  const goal = await buildDiagnoseGoal();
  if (!goal) {
    logSys('没有拿到报错信息，已取消');
    vscode.window.showWarningMessage('没有拿到报错信息，已取消');
    return;
  }

  try {
    const finalAnswer = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '报错上下文裁剪器：双层 Agent 诊断中…',
      },
      () => runMainAgent(goal),
    );

    const action = await vscode.window.showInformationMessage(
      '✅ 诊断完成，完整流转过程见输出面板',
      '查看完整报告',
    );
    if (action === '查看完整报告') {
      // 把最终诊断再打印一遍，方便复制
      logDivider('最终诊断（可复制）');
      logRaw(finalAnswer);
      channel.show(true);
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    logSys(`❌ 诊断失败：${message}`);
    channel.show(true);
    vscode.window.showErrorMessage(`诊断失败：${message}`);
  }
}

/** 命令：设置 API Key */
async function commandSetApiKey() {
  const value = await vscode.window.showInputBox({
    title: '设置 DeepSeek API Key',
    prompt: '输入 sk- 开头的 Key（保存在 VS Code 全局设置里）',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (String(v || '').trim() ? undefined : '不能为空'),
  });
  if (!value) return;
  await getConfig().update('apiKey', String(value).trim(), vscode.ConfigurationTarget.Global);
  ensureChannel().appendLine('[系统] 已保存 DeepSeek API Key');
  vscode.window.showInformationMessage('已保存 DeepSeek API Key');
}

// ============================================================================
// ██ 十四、插件生命周期
// ============================================================================
function activate(context) {
  const channel = ensureChannel();
  context.subscriptions.push(channel);

  context.subscriptions.push(
    vscode.commands.registerCommand('errorContextTrimmer.diagnoseError', () => commandDiagnose()),
    vscode.commands.registerCommand('errorContextTrimmer.setApiKey', () => commandSetApiKey()),
  );

  outputChannel.appendLine('[系统] 插件已激活：命令「报错上下文裁剪器: 诊断当前报错（双层 Agent）」可用');
  outputChannel.appendLine('[系统] 首次使用请先执行「报错上下文裁剪器: 设置 DeepSeek API Key」');
}

function deactivate() {
  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = null;
  }
}

module.exports = { activate, deactivate };

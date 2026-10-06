/**
 * ChatEvent — 后端 → 前端通信协议
 *
 * 判别联合类型，每个变体只包含该事件所需字段。
 * 零外部依赖，作为前后端通信的唯一契约。
 *
 * **phase 3 之后只剩「余项」**（plan §D）：会话内容（消息、正在流式的那张卡、工具进度、队列、询问、
 * 上下文用量）全部经视图同步（`SessionView`，见 `sync.ts` / `types/sessionView.ts`）到达前端；这里只留
 * 不属于内容的瞬时 / 全局信号 —— 运行生命周期（`agent_start` / `agent_end{reason}`，由主进程按投影的
 * 运行信号发）、运行时出生与关停、MCP 惰性连接、没有条目的错误、自动审查、资源 / 浏览器面板、派生 agent
 * 的登记与收尾、后台任务，以及只带数字的 `ask_count`（侧栏徽标与「卡在等人」标记读它，询问内容只在视图里）。
 */

import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import type { LucideIconName, ThemeColor } from '@shuvix/chat-protocol/theme'

// ─── 基础 ──────────────────────────────────────────────

interface ChatEventBase {
  sessionId: string
  /** 子智能体 task ID（来自子智能体的事件会携带此字段） */
  subAgentId?: string
  /** 子智能体类型名（如 'explore'） */
  subAgentType?: string
}

// ─── 运行生命周期 ──────────────────────────────────────

/** 一轮运行开始（根会话：sessionId = 会话 id；派生 agent：sessionId = agentId） */
export interface ChatAgentStartEvent extends ChatEventBase {
  type: 'agent_start'
}

/**
 * 一轮运行结束 —— 只是一个生命周期信号，**不带内容**：终答与用量都在视图里（`SessionView.messages` /
 * `context`）。由主进程按会话投影的运行信号发出，每个 `agent_start` 恰好配一个。
 */
export interface ChatAgentEndEvent extends ChatEventBase {
  type: 'agent_end'
  /**
   * 本轮**怎么**结束的：任务带中止标记 → aborted；否则看它最后一条 assistant 的 stopReason
   * （error → error，aborted → aborted，其余 → ok）。通知层按它分文案（完成 / 失败 / 不打扰）。
   */
  reason: 'ok' | 'aborted' | 'error'
}

// ─── 自动审查 ──────────────────────────────────────────

/**
 * 询问点的自动审查开始 / 落定（设计稿 docs/permission-review-design.md §11）：策略判出要问、
 * 审查员正在替用户看这次调用。工具卡据此显示「审查中」，免得几秒的等待看起来像工具卡住了。
 *
 * 只是过程态，不进会话树：结论另有落点 —— 放行的记在工具结果的 details 上（toolReviewOf），
 * 拒绝就是那条红行，转给人的是询问卡片（AskInputRequest.review）。
 */
export interface ChatToolReviewEvent extends ChatEventBase {
  type: 'tool_review'
  toolCallId: string
  /**
   * 发起询问的 durable 工具任务（P2-08 PIN-09）：provider 的 toolCallId 会话内可能重复（根与派生 agent
   * 都可能是 `call_0`），taskId 不会。不经 durable 工具调用的询问点没有。前端仍按 toolCallId 找卡。
   */
  taskId?: number
  /** true = 审查中；false = 审查落定（不论结论） */
  reviewing: boolean
}

// ─── 询问计数 ──────────────────────────────────────────

/**
 * 一条会话此刻挂着几条询问（P3-08 PIN-01）—— **只有数字**：询问的内容只在视图（`SessionView.asks`）里，
 * 这条事件给的是没人订阅视图的会话的「卡在等人回答」标记（侧栏徽标、后台任务面板）。主进程在每次
 * 询问挂起 / 落定后发（含落定到 0）。
 */
export interface ChatAskCountEvent extends ChatEventBase {
  type: 'ask_count'
  count: number
}

// ─── 资源事件 ──────────────────────────────────────────

/** 运行时资源状态信息（前端直接渲染，不理解具体资源类型） */
export interface RuntimeStatus {
  label: string
  icon?: LucideIconName
  color?: ThemeColor
  description?: string
}

/** 运行时资源生命周期事件（status 非 null → 激活/更新，null → 销毁） */
export interface ChatRuntimeEvent extends ChatEventBase {
  type: 'runtime_event'
  runtimeId: string
  status: RuntimeStatus | null
}

/** 浏览器面板生命周期事件（轻量通知，不持久化为消息；泛化了原 ChatDesignEvent） */
export interface ChatBrowserEvent extends ChatEventBase {
  type: 'browser_event'
  action: 'open' | 'close'
  url?: string
  title?: string
}

// ─── 子智能体 ──────────────────────────────────────────────

/**
 * 子智能体会话注册（在主会话中启动一个临时子会话）。
 * 子智能体运行期间的生命周期事件（agent_start / agent_end）统一以 subSessionId 作为 event.sessionId
 * 下发；renderer 通过 register 事件知晓该 sessionId 属于哪个父会话 + 名称。它的转写经 agent 视图同步。
 */
export interface ChatSubSessionRegisterEvent extends ChatEventBase {
  type: 'sub_session_register'
  /** 父会话 sessionId */
  parentSessionId: string
  /**
   * 父 Agent 派发本子会话的 tool_call id。有值 = Agent 自行触发（对话内 ToolCallBlock 内联展示）；
   * 无值 = 非工具派发（如 hook 派发的 agent），进右侧 Sub-agent 面板。
   */
  parentToolCallId?: string
  /** 子智能体类型名（如 'explore'） */
  subAgentName: string
  /** UI 展示名 */
  displayName: string
  /** 用户给出的任务简述（父工具 args.description） */
  description: string
  /** 子智能体的系统提示词（UI 以卡片形式展示） */
  systemPrompt: string
  /** 父 Agent 发给子智能体的初始 user prompt（UI 以卡片形式展示；含 inlineTokens 标记时渲染命令标签） */
  prompt: string
  /** prompt 中内联 Token（slash 命令 / skill）的字典；面板据此把 prompt 渲染为命令标签 + 文本 */
  inlineTokens?: Record<string, InlineToken>
  /** 额外注入子智能体上下文的人读文本（runTask 的 contextMessages）；UI 以折叠用户消息卡展示 */
  contextNote?: string
  /** 派生层级（根会话=0 不发此事件；直接派生=1，嵌套派生依次递增） */
  depth?: number
  /** 所属根会话 id（嵌套派生时 parentSessionId 是另一个派生 agent，此字段始终指向可见会话） */
  rootSessionId?: string
}

/** 子会话终结（在 agent_end 之后发出，携带最终结果摘要） */
export interface ChatSubSessionEndEvent extends ChatEventBase {
  type: 'sub_session_end'
  parentSessionId: string
  /** 子会话最终 result 文本（父的 tool_result） */
  result: string
  /**
   * 是否以失败结束：被中止、执行抛错、或模型调用报错（最后一条 assistant 的 stopReason 为 error）。
   * 软停止（用户中断）不算失败，但同一轮又被中止时算；结果契约捕获恒为成功。result 文本不因此改变。
   */
  isError?: boolean
}

// ─── 后台任务 ──────────────────────────────────────────

/**
 * 后台任务生命周期变更 —— bash 命令、派生 agent、子会话轮次三类共用一条事件。
 * 低频：每任务至多 2 次（宣告 / 落定）。
 *
 * 刻意**不**下发输出增量：bash 的 stdout/stderr 由 OS 直接写日志文件（前端按字节范围
 * 轮询 `bgTask.readLog`，模型直接 read 那个文件），派生 agent 的转写走它自己的事件频道，
 * 子会话的转写在它自己的会话里。详见 docs/background-task-hub-design.md。
 */
export interface ChatBgTaskEvent extends ChatEventBase {
  type: 'bg_task'
  /** 完整快照，前端按 task.taskId upsert */
  task: TaskInfo
}

// ─── 运行时关停 ─────────────────────────────────────────

/**
 * 会话的 Agent 运行时正在关停（`closing:true`）/ 已关停完毕（`closing:false`）。
 *
 * 一个会话同一时刻只允许有一个运行时：回退、切档案、删除会话都要先把旧运行时**彻底**停下
 * （等当前 run 跑完）才解绑，否则两个 run 会交叉写同一棵会话树，把 tool_use/tool_result
 * 的配对写坏。关停期间发消息没有意义（新运行时还没出生），前端据此显示「正在停止」并拦住发送。
 *
 * 关停通常瞬间完成；工具卡住不返回时可能持续很久 —— 这正是需要把它显式呈现给用户的原因。
 */
export interface ChatAgentClosingEvent extends ChatEventBase {
  type: 'agent_closing'
  closing: boolean
}

/**
 * 会话的 Agent 运行时已创建（懒创建：首次发消息或其它需要运行时的操作时才出生）。
 *
 * 与 `agent_closing{closing:false}` 成对，两者之间就是「这条会话有运行时」的区间。
 * 只在创建那一刻读一次的会话配置 —— 扩展能力勾选（`settings.enabledTools`）与会话模型 —— 在区间内
 * 只读，前端据此把输入框的工具 / 模型选择器与会话设置里的扩展能力切成只读（思考档位不在此列）。
 */
export interface ChatAgentCreatedEvent extends ChatEventBase {
  type: 'agent_created'
}

/**
 * 创建运行时期间正在连接某台 MCP 服务器（`connecting:true`）/ 这次尝试落定了（`false`，连上或失败）。
 *
 * MCP 惰性启动：服务器到装配工具那一刻才连，这段等待直接压在用户刚发出的那条消息上。
 * 前端据此在助手占位卡上写明「正在连接 MCP：…」—— 否则那几秒只有一张空卡，像是出了 bug。
 * 失败原因不走这里（另有 `error` 事件）；`agent_created` 之后不会再有它。
 */
export interface ChatMcpConnectingEvent extends ChatEventBase {
  type: 'mcp_connecting'
  /** server 名（`mcp:<server>` 里的 server） */
  server: string
  connecting: boolean
}

// ─── 错误 ──────────────────────────────────────────────

/** 错误事件 */
export interface ChatErrorEvent extends ChatEventBase {
  type: 'error'
  error: string
}

// ─── 联合类型 ──────────────────────────────────────────

export type ChatEvent =
  | ChatAgentStartEvent
  | ChatAgentEndEvent
  | ChatToolReviewEvent
  | ChatRuntimeEvent
  | ChatBrowserEvent
  | ChatSubSessionRegisterEvent
  | ChatSubSessionEndEvent
  | ChatBgTaskEvent
  | ChatAgentCreatedEvent
  | ChatAgentClosingEvent
  | ChatMcpConnectingEvent
  | ChatErrorEvent
  | ChatAskCountEvent

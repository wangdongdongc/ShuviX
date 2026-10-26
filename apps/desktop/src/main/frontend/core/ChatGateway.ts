import type {
  AgentChangePreview,
  AgentInitResult,
  AgentPreviewChangeParams,
  AgentRuntimeInfo,
  ThinkingLevel,
  WithdrawQueuedResult
} from '../../types'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'
import type { RedactionMarkInfo } from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { SubmitErrorCode } from '@shuvix/agent-runtime'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import type { DriveOptions } from '../../services/agentSession'
import type { AcceptSuggestionResult } from '@shuvix/chat-protocol/suggestions'
import type { SuggestionRef } from '@shuvix/chat-protocol/types/inputOrigin'

/** 想把锁住的 agent 改成什么样（`agent.previewChange` 去掉会话 id） */
export type AgentPreviewChange = Omit<AgentPreviewChangeParams, 'sessionId'>

/**
 * 会话级上行操作接口 — 前端 → 后端通信的统一入口
 *
 * 所有操作都在指定 sessionId 的会话内执行。
 * 非 Electron 前端通过 chatFrontendRegistry.bind(sessionId, frontend) 绑定后，
 * 使用 chatGateway 传入该 sessionId 即可操作。
 *
 * 不含 Session CRUD、Provider/Settings 等管理操作（由桌面端 IPC 直连 Service）。
 */
export interface ChatGateway {
  // ─── Agent 对话 ──────────────────────────────

  /** 开启对话：返回会话元信息（运行配置从会话树推导） */
  startChat(sessionId: string): Promise<AgentInitResult>

  /** 发送用户消息 */
  /**
   * 发一条用户消息并等整轮结束。返回 `{error}` = **没发出去**（最典型：会话正忙，
   * pi 拒 busy）——调用方必须能把它与「发出去了但没回话」区分开，子会话的驱动方
   * 正是靠这个报错而不是假装排队。`code` 是运行时给的分类（busy / no_model / model_error / closed …），
   * 会话打不开时没有。
   */
  prompt(
    sessionId: string,
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>,
    inlineTokens?: Record<string, InlineToken>,
    /** 子会话的驱动方（主进程内）专用：幂等键 + driven-run 标记（P2-10）；IPC 从不带它 */
    drive?: DriveOptions
  ): Promise<{ error?: string; code?: SubmitErrorCode }>

  /** 向运行中的 Agent 发送 steer 消息（引导/纠正方向） */
  steer(sessionId: string, text: string): void
  /**
   * 父会话往自己驱动着的子会话里插话（§19.6）：与 `steer` 同一道门，但**交回受理结果**（`{error}` = 没送到，
   * 文案给人读），并带上幂等键与来源。只交给打开着的会话 —— 正被驱动的子会话必然开着。主进程内专用，IPC 不走它。
   */
  steerDriven(
    sessionId: string,
    text: string,
    drive: { requestId: string; parentId: string }
  ): Promise<{ error?: string; code?: SubmitErrorCode }>
  /** 本轮本应结束时续跑同一次运行（pi followUp 队列） */
  followUp(sessionId: string, text: string): void
  /**
   * 撤回一条排着的用户输入（P3-11）：只对打开着的会话（不打开、不 peek）；`submissionId` 不是正的安全整数、
   * 会话没打开、句柄已关 → `not_found`（PIN-14）
   */
  withdrawQueued(sessionId: string, submissionId: number): Promise<WithdrawQueuedResult>

  /**
   * 采纳一条提议（`suggest` 工具）：核对它此刻还能采纳（取那条的话 —— 从会话里的工具参数取，不信请求），以用户的
   * 身份发进会话，来源带上提议引用。会话在跑 → steer；空闲 → 起一轮（不等这一轮结束就交回）
   */
  acceptSuggestion(sessionId: string, ref: SuggestionRef): Promise<AcceptSuggestionResult>

  /** 中止当前生成（部分内容由 harness 自行落成 entry，无需回传消息） */
  abort(sessionId: string): Promise<{ success: boolean }>

  /**
   * 继续被中断的工作（上个进程退出时正在跑的那一轮，P3-12），等它落定。只取打开着的会话、没开就 peek
   * （存储在才打开，**从不创建**，PIN-16）；没有可打开的会话（不存在 / 旧格式 / 退出中）→ `{}`。
   * 空闲且没被中断 → 运行时的严格无操作，`{}`。失败原样上交（`{ error, code }`）。
   */
  continue(sessionId: string): Promise<{ error?: string; code?: SubmitErrorCode }>

  // ─── 交互响应 ─────────────────────────────────

  /**
   * 统一的"用户输入响应"入口。
   * 命令询问 / 选择题 / SSH 凭证 / 用户取消都通过该方法路由到对应的挂起 Promise。
   * 返回是否有人认领（先到者胜）；没人认领什么也不广播 —— 询问的卡片跟着视图走（P3-08）。
   * `meta.clientId` = 答题方（审计用，PIN-20）。
   */
  respondToInput(
    sessionId: string,
    requestId: string,
    response: InputResponse,
    meta?: { clientId?: string }
  ): boolean

  // ─── 运行时调整 ────────────────────────────────

  /**
   * 切换模型：写会话设置 `settings.model`；会话有 Agent 运行时就当场重配它（下一次请求起生效，运行中也是）。
   * 那个 agent 用不了这个模型 → 什么也不写、返回 false。
   */
  setModel(sessionId: string, provider: string, model: string): Promise<boolean>

  /** 预判一次模型 / 扩展能力改动会不会让提示词缓存失效（不连服务器、什么也不写） */
  previewAgentChange(sessionId: string, change: AgentPreviewChange): Promise<AgentChangePreview>

  /** 设置思考深度（写会话设置 `settings.thinkingLevel`，recordSessionThinkingLevel） */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void>

  // 注：没有 setEnabledTools —— 扩展能力勾选是会话设置，写入口是 sessionService.updateEnabledTools
  // （有 Agent 运行时就当场重配它）。

  /**
   * 销毁会话的根 Agent 运行时（会话、历史与内置能力服务器都留着），下一条消息按那时的模型 /
   * 扩展能力勾选重建。正在跑的 run 会被中止；等关停落定才返回。没有运行时则无操作。
   */
  destroyAgent(sessionId: string): Promise<void>

  /** 读取运行时 Agent 对象的实时信息（systemPrompt/工具/模型）；Agent 未创建返回 null，
   *  传 { ensure: true } 则先懒创建（不请求 LLM）再取快照 */
  getAgentInfo(sessionId: string, options?: { ensure?: boolean }): Promise<AgentRuntimeInfo | null>

  // ─── 消息操作 ─────────────────────────────────

  /** 获取会话消息列表（entry 树的 UI 投影） */
  listMessages(sessionId: string): Promise<ChatMessage[]>

  /** 清空会话所有消息（整棵 entry 树）；先关停运行时再删，故为异步 */
  clearMessages(sessionId: string): Promise<void>

  /**
   * 回退到指定消息之前（P3-10b）：运行时把当前对话换成目标之前的 fork（旧分支留在存储里、不再可见），
   * 合格时顺带销毁 agent。真的回退了 → true；没有可回退的目标（旧格式会话、id 不是条目 id、目标不在当前
   * 对话里 / 不是用户消息）→ false，什么都不动（在跑的 run 照常跑）。
   */
  rollbackMessage(sessionId: string, messageId: string): Promise<boolean>

  // ─── 资源操作 ──────────────────────────────────

  /** 获取所有运行时资源状态（异步：ssh 一项可能要读用户的 ssh 配置，不能同步挂住主进程） */
  getRuntimeStatuses(sessionId: string): Promise<Record<string, RuntimeStatus>>

  /** 销毁指定运行时资源 */
  destroyRuntime(sessionId: string, runtimeId: string): Promise<{ success: boolean }>

  /**
   * 自动脱敏：这条会话对照表里这些占位符的类别与真值（界面渲染标记）。会话没开着就打开它（存储在才开）；
   * 不是标准写法的占位符、表里没有的不出现在结果里；有但解不开的只有类别。
   */
  resolveRedactions(
    sessionId: string,
    placeholders: string[]
  ): Promise<Record<string, RedactionMarkInfo>>

  // ─── 工具发现 ──────────────────────────────────

  /**
   * 获取所有可用工具列表（传入 sessionId 时包含项目级 skills）。
   * 没有会话时声明项按 `profile` 画（缺省 work —— 项目编辑页画的是项目会话）
   */
  listTools(
    sessionId?: string,
    options?: { profile?: string }
  ): Array<{
    name: string
    label: string
    hint?: string
    group?: string
    defaultEnabled?: boolean
    serverStatus?: string
    /** 会话的 agent 档案声明了这条 mcp:/skill: 项（值为档案显示名）：恒生效，选择器里锁成已勾 */
    declaredBy?: string
  }>
}

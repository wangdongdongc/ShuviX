import type { AgentInitResult, AgentRuntimeInfo, ThinkingLevel } from '../../types'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { SubmitErrorCode } from '@shuvix/agent-runtime'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import type { DriveOptions } from '../../services/agentSession'

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
  /** 本轮本应结束时续跑同一次运行（pi followUp 队列） */
  followUp(sessionId: string, text: string): void
  /** 排队到下一次 prompt 之前（pi nextTurn 队列；不被 abort 清空） */
  nextTurn(sessionId: string, text: string): void

  /** 中止当前生成（部分内容由 harness 自行落成 entry，无需回传消息） */
  abort(sessionId: string): Promise<{ success: boolean }>

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
   * 切换模型：往会话树追加 model_change entry。**只在会话没有 Agent 运行时的时候接受** ——
   * 模型与扩展能力一样只在创建 Agent 那一刻读一次；运行时已存在 / 正在创建 / 正在关停时
   * 什么也不写、返回 false。想换模型先 `destroyAgent`。
   */
  setModel(sessionId: string, provider: string, model: string): Promise<boolean>

  /** 设置思考深度（同上，落 thinking_level_change entry） */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void>

  // 注：没有 setEnabledTools —— 扩展能力勾选是会话设置，只在 Agent 未创建时可改
  // （sessionService.updateEnabledTools），运行时没有换工具的入口。

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

  /** 获取所有运行时资源状态 */
  getRuntimeStatuses(sessionId: string): Record<string, RuntimeStatus>

  /** 销毁指定运行时资源 */
  destroyRuntime(sessionId: string, runtimeId: string): Promise<{ success: boolean }>

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

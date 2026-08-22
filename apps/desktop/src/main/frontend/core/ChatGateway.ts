import type { AgentInitResult, AgentRuntimeInfo, ThinkingLevel } from '../../types'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'
import type { ChatMessage, InlineToken } from '@shuvix/chat-protocol/types/chatMessage'

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
  prompt(
    sessionId: string,
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>
  ): Promise<void>

  /**
   * 笔记本会话发送：不走主会话，每次开启独立子智能体（fire-and-forget）。
   * 上下文注入「当前笔记本文件路径 + 如需正文先用 read 读取」（路径由会话配置解析）。
   */
  notebookPrompt(
    sessionId: string,
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>,
    inlineTokens?: Record<string, InlineToken>
  ): Promise<void>

  /** 向运行中的 Agent 发送 steer 消息（引导/纠正方向） */
  steer(sessionId: string, text: string): void

  /** 中止当前生成（部分内容由 harness 自行落成 entry，无需回传消息） */
  abort(sessionId: string): Promise<{ success: boolean }>

  // ─── 交互响应 ─────────────────────────────────

  /**
   * 统一的"用户输入响应"入口。
   * 命令询问 / 选择题 / SSH 凭证 / 用户取消都通过该方法路由到对应的挂起 Promise。
   */
  respondToInput(sessionId: string, requestId: string, response: InputResponse): void

  // ─── 运行时调整 ────────────────────────────────

  /** 切换模型（harness 把变更作为 model_change entry 落在会话树上，故为异步） */
  setModel(
    sessionId: string,
    provider: string,
    model: string,
    baseUrl?: string,
    apiProtocol?: string
  ): Promise<void>

  /** 设置思考深度（同上，落 thinking_level_change entry） */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void>

  /** 动态更新启用工具集（同上，落 active_tools_change entry） */
  setEnabledTools(sessionId: string, tools: string[]): Promise<void>

  /** 读取运行时 Agent 对象的实时信息（systemPrompt/工具/模型）；Agent 未创建返回 null，
   *  传 { ensure: true } 则先懒创建（不请求 LLM）再取快照 */
  getAgentInfo(sessionId: string, options?: { ensure?: boolean }): Promise<AgentRuntimeInfo | null>

  // ─── 消息操作 ─────────────────────────────────

  /** 获取会话消息列表（entry 树的 UI 投影） */
  listMessages(sessionId: string): Promise<ChatMessage[]>

  /** 清空会话所有消息（整棵 entry 树） */
  clearMessages(sessionId: string): void

  /**
   * 回退到指定消息之前，使 Agent 失效。
   *
   * entry 树是 append-only：这里做的是把 leaf 移到目标 entry 的父节点，
   * 被"删掉"的分支仍在树上。旧的 deleteFromMessage 与之语义重合，已合并掉。
   */
  rollbackMessage(sessionId: string, messageId: string): Promise<void>

  // ─── 资源操作 ──────────────────────────────────

  /** 获取所有运行时资源状态 */
  getRuntimeStatuses(sessionId: string): Record<string, RuntimeStatus>

  /** 销毁指定运行时资源 */
  destroyRuntime(sessionId: string, runtimeId: string): Promise<{ success: boolean }>

  // ─── 工具发现 ──────────────────────────────────

  /** 获取所有可用工具列表（传入 sessionId 时包含项目级 skills） */
  listTools(sessionId?: string): Array<{
    name: string
    label: string
    hint?: string
    group?: string
    defaultEnabled?: boolean
    serverStatus?: string
  }>
}

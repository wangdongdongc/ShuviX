import type {
  AgentInitResult,
  AgentRuntimeInfo,
  MessageAddParams,
  Message,
  ThinkingLevel
} from '../../types'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'

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

  /** 开启对话（加载历史消息、项目指令等） */
  startChat(sessionId: string): AgentInitResult

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
  ): void

  /**
   * 用户直发派发（kind='agent' 斜杠命令 `/<agentName> <prompt>`）：不进主会话消息流，
   * 直接开启具名子智能体（fire-and-forget，进右侧 Sub-agent 面板）。
   * 返回的 promise 仅覆盖派发前的准备（确保主 AgentSession 存在以承接审批），不含子代理整轮。
   */
  dispatchPrompt(
    sessionId: string,
    agentName: string,
    text: string,
    inlineTokens?: Record<string, InlineToken>
  ): Promise<void>

  /** 向运行中的 Agent 发送 steer 消息（引导/纠正方向） */
  steer(sessionId: string, text: string): void

  /** 中止当前生成 */
  abort(sessionId: string): { success: boolean; savedMessage?: Message }

  // ─── 交互响应 ─────────────────────────────────

  /**
   * 统一的"用户输入响应"入口。
   * 命令审批 / 选择题 / SSH 凭证 / 用户取消都通过该方法路由到对应的挂起 Promise。
   */
  respondToInput(sessionId: string, requestId: string, response: InputResponse): void

  // ─── 运行时调整 ────────────────────────────────

  /** 切换模型 */
  setModel(
    sessionId: string,
    provider: string,
    model: string,
    baseUrl?: string,
    apiProtocol?: string
  ): void

  /** 设置思考深度 */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): void

  /** 动态更新启用工具集 */
  setEnabledTools(sessionId: string, tools: string[]): void

  /** 读取运行时 Agent 对象的实时信息（systemPrompt/工具/模型）；Agent 未创建返回 null */
  getAgentInfo(sessionId: string): AgentRuntimeInfo | null

  // ─── 消息操作 ─────────────────────────────────

  /** 获取会话消息列表 */
  listMessages(sessionId: string): Message[]

  /** 添加消息 */
  addMessage(params: MessageAddParams): Message

  /** 清空会话所有消息 */
  clearMessages(sessionId: string): void

  /** 回退到指定消息（保留该消息，删除之后的，使 Agent 失效） */
  rollbackMessage(sessionId: string, messageId: string): void

  /** 从指定消息开始删除（含该消息，使 Agent 失效） */
  deleteFromMessage(sessionId: string, messageId: string): void

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

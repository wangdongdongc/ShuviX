import type { AgentInitResult, MessageAddParams, Message, ThinkingLevel } from '../../types'
import type { SshCredentialPayload } from '../../tools/types'

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

  /** 初始化 Agent（加载历史消息、项目指令等） */
  initAgent(sessionId: string): AgentInitResult

  /** 发送用户消息 */
  prompt(
    sessionId: string,
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>
  ): Promise<void>

  /** 中止当前生成 */
  abort(sessionId: string): { success: boolean; savedMessage?: Message }

  // ─── 交互响应 ─────────────────────────────────

  /** 响应工具审批（沙箱模式 bash） */
  approveToolCall(toolCallId: string, approved: boolean, reason?: string): void

  /** 响应 ask 工具选择 */
  respondToAsk(toolCallId: string, selections: string[]): void

  /** 响应 SSH 凭据请求 */
  respondToSshCredentials(toolCallId: string, credentials: SshCredentialPayload | null): void

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

  /** 查询 Docker 容器状态 */
  getDockerStatus(sessionId: string): { containerId: string; image: string } | null

  /** 销毁 Docker 容器 */
  destroyDocker(sessionId: string): Promise<{ success: boolean }>

  /** 查询 SSH 连接状态 */
  getSshStatus(sessionId: string): { host: string; port: number; username: string } | null

  /** 断开 SSH 连接 */
  disconnectSsh(sessionId: string): Promise<{ success: boolean }>

  // ─── 工具发现 ──────────────────────────────────

  /** 获取所有可用工具列表 */
  listTools(): Array<{
    name: string
    label: string
    hint?: string
    group?: string
    serverStatus?: string
  }>
}

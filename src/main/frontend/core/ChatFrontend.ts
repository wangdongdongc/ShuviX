import type { ChatEvent } from './types'

/** 前端能力声明 */
export interface ChatFrontendCapabilities {
  /** 支持实时流式 delta 事件 (text_delta / thinking_delta / image_data) */
  streaming?: boolean
  /** 支持工具执行审批交互 (tool_approval_request) */
  toolApproval?: boolean
  /** 支持用户选择交互 — ask 工具 (user_input_request) */
  userInput?: boolean
  /** 支持 SSH 凭据输入 (ssh_credential_request) */
  sshCredentials?: boolean
}

/** 聊天前端适配器 — 接收 Agent 流式事件推送 */
export interface ChatFrontend {
  /** 唯一标识 */
  readonly id: string
  /** 该前端支持的能力 */
  readonly capabilities: ChatFrontendCapabilities
  /** 推送事件到前端 */
  sendEvent(event: ChatEvent): void
  /** 连接是否仍然有效 */
  isAlive(): boolean
}

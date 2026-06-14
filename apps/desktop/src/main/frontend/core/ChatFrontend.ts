import type { ChatEvent } from '@shuvix/chat-protocol/events'

/** 前端能力声明 */
export interface ChatFrontendCapabilities {
  /** 支持实时流式 delta 事件 (text_delta / thinking_delta / image_data) */
  streaming?: boolean
  /**
   * 支持"用户输入请求"交互(input_request 事件)。
   * 命令审批 / 选择题 / SSH 凭证全部归并为单一能力。
   * 不支持的前端在收到 input_request 时被跳过,工具收到 cancel 响应。
   */
  userInput?: boolean
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

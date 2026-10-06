import type { ChatEvent } from '@shuvix/chat-protocol/events'

/** 前端能力声明 */
export interface ChatFrontendCapabilities {
  /**
   * 能展示、回答「用户输入请求」（命令询问 / 选择题 / SSH 凭证）。询问本身经视图同步到达前端
   * （`SessionView.asks`，P3-08）—— 这项能力只剩一个用途：`hasUserInputCapability` 闸门（一个能答的前端
   * 都没有时，工具当场收到 cancel，而不是挂起一条永远没人答的询问）。
   */
  userInput?: boolean
}

/** 聊天前端适配器 — 接收余项事件推送（运行生命周期、错误、运行时出生 / 关停……；内容走视图同步） */
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

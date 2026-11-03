import type { ChatEvent } from '@shuvix/chat-protocol/events'

/** 聊天前端适配器 — 接收余项事件推送（运行生命周期、错误、运行时出生 / 关停……；内容走视图同步） */
export interface ChatFrontend {
  /** 唯一标识 */
  readonly id: string
  /** 推送事件到前端 */
  sendEvent(event: ChatEvent): void
  /** 连接是否仍然有效 */
  isAlive(): boolean
}

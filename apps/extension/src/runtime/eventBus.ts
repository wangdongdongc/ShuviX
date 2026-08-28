/**
 * 进程内事件总线 —— Agent 运行时与 chat-ui 同进程（Side Panel），无需消息通道。
 * RuntimeSession 的 eventSink.broadcast 经此把 ChatEvent 同步派发给 UI 的 onEvent 订阅。
 */
import type { ChatEvent } from '@shuvix/chat-protocol/events'

type Listener = (event: ChatEvent) => void

const listeners = new Set<Listener>()
const observers = new Set<Listener>()

export const eventBus = {
  /** RuntimeSession.eventSink.broadcast 调用 */
  emit(event: ChatEvent): void {
    for (const l of [...listeners, ...observers]) {
      try {
        l(event)
      } catch (e) {
        console.error('[shuvix] event listener error', e)
      }
    }
  },

  /** ChatApi.agent.onEvent 调用；返回取消订阅 */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /**
   * 旁听同一条事件流，但**不计入 hasListeners()**。
   *
   * 通知决策器这类消费者收事件却不是「能展示输入面板的 UI」—— 混进 listeners 会让
   * hasUserInputCapability 恒真，harnessSession 就再也不会把无人应答的询问及时取消。
   */
  subscribeObserver(listener: Listener): () => void {
    observers.add(listener)
    return () => observers.delete(listener)
  },

  /** 是否有 UI 在监听（可展示用户输入面板） */
  hasListeners(): boolean {
    return listeners.size > 0
  }
}

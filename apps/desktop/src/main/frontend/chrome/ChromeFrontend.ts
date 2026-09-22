import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { ChatFrontend, ChatFrontendCapabilities } from '../core'
import { chromeBrowserState, type BridgeConnection } from '../../services/chromeBridge'

/**
 * Chrome 侧边栏前端 —— 一条标签页会话在一条桥连接上的推送口。
 *
 * 会话打开时 `chatFrontendRegistry.bind(sessionId, …)`：只收这条会话（及它派生的）的事件，经桥推给
 * 扩展，扩展按会话 id 转到对应标签页的侧边栏。询问卡片（input_request）也走这里，所以要声明
 * `userInput`：侧边栏里弹、侧边栏里答。连接断了 isAlive 即假，注册表随之剪掉它。
 *
 * 顺带看一眼这条会话的轮次起止，给浏览器的「一轮跑完就释放调试」租约计数（见 browserState）。
 */
export class ChromeFrontend implements ChatFrontend {
  readonly id: string
  readonly capabilities: ChatFrontendCapabilities = { streaming: true, userInput: true }

  constructor(
    private readonly conn: BridgeConnection,
    private readonly sessionId: string
  ) {
    this.id = `chrome:${conn.id}:${sessionId}`
  }

  sendEvent(event: ChatEvent): void {
    if (event.sessionId === this.sessionId) this.trackRun(event)
    this.conn.emit('chat.event', { sessionId: this.sessionId, event })
  }

  isAlive(): boolean {
    return this.conn.ready
  }

  private trackRun(event: ChatEvent): void {
    const installId = this.conn.info?.installId
    if (!installId) return
    if (event.type === 'agent_start') chromeBrowserState(installId).beginRun(this.sessionId)
    else if (event.type === 'agent_end') chromeBrowserState(installId).endRun(this.sessionId)
  }
}

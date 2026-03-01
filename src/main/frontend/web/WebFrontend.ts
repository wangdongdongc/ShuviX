import type { WebSocket } from 'ws'
import type { ChatFrontend, ChatFrontendCapabilities, ChatEvent } from '../core'
import { v4 as uuid } from 'uuid'

/** WebSocket 前端实现 — 每个 WebSocket 连接对应一个实例 */
export class WebFrontend implements ChatFrontend {
  readonly id: string
  readonly capabilities: ChatFrontendCapabilities = {
    streaming: true,
    toolApproval: true,
    userInput: true,
    sshCredentials: false
  }

  constructor(
    private socket: WebSocket,
    readonly sessionId: string
  ) {
    this.id = `web-${uuid()}`
  }

  sendEvent(event: ChatEvent): void {
    if (this.isAlive()) {
      this.socket.send(JSON.stringify(event))
    }
  }

  isAlive(): boolean {
    return this.socket.readyState === this.socket.OPEN
  }
}

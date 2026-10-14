import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { ChatFrontend, ChatFrontendCapabilities } from '../core'
import { isClientAlive, pushTo, type NetworkClientRef } from '../../ipc/registry'

/**
 * 网络客户端前端（server mode phase B）—— 局域网里一个浏览器页面（一条 WebSocket 连接）收聊天余项事件的口。
 *
 * 与桌面主窗口一样注册成**默认前端**（`chatFrontendRegistry.registerDefault`）：收每条会话的 `agent:event`；
 * 能答询问，所以声明 `userInput`（询问本身经视图同步到达）。推送走通道注册表的 `pushTo`（网络传输把它变成那条
 * 连接上的 `{t:'push', channel:'agent:event', args:[event]}`），连接断了 `isAlive` 即假，注册表随之剪掉它；
 * 连接关掉时服务端也会主动 `unregister`。
 */
export class NetworkFrontend implements ChatFrontend {
  readonly id: string
  readonly capabilities: ChatFrontendCapabilities = { userInput: true }

  constructor(private readonly client: NetworkClientRef) {
    this.id = networkFrontendId(client.id)
  }

  sendEvent(event: ChatEvent): void {
    pushTo(this.client, 'agent:event', event)
  }

  isAlive(): boolean {
    return isClientAlive(this.client)
  }
}

/** 某条网络连接的前端 id */
export function networkFrontendId(clientId: string): string {
  return `network:${clientId}`
}

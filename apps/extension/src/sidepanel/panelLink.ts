/**
 * 侧边栏这一端的连接 —— 一条 `chrome.runtime` 端口连 SW（SW 再经原生消息连桌面）。
 *
 * SW 被回收或重启会断开所有端口：这里自动重连，并把挂着的请求以「桌面不在」失败 —— 与本地组件
 * 替桌面回的错误同一个码，上层只认一种失败。
 */
import {
  BRIDGE_ERROR_DESKTOP_OFFLINE,
  type PanelRequestMap
} from '@shuvix/chat-protocol/chromeBridge'
import {
  PANEL_PORT_PREFIX,
  type PanelLinkState,
  type PanelMethod,
  type PanelToWorker,
  type WorkerToPanel
} from '../shared/panelLink'

type Listener<T> = (value: T) => void

export class PanelLink {
  state: PanelLinkState = 'connecting'
  private port: chrome.runtime.Port | null = null
  private seq = 0
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly stateListeners = new Set<Listener<PanelLinkState>>()
  private readonly chatListeners = new Set<Listener<unknown>>()
  private readonly appListeners = new Set<Listener<unknown>>()

  constructor(readonly tabId: number) {
    this.connect()
  }

  private connect(): void {
    const port = chrome.runtime.connect({ name: `${PANEL_PORT_PREFIX}${this.tabId}` })
    this.port = port
    port.onMessage.addListener((message: WorkerToPanel) => this.onMessage(message))
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return
      this.port = null
      this.failAll(BRIDGE_ERROR_DESKTOP_OFFLINE)
      this.setState('connecting')
      // SW 重启 / 被回收：隔一下再连，连上就会被唤醒
      setTimeout(() => this.connect(), 500)
    })
  }

  private onMessage(message: WorkerToPanel): void {
    switch (message.kind) {
      case 'status':
        this.setState(message.state)
        if (message.state !== 'ready') this.failAll(BRIDGE_ERROR_DESKTOP_OFFLINE)
        return
      case 'response': {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.ok) entry.resolve(message.result)
        else entry.reject(new Error(message.error || 'ShuviX reported an error.'))
        return
      }
      case 'chat.event':
        for (const fn of this.chatListeners) fn(message.event)
        return
      case 'app.event':
        for (const fn of this.appListeners) fn(message.event)
        return
    }
  }

  private setState(next: PanelLinkState): void {
    if (this.state === next) return
    this.state = next
    for (const fn of this.stateListeners) fn(next)
  }

  private failAll(error: string): void {
    for (const [, entry] of this.pending) entry.reject(new Error(error))
    this.pending.clear()
  }

  request<M extends PanelMethod>(
    method: M,
    params: PanelRequestMap[M]['params']
  ): Promise<PanelRequestMap[M]['result']> {
    const port = this.port
    if (!port) return Promise.reject(new Error(BRIDGE_ERROR_DESKTOP_OFFLINE))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      const message: PanelToWorker = { kind: 'request', id, method, params }
      try {
        port.postMessage(message)
      } catch {
        this.pending.delete(id)
        reject(new Error(BRIDGE_ERROR_DESKTOP_OFFLINE))
      }
    })
  }

  onState(fn: Listener<PanelLinkState>): () => void {
    this.stateListeners.add(fn)
    return () => this.stateListeners.delete(fn)
  }

  onChatEvent(fn: Listener<unknown>): () => void {
    this.chatListeners.add(fn)
    return () => this.chatListeners.delete(fn)
  }

  onAppEvent(fn: Listener<unknown>): () => void {
    this.appListeners.add(fn)
    return () => this.appListeners.delete(fn)
  }
}

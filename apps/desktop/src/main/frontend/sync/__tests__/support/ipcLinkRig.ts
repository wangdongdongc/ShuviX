/**
 * 桌面窗口链路（`frontend/sync/ipcLink`）用例的夹具（pi 1.2 / chord2）：假 webContents、假 ipcMain、每个窗口一个
 * 假 ipcRenderer，以及窗口里**真的** syncClient 跑在 preload 的 `createSyncBridge` 上。
 *
 *  - `FakeWebContents`：EventEmitter + `send`（参数 JSON 往返一遍、在微任务里交给这个窗口的渲染端监听器 —— Electron
 *    的 IPC 一样是拷贝、异步到达；每次调用记进 `sent`）+ `isDestroyed()`；`destroy()` / `crash()` / `navigate()` 发
 *    对应的事件（`destroyed` / `render-process-gone` / `did-navigate`）；`throwOnSend` 让 `send` 抛错。
 *  - `FakeIpcMain`：`on(channel, listener)` 记下监听器；`emitFrom(wc, channel, …args)` 以那个 webContents 的身份投递
 *    （`event.sender = wc`）。
 *  - `fakeIpcRenderer(wc, ipcMain)`：`send` 在微任务里经 `ipcMain.emitFrom` 送到主进程；`on` / `removeListener` 管
 *    `wc.send` 的接收者。
 *  - `syncWindow(wc, ipcMain)`：一个窗口 = webContents + ipcRenderer + `sync` 桥 + 一个 syncClient。
 */
import { EventEmitter } from 'node:events'
import type { SyncLinkChannel } from '@shuvix/chat-protocol/sync'
import {
  createSyncClient,
  type SyncClient,
  type SyncClientOptions
} from '../../../../../../../../packages/chat-ui/src/sync/syncClient'
import { SYNC_FRAME_CHANNEL, type IpcLinkHub, type SyncWebContents } from '../../ipcLink'
// eslint-disable-next-line boundaries/dependencies -- 链路的两半（主进程的窗口链路表与 preload 的桥）在一个用例里接起来
import { createSyncBridge, type SyncIpcRenderer } from '../../../../../preload/syncBridge'

type Listener = (...args: any[]) => void

function json<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等微任务 / 宏任务都跑完几轮 */
export async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index++) await sleep(0)
}

/** 轮询直到 `check` 为真；超时抛错 */
export async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`)
    await sleep(2)
  }
}

/** 每一帧都能 JSON 往返（严格 JSON：没有 undefined / 函数 / 循环） */
export function jsonRoundTrips(value: unknown): boolean {
  return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value)
}

/** 窗口链路要盯的事件（它们的监听器数应该跟着链路走） */
export const WINDOW_EVENTS = ['destroyed', 'render-process-gone', 'did-navigate'] as const

export class FakeWebContents extends EventEmitter implements SyncWebContents {
  destroyed = false
  /** `send` 抛错（发帧时窗口已经不在 / IPC 坏了） */
  throwOnSend = false
  /** 每次 `send` 的（通道，参数） */
  readonly sent: Array<[string, ...unknown[]]> = []
  /** 渲染端监听器（`ipcRenderer.on`）：通道 → 监听器 */
  readonly rendererListeners = new Map<string, Set<Listener>>()

  constructor(readonly id: number) {
    super()
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.throwOnSend) throw new Error(`send to webContents ${this.id} failed`)
    this.sent.push([channel, ...args])
    const copy = json(args)
    queueMicrotask(() => {
      for (const listener of [...(this.rendererListeners.get(channel) ?? [])]) {
        listener({ sender: 'main' }, ...copy)
      }
    })
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  /** 销毁：先标记、再发 `destroyed`（与 Electron 一致） */
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }

  /** 渲染进程没了 */
  crash(): void {
    this.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  }

  /** 主框架跨文档导航落定（重载 / 换页） */
  navigate(url = 'app://reloaded'): void {
    this.emit('did-navigate', {}, url)
  }

  /** `sync:frame` 这一路发给渲染端的（链路 id，帧） */
  frames(): Array<[string, unknown]> {
    return this.sent
      .filter(([channel]) => channel === SYNC_FRAME_CHANNEL)
      .map(([, link, frame]) => [link as string, frame])
  }

  /** 窗口链路盯的各事件此刻的监听器数 */
  windowListenerCounts(): Record<(typeof WINDOW_EVENTS)[number], number> {
    return {
      destroyed: this.listenerCount('destroyed'),
      'render-process-gone': this.listenerCount('render-process-gone'),
      'did-navigate': this.listenerCount('did-navigate')
    }
  }
}

export type IpcMainListener = (event: { sender: SyncWebContents }, ...args: unknown[]) => void

export class FakeIpcMain {
  readonly listeners = new Map<string, Set<IpcMainListener>>()
  /** `handle` 登记过的通道（视图同步不该有） */
  readonly handled: string[] = []

  on(channel: string, listener: IpcMainListener): this {
    let set = this.listeners.get(channel)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(listener)
    return this
  }

  handle(channel: string): void {
    this.handled.push(channel)
  }

  /** 以某个 webContents 的身份投递（参数 JSON 往返一遍） */
  emitFrom(sender: SyncWebContents, channel: string, ...args: unknown[]): void {
    const copy = json(args)
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener({ sender }, ...copy)
  }

  count(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0
  }
}

/** 把 ipcMain 的 `sync:frame` 直接接到一张窗口链路表上（不经 `registerSyncHandlers`） */
export function wireHub(ipcMain: FakeIpcMain, hub: IpcLinkHub): void {
  ipcMain.on(SYNC_FRAME_CHANNEL, (event, linkId, frame) => hub.receive(event.sender, linkId, frame))
}

export function fakeIpcRenderer(wc: FakeWebContents, ipcMain: FakeIpcMain): SyncIpcRenderer {
  return {
    send: (channel, ...args) => {
      const copy = json(args)
      queueMicrotask(() => ipcMain.emitFrom(wc, channel, ...copy))
    },
    on: (channel, listener) => {
      let set = wc.rendererListeners.get(channel)
      if (set === undefined) {
        set = new Set()
        wc.rendererListeners.set(channel, set)
      }
      set.add(listener)
    },
    removeListener: (channel, listener) => {
      wc.rendererListeners.get(channel)?.delete(listener)
    }
  }
}

export interface SyncWindow {
  readonly wc: FakeWebContents
  readonly renderer: SyncIpcRenderer
  readonly bridge: SyncLinkChannel
  readonly client: SyncClient
  /** 客户端的 warn 日志 */
  readonly warnings: string[]
}

/** 一个窗口：它的 syncClient 经 preload 的 `sync` 桥发 / 收 `sync:frame` */
export function syncWindow(
  wc: FakeWebContents,
  ipcMain: FakeIpcMain,
  options: Partial<Omit<SyncClientOptions, 'channel'>> = {}
): SyncWindow {
  const renderer = fakeIpcRenderer(wc, ipcMain)
  const bridge = createSyncBridge(renderer)
  const warnings: string[] = []
  const client = createSyncClient({
    channel: bridge,
    logger: { warn: (message) => warnings.push(message) },
    ...options
  })
  return { wc, renderer, bridge, client, warnings }
}

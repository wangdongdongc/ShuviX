/**
 * 视图同步的 IPC 夹具（P3-05）：假 webContents、假 ipcMain、每个窗口一个假 ipcRenderer，以及窗口里
 * **真的** chord 绑定（agent-runtime 的 `TestClient`）跑在 preload 的 `createSyncBridge` 上。
 *
 *  - `FakeWebContents`：EventEmitter（`on` / `once` / `removeListener` / `emit`）+ `send` spy +
 *    `isDestroyed()`；`send` 把参数 `structuredClone` 一遍、在微任务里交给这个窗口的渲染端监听器
 *    （Electron 的 IPC 一样是结构化克隆、异步到达）。
 *  - `FakeIpcMain`：只记 `handle(channel, fn)`。
 *  - `FakeIpcRenderer`：`invoke` 调记下的处理器（`event.sender = wc`，参数与回复各克隆一遍）；
 *    `on` / `removeListener` 管 `wc.send` 的接收者。
 *  - `syncWindow(...)`：一个窗口 = webContents + ipcRenderer + `sync` 桥 + 按目标建 chord 绑定。
 */
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import type { SyncChannel } from '@shuvix/chat-protocol/sync'
import type { SyncWireFrame } from '@shuvix/agent-runtime'
// eslint-disable-next-line boundaries/dependencies -- 冒烟用例让真的 preload 桥（渲染进程那一侧）接主进程的处理器
import { createSyncBridge, type SyncIpcRenderer } from '../../../../../preload/syncBridge'
import {
  TestClient,
  type TestBinding
} from '../../../../../../../../packages/agent-runtime/src/sync/__tests__/support/client'

export type { TestBinding }

type Listener = (...args: any[]) => void // eslint-disable-line @typescript-eslint/no-explicit-any

export class FakeWebContents extends EventEmitter {
  destroyed = false
  /** 渲染端监听器（`ipcRenderer.on`）：通道 → 监听器 */
  readonly rendererListeners = new Map<string, Set<Listener>>()
  readonly send = vi.fn((channel: string, ...args: unknown[]) => {
    const copy = structuredClone(args)
    queueMicrotask(() => {
      for (const listener of [...(this.rendererListeners.get(channel) ?? [])]) {
        listener({ sender: this }, ...copy)
      }
    })
  })

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  /** 销毁：先标记、再发 `destroyed`（与 Electron 一致） */
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }

  /** `sync:frame` 这一路收到的帧 */
  frames(): SyncWireFrame[] {
    return this.send.mock.calls
      .filter(([channel]) => channel === 'sync:frame')
      .map(([, frame]) => frame as SyncWireFrame)
  }
}

export class FakeIpcMain {
  readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  readonly handle = vi.fn(
    (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      this.handlers.set(channel, listener)
    }
  )

  /** 以某个 webContents 的身份调一个通道（参数与回复各结构化克隆一遍） */
  async invokeAs(sender: { id: number }, channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error(`No handler registered for '${channel}'`)
    const reply = await handler({ sender }, ...structuredClone(args))
    return structuredClone(reply)
  }
}

export function fakeIpcRenderer(wc: FakeWebContents, ipcMain: FakeIpcMain): SyncIpcRenderer {
  return {
    invoke: (channel, ...args) => ipcMain.invokeAs(wc, channel, ...args),
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
  readonly sync: SyncChannel
  readonly client: TestClient
  bind(target: SyncTarget): TestBinding
}

/** 一个窗口：它的 chord 客户端经 `sync` 桥调 `sync:invoke`、经 `sync.onFrame` 收帧 */
export function syncWindow(wc: FakeWebContents, ipcMain: FakeIpcMain): SyncWindow {
  const renderer = fakeIpcRenderer(wc, ipcMain)
  const sync = createSyncBridge(renderer)
  const client = new TestClient(
    `window:${wc.id}`,
    { invoke: (_clientId, target, call) => sync.invoke(target as SyncTarget, call as never) },
    {
      attach: (_clientId, receiver) => {
        sync.onFrame((frame) => receiver(frame as SyncWireFrame))
      }
    }
  )
  return { wc, renderer, sync, client, bind: (target) => client.bind(target) }
}

/** webContents 表 → `lookup` */
export function lookupOf(
  table: Map<number, FakeWebContents>
): (webContentsId: number) => FakeWebContents | undefined {
  return (id) => table.get(id)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等 hub 冲完缓存（宏任务）、IPC 送达（微任务） */
export async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index++) await sleep(0)
}

/** 每一帧都能 JSON 往返（严格 JSON：没有 undefined / 函数 / 循环） */
export function jsonRoundTrips(value: unknown): boolean {
  return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value)
}

/**
 * Chrome 侧边栏视图同步用例的夹具（pi 1.2 / chord2）：一条假的桥连接 + 一个假的 service worker（SW），把侧边栏的
 * 链路渠道（`SyncLinkChannel`，chat-ui 的 syncClient 跑在它上面）接到桌面的链路表（`chromeLinks` 的 hub）上。
 *
 *  - `FakeConn`：`ChromeLinkConnection` 的替身 —— `{id, ready, info, emitted[], emit}`。`emit` 记下（JSON 拷贝）每个
 *    桥事件，再在微任务里交给 `onEmit` 的监听器（真的桥连接是写 socket，一样是异步、拷贝）；`throwOnEmit` 让它抛错。
 *  - `FakeSw`：扮演 SW 的转发 ——
 *    - `panelChannel(panelId)` → 一个 {@link FakePanel}：它的 `channel` 发帧 = 在微任务里
 *      `hub.receive(conn, {panelId, link, frame})`（JSON 拷贝）；桌面 `conn.emit('sync.link', …)` 的帧按 `panelId`
 *      送回这个侧边栏。侧边栏没就绪（`up = false`）时发的帧丢掉（与 PanelLink.sendSync 一样）。
 *    - 记下每个侧边栏用过的链路 id；转发一帧 `bye`（侧边栏发的或桌面发的）时把那个 id 划掉（与 SW 一样）；
 *    - `closePanel(panelId)`：侧边栏端口断开 → 替它在用过的每条链路上补一帧 `bye`（SW 就是这么做的），之后它
 *      收不到也发不出任何帧；
 *    - `disconnect()`：桥连接断了 —— `hub.closeConnection(conn.id)`、连接不再 ready、链路记账作废、每个侧边栏
 *      down；`reconnect(conn)`：新的一条桥连接就绪 —— 每个侧边栏 up（之后的帧走新连接）。
 *  - 自由函数 `panelChannel(hub, conn, panelId)` / `closePanel(conn, panelId)`：同一条连接共用一个 `FakeSw`。
 */
import type { DesktopEventMap, SyncLinkEvent } from '@shuvix/chat-protocol/chromeBridge'
import type { JsonValue, SyncLinkChannel } from '@shuvix/chat-protocol/sync'
import type { ChromeLinkConnection, ChromeLinkHub } from '../../chromeLinks'

function json<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function isBye(frame: unknown): boolean {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    !Array.isArray(frame) &&
    (frame as { t?: unknown }).t === 'bye'
  )
}

export interface EmittedEvent {
  readonly name: string
  readonly params: unknown
}

type EmitListener = (name: string, params: unknown) => void

/** 桥连接的替身 */
export class FakeConn implements ChromeLinkConnection {
  ready = true
  info: { installId: string; runId: string } | undefined
  /** `emit` 抛错（写 socket 失败） */
  throwOnEmit = false
  /** 每次 `emit`（JSON 拷贝） */
  readonly emitted: EmittedEvent[] = []
  readonly #listeners = new Set<EmitListener>()

  constructor(
    readonly id: string,
    info: { installId: string; runId: string } | undefined = { installId: 'i1', runId: 'r1' }
  ) {
    this.info = info
  }

  emit<N extends keyof DesktopEventMap>(name: N, params: DesktopEventMap[N]): void {
    if (this.throwOnEmit) throw new Error(`emit on ${this.id} failed`)
    const copy = json(params)
    this.emitted.push({ name, params: copy })
    queueMicrotask(() => {
      for (const listener of [...this.#listeners]) listener(name, json(copy))
    })
  }

  /** 听 `emit`（微任务里送达）；返回注销 */
  onEmit(listener: EmitListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** 发过的 `sync.link` 事件（某个侧边栏的 / 全部） */
  syncEvents(panelId?: string): SyncLinkEvent[] {
    return this.emitted
      .filter((event) => event.name === 'sync.link')
      .map((event) => event.params as SyncLinkEvent)
      .filter((params) => panelId === undefined || params.panelId === panelId)
  }
}

/** 一个侧边栏（它那条端口 + 它的链路渠道） */
export interface FakePanel {
  readonly panelId: string
  readonly channel: SyncLinkChannel
  /** SW 记着的、这个侧边栏用过还没关的链路 id */
  readonly links: Set<string>
  /** 侧边栏发出、SW 转给桌面的帧：[链路 id, 帧] */
  readonly sent: Array<[string, unknown]>
  /** 侧边栏没就绪时发的帧（丢掉了） */
  readonly dropped: Array<[string, unknown]>
  /** 桌面发来、送到这个侧边栏的帧：[链路 id, 帧] */
  readonly received: Array<[string, unknown]>
  /** 端口关了 */
  readonly closed: boolean
  /** 侧边栏到桌面的连接此刻就绪 */
  readonly up: boolean
  /** 改连接状态（离开 ready = down，回到 ready = up；同样的状态再来一次什么也不发） */
  setUp(up: boolean, reason?: string): void
  /** 侧边栏关了（= `closePanel`） */
  close(): void
}

class Panel implements FakePanel {
  readonly links = new Set<string>()
  readonly sent: Array<[string, unknown]> = []
  readonly dropped: Array<[string, unknown]> = []
  readonly received: Array<[string, unknown]> = []
  closed = false
  up: boolean
  readonly channel: SyncLinkChannel
  readonly #frameListeners = new Set<(link: string, frame: JsonValue) => void>()
  readonly #downListeners = new Set<(reason: string) => void>()
  readonly #upListeners = new Set<() => void>()

  constructor(
    private readonly sw: FakeSw,
    readonly panelId: string
  ) {
    this.up = sw.conn?.ready === true
    this.channel = {
      send: (link, frame) => this.#send(link, frame),
      onFrame: (callback) => {
        const entry = (link: string, frame: JsonValue): void => callback(link, frame)
        this.#frameListeners.add(entry)
        return () => {
          this.#frameListeners.delete(entry)
        }
      },
      onDown: (callback) => {
        const entry = (reason: string): void => callback(reason)
        this.#downListeners.add(entry)
        return () => {
          this.#downListeners.delete(entry)
        }
      },
      onUp: (callback) => {
        const entry = (): void => callback()
        this.#upListeners.add(entry)
        return () => {
          this.#upListeners.delete(entry)
        }
      },
      isUp: () => this.up && !this.closed
    }
  }

  #send(link: string, frame: JsonValue): void {
    const conn = this.sw.conn
    if (this.closed || !this.up || conn === undefined) {
      this.dropped.push([link, json(frame)])
      return
    }
    const copy = json(frame)
    this.sent.push([link, copy])
    if (isBye(copy)) this.links.delete(link)
    else this.links.add(link)
    queueMicrotask(() => this.sw.hub.receive(conn, { panelId: this.panelId, link, frame: copy }))
  }

  /** 桌面的一帧到了（SW 已按 panelId 挑过） */
  deliver(link: string, frame: unknown): void {
    if (this.closed) return
    this.received.push([link, frame])
    if (isBye(frame)) this.links.delete(link)
    for (const listener of [...this.#frameListeners]) listener(link, json(frame) as JsonValue)
  }

  setUp(up: boolean, reason = 'desktop-offline'): void {
    if (this.closed || this.up === up) return
    this.up = up
    if (up) for (const listener of [...this.#upListeners]) listener()
    else for (const listener of [...this.#downListeners]) listener(`side panel link ${reason}`)
  }

  close(): void {
    this.sw.closePanel(this.panelId)
  }

  /** SW 替断开的端口补 bye、收线 */
  shutdown(): void {
    if (this.closed) return
    this.closed = true
    const conn = this.sw.conn
    const open = [...this.links]
    this.links.clear()
    this.#frameListeners.clear()
    this.#downListeners.clear()
    this.#upListeners.clear()
    if (conn === undefined || !conn.ready) return
    for (const link of open) {
      const frame = { t: 'bye', reason: 'side panel closed' }
      queueMicrotask(() => this.sw.hub.receive(conn, { panelId: this.panelId, link, frame }))
    }
  }
}

/** 假的 service worker：一条桥连接上的几个侧边栏 */
export class FakeSw {
  conn: FakeConn | undefined
  readonly panels = new Map<string, Panel>()
  #unlisten: (() => void) | undefined

  constructor(
    readonly hub: ChromeLinkHub,
    conn?: FakeConn
  ) {
    if (conn !== undefined) this.#attach(conn)
  }

  #attach(conn: FakeConn): void {
    this.#unlisten?.()
    this.conn = conn
    this.#unlisten = conn.onEmit((name, params) => {
      if (name !== 'sync.link' || this.conn !== conn) return
      const { panelId, link, frame } = (params ?? {}) as Partial<SyncLinkEvent>
      if (typeof panelId !== 'string' || typeof link !== 'string') return
      this.panels.get(panelId)?.deliver(link, frame)
    })
  }

  /** 一个侧边栏连进来（同一个 panelId 再连 = 页面刷新：旧的那个先关掉） */
  panelChannel(panelId: string): FakePanel {
    this.panels.get(panelId)?.shutdown()
    const panel = new Panel(this, panelId)
    this.panels.set(panelId, panel)
    return panel
  }

  /** 侧边栏端口断开：SW 替它在用过的每条链路上补一帧 bye */
  closePanel(panelId: string): void {
    const panel = this.panels.get(panelId)
    if (panel === undefined) return
    this.panels.delete(panelId)
    panel.shutdown()
  }

  /** 桥连接断了：桌面收掉这条连接上的链路，SW 的链路记账作废，每个侧边栏 down */
  disconnect(reason = 'desktop-offline'): void {
    const conn = this.conn
    if (conn === undefined) return
    conn.ready = false
    this.hub.closeConnection(conn.id)
    this.#unlisten?.()
    this.#unlisten = undefined
    this.conn = undefined
    for (const panel of this.panels.values()) {
      panel.links.clear()
      panel.setUp(false, reason)
    }
  }

  /** 新的一条桥连接就绪：每个侧边栏 up（之后的帧走它） */
  reconnect(conn: FakeConn): void {
    this.#attach(conn)
    for (const panel of this.panels.values()) panel.setUp(true)
  }
}

const sws = new WeakMap<FakeConn, FakeSw>()

function swOf(hub: ChromeLinkHub, conn: FakeConn): FakeSw {
  let sw = sws.get(conn)
  if (sw === undefined || sw.hub !== hub) {
    sw = new FakeSw(hub, conn)
    sws.set(conn, sw)
  }
  return sw
}

/** 一条连接上的一个侧边栏的链路渠道（同一条连接共用一个 FakeSw） */
export function panelChannel(hub: ChromeLinkHub, conn: FakeConn, panelId: string): FakePanel {
  return swOf(hub, conn).panelChannel(panelId)
}

/** 关掉 `panelChannel` 开的那个侧边栏 */
export function closePanel(conn: FakeConn, panelId: string): void {
  sws.get(conn)?.closePanel(panelId)
}

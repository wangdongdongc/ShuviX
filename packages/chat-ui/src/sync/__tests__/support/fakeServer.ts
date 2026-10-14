/**
 * 视图同步钩子用例的服务端一侧（pi 1.2 / chord2）：一个**真的** chord2 宿主（名字 `main`），用与产品相同的远程契约
 * （`shuvix.session-view` / `shuvix.agent-view`）交出测试可控的视图，经 {@link linkChannel} 包成一条
 * `SyncLinkChannel`（帧 JSON 往返一遍、在微任务里送达，与 IPC 一样异步）。
 *
 * 与产品的视图服务端（agent-runtime 的 `viewServer`）的区别：这里的状态完全由测试摆布 ——
 *  - `serve(target, view)`：给一个目标装上初始值（第一次持有之前调）；
 *  - `change(target, draft => …)`：改服务端的值（一次修订，客户端收到增量）；
 *  - `replace(target, view)`：换一份新的值（整份），可用性回到 `available`；
 *  - `withdraw(target)`：`availability = 'unavailable'`（会话被删 / 对话没了）；
 *  - `reset(holdId)`：把同一份值整份再发一次（客户端收到一个 reset 帧）；
 *  - `failSubscribe(code)`：下一次新建的视图记录以这个码失败（`not_found` → chord 的「找不到」；其余当 chord 码；
 *    不给 → 一个没有码的普通错误，chord 记成 `unavailable`）。
 *
 * 记录：`calls`（`subscribe:<holdId>` / `unsubscribe:<holdId>`，按链路上的 hold / release 帧记）、
 * `subscriptions(target)`（还持有着的 hold）、`frameListeners`（渠道 onFrame 的登记 / 注销）、`sent`（客户端
 * 发出的每一帧，`[链路 id, 帧, 时刻]`）。
 *
 * 链路 / 传输的摆布（{@link linkChannel} 的，`fakeServer` 原样转交）：
 *  - `setUp(bool)`：传输断开 / 恢复（驱动渠道的 `isUp` / `onDown` / `onUp`；断开时服务端这头的链路一起结束、
 *    两个方向的帧都丢掉）；
 *  - `endServerLink(id, {bye})`：服务端结束一条链路（带 `bye` = 客户端当场知道；不带 = 悄悄没了，客户端只能靠
 *    ping 超时发现）；
 *  - `inject(linkId, frame)`：直接往客户端塞一帧；
 *  - `setDeaf(bool)`：服务端不再读客户端的帧（不建链路、不应答 —— 「新链路一帧都收不到」）；
 *  - `delayDown(match)` / `releaseDown()`：服务端发往客户端的帧里匹配的先扣下、再按序放行（调换两个订阅的先后）；
 *  - `throwOnSend(match)`：渠道的 `send` 对匹配的帧抛错（传输坏了）；
 *  - `fakeServer` 自己的：`close()`（`host.close`：服务端的记录被强制拿走 = gone，链路随后带 `bye` 关掉）、
 *    `refuseAllLinks()`（每条新链路一来就带 `bye` 关掉）。
 */
import {
  ChordError,
  cell,
  createHost,
  local,
  replicatedState,
  type BehaviorOf,
  type ChordErrorCode,
  type Draft,
  type MutableReplicatedState
} from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from 'typebox'
import {
  AgentViewContract,
  AvailabilitySchema,
  FrameLink,
  notFoundError,
  SessionViewContract,
  VIEW_SERVER_HOST,
  type ViewAvailability
} from '@shuvix/agent-runtime/sync/viewContracts'
import {
  SYNC_NOT_FOUND,
  syncTargetKey,
  type JsonValue,
  type SyncLinkChannel,
  type SyncTarget
} from '@shuvix/chat-protocol/sync'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'

type View = SessionView | AgentView

function json<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

// ─── 渠道 ⇄ 服务端链路 ─────────────────────────────────

/** 线上的一帧（JSON 副本） */
export type WireFrame = { t?: unknown; [key: string]: unknown }

/** 客户端发出的一帧：`[链路 id, 帧, 交给渠道时的 Date.now()]` */
export type SentFrame = [linkId: string, frame: WireFrame, at: number]

export type FrameMatch = (linkId: string, frame: WireFrame) => boolean

export interface LinkChannel {
  readonly channel: SyncLinkChannel
  /** onFrame 登记 / 注销的次数 */
  readonly frameListeners: { registered: number; unregistered: number; active: number }
  /**
   * 客户端交给渠道的每一帧（`send` 时同步记下，JSON 副本；传输断着、服务端聋着时交来的也记 —— 「什么都没发出去」
   * 就看这里）。`throwOnSend` 抛掉的不记
   */
  readonly sent: SentFrame[]
  /** 服务端此刻开着的链路 id */
  links(): string[]
  /**
   * 传输断开 / 恢复：`false` → 服务端这头的链路全部结束（不发 bye）、再通知渠道的 `onDown`；`true` → 通知 `onUp`。
   * 断着时两个方向的帧都丢掉。状态没变 = 什么都不做
   */
  setUp(up: boolean, reason?: string): void
  /** 服务端结束一条链路：`bye`（缺省 true）= 先给客户端发 `bye`；false = 悄悄结束 */
  endServerLink(linkId: string, options?: { bye?: boolean }): void
  /** 往客户端塞一帧（微任务里送达，不受断开 / 扣帧影响） */
  inject(linkId: string, frame: unknown): void
  /** 服务端聋了：客户端的帧照记 `sent`，但服务端一帧都不读（不建链路、不应答） */
  setDeaf(deaf: boolean): void
  /** 服务端发往客户端的帧里，匹配的先扣下（`undefined` = 不再扣；已扣的留着等 `releaseDown`） */
  delayDown(match: FrameMatch | undefined): void
  /** 按原顺序放行扣下的帧 */
  releaseDown(): void
  /** 渠道的 `send` 对匹配的帧同步抛错（`undefined` = 不再抛） */
  throwOnSend(match: FrameMatch | undefined): void
}

/**
 * 一条进程内的 `SyncLinkChannel`：客户端每条新链路的第一帧（`hello`）在服务端这头建一条 `FrameLink` 交给
 * `accept`；之后两个方向的帧都 JSON 往返、在微任务里送达。`tap` 看客户端发来的每一帧（服务端收之前）。
 */
export function linkChannel(
  accept: (link: FrameLink, linkId: string) => void,
  tap?: (linkId: string, frame: { t?: unknown; [key: string]: unknown }) => void
): LinkChannel {
  const listeners = new Set<(link: string, frame: JsonValue) => void>()
  const downListeners = new Set<(reason: string) => void>()
  const upListeners = new Set<() => void>()
  const serverLinks = new Map<string, FrameLink>()
  const frameListeners = { registered: 0, unregistered: 0, active: 0 }
  const sent: SentFrame[] = []
  let up = true
  let deaf = false
  let delayMatch: FrameMatch | undefined
  const delayed: [string, JsonValue][] = []
  let throwMatch: FrameMatch | undefined

  const deliverToClient = (linkId: string, copy: JsonValue): void => {
    queueMicrotask(() => {
      for (const listener of [...listeners]) listener(linkId, copy)
    })
  }

  const toClient = (linkId: string, frame: unknown): void => {
    if (!up) return
    const copy = json(frame) as JsonValue
    if (delayMatch?.(linkId, copy as WireFrame)) {
      delayed.push([linkId, copy])
      return
    }
    deliverToClient(linkId, copy)
  }

  const subscribe = <L>(set: Set<L>, listener: L): (() => void) => {
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  const channel: SyncLinkChannel = {
    send(linkId, frame) {
      const copy = json(frame) as WireFrame
      if (throwMatch?.(linkId, copy)) throw new Error(`fake transport: send refused on ${linkId}`)
      sent.push([linkId, copy, Date.now()])
      if (!up || deaf) return
      queueMicrotask(() => {
        if (!up || deaf) return
        let link = serverLinks.get(linkId)
        if (link === undefined) {
          if (copy.t !== 'hello') return
          const created = new FrameLink(
            (out) => toClient(linkId, out),
            () => {
              if (serverLinks.get(linkId) === created) serverLinks.delete(linkId)
            }
          )
          link = created
          serverLinks.set(linkId, created)
          accept(created, linkId)
        }
        tap?.(linkId, copy)
        link.deliver(copy)
      })
    },
    onFrame(callback) {
      frameListeners.registered += 1
      frameListeners.active += 1
      const entry = (link: string, frame: JsonValue): void => callback(link, frame)
      listeners.add(entry)
      let removed = false
      return () => {
        if (removed) return
        removed = true
        frameListeners.unregistered += 1
        frameListeners.active -= 1
        listeners.delete(entry)
      }
    },
    onDown: (callback) => subscribe(downListeners, callback),
    onUp: (callback) => subscribe(upListeners, callback),
    isUp: () => up
  }
  return {
    channel,
    frameListeners,
    sent,
    links: () => [...serverLinks.keys()],
    setUp(next, reason = 'test transport down') {
      if (next === up) return
      up = next
      if (!next) {
        for (const link of [...serverLinks.values()]) link.ended('transport down')
        for (const listener of [...downListeners]) listener(reason)
      } else {
        for (const listener of [...upListeners]) listener()
      }
    },
    endServerLink(linkId, options = {}) {
      const link = serverLinks.get(linkId)
      if (link === undefined) throw new Error(`linkChannel: no server link ${linkId}`)
      if (options.bye === false) link.ended('server ended the link')
      else link.close('server ended the link')
    },
    inject(linkId, frame) {
      deliverToClient(linkId, json(frame) as JsonValue)
    },
    setDeaf(next) {
      deaf = next
    },
    delayDown(match) {
      delayMatch = match
    },
    releaseDown() {
      for (const [linkId, copy] of delayed.splice(0)) deliverToClient(linkId, copy)
    },
    throwOnSend(match) {
      throwMatch = match
    }
  }
}

/** 只等微任务（假定时器下也能用 —— `settle()` 等的是宏任务，假定时器下不会走） */
export async function microtasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

// ─── 可控的视图服务端 ───────────────────────────────────

interface Served {
  state: MutableReplicatedState<View>
  availability: ViewAvailability
  /** 递增：每次 reset 要求整份重发 */
  resets: number
  readonly listeners: Set<() => void>
}

export interface FakeServerOptions {
  /** 旧版的「订阅回复之前先发几帧」—— chord2 的链路上没有这回事，保留只为不改调用方 */
  framesBeforeReply?: number
}

export interface FakeServer extends Pick<
  LinkChannel,
  | 'sent'
  | 'links'
  | 'setUp'
  | 'endServerLink'
  | 'inject'
  | 'setDeaf'
  | 'delayDown'
  | 'releaseDown'
  | 'throwOnSend'
> {
  readonly channel: SyncLinkChannel
  /** 链路上的持有：`subscribe:<holdId>` / `unsubscribe:<holdId>` */
  readonly calls: string[]
  readonly frameListeners: { registered: number; unregistered: number; active: number }
  /** 关掉服务端宿主（`host.close`）：每个记录被强制拿走（客户端句柄 gone），之后链路带 `bye` 关掉 */
  close(): Promise<void>
  /** 之后每条新链路一来就带 `bye` 关掉（`false` = 不再拒） */
  refuseAllLinks(refuse?: boolean): void
  serve(target: SyncTarget, view: View): void
  value(target: SyncTarget): View
  change(target: SyncTarget, mutate: (draft: Draft<View>) => void): void
  replace(target: SyncTarget, view: View): void
  withdraw(target: SyncTarget): void
  failSubscribe(code?: string): void
  /** 把这个持有所在目标的值整份再发一次 */
  reset(holdId: string): void
  /** 还持有着的 hold（按目标） */
  subscriptions(target?: SyncTarget): string[]
  /** 等微任务 / 宏任务都跑完 */
  settle(): Promise<void>
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const FakeSource = local('test.fake-view-source', {
  version: 1,
  input: Type.Object({ key: Type.String() }),
  members: { view: Type.Unknown(), availability: AvailabilitySchema }
})

export function fakeServer(_options: FakeServerOptions = {}): FakeServer {
  const served = new Map<string, Served>()
  const calls: string[] = []
  /** 活着的持有：`<linkId>#<holdId>` → 目标键 */
  const holds = new Map<string, { id: string; key: string }>()
  let failNext: { code?: string } | undefined
  let refusing = false

  const host = createHost({ name: VIEW_SERVER_HOST, onError: () => {} })

  const entryOf = (target: SyncTarget): Served => {
    const entry = served.get(syncTargetKey(target))
    if (!entry) throw new Error(`fakeServer: no view served for ${syncTargetKey(target)}`)
    return entry
  }
  const notify = (entry: Served): void => {
    for (const listener of [...entry.listeners]) listener()
  }

  host.serve(FakeSource, ({ key }, _principal, self) => {
    const initial = served.get(key)
    const cells = self.state({
      view: cell(Type.Unknown(), (initial?.state.value ?? null) as unknown),
      availability: cell(AvailabilitySchema, initial?.availability ?? 'unavailable')
    })
    self.tasks({
      bridge: async (ctx) => {
        const entry = served.get(key)
        if (entry === undefined) return
        let current: MutableReplicatedState<View> | undefined
        let resets = entry.resets
        let stop: (() => void) | undefined
        const sync = (): void => {
          if (ctx.signal.aborted) return
          if (current !== entry.state) {
            stop?.()
            current = entry.state
            const state = entry.state
            cells.view.replace(ctx, state.value)
            stop = state.subscribe((value) => {
              if (ctx.signal.aborted || current !== state || value === cells.view.value) return
              cells.view.replace(ctx, value, { diff: true })
            })
          } else if (resets !== entry.resets) {
            // 真的整份重发：订阅者收到一个 reset（线上是 `{t:'state', reset}`，服务端的增量编码随之重来）。
            // `replace` 不行 —— 值没变就没有 op，什么都不发
            cells.view.reset(json(entry.state.value), cells.view.schema)
          }
          resets = entry.resets
          if (cells.availability.value !== entry.availability) {
            cells.availability.replace(ctx, entry.availability)
          }
        }
        sync()
        entry.listeners.add(sync)
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve()
          else ctx.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        entry.listeners.delete(sync)
        stop?.()
      }
    })
    return { view: cells.view, availability: cells.availability }
  })

  const refuse = (): void => {
    if (failNext === undefined) return
    const { code } = failNext
    failNext = undefined
    if (code === undefined) throw new Error('subscribe refused (no code)')
    if (code === SYNC_NOT_FOUND) throw notFoundError('subscribe refused (not found)')
    throw new ChordError(code as ChordErrorCode, `subscribe refused (${code})`)
  }

  host.serve(SessionViewContract, ({ sessionId }, _principal, self) => {
    refuse()
    const source = self.get(FakeSource, { key: syncTargetKey({ kind: 'session', sessionId }) })
    return {
      kind: 'owner',
      view: source.view,
      availability: source.availability
    } as unknown as BehaviorOf<typeof SessionViewContract>
  })
  host.serve(AgentViewContract, ({ agentId }, _principal, self) => {
    refuse()
    const source = self.get(FakeSource, { key: syncTargetKey({ kind: 'agent', agentId }) })
    return {
      kind: 'owner',
      view: source.view,
      availability: source.availability
    } as unknown as BehaviorOf<typeof AgentViewContract>
  })

  const keyOfHold = (frame: { [key: string]: unknown }): string | undefined => {
    const name = (frame.token as { name?: unknown } | undefined)?.name
    const input = (frame.input ?? {}) as { sessionId?: unknown; agentId?: unknown }
    if (name === SessionViewContract.name && typeof input.sessionId === 'string') {
      return syncTargetKey({ kind: 'session', sessionId: input.sessionId })
    }
    if (name === AgentViewContract.name && typeof input.agentId === 'string') {
      return syncTargetKey({ kind: 'agent', agentId: input.agentId })
    }
    return undefined
  }

  const wire = linkChannel(
    (link, linkId) => {
      // 链路怎么结束的都一样（客户端 bye、服务端结束、传输断开、被拒）：它上面的持有都不在了
      link.onClose(() => {
        for (const hold of [...holds.keys()]) if (hold.startsWith(`${linkId}#`)) holds.delete(hold)
      })
      if (refusing) link.close('refused')
      else host.accept(link, { principal: { kind: 'test' }, kind: 'client' })
    },
    (linkId, frame) => {
      if (frame.t === 'hold') {
        const id = String(frame.id)
        const key = keyOfHold(frame)
        calls.push(`subscribe:${id}`)
        if (key !== undefined) holds.set(`${linkId}#${id}`, { id, key })
      } else if (frame.t === 'release') {
        const id = String(frame.id)
        calls.push(`unsubscribe:${id}`)
        holds.delete(`${linkId}#${id}`)
      } else if (frame.t === 'bye') {
        for (const hold of [...holds.keys()]) if (hold.startsWith(`${linkId}#`)) holds.delete(hold)
      }
    }
  )

  return {
    channel: wire.channel,
    calls,
    frameListeners: wire.frameListeners,
    sent: wire.sent,
    links: wire.links,
    setUp: wire.setUp,
    endServerLink: wire.endServerLink,
    inject: wire.inject,
    setDeaf: wire.setDeaf,
    delayDown: wire.delayDown,
    releaseDown: wire.releaseDown,
    throwOnSend: wire.throwOnSend,
    close: () => host.close(),
    refuseAllLinks: (refuse = true) => {
      refusing = refuse
    },
    serve: (target, view) => {
      served.set(syncTargetKey(target), {
        state: replicatedState<View>(json(view)),
        availability: 'available',
        resets: 0,
        listeners: new Set()
      })
    },
    value: (target) => entryOf(target).state.value,
    change: (target, mutate) => {
      const entry = entryOf(target)
      entry.state.change(BACKGROUND_CONTEXT, (draft) => mutate(draft as Draft<View>))
    },
    replace: (target, view) => {
      const entry = entryOf(target)
      entry.state = replicatedState<View>(json(view))
      entry.availability = 'available'
      notify(entry)
    },
    withdraw: (target) => {
      const entry = entryOf(target)
      entry.availability = 'unavailable'
      notify(entry)
    },
    failSubscribe: (code) => {
      failNext = code === undefined ? {} : { code }
    },
    reset: (holdId) => {
      const hold = [...holds.values()].find((h) => h.id === holdId)
      if (!hold) throw new Error(`fakeServer: no hold ${holdId}`)
      const entry = served.get(hold.key)!
      entry.resets += 1
      notify(entry)
    },
    subscriptions: (target) =>
      [...holds.values()]
        .filter((h) => target === undefined || h.key === syncTargetKey(target))
        .map((h) => h.id),
    settle: async () => {
      for (let i = 0; i < 6; i++) await tick()
    }
  }
}

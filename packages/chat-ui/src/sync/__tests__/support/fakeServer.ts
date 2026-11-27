/**
 * 视图同步钩子用例的服务端一侧（Chord 1.6.1 / v2）：一个**真的** chord v2 宿主（地址 `VIEW_SERVER_ADDRESS`），
 * 用与产品相同的远程契约（`shuvix.session-view` / `shuvix.agent-view`）交出测试可控的视图，经 {@link linkChannel}
 * 包成一条 `SyncLinkChannel`（帧 JSON 往返一遍、在微任务里送达，与 IPC 一样异步）。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { diffRevisions, type Draft, type Op } from '@earendil-works/chord/delta'
import type { JsonValue as ChordJsonValue } from '@earendil-works/chord/json'
import {
  AgentViewContract,
  ChordError,
  createHost,
  defineFacet,
  forbidden,
  FrameLink,
  notFoundError,
  SessionViewContract,
  VIEW_LINK_CODEC,
  VIEW_SERVER_ADDRESS,
  type ChordErrorCode,
  type FollowObserver,
  type ViewAvailability
} from '@shuvix/agent-runtime/sync/viewContracts'
import {
  replicatedState,
  type MutableReplicatedState
} from '../../../../../agent-runtime/src/sync/replicatedState'
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
export type WireFrame = { t?: unknown; d?: unknown; [key: string]: unknown }

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
  tap?: (linkId: string, frame: WireFrame) => void
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
  /** 关掉服务端宿主（`host.close`）：每个对象被强制结束，之后链路带 `bye` 关掉 */
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

export function fakeServer(_options: FakeServerOptions = {}): FakeServer {
  const served = new Map<string, Served>()
  const calls: string[] = []
  /** 活着的持有：`<linkId>#<holdId>` → 目标键 */
  const holds = new Map<string, { id: string; key: string }>()
  let failNext: { code?: string } | undefined
  let refusing = false
  let closed = false

  const host = createHost({
    address: VIEW_SERVER_ADDRESS,
    principal: { kind: 'host' },
    revokedBy: () => ['disposed'],
    onError: () => {}
  })

  const entryOf = (target: SyncTarget): Served => {
    const entry = served.get(syncTargetKey(target))
    if (!entry) throw new Error(`fakeServer: no view served for ${syncTargetKey(target)}`)
    return entry
  }
  const notify = (entry: Served): void => {
    for (const listener of [...entry.listeners]) listener()
  }

  const refuse = (): void => {
    if (failNext === undefined) return
    const { code } = failNext
    failNext = undefined
    if (code === undefined) throw new Error('subscribe refused (no code)')
    if (code === SYNC_NOT_FOUND) throw notFoundError('subscribe refused (not found)')
    if (code === 'forbidden') throw forbidden('subscribe refused (forbidden)')
    throw new ChordError({
      code: code as Exclude<ChordErrorCode, 'invalid'>,
      message: `subscribe refused (${code})`
    })
  }

  const facet = defineFacet((fHost) => {
    const attach = (
      key: string,
      self: Parameters<Parameters<typeof fHost.serve<typeof SessionViewContract>>[1]>[2]
    ): {
      readonly view: ReturnType<typeof self.follow<unknown>>
      readonly availability: ReturnType<typeof self.follow<ViewAvailability>>
    } => {
      const bridgeNative = self.open(
        async () => {
          const entry = served.get(key)
          let viewValue: unknown = entry?.state.value ?? null
          let availValue: ViewAvailability = entry?.availability ?? 'unavailable'
          let current: MutableReplicatedState<View> | undefined
          let resets = entry?.resets ?? 0
          let stopState: (() => void) | undefined
          const viewObservers = new Set<FollowObserver<unknown>>()
          const availObservers = new Set<FollowObserver<unknown>>()

          const emitView = (next: unknown, ops: readonly Op[]): void => {
            viewValue = next
            if (ops.length === 0) return
            for (const obs of [...viewObservers]) {
              obs.advance({ kind: 'value', value: next, ops, retired: false }, BACKGROUND_CONTEXT)
            }
          }
          const emitAvail = (next: ViewAvailability): void => {
            if (availValue === next) return
            availValue = next
            for (const obs of [...availObservers]) {
              obs.advance(
                { kind: 'value', value: next, ops: [['r', next]], retired: false },
                BACKGROUND_CONTEXT
              )
            }
          }

          const sync = (): void => {
            if (entry === undefined) return
            if (current !== entry.state) {
              stopState?.()
              current = entry.state
              const state = entry.state
              emitView(state.value, [['r', state.value as unknown as ChordJsonValue]])
              stopState = state.subscribe((value, _ctx, delivery) => {
                if (current !== state || value === viewValue) return
                const ops =
                  delivery.ops.length > 0
                    ? delivery.ops
                    : diffRevisions(
                        viewValue as unknown as ChordJsonValue,
                        value as unknown as ChordJsonValue
                      )
                emitView(value, ops)
              })
            } else if (resets !== entry.resets) {
              const fresh = json(entry.state.value)
              emitView(fresh, [['r', fresh as unknown as ChordJsonValue]])
            }
            resets = entry.resets
            emitAvail(entry.availability)
          }

          if (entry !== undefined) {
            sync()
            entry.listeners.add(sync)
          }
          return {
            attachView: (obs: FollowObserver<unknown>) => {
              viewObservers.add(obs)
              return { value: viewValue, detach: () => void viewObservers.delete(obs) }
            },
            attachAvail: (obs: FollowObserver<unknown>) => {
              availObservers.add(obs)
              return { value: availValue, detach: () => void availObservers.delete(obs) }
            },
            close: () => {
              entry?.listeners.delete(sync)
              stopState?.()
              viewObservers.clear()
              availObservers.clear()
            }
          }
        },
        (bridge) => bridge.close()
      )

      const view = self.follow<unknown>(async (obs) => bridgeNative.value.attachView(obs))
      const availability = self.follow<ViewAvailability>(async (obs) =>
        bridgeNative.value.attachAvail(obs)
      )
      return { view, availability }
    }

    fHost.serve(SessionViewContract, ({ sessionId }, _principal, self) => {
      refuse()
      const members = attach(syncTargetKey({ kind: 'session', sessionId }), self)
      return { variant: 'owner', members } as never
    })
    fHost.serve(AgentViewContract, ({ agentId }, _principal, self) => {
      refuse()
      const members = attach(syncTargetKey({ kind: 'agent', agentId }), self)
      return { variant: 'owner', members } as never
    })
  })

  void host.load([{ name: 'test-fake-server', facet }], BACKGROUND_CONTEXT)

  const keyOfHold = (frame: WireFrame): { id: string; key: string | undefined } | undefined => {
    const tuple = Array.isArray(frame.d) ? frame.d : undefined
    if (!tuple || tuple[0] !== 'H') return undefined
    const id = String(tuple[1])
    const name = tuple[2]
    const part = Array.isArray(tuple[5]) ? tuple[5][1] : undefined
    const input = (part ?? {}) as { sessionId?: unknown; agentId?: unknown }
    if (name === SessionViewContract.name && typeof input.sessionId === 'string') {
      return { id, key: syncTargetKey({ kind: 'session', sessionId: input.sessionId }) }
    }
    if (name === AgentViewContract.name && typeof input.agentId === 'string') {
      return { id, key: syncTargetKey({ kind: 'agent', agentId: input.agentId }) }
    }
    return { id, key: undefined }
  }

  const wire = linkChannel(
    (link, linkId) => {
      link.onClose(() => {
        for (const hold of [...holds.keys()]) if (hold.startsWith(`${linkId}#`)) holds.delete(hold)
      })
      if (refusing || closed) link.close('refused')
      else
        host.accept(
          link,
          { principal: { kind: 'test' }, codec: VIEW_LINK_CODEC },
          BACKGROUND_CONTEXT
        )
    },
    (linkId, frame) => {
      if (frame.t === 'hold') {
        const parsed = keyOfHold(frame)
        if (parsed !== undefined) {
          calls.push(`subscribe:${parsed.id}`)
          if (parsed.key !== undefined) {
            holds.set(`${linkId}#${parsed.id}`, { id: parsed.id, key: parsed.key })
          }
        }
      } else if (frame.t === 'release') {
        const tuple = Array.isArray(frame.d) ? frame.d : undefined
        const id = tuple ? String(tuple[1]) : ''
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
    close: async () => {
      if (closed) return
      closed = true
      host.revoke('disposed', BACKGROUND_CONTEXT)
      await host.close(BACKGROUND_CONTEXT)
    },
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

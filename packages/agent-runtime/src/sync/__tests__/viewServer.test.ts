/**
 * 视图服务端（`viewServer`，pi 1.2 / chord2）—— 假会话宿主（`support/viewRig` 的 `fakeViewHost`：会话的根 / 派生
 * agent 投影器是真的 chord `replicatedState` 上的引用计数 `acquire()`）+ 真的 chord 客户端宿主（窃听链路上的
 * `rawClient`）。编号对着测试设计（docs/pi12/sync-chord2-design.md 的用例清单，第 2 节）：
 *
 *   基础      VS-1 … VS-8   快照 → 增量（`{diff:true}`）、两条链路、晚加入、同一主体两条链路、放手、进程内 get、
 *                           非法输入、会话目标不解析 agent
 *   激活与钉住 VS-10 … VS-18 先钉住再 peek、第一份快照就是真视图、激活失败不漏租约、被放弃的激活、peek 里报打开、
 *                           开 / 关与激活赛跑、事件太多时的上限、激活与上线之间的修订
 *   生命周期  VS-20 … VS-34 none → live、关闭留静态值（PIN-13）、invalidate、清空（destroy）、agent 目标销毁、删除
 *                           （PIN-14）与它的各种时序、删除之后同一个 id 复活、同一实例 / 新实例的重开、agent 目标
 *   旧格式与封存 VS-40 … VS-45
 *   客户端离开 VS-50 … VS-52 链路结束 / bye（PIN-21）、发送抛错、ping 超时
 *   主体核对  VS-60 … VS-67 缺省都让看、同步拒绝、按（主体，目标）记录只核一次、异步通过 / 拒绝 / 抛错、删了的
 *                           id 遇上不让看的主体
 *   处置      VS-70
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isChordError, type Frame, type HandleStatus } from '@earendil-works/chord'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import {
  emptySessionView,
  type AgentView,
  type SessionView
} from '@shuvix/chat-protocol/types/sessionView'
import { isJsonOnly } from '@shuvix/chat-protocol/utils/jsonOnly'
import { legacySessionView } from '../services'
import { isNotFoundError, SessionViewContract, VIEW_SERVER_HOST } from '../viewContracts'
import type { ViewPrincipal, ViewServer, ViewServerDeps } from '../viewServer'
import {
  agentView,
  durableView,
  fakeViewHost,
  isViewStateFrame,
  rawClient,
  recordingLogger,
  serverFor,
  settle,
  sleep,
  stream,
  tappedLinkPair,
  until,
  type FakeViewHost,
  type FakeViewHostOptions,
  type RawClient,
  type TestView
} from './support/viewRig'

const S1: SyncTarget = { kind: 'session', sessionId: 's1' }
const S2: SyncTarget = { kind: 'session', sessionId: 's2' }
const A1: SyncTarget = { kind: 'agent', agentId: 'a1' }
const W1: ViewPrincipal = { kind: 'window', webContentsId: 1 }
const W2: ViewPrincipal = { kind: 'window', webContentsId: 2 }

let servers: ViewServer[] = []
let clients: RawClient[] = []

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => undefined)
  for (const server of servers) await server.dispose().catch(() => undefined)
  clients = []
  servers = []
})

interface Rig {
  readonly host: FakeViewHost
  readonly server: ViewServer
  readonly logs: string[]
  connect(principal?: ViewPrincipal): RawClient
}

function rig(
  options: { host?: FakeViewHostOptions; deps?: Partial<Omit<ViewServerDeps, 'host'>> } = {}
): Rig {
  const host = fakeViewHost(options.host)
  const { logs, logger } = recordingLogger()
  const server = serverFor(host, { logger, ...options.deps })
  servers.push(server)
  return {
    host,
    server,
    logs,
    connect: (principal = W1) => {
      const client = rawClient(server, principal)
      clients.push(client)
      return client
    }
  }
}

/** 等句柄活过来、视图到了 */
async function live<V>(view: TestView<V>, what = 'live'): Promise<V> {
  await until(() => view.status() === 'live' && view.value() !== undefined, what)
  return view.value() as V
}

/** 等句柄失败，交回错误 */
async function failed(view: TestView<unknown>): Promise<unknown> {
  const error = await view.settled()
  expect(error).toBeDefined()
  return error
}

const codeOf = (error: unknown): string | undefined =>
  isChordError(error) ? error.code : (error as { code?: string } | undefined)?.code

/** 客户端在某个成员上的订阅 id（`sub` 帧） */
function subIds(client: RawClient, member: 'view' | 'availability'): number[] {
  return client
    .up()
    .filter((f) => f.t === 'sub' && (f as { member: string }).member === member)
    .map((f) => (f as { id: number }).id)
}

/** 服务端在视图订阅上发来的 state 帧 */
function viewStateFrames(client: RawClient): Frame[] {
  const ids = new Set(subIds(client, 'view'))
  return client.down().filter((f) => f.t === 'state' && ids.has((f as { id: number }).id))
}

const opsFramesOf = (client: RawClient): Frame[] =>
  viewStateFrames(client).filter((f) => (f as { ops?: unknown }).ops !== undefined)

const holdFrames = (client: RawClient): Frame[] => client.up().filter((f) => f.t === 'hold')

const acquires = (host: FakeViewHost): string[] => host.log.filter((e) => e.startsWith('acquire:'))

/** 一份有点分量的视图（VS-1 比帧大小用） */
function heavyView(sessionId: string): SessionView {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    id: String(index + 1),
    sessionId,
    role: 'user' as const,
    type: 'text' as const,
    content: `message ${index} `.repeat(30),
    model: '',
    createdAt: index,
    metadata: null
  })) as unknown as ChatMessage[]
  return { ...durableView(sessionId), messages }
}

// ─── 基础 ──────────────────────────────────────────────

describe('VS basics', () => {
  it('VS-1 first value is the projector value; snap → reset → ops; a deep change is a small diff (no root replace)', async () => {
    const { host, connect } = rig()
    const session = host.add('s1', heavyView('s1'))
    stream.start(session.root.state)
    const client = connect()
    const view = client.get<SessionView>(S1)
    const first = await live(view)
    expect(view.values()[0]).toEqual(session.root.value)
    expect(first.messages).toHaveLength(12)
    expect(await until(() => view.avail(), 'availability')).toBe('available')

    stream.append(session.root.state, 'hello there')
    await until(() => view.value()?.live?.message.content === 'hello there', 'delta applied')
    await settle()
    expect(view.events).toEqual(['snap', 'reset', 'ops'])
    expect(view.value()).toEqual(session.root.value)

    const frames = viewStateFrames(client)
    const snapshot = frames.find(
      (f) =>
        (f as { snap?: unknown }).snap !== undefined ||
        (f as { reset?: unknown }).reset !== undefined
    )!
    const delta = frames.filter((f) => (f as { ops?: unknown }).ops !== undefined)
    expect(delta).toHaveLength(1)
    const ops = (delta[0] as unknown as { ops: unknown[][] }).ops
    expect(ops.some((op) => op[0] === 'r')).toBe(false)
    expect(JSON.stringify(delta[0]).length).toBeLessThan(JSON.stringify(snapshot).length / 4)
  })

  it('VS-2 two links (window:1, window:2): one peek, one acquire, both converge; each link sees only its own holds', async () => {
    const { host, connect } = rig()
    const session = host.add('s1')
    const a = connect(W1)
    const b = connect(W2)
    const va = a.get<SessionView>(S1)
    const vb = b.get<SessionView>(S1)
    await live(va)
    await live(vb)
    expect(host.peeks).toEqual(['s1'])
    expect(acquires(host)).toHaveLength(1)

    stream.answer(session.root.state, ['one', ' two'], 3)
    await until(
      () => va.value()?.messages.length === 1 && vb.value()?.messages.length === 1,
      'both converge'
    )
    expect(va.value()).toEqual(session.root.value)
    expect(vb.value()).toEqual(session.root.value)

    for (const client of [a, b]) {
      const holds = new Set(holdFrames(client).map((f) => (f as { id: number }).id))
      const subs = new Set([...subIds(client, 'view'), ...subIds(client, 'availability')])
      for (const frame of client.down()) {
        if (frame.t === 'state') expect(subs.has((frame as { id: number }).id)).toBe(true)
        if (frame.t === 'shape' || frame.t === 'gone') {
          expect(holds.has((frame as { id: number }).id)).toBe(true)
        }
      }
    }
  })

  it('VS-3 late join after 5 revisions: first value is the current one, then one ops frame per later revision', async () => {
    const { host, connect } = rig()
    const session = host.add('s1')
    const a = connect(W1)
    const va = a.get<SessionView>(S1)
    await live(va)
    stream.start(session.root.state)
    for (let index = 0; index < 4; index++) {
      stream.append(session.root.state, `p${index} `)
      await settle(2)
    }
    const b = connect(W2)
    const vb = b.get<SessionView>(S1)
    const first = await live(vb)
    expect(first).toEqual(session.root.value)
    const before = opsFramesOf(b).length
    for (let index = 0; index < 3; index++) {
      stream.append(session.root.state, `q${index} `)
      await settle(4)
    }
    await until(() => vb.value()?.live?.message.content.endsWith('q2 '), 'late joiner caught up')
    expect(opsFramesOf(b).length - before).toBe(3)
    expect(vb.value()).toEqual(session.root.value)
    expect(va.value()).toEqual(session.root.value)
  })

  it('VS-4 the same principal on two links: both live; closing one leaves the other untouched', async () => {
    const { host, server, connect } = rig()
    const session = host.add('s1')
    const renderer = connect(W1)
    const probe = connect(W1)
    const vr = renderer.get<SessionView>(S1)
    const vp = probe.get<SessionView>(S1)
    await live(vr)
    await live(vp)
    await probe.close()
    await settle()
    expect(server.hasSubscribers('s1')).toBe(true)
    stream.answer(session.root.state, ['still here'], 4)
    await until(() => vr.value()?.messages.length === 1, 'renderer keeps converging')
    expect(vr.status()).toBe('live')
    expect(vr.value()).toEqual(session.root.value)
  })

  it('VS-5 last release → not pinned, lease released; a new get peeks again and sees the current value', async () => {
    const { host, server, connect } = rig()
    const session = host.add('s1')
    const client = connect()
    const view = client.get<SessionView>(S1)
    await live(view)
    const root = session.root
    stream.answer(root.state, ['before release'], 2)
    await until(() => view.value()?.messages.length === 1, 'answer arrived')
    view.release()
    await until(() => !server.hasSubscribers('s1'), 'unpinned')
    await until(() => root.refs === 0, 'lease released')
    expect(host.log.at(-1)).toBe(`release:${root.id}`)

    const again = client.get<SessionView>(S1)
    const value = await live(again)
    expect(host.peeks).toEqual(['s1', 's1'])
    expect(value.messages.map((m) => m.content)).toEqual(['before release'])
    expect(value).toEqual(session.root.value)
  })

  it('VS-6 an in-process get (host principal) works and never calls authorize', async () => {
    const authorize = vi.fn(() => false)
    const { host, server } = rig({ deps: { authorize } })
    const session = host.add('s1')
    const handle = server.host.get(
      SessionViewContract,
      { sessionId: 's1' },
      { at: VIEW_SERVER_HOST }
    )
    const stop = handle.view.subscribe(() => {})
    await handle.ready
    await until(() => handle.view.value !== undefined, 'in-process value')
    expect(handle.view.value).toEqual(session.root.value)
    expect(authorize).not.toHaveBeenCalled()
    stop()
    handle.release()
  })

  it('VS-7 an empty id from a raw client → invalid; nothing peeked or resolved', async () => {
    const { host, connect } = rig()
    const client = connect()
    for (const target of [
      { kind: 'session', sessionId: '' },
      { kind: 'agent', agentId: '' }
    ] as SyncTarget[]) {
      const view = client.get(target)
      expect(codeOf(await failed(view))).toBe('invalid')
    }
    expect(host.peeks).toEqual([])
    expect(host.resolveCalls).toEqual([])
  })

  it('VS-8 a session target never calls resolveAgent', async () => {
    const { host, connect } = rig()
    host.add('s1')
    await live(connect().get(S1))
    expect(host.resolveCalls).toEqual([])
  })
})

// ─── 激活与钉住 ────────────────────────────────────────

describe('VS activation and pins', () => {
  it('VS-10 the session is pinned before peek; an agent target pins its root before the peek', async () => {
    const { host, connect } = rig()
    host.add('s1')
    host.add('s2')
    host.addAgent('a1', 's2')
    const client = connect()
    await live(client.get(S1))
    expect(host.pinnedAtPeek.s1).toBe(true)
    await live(client.get(A1))
    expect(host.pinnedAtPeek.s2).toBe(true)
  })

  it('VS-11 before the first ops the client sees exactly one value, and it is the real view (none, legacy, live, agent)', async () => {
    const { host, connect } = rig()
    const live1 = host.add('s1')
    stream.start(live1.root.state)
    host.add('s2')
    host.addAgent('a1', 's2', { ...agentView('a1', 's2', 2), run: { state: 'busy' } })
    const legacyMessages = [
      {
        id: 'u1',
        sessionId: 'old',
        role: 'user',
        type: 'text',
        content: 'hi',
        model: '',
        createdAt: 1
      }
    ] as unknown as ChatMessage[]
    host.legacy('old', { messages: legacyMessages })
    const client = connect()
    const cases: Array<[SyncTarget, () => unknown]> = [
      [{ kind: 'session', sessionId: 'nostore' }, () => emptySessionView('nostore')],
      [
        { kind: 'session', sessionId: 'old' },
        () => legacySessionView('old', { messages: legacyMessages })
      ],
      [S1, () => live1.root.value],
      [A1, () => host.session('s2')!.agent('a1').value]
    ]
    for (const [target, expected] of cases) {
      const view = client.get(target)
      await live(view, `live ${JSON.stringify(target)}`)
      await settle()
      expect(view.values()).toEqual([expected()])
      expect(view.views[0]).toBeUndefined()
      expect(view.events).toEqual(['snap', 'reset'])
    }
    const none = client.get<SessionView>({ kind: 'session', sessionId: 'nostore' })
    const value = await live(none)
    expect(value.source).toBe('none')
    expect(value.capabilities).toEqual({ send: true, rollback: false, continue: false })
  })

  it.each(['peek rejects', 'projector() rejects', 'acquire throws'] as const)(
    'VS-12 %s → unavailable, not pinned, no lease leaked; the next get retries and succeeds',
    async (failure) => {
      const { host, server, connect } = rig()
      const session = host.add('s1')
      const root = session.root
      if (failure === 'peek rejects') host.failPeek('s1')
      if (failure === 'projector() rejects') session.failProjector()
      if (failure === 'acquire throws') root.failAcquire = new Error('acquire failed')
      const client = connect()
      const view = client.get(S1)
      expect(codeOf(await failed(view))).toBe('unavailable')
      await until(() => !server.hasSubscribers('s1'), 'unpinned')
      expect(acquires(host)).toEqual([])
      expect(root.refs).toBe(0)
      view.release()

      const again = client.get<SessionView>(S1)
      expect(await live(again)).toEqual(session.root.value)
      expect(server.hasSubscribers('s1')).toBe(true)
    }
  )

  it.each(['release', 'link closes'] as const)(
    'VS-13 abandoned activation (%s before the peek resolves) → lease released, pin dropped, no state frames',
    async (how) => {
      const { host, server, connect } = rig()
      const session = host.add('s1')
      const root = session.root
      const gate = host.deferPeek('s1')
      const client = connect()
      const view = client.get(S1)
      await until(() => host.peeks.length === 1, 'peek started')
      expect(server.hasSubscribers('s1')).toBe(true)
      if (how === 'release') view.release()
      else client.pair.client.close('client went away')
      await settle()
      gate.resolve(session)
      await until(() => !server.hasSubscribers('s1'), 'unpinned')
      await settle()
      expect(host.log).toEqual([`acquire:${root.id}`, `release:${root.id}`])
      expect(root.refs).toBe(0)
      expect(root.disposed).toBe(true)
      expect(client.down().filter(isViewStateFrame)).toEqual([])
    }
  )

  it('VS-14 peek that reports the open itself (as SessionHost does): one peek, one acquire, no recompute', async () => {
    const { host, connect } = rig({ host: { peekFiresOpened: true } })
    const session = host.add('s1')
    const view = connect().get<SessionView>(S1)
    expect(await live(view)).toEqual(session.root.value)
    await settle()
    expect(host.peeks).toEqual(['s1'])
    expect(acquires(host)).toHaveLength(1)
    expect(session.projectorCalls).toBe(1)
  })

  it.each([0, 1, 2, 3, 4, 5])(
    'VS-15 peek → undefined while the session opens meanwhile (%i microtasks apart) → ends live and keeps updating',
    async (delay) => {
      const { host, connect } = rig()
      const gate = host.deferPeek('s1')
      const view = connect().get<SessionView>(S1)
      await until(() => host.peeks.length === 1, 'peek started')
      const session = host.add('s1')
      gate.resolve(undefined)
      for (let index = 0; index < delay; index++) await Promise.resolve()
      host.opened(session)
      await until(() => view.value()?.source === 'durable', 'durable view')
      stream.answer(session.root.state, ['after open'], 5)
      await until(() => view.value()?.messages.length === 1, 'changes arrive')
      expect(view.value()).toEqual(session.root.value)
    }
  )

  it('VS-15 the open reported before the empty peek resolves → ends live', async () => {
    const { host, connect } = rig()
    const gate = host.deferPeek('s1')
    const view = connect().get<SessionView>(S1)
    await until(() => host.peeks.length === 1, 'peek started')
    const session = host.add('s1')
    host.opened(session)
    gate.resolve(undefined)
    await until(() => view.value()?.source === 'durable', 'durable view')
    stream.answer(session.root.state, ['x'], 2)
    await until(() => view.value()?.messages.length === 1, 'changes arrive')
  })

  it('VS-16 a close while projector() is pending → recompute; never bridged to a disposed projector; a reopen goes live', async () => {
    const { host, logs, connect } = rig()
    const session = host.add('s1')
    const gate = session.deferProjector()
    const view = connect().get<SessionView>(S1)
    await until(() => session.projectorCalls === 1, 'projector requested')
    host.closed('s1', 'remove')
    gate.resolve()
    await live(view)
    await settle()
    expect(host.peeks).toEqual(['s1', 's1'])
    const current = session.currentRoot()!
    expect(current.disposed).toBe(false)
    expect(current.refs).toBe(1)
    current.change((draft) => {
      draft.run = { state: 'busy' }
    })
    await until(() => view.value()?.run.state === 'busy', 'change on the live projector arrives')

    const reopened = host.reopen('s1')
    reopened.root.change((draft) => {
      draft.messages.push({ id: '9', role: 'user', content: 'reopened' } as never)
    })
    host.opened(reopened)
    await until(() => view.value()?.messages.length === 1, 'reopened value')
    stream.start(reopened.root.state)
    await until(() => view.value()?.live !== null, 'changes after the reopen arrive')
    expect(view.value()).toEqual(reopened.root.value)
    expect(logs).toEqual([])
  })

  it('VS-17 more than 5 open / close events during activation → at most 5 peeks; the loop handles the rest', async () => {
    const { host, connect } = rig()
    const session = host.add('s1')
    const peek = host.peek.bind(host)
    let closes = 0
    host.peek = async (sessionId) => {
      const result = await peek(sessionId)
      if (closes < 7) {
        closes++
        host.closed(sessionId, 'remove')
      }
      return result
    }
    const view = connect().get<SessionView>(S1)
    await live(view)
    await settle()
    expect(host.peeks).toHaveLength(5)
    // 最后一个事件是关闭：静态的最后一个值，租约全还了
    expect(host.log.filter((e) => e.startsWith('acquire:'))).toHaveLength(5)
    expect(host.log.filter((e) => e.startsWith('release:'))).toHaveLength(5)
    expect(view.value()).toEqual(session.lastRoot())

    host.peek = peek
    host.opened(session)
    await until(() => session.currentRoot()?.refs === 1, 'live again')
    stream.answer(session.root.state, ['back'], 3)
    await until(() => view.value()?.messages.length === 1, 'changes arrive')
  })

  it('VS-18 a revision right after acquire (between activation and going live) is not lost', async () => {
    const { host, connect } = rig()
    const session = host.add('s1')
    const root = session.root
    const acquire = root.acquire.bind(root)
    root.acquire = () => {
      const lease = acquire()
      queueMicrotask(() =>
        root.change((draft) => {
          draft.run = { state: 'busy' }
        })
      )
      return lease
    }
    const view = connect().get<SessionView>(S1)
    await live(view)
    await until(() => view.value()?.run.state === 'busy', 'the early revision arrives')
    expect(view.value()).toEqual(root.value)
  })
})

// ─── 生命周期 ──────────────────────────────────────────

describe('VS lifecycle', () => {
  it('VS-20 none → live on open: the new value arrives without loading / unavailable, still one hold; deltas resume', async () => {
    const { host, connect } = rig()
    const client = connect()
    const view = client.get<SessionView>(S1)
    expect((await live(view)).source).toBe('none')
    const session = host.add('s1')
    host.opened(session)
    await until(() => view.value()?.source === 'durable', 'durable view')
    stream.answer(session.root.state, ['hi'], 2)
    await until(() => view.value()?.messages.length === 1, 'deltas resume')
    expect(view.statuses).not.toContain('loading')
    expect(view.statuses).not.toContain('gone')
    expect(view.availability).not.toContain('unavailable')
    expect(holdFrames(client)).toHaveLength(1)
  })

  it.each(['remove', 'invalidate'] as const)(
    'VS-21/22 %s mid-stream → the last projector value stays (run busy, nothing synthesized); lease released; reopen goes live',
    async (reason) => {
      const { host, connect } = rig()
      const session = host.add('s1')
      const client = connect()
      const view = client.get<SessionView>(S1)
      await live(view)
      const root = session.root
      stream.start(root.state)
      stream.append(root.state, 'half wri')
      await until(() => view.value()?.live?.message.content === 'half wri', 'half-written card')
      await settle()
      const last = root.value
      const framesBefore = client.down().length

      host.closed('s1', reason)
      await settle()
      expect(view.value()).toEqual(last)
      expect(view.value()?.run).toEqual({ state: 'busy' })
      expect(host.log.at(-1)).toBe(`release:${root.id}`)
      expect(root.refs).toBe(0)
      expect(client.down().length).toBe(framesBefore)

      // 旧状态之后的写入不再送达
      stream.append(root.state, 'tten')
      await settle()
      expect(client.down().length).toBe(framesBefore)
      expect(view.value()).toEqual(last)

      const reopened = host.add('s1', { ...durableView('s1'), conversationId: 7 })
      host.opened(reopened)
      await until(() => view.value()?.conversationId === 7, 'live with the new projector')
      expect(view.value()).toEqual(reopened.root.value)
      expect(view.status()).toBe('live')
    }
  )

  it('VS-23 destroy (clear) on a session target → empty none view, still available, still pinned; a later open goes live', async () => {
    const { host, server, connect } = rig()
    const session = host.add('s1')
    const view = connect().get<SessionView>(S1)
    await live(view)
    stream.answer(session.root.state, ['old'], 2)
    await until(() => view.value()?.messages.length === 1, 'answer')
    host.closed('s1', 'destroy')
    await until(() => view.value()?.source === 'none', 'none view')
    expect(view.value()).toEqual(emptySessionView('s1'))
    expect(view.avail()).toBe('available')
    expect(server.hasSubscribers('s1')).toBe(true)

    const fresh = host.add('s1')
    host.opened(fresh)
    await until(() => view.value()?.source === 'durable', 'live again')
    expect(view.value()).toEqual(fresh.root.value)
    expect(fresh.root.refs).toBe(1)
  })

  it('VS-24 destroy on an agent target → unavailable; its pin on the root drops; a later open of the root is ignored', async () => {
    const { host, server, connect } = rig()
    host.add('s1')
    host.addAgent('a1', 's1')
    const view = connect().get<AgentView>(A1)
    await live(view)
    expect(server.hasSubscribers('s1')).toBe(true)
    host.closed('s1', 'destroy')
    await until(() => view.avail() === 'unavailable', 'unavailable')
    expect(server.hasSubscribers('s1')).toBe(false)

    const reopened = host.add('s1')
    reopened.addAgent('a1')
    host.opened(reopened)
    await settle()
    expect(reopened.agentProjectorCalls).toEqual([])
    expect(view.avail()).toBe('unavailable')
    expect(server.hasSubscribers('s1')).toBe(false)
  })

  it('VS-25 deleteSession with two clients: unpinned synchronously; both unavailable; leases released; agents rooted in it too; fresh gets → not found', async () => {
    const { host, server, connect } = rig()
    const session = host.add('s1')
    host.addAgent('a1', 's1')
    const a = connect(W1)
    const b = connect(W2)
    const va = a.get<SessionView>(S1)
    const vAgent = a.get<AgentView>(A1)
    const vb = b.get<SessionView>(S1)
    await live(va)
    await live(vAgent)
    await live(vb)
    const root = session.root
    const agent = session.agent('a1')

    server.deleteSession('s1')
    expect(server.hasSubscribers('s1')).toBe(false)
    await until(
      () =>
        va.avail() === 'unavailable' &&
        vb.avail() === 'unavailable' &&
        vAgent.avail() === 'unavailable',
      'all unavailable'
    )
    await settle()
    expect(root.refs).toBe(0)
    expect(agent.refs).toBe(0)

    // 旧持有者放手之后，新链路上再 get：会话与它派生的 agent 都是「找不到」
    va.release()
    vb.release()
    vAgent.release()
    await settle()
    const c = connect({ kind: 'window', webContentsId: 3 })
    expect(isNotFoundError(await failed(c.get(S1)))).toBe(true)
    expect(isNotFoundError(await failed(c.get(A1)))).toBe(true)
    expect(server.hasSubscribers('s1')).toBe(false)
  })

  it('VS-25 a fresh get of the deleted session while old holders still hold it → not found', async () => {
    const { host, server, connect } = rig()
    host.add('s1')
    const a = connect(W1)
    const va = a.get<SessionView>(S1)
    await live(va)
    server.deleteSession('s1')
    await until(() => va.avail() === 'unavailable', 'unavailable')
    const c = connect(W2)
    expect(isNotFoundError(await failed(c.get(S1)))).toBe(true)
  })

  it('VS-26 destroy then deleteSession → none, then unavailable', async () => {
    const { host, server, connect } = rig()
    host.add('s1')
    const view = connect().get<SessionView>(S1)
    await live(view)
    host.closed('s1', 'destroy')
    await until(() => view.value()?.source === 'none', 'none view')
    server.deleteSession('s1')
    await until(() => view.avail() === 'unavailable', 'unavailable')
    expect(server.hasSubscribers('s1')).toBe(false)
  })

  it('VS-27 delete during activation → not found, never live, lease released, no pin', async () => {
    const { host, server, connect } = rig()
    const session = host.add('s1')
    const root = session.root
    const gate = host.deferPeek('s1')
    const client = connect()
    const view = client.get(S1)
    await until(() => host.peeks.length === 1, 'peek started')
    server.deleteSession('s1')
    expect(server.hasSubscribers('s1')).toBe(false)
    gate.resolve(session)
    expect(isNotFoundError(await failed(view))).toBe(true)
    await settle()
    expect(view.statuses).not.toContain('live')
    expect(host.log).toEqual([`acquire:${root.id}`, `release:${root.id}`])
    expect(root.refs).toBe(0)
    expect(server.hasSubscribers('s1')).toBe(false)
    expect(client.down().filter(isViewStateFrame)).toEqual([])
  })

  it('VS-28a delete, the old holder releases, the same id opens again → a new get is live', async () => {
    const { host, server, connect } = rig()
    host.add('s1')
    const client = connect()
    const old = client.get<SessionView>(S1)
    await live(old)
    server.deleteSession('s1')
    await until(() => old.avail() === 'unavailable', 'unavailable')
    old.release()
    await settle()
    const reopened = host.add('s1', { ...durableView('s1'), conversationId: 4 })
    host.opened(reopened)
    const fresh = client.get<SessionView>(S1)
    expect(await live(fresh)).toEqual(reopened.root.value)
    expect(fresh.avail()).toBe('available')
    expect(server.hasSubscribers('s1')).toBe(true)
  })

  it('VS-28b delete while the old holder keeps its handle, then the same id opens again → old holder and new subscriber both live', async () => {
    const { host, server, connect } = rig()
    host.add('s1')
    const a = connect(W1)
    const old = a.get<SessionView>(S1)
    await live(old)
    server.deleteSession('s1')
    await until(() => old.avail() === 'unavailable', 'unavailable')

    const reopened = host.add('s1', { ...durableView('s1'), conversationId: 9 })
    host.opened(reopened)
    const b = connect(W2)
    const fresh = b.get<SessionView>(S1)
    await until(
      () =>
        fresh.status() === 'live' &&
        fresh.avail() === 'available' &&
        fresh.value()?.conversationId === 9,
      'new subscriber live'
    )
    await until(
      () => old.avail() === 'available' && old.value()?.conversationId === 9,
      'old holder revived'
    )
    expect(server.hasSubscribers('s1')).toBe(true)
    stream.answer(reopened.root.state, ['after revive'], 3)
    await until(
      () => old.value()?.messages.length === 1 && fresh.value()?.messages.length === 1,
      'both keep updating'
    )
    expect(old.value()).toEqual(reopened.root.value)
    expect(fresh.value()).toEqual(reopened.root.value)
  })

  it.each(['synchronously', 'in a microtask'] as const)(
    'VS-29 authorize deletes the session %s and returns true → not found, no view, no lingering pin',
    async (when) => {
      const ref: { server?: ViewServer } = {}
      const authorize = (_p: ViewPrincipal, target: SyncTarget): boolean => {
        if (target.kind === 'session') {
          if (when === 'synchronously') ref.server!.deleteSession(target.sessionId)
          else queueMicrotask(() => ref.server!.deleteSession(target.sessionId))
        }
        return true
      }
      const r = rig({ deps: { authorize } })
      const server = r.server
      ref.server = server
      const session = r.host.add('s1')
      const client = r.connect()
      const view = client.get(S1)
      expect(isNotFoundError(await failed(view))).toBe(true)
      await settle()
      expect(view.statuses).not.toContain('live')
      expect(client.down().filter(isViewStateFrame)).toEqual([])
      expect(server.hasSubscribers('s1')).toBe(false)
      expect(session.currentRoot()?.refs ?? 0).toBe(0)
      expect(acquires(r.host).length).toBe(
        r.host.log.filter((e) => e.startsWith('release:')).length
      )
    }
  )

  it('VS-30 deleting a session nobody views → a later get is not found; other sessions unaffected; nothing throws', async () => {
    const { host, server, connect } = rig()
    host.add('s1')
    host.add('s3')
    expect(() => server.deleteSession('s3')).not.toThrow()
    const client = connect()
    expect(isNotFoundError(await failed(client.get({ kind: 'session', sessionId: 's3' })))).toBe(
      true
    )
    await live(client.get(S1))
  })

  it('VS-31 opened again with the same instance → no second acquire; a new instance → acquire(new) before release(old), no loading', async () => {
    const { host, connect } = rig()
    const first = host.add('s1')
    const view = connect().get<SessionView>(S1)
    await live(view)
    const oldRoot = first.root
    host.opened(first)
    await settle()
    expect(acquires(host)).toHaveLength(1)

    const second = host.reopen('s1')
    const newRoot = second.root
    newRoot.change((draft) => {
      draft.conversationId = 2
    })
    host.opened(second)
    await until(() => view.value()?.conversationId === 2, 'new value')
    const acquiredAt = host.log.indexOf(`acquire:${newRoot.id}`)
    const releasedAt = host.log.indexOf(`release:${oldRoot.id}`)
    expect(acquiredAt).toBeGreaterThanOrEqual(0)
    expect(releasedAt).toBeGreaterThan(acquiredAt)
    expect(view.statuses.filter((s: HandleStatus) => s === 'loading')).toEqual([])
    expect(view.value()).toEqual(newRoot.value)
  })

  it('VS-32 projector() rejecting on reopen → a warning; the view stays static; the next open brings it live', async () => {
    const { host, logs, connect } = rig()
    host.add('s1')
    const view = connect().get<SessionView>(S1)
    await live(view)
    host.closed('s1', 'remove')
    await settle()
    const staticValue = view.value()
    const reopened = host.reopen('s1')
    reopened.failProjector()
    host.opened(reopened)
    await until(() => logs.some((l) => l.includes('view server: session:s1 opened failed')), 'warn')
    expect(view.value()).toEqual(staticValue)
    expect(view.status()).toBe('live')

    host.opened(reopened)
    await until(() => reopened.currentRoot()?.refs === 1, 'live again')
    stream.answer(reopened.root.state, ['hello again'], 6)
    await until(() => view.value()?.messages.length === 1, 'changes arrive')
  })

  it('VS-33 agent target: the agent projector value, append ops, static on close, live again on reopen', async () => {
    const { host, server, connect } = rig()
    const session = host.add('s1')
    host.addAgent('a1', 's1')
    const client = connect()
    const view = client.get<AgentView>(A1)
    const first = await live(view)
    expect(first).toEqual(session.agent('a1').value)
    expect(Object.keys(first).sort()).toEqual(
      [
        'agentId',
        'context',
        'conversationId',
        'live',
        'messages',
        'run',
        'sessionId',
        'toolRuns',
        'v'
      ].sort()
    )
    expect(server.hasSubscribers('s1')).toBe(true)

    const agent = session.agent('a1')
    stream.start(agent.state)
    stream.append(agent.state, 'stream')
    stream.append(agent.state, 'ing')
    await until(() => view.value()?.live?.message.content === 'streaming', 'streamed')
    const appendOps = opsFramesOf(client)
      .flatMap((f) => (f as unknown as { ops: unknown[][] }).ops)
      .filter((op) => op[0] === 'a')
    expect(appendOps.length).toBeGreaterThan(0)

    // 根会话关了：留着最后一个值
    host.closed('s1', 'remove')
    await settle()
    const last = view.value()
    expect(last?.live?.message.content).toBe('streaming')
    expect(view.status()).toBe('live')

    // 重开、认得这个 agent：又活了
    const reopened = host.reopen('s1')
    host.opened(reopened)
    await until(() => reopened.agentProjectorCalls.includes('a1'), 'agent projector requested')
    stream.commit(reopened.agent('a1').state, 5)
    await until(() => view.value()?.messages.length === 1, 'live again')

    // 再关、重开成一个不认得它的实例：保持静态
    host.closed('s1', 'remove')
    await settle()
    const staticValue = view.value()
    const stranger = host.add('s1')
    host.opened(stranger)
    await until(() => stranger.agentProjectorCalls.includes('a1'), 'asked the new instance')
    await settle()
    expect(view.value()).toEqual(staticValue)
    expect(view.avail()).toBe('available')
    expect(server.hasSubscribers('s1')).toBe(true)

    view.release()
    await until(() => !server.hasSubscribers('s1'), 'unpinned after release')
  })

  it('VS-33 agent target not found: unknown agent, deleted root, root without storage', async () => {
    const { host, server, connect } = rig()
    host.add('s2')
    host.addAgent('a2', 's2')
    host.addAgent('a3', 's3') // s3 没有存储
    server.deleteSession('s2')
    const client = connect()
    expect(isNotFoundError(await failed(client.get({ kind: 'agent', agentId: 'ghost' })))).toBe(
      true
    )
    expect(isNotFoundError(await failed(client.get({ kind: 'agent', agentId: 'a2' })))).toBe(true)
    expect(isNotFoundError(await failed(client.get({ kind: 'agent', agentId: 'a3' })))).toBe(true)
    await settle()
    expect(server.hasSubscribers('s2')).toBe(false)
    expect(server.hasSubscribers('s3')).toBe(false)
  })

  it('VS-34 resolveAgent rejects → unavailable, no pin', async () => {
    const { host, server, connect } = rig({
      deps: {
        resolveAgent: async () => {
          throw new Error('router exploded')
        }
      }
    })
    host.add('s1')
    const view = connect().get(A1)
    expect(codeOf(await failed(view))).toBe('unavailable')
    await settle()
    expect(server.hasSubscribers('s1')).toBe(false)
    expect(host.peeks).toEqual([])
  })
})

// ─── 旧格式与封存 ──────────────────────────────────────

describe('VS legacy and sealed', () => {
  it('VS-40 legacy target: frozen JSON-only view, never peeked; a non-destroy close is ignored; destroy → none; open → live', async () => {
    const { host, server, connect } = rig()
    const messages = [
      { id: 'u1', sessionId: 'old', role: 'user', type: 'text', content: 'hi', images: undefined },
      {
        id: 'a1',
        sessionId: 'old',
        role: 'assistant',
        type: 'message',
        content: 'yo',
        blocks: [{ type: 'text', text: 'yo' }],
        metadata: undefined
      }
    ] as unknown as ChatMessage[]
    host.legacy('old', { messages })
    host.add('old')
    const target: SyncTarget = { kind: 'session', sessionId: 'old' }
    const view = connect().get<SessionView>(target)
    const value = await live(view)
    expect(value.source).toBe('legacy')
    expect(value.capabilities).toEqual({ send: false, rollback: false, continue: false })
    expect(value.messages).toEqual(JSON.parse(JSON.stringify(messages)))
    expect(host.peeks).toEqual([])
    expect(host.session('old')!.projectorCalls).toBe(0)

    // 服务端那份值：严格 JSON、与输入不共享容器
    const handle = server.host.get(
      SessionViewContract,
      { sessionId: 'old' },
      { at: VIEW_SERVER_HOST }
    )
    const stop = handle.view.subscribe(() => {})
    await handle.ready
    const own = handle.view.value as SessionView
    expect(isJsonOnly(own)).toBe(true)
    expect(own.messages).not.toBe(messages)
    expect(own.messages[0]).not.toBe(messages[0])
    expect((own.messages[1] as { blocks: unknown }).blocks).not.toBe(
      (messages[1] as unknown as { blocks: unknown }).blocks
    )
    stop()
    handle.release()

    host.closed('old', 'remove')
    await settle()
    expect(view.value()?.source).toBe('legacy')
    host.closed('old', 'destroy')
    await until(() => view.value()?.source === 'none', 'none after destroy')
    expect(view.value()).toEqual(emptySessionView('old'))
    const fresh = host.add('old')
    host.opened(fresh)
    await until(() => view.value()?.source === 'durable', 'live after open')
    expect(host.peeks).toEqual([])
  })

  it.each([null, undefined])('VS-41 legacyView → %s → the normal peek path', async (answer) => {
    const { host, connect } = rig({ deps: { legacyView: () => answer } })
    const session = host.add('s1')
    const view = connect().get<SessionView>(S1)
    expect(await live(view)).toEqual(session.root.value)
    expect(host.peeks).toEqual(['s1'])
  })

  it('VS-42 legacyView throws → an error for the client, pin dropped', async () => {
    const { host, server, connect } = rig({
      deps: {
        legacyView: () => {
          throw new Error('corrupt row')
        }
      }
    })
    host.add('s1')
    const view = connect().get(S1)
    expect(codeOf(await failed(view))).toBe('unavailable')
    await settle()
    expect(server.hasSubscribers('s1')).toBe(false)
    expect(host.peeks).toEqual([])
  })

  it('VS-43 sealed before the get → empty view, nothing peeked or read; later events send nothing; agents → not found', async () => {
    const { host, connect } = rig()
    const session = host.add('s1')
    host.legacy('s1', { messages: [] })
    host.addAgent('a1', 's1')
    host.sealed = true
    const client = connect()
    const view = client.get<SessionView>(S1)
    expect(await live(view)).toEqual(emptySessionView('s1'))
    expect(host.peeks).toEqual([])
    expect(host.legacyCalls).toEqual([])
    await settle()
    const framesBefore = client.down().length
    host.opened(session)
    host.closed('s1', 'remove')
    host.closed('s1', 'destroy')
    await settle()
    expect(client.down().length).toBe(framesBefore)
    expect(session.projectorCalls).toBe(0)

    expect(isNotFoundError(await failed(client.get(A1)))).toBe(true)
  })

  it('VS-44 the peek returns undefined because the host sealed meanwhile → sealed (a later open is ignored)', async () => {
    const { host, connect } = rig()
    const gate = host.deferPeek('s1')
    const client = connect()
    const view = client.get<SessionView>(S1)
    await until(() => host.peeks.length === 1, 'peek started')
    host.sealed = true
    gate.resolve(undefined)
    expect(await live(view)).toEqual(emptySessionView('s1'))
    await settle()
    const framesBefore = client.down().length
    const session = host.add('s1')
    host.opened(session)
    await settle()
    expect(session.projectorCalls).toBe(0)
    expect(client.down().length).toBe(framesBefore)
    expect(view.value()).toEqual(emptySessionView('s1'))
  })

  it('VS-45 a live target when the host seals (close remove) → holders keep the static last value', async () => {
    const { host, connect } = rig()
    const session = host.add('s1')
    const view = connect().get<SessionView>(S1)
    await live(view)
    stream.answer(session.root.state, ['last words'], 2)
    await until(() => view.value()?.messages.length === 1, 'answer')
    const last = view.value()
    host.sealed = true
    host.closed('s1', 'remove')
    await settle()
    expect(view.value()).toEqual(last)
    expect(view.status()).toBe('live')
    expect(view.avail()).toBe('available')
  })
})

// ─── 客户端离开 ────────────────────────────────────────

describe('VS clients gone', () => {
  it.each(['ended', 'bye'] as const)(
    'VS-50 link A ends (%s) → its holds are released; B keeps converging; A’s principal on a new link gets a fresh snapshot',
    async (how) => {
      const { host, server, connect } = rig()
      const s1 = host.add('s1')
      host.add('s2')
      const a = connect(W1)
      const b = connect(W2)
      await live(a.get(S1))
      await live(a.get(S2))
      const vb = b.get<SessionView>(S1)
      await live(vb)

      if (how === 'ended') a.pair.server.ended('transport gone')
      else a.pair.client.close('renderer left')
      await until(() => !server.hasSubscribers('s2'), 's2 unpinned')
      expect(server.hasSubscribers('s1')).toBe(true)
      await settle()
      const framesToA = a.down().length
      stream.answer(s1.root.state, ['after', ' a left'], 4)
      await until(() => vb.value()?.messages.length === 1, 'b converges')
      await settle()
      expect(a.down().length).toBe(framesToA)
      expect(vb.value()).toEqual(s1.root.value)

      const again = connect(W1).get<SessionView>(S1)
      expect(await live(again)).toEqual(s1.root.value)
    }
  )

  it('VS-51 transmit throws on link A → A ends with transport error and is released; B unaffected; change never throws', async () => {
    const { host, server, connect } = rig()
    const s1 = host.add('s1')
    host.add('s2')
    const a = connect(W1)
    const b = connect(W2)
    await live(a.get(S1))
    await live(a.get(S2))
    const vb = b.get<SessionView>(S1)
    await live(vb)
    const reasons: string[] = []
    a.pair.server.onClose((reason) => reasons.push(reason))

    a.pair.breakDown()
    expect(() => stream.answer(s1.root.state, ['boom'], 3)).not.toThrow()
    await until(() => a.pair.server.closed, 'link A ended')
    expect(reasons).toEqual(['transport error'])
    await until(() => !server.hasSubscribers('s2'), 's2 released')
    await until(() => vb.value()?.messages.length === 1, 'b converges')
    expect(vb.value()).toEqual(s1.root.value)
    expect(server.hasSubscribers('s1')).toBe(true)
  })

  it('VS-52 ping timeout: a silent link is closed by the server and its pins drop', async () => {
    const { host, server, connect } = rig({
      deps: { linkOptions: { pingInterval: 20, pingTimeout: 60 } }
    })
    host.add('s1')
    const a = connect(W1)
    await live(a.get(S1))
    expect(server.hasSubscribers('s1')).toBe(true)
    a.pair.pause('up')
    await until(() => a.pair.server.closed, 'server closed the silent link', 2000)
    await until(() => !server.hasSubscribers('s1'), 'unpinned')
    a.pair.resume()
  })
})

// ─── 主体核对 ──────────────────────────────────────────

describe('VS authorize', () => {
  it('VS-60 no authorize dep → every principal may view', async () => {
    const { host, connect } = rig()
    host.add('s1')
    await live(connect({ kind: 'stranger' }).get(S1))
  })

  it('VS-61 a synchronous false → forbidden; nothing peeked, read or resolved; never pinned; authorize sees the stamped principal', async () => {
    const authorize = vi.fn((_principal: ViewPrincipal, _target: SyncTarget) => false)
    const { host, server, connect } = rig({ deps: { authorize } })
    host.add('s1')
    host.legacy('s1', { messages: [] })
    host.addAgent('a1', 's1')
    const principal = { kind: 'window', webContentsId: 7 }
    const client = connect(principal)
    expect(codeOf(await failed(client.get(S1)))).toBe('forbidden')
    expect(codeOf(await failed(client.get(A1)))).toBe('forbidden')
    expect(host.peeks).toEqual([])
    expect(host.legacyCalls).toEqual([])
    expect(host.resolveCalls).toEqual([])
    expect(host.pinnedAtPeek).toEqual({})
    expect(server.hasSubscribers('s1')).toBe(false)
    expect(authorize.mock.calls).toEqual([
      [principal, S1],
      [principal, A1]
    ])
    expect(client.down().filter(isViewStateFrame)).toEqual([])
  })

  it('VS-62 a synchronous true is checked once per (principal, target) record', async () => {
    const authorize = vi.fn(() => true)
    const { host, connect } = rig({ deps: { authorize } })
    host.add('s1')
    await live(connect(W1).get(S1))
    expect(authorize).toHaveBeenCalledTimes(1)
    // 同一主体的第二个持有（另一条链路）：同一条远程记录，不再核对
    await live(connect(W1).get(S1))
    expect(authorize).toHaveBeenCalledTimes(1)
    // 另一个主体：核对
    await live(connect(W2).get(S1))
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(authorize.mock.calls[1]).toEqual([W2, S1])
  })

  it('VS-63 an async true → live', async () => {
    const { host, connect } = rig({ deps: { authorize: async () => true } })
    const session = host.add('s1')
    expect(await live(connect().get(S1))).toEqual(session.root.value)
  })

  it('VS-64 an async false on an agent target → forbidden; no view frames; root unpinned, lease released; an authorized principal stays live', async () => {
    const { host, server, connect } = rig({
      deps: {
        authorize: async (principal) =>
          (principal as { webContentsId?: number }).webContentsId === 1
      }
    })
    const session = host.add('s1')
    host.addAgent('a1', 's1')
    const refused = connect(W2)
    expect(codeOf(await failed(refused.get(A1)))).toBe('forbidden')
    await until(() => !server.hasSubscribers('s1'), 'root unpinned')
    await settle()
    expect(refused.down().filter(isViewStateFrame)).toEqual([])
    expect(session.agent('a1').refs).toBe(0)

    const allowed = connect(W1)
    const view = allowed.get<AgentView>(A1)
    await live(view)
    const again = connect({ kind: 'window', webContentsId: 3 })
    expect(codeOf(await failed(again.get(A1)))).toBe('forbidden')
    expect(again.down().filter(isViewStateFrame)).toEqual([])
    stream.answer(session.agent('a1').state, ['still'], 4)
    await until(() => view.value()?.messages.length === 1, 'authorized stays live')
    expect(server.hasSubscribers('s1')).toBe(true)
  })

  it('VS-65 an async verdict that rejects → forbidden, no view frames', async () => {
    const { host, connect } = rig({
      deps: { authorize: () => Promise.reject(new Error('authorizer exploded')) }
    })
    host.add('s1')
    const client = connect()
    expect(codeOf(await failed(client.get(S1)))).toBe('forbidden')
    await settle()
    expect(client.down().filter(isViewStateFrame)).toEqual([])
  })

  it('VS-66 authorize throws synchronously → forbidden, nothing peeked', async () => {
    const { host, server, connect } = rig({
      deps: {
        authorize: () => {
          throw new Error('authorizer threw')
        }
      }
    })
    host.add('s1')
    const client = connect()
    const error = await failed(client.get(S1))
    // 判定抛错按不让看：与异步判定拒绝（VS-65）同一个口径
    expect(codeOf(error)).toBe('forbidden')
    expect(host.peeks).toEqual([])
    expect(server.hasSubscribers('s1')).toBe(false)
  })

  it('VS-67 a deleted id seen by an unauthorized principal → forbidden (the principal is checked first); an authorized one → not found', async () => {
    const { host, server, connect } = rig({
      deps: {
        authorize: (principal) => (principal as { webContentsId?: number }).webContentsId === 1
      }
    })
    host.add('s1')
    server.deleteSession('s1')
    expect(codeOf(await failed(connect(W2).get(S1)))).toBe('forbidden')
    expect(isNotFoundError(await failed(connect(W1).get(S1)))).toBe(true)
  })
})

// ─── 处置 ──────────────────────────────────────────────

describe('VS dispose', () => {
  it('VS-70 dispose → handles gone, hooks unregistered, leases released, unpinned; later accepts refused with a bye; idempotent', async () => {
    const { host, server, logs, connect } = rig()
    const session = host.add('s1')
    host.addAgent('a1', 's1')
    const client = connect()
    const vs = client.get(S1)
    const va = client.get(A1)
    await live(vs)
    await live(va)
    expect(host.listenerCount()).toBe(2)

    await server.dispose()
    await until(() => vs.status() === 'gone' && va.status() === 'gone', 'handles gone')
    expect(host.listenerCount()).toBe(0)
    await settle()
    expect(session.root.refs).toBe(0)
    expect(session.agent('a1').refs).toBe(0)
    expect(server.hasSubscribers('s1')).toBe(false)

    const pair = tappedLinkPair()
    const reasons: string[] = []
    pair.client.onClose((reason) => reasons.push(reason))
    server.accept(pair.server, W1)
    expect(pair.server.closed).toBe(true)
    await settle()
    expect(pair.frames).toEqual([
      { dir: 'down', frame: { t: 'bye', reason: 'view server disposed' } }
    ])
    expect(reasons).toEqual(['view server disposed'])

    const logsBefore = logs.length
    expect(() => server.deleteSession('s1')).not.toThrow()
    expect(() => host.opened(session)).not.toThrow()
    expect(() => host.closed('s1', 'remove')).not.toThrow()
    await settle()
    expect(logs.length).toBe(logsBefore)
    await expect(server.dispose()).resolves.toBeUndefined()
    await sleep(0)
  })
})

/**
 * 视图服务端 × 真的会话宿主（pi 1.2 / chord2）—— durable 测试套件的 `makeHost`（真 SessionHost、SQLite 存储、
 * faux 模型）+ 真的视图服务端 + 窃听链路上的裸 chord 客户端（`support/viewRig` 的 `rawClient`）。编号对着测试设计
 * 的用例清单第 3 节：
 *
 *   RH-1 （P3-04-12）订阅从不打开存储：不存在的会话 → 空视图，`host.open` 一次都没调、没有 `open:`；被中断的会话
 *        （`crashWith`）→ 只 peek，仍是 interrupted，订阅不写任何提交，视图 = 投影的值
 *   RH-2 （P3-04-13）`maxIdleOpen: 0` + `isPinned = server.hasSubscribers`：看着的空闲会话挺过修剪；两个客户端走了
 *        一个仍钉着；都走了之后在**下一次**修剪时才关（不是放手那一刻，PIN-09）；派生 agent 目标钉住它的根会话
 *   RH-3 真跑一轮（faux 流式）：客户端每次拿到的值都是投影的某个修订、按序；每次 settle 时客户端的值都是投影
 *        已经给出过的值；最后相等，消息对、空闲
 *   RH-4 看着的时候 closeAll → 留着最后的值（静态）；之后新的 get → 空视图，不 peek
 *   RH-5 `host.delete`（清空）→ 空视图；下一次发送 → 新对话的活视图（中途不 loading、不 unavailable）
 *   RH-6 真投影上多挂一个每次都抛错的订阅方 → 客户端照样收敛，记了日志，没有未处理的错误
 *
 * 宿主适配：服务端的 `SyncHubHost` 是一层薄适配 —— `sealed` / `peek` 现读此刻的 `t.host`，开 / 关监听器放在宿主
 * **之外**的集合里，由 `makeHost` 的 `onSessionOpened` / `onSessionClosed` 喂（`crashWith` 的重启选项也接同一组），
 * `isPinned` 经一个先于服务端建好的引用读 `server.hasSubscribers`（与旧的 `pinRef` 同理）。`DurableSession` 直接
 * 满足 `SyncSession`。
 */
import { isDeepStrictEqual } from 'node:util'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import { emptySessionView, type SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DurableSession } from '../../durable/durableSession'
import {
  recordPublications,
  type PublicationRecorder
} from '../../durable/__tests__/support/commits'
import { crashWith } from '../../durable/__tests__/support/crash'
import { answer, fauxKit } from '../../durable/__tests__/support/faux'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost,
  type TestHostOptions
} from '../../durable/__tests__/support/host'
import { hookRec, seedAgent, TEST_SPAWN_EXTENSION } from '../../durable/__tests__/support/spawn'
import { waitFor, withTimeout } from '../../durable/__tests__/support/wait'
import { throwingSubscriber } from '../../durable/projection/__tests__/projectorSupport'
import {
  createViewServer,
  type SyncHubHost,
  type SyncSession,
  type SyncSessionClosedReason,
  type ViewPrincipal,
  type ViewServer,
  type ViewServerDeps
} from '../viewServer'
import {
  rawClient,
  recordingLogger,
  settle,
  until,
  type RawClient,
  type TestView
} from './support/viewRig'

registerHostCleanup()

const TIMEOUT = 25000

const S1: SyncTarget = { kind: 'session', sessionId: 's1' }
const S2: SyncTarget = { kind: 'session', sessionId: 's2' }

let servers: ViewServer[] = []
let clients: RawClient[] = []
let stopUnhandled: (() => void) | undefined

// 先于 registerHostCleanup 的 afterEach 跑（vitest 的 after 钩子按登记的倒序）：客户端、服务端先走，宿主再 closeAll
afterEach(async () => {
  stopUnhandled?.()
  stopUnhandled = undefined
  for (const client of clients) await client.close().catch(() => undefined)
  for (const server of servers) await server.dispose().catch(() => undefined)
  clients = []
  servers = []
})

// ─── 装配 ──────────────────────────────────────────────

/** 宿主之外的开 / 关监听器与钉住引用（先于宿主建好，交给 `makeHost` / 重启选项） */
interface Hooks {
  readonly opened: Set<(session: SyncSession) => void>
  readonly closed: Set<(sessionId: string, reason: SyncSessionClosedReason) => void>
  /** 交给 `makeHost`（或 `crashWith` 的 `restart`）的那三个选项 */
  readonly options: Pick<TestHostOptions, 'isPinned' | 'onSessionOpened' | 'onSessionClosed'>
  server: ViewServer | undefined
}

function hostHooks(): Hooks {
  const hooks: Hooks = {
    opened: new Set(),
    closed: new Set(),
    server: undefined,
    options: {
      isPinned: (sessionId) => hooks.server?.hasSubscribers(sessionId) ?? false,
      onSessionOpened: (session) => {
        for (const listener of [...hooks.opened]) listener(session)
      },
      onSessionClosed: (sessionId, reason) => {
        for (const listener of [...hooks.closed]) listener(sessionId, reason)
      }
    }
  }
  return hooks
}

interface RealRig {
  readonly t: TestHost
  readonly server: ViewServer
  /** 服务端的 peek（按次序） */
  readonly peeks: string[]
  /** 服务端的 warn / error 日志 */
  readonly logs: string[]
  /** peek 交出一个会话时（在服务端拿它的投影之前） */
  onPeek: ((session: DurableSession) => void) | undefined
  client(webContentsId?: number): RawClient
}

function rigFor(
  t: TestHost,
  hooks: Hooks,
  extra: Partial<Omit<ViewServerDeps, 'host'>> = {}
): RealRig {
  const peeks: string[] = []
  const { logs, logger } = recordingLogger()
  const host: SyncHubHost = {
    get sealed() {
      return t.host.sealed
    },
    peek: async (sessionId) => {
      peeks.push(sessionId)
      const session = await t.host.peek(sessionId)
      if (session !== undefined) rig.onPeek?.(session)
      return session
    },
    onSessionOpened: (listener) => {
      hooks.opened.add(listener)
      return () => {
        hooks.opened.delete(listener)
      }
    },
    onSessionClosed: (listener) => {
      hooks.closed.add(listener)
      return () => {
        hooks.closed.delete(listener)
      }
    }
  }
  const server = createViewServer({ host, logger, ...extra })
  hooks.server = server
  servers.push(server)
  let clientSeq = 0
  const rig: RealRig = {
    t,
    server,
    peeks,
    logs,
    onPeek: undefined,
    client: (webContentsId = ++clientSeq) => {
      const principal: ViewPrincipal = { kind: 'window', webContentsId }
      const client = rawClient(server, principal)
      clients.push(client)
      return client
    }
  }
  return rig
}

/** 等句柄 live、拿到第一份值 */
async function live<V>(view: TestView<V>): Promise<V> {
  const error = await withTimeout(view.settled(), 5000, 'handle ready')
  expect(error).toBeUndefined()
  return until(() => view.value(), 'first value')
}

/** 等到客户端的值与 `expected()` 深相等 */
async function converged<V>(view: TestView<V>, expected: () => V, what: string): Promise<void> {
  await until(() => isDeepStrictEqual(view.value(), expected()), what, 5000)
}

/** process 上的 `unhandledRejection` / `uncaughtException`（用例结束时摘掉） */
function recordUnhandled(): unknown[] {
  const errors: unknown[] = []
  const onError = (error: unknown): void => {
    errors.push(error)
  }
  process.on('unhandledRejection', onError)
  process.on('uncaughtException', onError)
  stopUnhandled = () => {
    process.off('unhandledRejection', onError)
    process.off('uncaughtException', onError)
  }
  return errors
}

function opens(t: TestHost): string[] {
  return t.events.filter((event) => event.startsWith('open:'))
}

function closes(t: TestHost, sessionId: string): number {
  return t.events.filter((event) => event === `close:${sessionId}`).length
}

/** 那些值都是 `revisions` 里的某一个、按序（每个客户端值在投影的修订序列里依次找得到） */
function expectOrderedSubsequence(
  values: readonly SessionView[],
  revisions: readonly SessionView[]
): void {
  let at = 0
  for (const [index, value] of values.entries()) {
    while (at < revisions.length && !isDeepStrictEqual(revisions[at], value)) at++
    expect(at < revisions.length, `client value ${index} is a projector revision, in order`).toBe(
      true
    )
    at++
  }
}

// ─── 用例 ──────────────────────────────────────────────

describe('view server × real session host', () => {
  it(
    'RH-1 subscribing never opens storage: unknown → none without open; crashed → peek only, still interrupted, nothing written (P3-04-12)',
    async () => {
      // 不存在的会话：只 peek（storageExists=false），从不 open / 不建存储
      const hooks = hostHooks()
      const t = await makeHost(hooks.options)
      const rig = rigFor(t, hooks)
      const open = vi.spyOn(t.host, 'open')
      const missing = rig.client().get({ kind: 'session', sessionId: 's9' })
      expect(await live(missing)).toEqual(emptySessionView('s9'))
      expect(missing.value()!.capabilities).toEqual({
        send: true,
        rollback: false,
        continue: false
      })
      expect(missing.avail()).toBe('available')
      expect(rig.peeks).toEqual(['s9'])
      expect(open).not.toHaveBeenCalled()
      expect(opens(t)).toEqual([])
      expect(t.host.get('s9')).toBeUndefined()

      // 已存在、已关闭、被中断的会话：peek 打开 Harness，从不 open、不 resume，订阅不写任何东西
      const crashHooks = hostHooks()
      const { t: t2 } = await crashWith({ restart: crashHooks.options })
      const crashed = rigFor(t2, crashHooks)
      const crashedOpen = vi.spyOn(t2.host, 'open')
      let recorder: PublicationRecorder | undefined
      crashed.onPeek = (session) => {
        recorder ??= recordPublications(session.harness)
      }
      const view = crashed.client().get(S1)
      await live(view)
      await settle()
      expect(crashed.peeks).toEqual(['s1'])
      expect(crashedOpen).not.toHaveBeenCalled()
      const session = t2.host.get('s1')!
      expect(session).toBeDefined()
      expect(session.isInterrupted()).toBe(true)
      expect(recorder).toBeDefined()
      expect(recorder!.publications).toEqual([])
      const projector = await session.projector()
      expect(view.value()).toEqual(projector.value)
      expect(view.value()!.source).toBe('durable')
      expect(view.value()!.run.state).toBe('interrupted')
      expect(view.value()!.messages.map((m) => m.content)).toContain('hello')
      expect(crashed.server.hasSubscribers('s1')).toBe(true)
      expect(crashed.logs).toEqual([])
      expect(rig.logs).toEqual([])
      recorder!.stop()
    },
    TIMEOUT
  )

  it(
    'RH-2 pins with maxIdleOpen 0: a viewed idle session survives trims, closes at the next trim after the last release; an agent target pins its root (P3-04-13)',
    async () => {
      const hooks = hostHooks()
      const t = await makeHost({
        ...hooks.options,
        maxIdleOpen: 0,
        extensions: [TEST_SPAWN_EXTENSION]
      })
      const agents = new Map<string, { sessionId: string; conversationId: number }>()
      const rig = rigFor(t, hooks, { resolveAgent: (agentId) => agents.get(agentId) })
      // 建存储（建的途中先钉住，免得刚打开就被修剪），然后让它被 LRU 关掉
      const prime = async (
        sessionId: string,
        during?: (session: DurableSession) => Promise<void>
      ): Promise<void> => {
        t.pinned.add(sessionId)
        const session = await t.open(sessionId)
        await primeRoot(session)
        await during?.(session)
        t.pinned.delete(sessionId)
        const closed = closes(t, sessionId)
        await t.open('s0')
        // 摘牌是同步的，存储真正关掉（`close:` 事件）在 close 落定之后
        await waitFor(
          () => t.host.get(sessionId) === undefined && closes(t, sessionId) > closed,
          3000,
          `idle ${sessionId} closed by LRU`
        )
      }
      await prime('s1')
      expect(closes(t, 's1')).toBe(1)

      expect(rig.server.hasSubscribers('s1')).toBe(false)
      const a = rig.client().get(S1)
      await live(a)
      expect(rig.server.hasSubscribers('s1')).toBe(true)
      const b = rig.client().get(S1)
      await live(b)
      expect(rig.server.hasSubscribers('s1')).toBe(true)
      const session = t.host.get('s1')!
      expect(session).toBeDefined()

      // 走了一个：仍钉着
      a.release()
      await settle()
      expect(rig.server.hasSubscribers('s1')).toBe(true)

      // 看着的空闲会话：忙 → 闲之后的修剪、别的会话打开之后的修剪都不关它
      t.kit.queue(answer('ok'))
      expect(await withTimeout(session.submitUser('hi'), 5000, 'run')).toEqual({})
      await waitFor(() => t.statesOf('s1').at(-1) === 'idle', 3000, 'idle again')
      await t.open('s2')
      await settle()
      expect(t.host.get('s1')).toBe(session)
      expect(closes(t, 's1')).toBe(1)
      const shared = await session.projector()
      await converged(b, () => shared.value, 'b converged with the projector')
      expect(b.value()!.messages.map((m) => m.content)).toEqual(['hi', 'ok'])

      // 都走了：放手那一刻不关，下一次修剪才关（PIN-09）
      b.release()
      await until(() => !rig.server.hasSubscribers('s1'), 's1 unpinned')
      await settle()
      expect(t.host.get('s1')).toBe(session)
      expect(closes(t, 's1')).toBe(1)
      await t.open('s2')
      await waitFor(() => closes(t, 's1') === 2, 3000, 's1 closed by the next trim')
      expect(t.host.get('s1')).toBeUndefined()

      // 派生 agent 的目标钉住它的根会话（PIN-16）
      await prime('s3', async (s3) => {
        const seeded = await seedAgent(s3, { record: hookRec(), settle: true })
        agents.set('sub-h1', { sessionId: 's3', conversationId: seeded.conversationId })
      })
      expect(rig.server.hasSubscribers('s3')).toBe(false)
      const c = rig.client().get({ kind: 'agent', agentId: 'sub-h1' })
      const agentValue = await live(c)
      expect(agentValue).toMatchObject({ v: 1, agentId: 'sub-h1', sessionId: 's3' })
      expect(rig.server.hasSubscribers('s3')).toBe(true)
      const s3 = t.host.get('s3')!
      expect(s3).toBeDefined()
      await t.open('s4')
      await settle()
      expect(t.host.get('s3')).toBe(s3)
      c.release()
      await until(() => !rig.server.hasSubscribers('s3'), 's3 unpinned')
      expect(rig.logs).toEqual([])
    },
    TIMEOUT
  )

  it(
    'RH-3 a real faux turn: every client value is a projector revision in order, sampled values were already given, final messages and idle run',
    async () => {
      const hooks = hostHooks()
      const t = await makeHost({ ...hooks.options, kit: fauxKit({ tokensPerSecond: 120 }) })
      const rig = rigFor(t, hooks)
      const session = await t.open('s1')
      await primeRoot(session)
      const proj = await session.projector()
      const h = proj.acquire()
      const revisions: SessionView[] = []
      const stop = h.state.subscribe((value) => {
        revisions.push(value)
      })

      const view = rig.client().get(S1)
      expect(await live(view)).toEqual(h.state.value)

      const ANSWER = `alpha ${'beta '.repeat(30)}omega`
      t.kit.queue(answer(ANSWER))
      const sending = session.submitUser('hi')
      // 每次 settle：客户端此刻的值是投影已经给出过的某个值（跑完之前不要求是最新的）
      let samples = 0
      let sawBusy = false
      for (let index = 0; index < 400 && (samples === 0 || session.runState !== 'idle'); index++) {
        await settle(2)
        const value = view.value()
        expect(value).toBeDefined()
        expect(
          revisions.some((revision) => isDeepStrictEqual(revision, value)),
          `sample ${samples} is a revision the projector already gave`
        ).toBe(true)
        if (value!.run.state === 'busy') sawBusy = true
        samples++
      }
      expect(await withTimeout(sending, 15000, 'turn')).toEqual({})
      await waitFor(() => session.runState === 'idle', 5000, 'idle')
      await converged(view, () => h.state.value, 'final value')
      await settle()

      expect(view.value()).toEqual(h.state.value)
      expect(view.value()!.messages.map((m) => m.content)).toEqual(['hi', ANSWER])
      expect(view.value()!.run).toEqual({ state: 'idle' })
      expect(view.value()!.live).toBeNull()
      expect(sawBusy).toBe(true)
      // 流式中途的值也到了客户端（不止开头与结尾），每一个都是投影的修订、按序
      const values = view.values()
      expect(values.length).toBeGreaterThan(3)
      expect(values.some((value) => value.live !== null && value.live.message.content !== '')).toBe(
        true
      )
      expectOrderedSubsequence(values, revisions)
      expect(view.events.filter((event) => event === 'ops').length).toBeGreaterThan(2)
      expect(rig.logs).toEqual([])
      stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'RH-4 closeAll while viewed keeps the static last value; a new get afterwards is an empty view with no peek',
    async () => {
      const hooks = hostHooks()
      const t = await makeHost(hooks.options)
      const rig = rigFor(t, hooks)
      const session = await t.open('s1')
      await primeRoot(session)
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      const proj = await session.projector()
      const view = rig.client().get(S1)
      await live(view)
      await converged(view, () => proj.value, 'live value')
      const last = proj.value
      expect(last.messages.map((m) => m.content)).toEqual(['u1', 'one'])
      const framesBefore = view.views.length

      await withTimeout(t.host.closeAll(), 5000, 'closeAll')
      expect(t.host.sealed).toBe(true)
      await settle()
      expect(t.host.get('s1')).toBeUndefined()
      // 静态：句柄不断、值留着、可用性不变，关闭本身不发帧
      expect(view.status()).toBe('live')
      expect(view.value()).toEqual(last)
      expect(view.avail()).toBe('available')
      expect(view.views.length).toBe(framesBefore)
      expect(view.statuses).not.toContain('loading')

      // 之后新的 get：封存 → 空视图，不 peek（新目标；以及同一个目标在旧记录处置之后）
      const peeks = rig.peeks.length
      const s2 = rig.client().get(S2)
      expect(await live(s2)).toEqual(emptySessionView('s2'))
      view.release()
      await until(() => !rig.server.hasSubscribers('s1'), 's1 record disposed')
      const again = rig.client().get(S1)
      expect(await live(again)).toEqual(emptySessionView('s1'))
      expect(rig.peeks.length).toBe(peeks)
      expect(opens(t)).toEqual(['open:s1'])
      expect(rig.logs).toEqual([])
    },
    TIMEOUT
  )

  it(
    'RH-5 host.delete (clear) → the none view; the next submit → live on a fresh conversation, with no loading or unavailable in between',
    async () => {
      const hooks = hostHooks()
      const t = await makeHost(hooks.options)
      const rig = rigFor(t, hooks)
      const session = await t.open('s1')
      await primeRoot(session)
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      const view = rig.client().get(S1)
      await live(view)
      await until(() => view.value()?.messages.length === 2, 'history visible')

      await withTimeout(t.host.delete('s1'), 5000, 'delete')
      expect(t.events).toContain('delete:s1')
      await converged(view, () => emptySessionView('s1'), 'none view after delete')
      expect(view.avail()).toBe('available')
      expect(view.status()).toBe('live')
      expect(rig.server.hasSubscribers('s1')).toBe(true)

      // 下一次发送：宿主重新打开（新存储）→ 活视图，新对话里只有这一轮
      const fresh = await t.open('s1')
      expect(fresh).not.toBe(session)
      await primeRoot(fresh)
      t.kit.queue(answer('two'))
      expect(await fresh.submitUser('u2')).toEqual({})
      const proj = await fresh.projector()
      await until(
        () =>
          isDeepStrictEqual(
            view.value()?.messages.map((m) => m.content),
            ['u2', 'two']
          ),
        'fresh conversation visible'
      )
      await converged(view, () => proj.value, 'live on the fresh session')
      expect(view.value()!.source).toBe('durable')
      expect(view.value()!.run).toEqual({ state: 'idle' })
      expect(view.statuses).toEqual(['live'])
      expect(view.availability).not.toContain('unavailable')
      expect(rig.logs).toEqual([])
    },
    TIMEOUT
  )

  it(
    'RH-6 an extra throwing subscriber on the real projector: the client still converges, the failure is logged, nothing unhandled',
    async () => {
      const unhandled = recordUnhandled()
      const hooks = hostHooks()
      const t = await makeHost(hooks.options)
      const rig = rigFor(t, hooks)
      const session = await t.open('s1')
      await primeRoot(session)
      const view = rig.client().get(S1)
      await live(view)
      const proj = await session.projector()
      const h = proj.acquire()
      const stopThrowing = throwingSubscriber(h.state)

      t.kit.queue(answer('one'), answer('two'))
      expect(await session.submitUser('u1')).toEqual({})
      expect(await session.submitUser('u2')).toEqual({})
      await waitFor(() => session.runState === 'idle', 3000, 'idle')
      await converged(view, () => h.state.value, 'client converged')
      expect(view.value()!.messages.map((m) => m.content)).toEqual(['u1', 'one', 'u2', 'two'])
      expect(t.warnings.some((warning) => warning.includes('downstream boom'))).toBe(true)
      expect(unhandled).toEqual([])
      expect(rig.logs).toEqual([])
      stopThrowing()
      h.release()
    },
    TIMEOUT
  )
})

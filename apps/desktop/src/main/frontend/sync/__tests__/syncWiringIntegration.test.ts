/**
 * 视图同步的桌面接线 —— S 用例（pi 1.2 / chord2 上的视图服务端；移植自 phase 3 的 P3-05 / P3-14 / P3-10b /
 * P3-08）：真 SessionHost + 真 SQLite + 真 sessionService / 网关 / messageService / 路由（夹具
 * `services/__tests__/support/desktopRig`），真 `registerSyncHandlers(ipc)`（假 ipcMain、假 webContents），每个窗口里
 * 是 chat-ui **真的** `createSyncClient` 跑在 preload 的 `createSyncBridge` 上（夹具 `support/ipcLinkRig`）。
 *
 *   DI-1 (P3-05-18)  钉住整合（maxIdleOpen 0）：看着的空闲会话熬过修剪；两个窗口里一个关掉（`wc.destroy()`）仍钉着；
 *                    都关掉之后下一次修剪才关它，不在放手时关（PIN-09）；agent 目标钉住它的根会话
 *   DI-2 (P3-05-19)  旧格式行 + 有效 .jsonl → 旧格式视图；不 peek / open、不建 .sqlite、.jsonl 字节不变；
 *                    .jsonl 不在 / 读坏了 → 旧格式视图、空消息，不 peek
 *   DI-3 (P3-05-20)  没有存储 → none 视图（none 的能力）、不建 .sqlite；发送之后同一个绑定变成 durable（只 hold 一次），
 *                    答复到了
 *   DI-4 (P3-14-11)  重启之后：根会话没打开前订 agent → error not_found；订过会话（peek → 路由索引重建）之后订 agent →
 *                    live，等于会话自己的 agentProjector 的消息
 *   DI-5 (P3-05-22)  删除：deleteSession 恰一次、在宿主 delete 之后、删行之前；看着的绑定 → unavailable，放手之后
 *                    再订 → error not_found；没开过的会话也调；父子先子后父
 *   DI-6 (P3-05-23)  清空 durable 会话 → none 视图；从不 deleteSession、从不 unavailable；下一次发送 → durable
 *   DI-7 (P3-05-24)  清空旧格式会话 → none 视图 send:true；存储类型换成 durable-sqlite-1；不 deleteSession
 *   DI-8 (P3-10b-10) 回退 → 一次 settle 之内 view.messages = listMessages；没有 loading / unavailable，不重新 hold
 *   DI-9 (P3-08-62)  一轮工具 + 终答：store 的视图 = viewSnapshot；卡片 key 一路不变；放手之后不再钉住
 *
 * 夹具必须第一个 import（它登记 vi.mock）。`syncHandlers` / `syncWiring` 有模块级单例，`bootProcess()` 每次
 * `vi.resetModules()`，所以每个进程动态 import 它们（与会话宿主同一张模块图）。
 */
import {
  bootProcess,
  crash,
  insert,
  proc,
  rig,
  role,
  setupRig,
  teardownRig,
  unhandled,
  type Proc
} from '../../../services/__tests__/support/desktopRig'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { replicatedState } from '@earendil-works/chord'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'
import {
  answer,
  callTool,
  waitFor,
  withTimeout
} from '../../../services/__tests__/support/realHost'
import {
  assistant as legacyAssistant,
  legacyJsonl,
  user as legacyUser
} from '../../../services/__tests__/support/transcriptTwins'
import {
  FakeIpcMain,
  FakeWebContents,
  settle,
  syncWindow,
  type SyncWindow
} from './support/ipcLinkRig'
import type { SyncWebContents } from '../ipcLink'
import type {
  ViewBindingState,
  ViewEvent,
  ViewSubscription
} from '../../../../../../../packages/chat-ui/src/sync/syncClient'
import {
  applySessionView,
  releaseSessionView,
  selectIsStreaming,
  selectPendingPrompt,
  useChatStore
} from '../../../../../../../packages/chat-ui/src/stores/chatStore'
import { buildVisibleItems } from '../../../../../../../packages/chat-ui/src/components/chat/conversationItems'

const T = 30000

const SYNC_FRAME = 'sync:frame'

type Wiring = typeof import('../syncWiring')

/** 记下渲染端发上来的每一帧（数 `hold`：「同一个绑定、没有重新持有」） */
class TappedIpcMain extends FakeIpcMain {
  readonly up: Array<{ readonly wc: number; readonly link: string; readonly t: unknown }> = []

  override emitFrom(sender: SyncWebContents, channel: string, ...args: unknown[]): void {
    if (channel === SYNC_FRAME) {
      const frame = args[1] as { t?: unknown } | undefined
      this.up.push({ wc: sender.id, link: String(args[0]), t: frame?.t })
    }
    super.emitFrom(sender, channel, ...args)
  }

  /** 某个窗口发过几个 `hold` */
  holds(wcId: number): number {
    return this.up.filter((frame) => frame.wc === wcId && frame.t === 'hold').length
  }
}

interface Wired {
  readonly p: Proc
  readonly wiring: Wiring
  readonly ipc: TappedIpcMain
  window(id: number): SyncWindow
}

/** 这个测试里开过的窗口（收尾时关掉它们的客户端，免得重连计时器活过用例） */
const windows: SyncWindow[] = []
let currentWiring: Wiring | undefined

/** 这个进程的同步接线：真 registerSyncHandlers（假 ipcMain），窗口 = 真 syncClient + preload 桥 */
async function wire(): Promise<Wired> {
  const p = proc()
  const wiring = await import('../syncWiring')
  // eslint-disable-next-line boundaries/dependencies -- 同步通道的两半（frontend/sync 的服务端与 ipc 的 sync:frame 处理器）在一个用例里接起来
  const { registerSyncHandlers } = await import('../../../ipc/syncHandlers')
  const ipc = new TappedIpcMain()
  registerSyncHandlers(ipc)
  currentWiring = wiring
  return {
    p,
    wiring,
    ipc,
    window: (id) => {
      const win = syncWindow(new FakeWebContents(id), ipc)
      windows.push(win)
      return win
    }
  }
}

const S = (sessionId: string): SyncTarget => ({ kind: 'session', sessionId })
const A = (agentId: string): SyncTarget => ({ kind: 'agent', agentId })

/** 一个使用方的持有 + 它收到的全部事件 */
interface Watched<V> {
  readonly sub: ViewSubscription<V>
  readonly events: ViewEvent<V>[]
  value(): V | undefined
  state(): ViewBindingState
  /** 依次报出的状态 */
  statuses(): string[]
}

function watch<V extends SessionView | AgentView = SessionView>(
  win: SyncWindow,
  target: SyncTarget
): Watched<V> {
  const sub = win.client.acquire<V>(target)
  const events: ViewEvent<V>[] = []
  sub.subscribe((event) => void events.push(event))
  return {
    sub,
    events,
    value: () => sub.value(),
    state: () => sub.state(),
    statuses: () => events.flatMap((event) => (event.kind === 'status' ? [event.state.status] : []))
  }
}

/** 等绑定不再 loading（live / error / unavailable） */
async function settledBinding<V>(watched: Watched<V>, what: string): Promise<void> {
  await waitFor(() => watched.state().status !== 'loading', 10000, `binding settles: ${what}`)
}

/** 持有并等到 live（快照到了） */
async function live<V extends SessionView | AgentView = SessionView>(
  win: SyncWindow,
  target: SyncTarget
): Promise<Watched<V>> {
  const watched = watch<V>(win, target)
  await settledBinding(watched, JSON.stringify(target))
  expect(watched.state(), `binding of ${JSON.stringify(target)}`).toEqual({ status: 'live' })
  expect(watched.value()).toBeDefined()
  return watched
}

/** 有存储的会话：发一轮，等它答完 */
async function seed(p: Proc, sessionId: string, reply = 'ok'): Promise<void> {
  p.router.on(`seed-${sessionId}`, role('chat', `seed ${sessionId}`), answer(reply))
  expect(await withTimeout(p.chatGateway.prompt(sessionId, `seed ${sessionId}`), 15000)).toEqual({})
}

const sqlite = (sessionId: string): string => join(rig.sessionsDir, `${sessionId}.sqlite`)

const json = <V>(value: V): V => JSON.parse(JSON.stringify(value)) as V

const contents = (view: SessionView | AgentView | undefined): string[] =>
  (view?.messages ?? []).map((message) => `${message.role}:${message.content}`)

beforeEach(async () => {
  await setupRig()
})

afterEach(async () => {
  for (const win of windows.splice(0)) {
    try {
      win.client.dispose()
    } catch {
      /* 已经关了 */
    }
  }
  await settle()
  // 整条链路（chord、窗口链路、客户端）不该留下未处理的拒绝
  const leaked = unhandled.map(String)
  try {
    ;(currentWiring ?? (await import('../syncWiring'))).resetSyncHubForTests()
  } catch {
    /* 没有进程 */
  }
  currentWiring = undefined
  vi.restoreAllMocks()
  await teardownRig()
  expect(leaked).toEqual([])
})

// ─── DI-1 ─────────────────────────────────────────────

describe('DI-1 钉住整合（maxIdleOpen 0）', () => {
  /** 修剪的触发：再开一条（有存储的）会话 —— 打开之后宿主修剪一次 */
  async function trimVia(p: Proc, sessionId: string): Promise<void> {
    await p.host.peek(sessionId)
    await settle()
  }

  it(
    'DI-1 看着的空闲 s1 熬过修剪；两个窗口关掉一个仍钉着；都关掉（wc.destroy）之后下一次修剪才关它；agent 目标钉住根会话',
    async () => {
      // 进程 1（缺省 LRU）种好三条有存储的会话；进程 2 把 maxIdleOpen 设成 0（修剪由「再开一条会话」触发）
      await bootProcess()
      insert('s1')
      insert('s2')
      insert('s3')
      for (const id of ['s1', 's2', 's3']) await seed(proc(), id)
      await crash({ deps: { maxIdleOpen: 0 } })
      const { p, wiring, window } = await wire()
      expect(p.host.openSessionIds()).toEqual([])

      const closed: Array<[string, string]> = []
      const unhook = wiring.sessionHostHooks.onSessionClosed(
        (id, reason) => void closed.push([id, reason])
      )

      // 两个窗口看着 s1
      const w7 = window(7)
      const w9 = window(9)
      const a = await live(w7, S('s1'))
      const b = await live(w9, S('s1'))
      expect(a.value()?.source).toBe('durable')
      expect(b.value()?.source).toBe('durable')
      await settle()
      expect(p.host.get('s1')).toBeDefined()
      expect(wiring.peekSyncHub()!.hasSubscribers('s1')).toBe(true)

      // 另一条会话打开 → 修剪：s1 被钉住，s2 被关
      await trimVia(p, 's2')
      await waitFor(() => p.host.get('s2') === undefined, 5000, 's2 closed by LRU')
      expect(p.host.get('s1')).toBeDefined()

      // 一个窗口关掉：另一个还看着 → 仍钉着，修剪不关它
      w7.wc.destroy()
      await settle()
      expect(wiring.peekSyncHub()!.hasSubscribers('s1')).toBe(true)
      await trimVia(p, 's2')
      await waitFor(() => p.host.get('s2') === undefined, 5000, 's2 closed by LRU again')
      expect(p.host.get('s1')).toBeDefined()
      expect(closed.filter(([id]) => id === 's1')).toEqual([])

      // 两个都关掉：钉住松开，但放手本身不触发修剪（PIN-09）
      w9.wc.destroy()
      await waitFor(
        () => !wiring.peekSyncHub()!.hasSubscribers('s1'),
        5000,
        's1 unpinned after both windows left'
      )
      await settle()
      expect(p.host.get('s1')).toBeDefined()
      expect(closed.filter(([id]) => id === 's1')).toEqual([])
      // 下一次修剪才关它
      await trimVia(p, 's2')
      await waitFor(() => p.host.get('s1') === undefined, 5000, 's1 closed at the next trim')
      expect(closed).toContainEqual(['s1', 'remove'])

      // agent 目标钉住它的根会话（路由认得 a1 → s3；会话里的派生 agent 投影器换成一个假的）
      const agentState = replicatedState<AgentView>({
        v: 1,
        agentId: 'a1',
        sessionId: 's3',
        conversationId: 2,
        messages: [],
        live: null,
        toolRuns: {},
        run: { state: 'idle' },
        context: { usedTokens: null }
      })
      let agentLeases = 0
      vi.spyOn(p.agentManager, 'locate').mockImplementation((id) =>
        id === 'a1' ? { sessionId: 's3', conversationId: 2 } : undefined
      )
      const realPeek = p.host.peek.bind(p.host)
      vi.spyOn(p.host, 'peek').mockImplementation(async (id) => {
        const session = await realPeek(id)
        if (session !== undefined && id === 's3') {
          vi.spyOn(session, 'agentProjector').mockResolvedValue({
            acquire: () => {
              agentLeases += 1
              return { state: agentState, release: () => void (agentLeases -= 1) }
            }
          } as never)
        }
        return session
      })
      const w8 = window(8)
      const agent = await live<AgentView>(w8, A('a1'))
      expect(agent.value()!.agentId).toBe('a1')
      expect(agent.value()!.sessionId).toBe('s3')
      expect(agentLeases).toBe(1)
      expect(wiring.peekSyncHub()!.hasSubscribers('s3')).toBe(true)
      await trimVia(p, 's2')
      await waitFor(() => p.host.get('s2') === undefined, 5000, 's2 closed by LRU (agent case)')
      expect(p.host.get('s3')).toBeDefined()

      // agent 的窗口也关掉：根会话的钉住松开，租约还回去
      w8.wc.destroy()
      await waitFor(
        () => !wiring.peekSyncHub()!.hasSubscribers('s3'),
        5000,
        's3 unpinned after the agent window left'
      )
      await waitFor(() => agentLeases === 0, 5000, 'agent projector lease released')
      unhook()
    },
    T
  )
})

// ─── DI-2 ─────────────────────────────────────────────

describe('DI-2 旧格式视图', () => {
  it(
    'DI-2 旧格式行 + 有效 .jsonl：旧格式视图（能力全关、消息 = readLegacyTranscript）；不 peek / open、不建 .sqlite、.jsonl 字节不变',
    async () => {
      await bootProcess()
      const { p, window } = await wire()
      insert('old', { storageKind: 'harness-v3-jsonl' })
      const file = join(rig.sessionsDir, 'old.jsonl')
      writeFileSync(
        file,
        legacyJsonl('old', [legacyUser(1000, 'hi'), legacyAssistant(2000, 'hello there')])
      )
      const bytes = readFileSync(file)
      const peek = vi.spyOn(p.host, 'peek')
      const open = vi.spyOn(p.host, 'open')
      const { readLegacyTranscript } = await import('../../../services/sessionStorage')
      const expected = readLegacyTranscript('old')!.messages
      expect(expected.length).toBeGreaterThan(0)

      const a = await live(window(7), S('old'))
      const view = a.value()!
      expect(view.source).toBe('legacy')
      expect(view.capabilities).toEqual({ send: false, rollback: false, continue: false })
      expect(view.messages).toEqual(json(expected))
      expect(contents(view)).toEqual(['user:hi', 'assistant:hello there'])
      await settle()
      expect(peek).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      expect(existsSync(sqlite('old'))).toBe(false)
      expect(readFileSync(file).equals(bytes)).toBe(true)
    },
    T
  )

  it(
    'DI-2 旧格式行但 .jsonl 不在 / 读坏了 → 只读的旧格式视图、消息为空，不 peek',
    async () => {
      await bootProcess()
      const { p, window } = await wire()
      insert('gone', { storageKind: 'harness-v3-jsonl' })
      insert('bad', { storageKind: 'harness-v3-jsonl' })
      writeFileSync(join(rig.sessionsDir, 'bad.jsonl'), '{not json\n')
      const peek = vi.spyOn(p.host, 'peek')
      const open = vi.spyOn(p.host, 'open')
      const w = window(7)
      for (const id of ['gone', 'bad']) {
        const view = (await live(w, S(id))).value()!
        expect(view.source, id).toBe('legacy')
        expect(view.messages, id).toEqual([])
        expect(view.capabilities.send, id).toBe(false)
      }
      await settle()
      expect(peek).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      expect(existsSync(sqlite('gone'))).toBe(false)
      expect(existsSync(sqlite('bad'))).toBe(false)
    },
    T
  )
})

// ─── DI-3 ─────────────────────────────────────────────

describe('DI-3 none → durable', () => {
  it(
    'DI-3 没有存储：none 视图 {send:true, rollback:false, continue:false}、不建 .sqlite；发送之后同一个绑定变成 durable（只 hold 一次），答复到了',
    async () => {
      await bootProcess()
      const { p, ipc, window } = await wire()
      insert('s1')
      const w = window(7)
      const a = await live(w, S('s1'))
      expect(a.value()?.source).toBe('none')
      expect(a.value()?.capabilities).toEqual({ send: true, rollback: false, continue: false })
      expect(a.value()?.messages).toEqual([])
      expect(existsSync(sqlite('s1'))).toBe(false)

      p.router.on('root', role('chat', 'hello'), answer('hi back'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'hello'), 15000)).toEqual({})
      await waitFor(() => a.value()?.source === 'durable', 5000, 'durable view')
      await waitFor(
        () => contents(a.value()).includes('assistant:hi back'),
        5000,
        'answer reaches the view'
      )
      expect(contents(a.value())).toEqual(['user:hello', 'assistant:hi back'])
      expect(a.state()).toEqual({ status: 'live' })
      expect(a.statuses()).not.toContain('unavailable')
      expect(a.statuses()).not.toContain('error')
      expect(a.statuses()).not.toContain('loading')
      expect(ipc.holds(7)).toBe(1)
      expect(w.warnings).toEqual([])
    },
    T
  )
})

// ─── DI-4 ─────────────────────────────────────────────

describe('DI-4 重启之后的 agent 目标', () => {
  it(
    'DI-4 进程 2：根会话没打开前订 agent → error not_found；订过会话（peek → 路由索引重建）之后订 agent → live，= 会话自己的 agentProjector 的消息',
    async () => {
      // 进程 1：s1 派发一个 explore（a1），答完
      const p1 = await bootProcess()
      insert('s1')
      p1.router.on('explore', role('explore'), answer('found'))
      p1.router.on(
        'root',
        role('chat'),
        callTool('agent', { name: 'explore', prompt: 'find', description: 'look' }, 'call-agent'),
        answer('done')
      )
      expect(await withTimeout(p1.chatGateway.prompt('s1', 'go'), 15000, 'prompt')).toEqual({})
      const a1 = rig.broadcasts.find((e) => e.type === 'sub_session_register')!.sessionId as string
      expect(await (await import('../syncWiring')).resolveAgentOf(a1)).toEqual({
        sessionId: 's1',
        conversationId: expect.any(Number)
      })

      // 重启：根会话还没在这个进程里打开过 → 认不出（不加持久的 agentId → 会话查找）
      await crash()
      const { p, window } = await wire()
      expect(p.host.openSessionIds()).toEqual([])
      const w = window(7)
      const early = watch<AgentView>(w, A(a1))
      await settledBinding(early, 'agent before the root is open')
      expect(early.state()).toEqual({ status: 'error', code: 'not_found' })
      expect(early.value()).toBeUndefined()
      expect(early.events.some((event) => event.kind === 'value')).toBe(false)
      expect(early.sub.release()).toBe(true)

      // 先订会话（peek → 打开 → 路由索引重建），再订 agent：快照是 a1 的 AgentView
      const root = await live(w, S('s1'))
      expect(root.value()?.source).toBe('durable')
      const agent = await live<AgentView>(w, A(a1))
      const view = agent.value()!
      expect(view.agentId).toBe(a1)
      expect(view.sessionId).toBe('s1')
      expect(view.conversationId).toBe(p.agentManager.locate(a1)!.conversationId)
      expect(view.messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'find'],
        ['assistant', 'found']
      ])
      // 与这条会话自己对 a1 的投影同一份
      const session = p.host.get('s1')!
      const projector = (await session.agentProjector(a1))!
      const handle = projector.acquire()
      try {
        expect(view.messages).toEqual(json(handle.state.value.messages))
      } finally {
        handle.release()
      }
      expect(agent.statuses()).not.toContain('error')
      expect(agent.statuses()).not.toContain('unavailable')
    },
    T
  )
})

// ─── DI-5 ─────────────────────────────────────────────

describe('DI-5 删除', () => {
  it(
    'DI-5 宿主 delete 挂着时 deleteSession 没调；放开后恰一次、在宿主 delete 之后、删行之前；看着的绑定 → unavailable，放手之后再订 → error not_found',
    async () => {
      await bootProcess()
      const { p, wiring, window } = await wire()
      insert('s1')
      await seed(p, 's1')
      const w = window(7)
      const a = await live(w, S('s1'))
      expect(a.value()?.source).toBe('durable')

      const hub = wiring.peekSyncHub()!
      expect(hub.hasSubscribers('s1')).toBe(true)
      const deleteSession = vi.spyOn(hub, 'deleteSession')
      const deleteById = vi.spyOn(p.sessionRecords, 'deleteById')
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      const realDelete = p.host.delete.bind(p.host)
      const hostDelete = vi.spyOn(p.host, 'delete').mockImplementation(async (id) => {
        if (id === 's1') await held
        return realDelete(id)
      })

      const pending = p.sessionService.delete('s1')
      await waitFor(() => hostDelete.mock.calls.length > 0, 5000, 'host.delete reached')
      await settle()
      expect(deleteSession).not.toHaveBeenCalled()
      expect(deleteById).not.toHaveBeenCalled()

      release()
      await withTimeout(pending, 15000, 'sessionService.delete')
      expect(deleteSession.mock.calls).toEqual([['s1']])
      expect(deleteById).toHaveBeenCalledTimes(1)
      expect(deleteSession.mock.invocationCallOrder[0]!).toBeGreaterThan(
        hostDelete.mock.invocationCallOrder[0]!
      )
      expect(deleteSession.mock.invocationCallOrder[0]!).toBeLessThan(
        deleteById.mock.invocationCallOrder[0]!
      )

      await waitFor(() => a.state().status === 'unavailable', 5000, 'viewer sees unavailable')
      expect(a.state()).toEqual({ status: 'unavailable' })
      expect(a.value()).toBeUndefined()
      expect(hub.hasSubscribers('s1')).toBe(false)

      // 旧绑定放手之后再订（新句柄）→ 找不到
      expect(a.sub.release()).toBe(true)
      const again = watch(w, S('s1'))
      await settledBinding(again, 'resubscribe after delete')
      expect(again.state()).toEqual({ status: 'error', code: 'not_found' })
      expect(again.value()).toBeUndefined()
      expect(hub.hasSubscribers('s1')).toBe(false)
    },
    T
  )

  it(
    'DI-5 没开过的会话也调 deleteSession；父子：先子后父（各在自己的宿主 delete 之后）',
    async () => {
      await bootProcess()
      const { p, wiring, window } = await wire()
      // 服务端在第一条链路的第一帧才建：先有一个客户端
      insert('watched')
      await live(window(7), S('watched'))
      const hub = wiring.peekSyncHub()!
      const deleteSession = vi.spyOn(hub, 'deleteSession')
      const hostDelete = vi.spyOn(p.host, 'delete')

      insert('never')
      await withTimeout(p.sessionService.delete('never'), 15000)
      expect(deleteSession.mock.calls).toEqual([['never']])
      expect(hostDelete.mock.calls.map(([id]) => id)).toEqual(['never'])
      expect(deleteSession.mock.invocationCallOrder[0]!).toBeGreaterThan(
        hostDelete.mock.invocationCallOrder[0]!
      )

      insert('P')
      insert('C', { parentId: 'P' })
      deleteSession.mockClear()
      hostDelete.mockClear()
      await withTimeout(p.sessionService.delete('P'), 15000)
      expect(deleteSession.mock.calls).toEqual([['C'], ['P']])
      expect(hostDelete.mock.calls.map(([id]) => id)).toEqual(['C', 'P'])
      expect(deleteSession.mock.invocationCallOrder[0]!).toBeGreaterThan(
        hostDelete.mock.invocationCallOrder[0]!
      )
      expect(deleteSession.mock.invocationCallOrder[1]!).toBeGreaterThan(
        hostDelete.mock.invocationCallOrder[1]!
      )
      // 子会话的 deleteSession 在父会话的宿主 delete 之前
      expect(deleteSession.mock.invocationCallOrder[0]!).toBeLessThan(
        hostDelete.mock.invocationCallOrder[1]!
      )
    },
    T
  )
})

// ─── DI-6 ─────────────────────────────────────────────

describe('DI-6 清空 durable 会话', () => {
  it(
    'DI-6 gateway.clearMessages → none 视图；从不 deleteSession、从不 unavailable；下一次发送 → durable',
    async () => {
      await bootProcess()
      const { p, wiring, ipc, window } = await wire()
      insert('s1')
      await seed(p, 's1')
      const w = window(7)
      const a = await live(w, S('s1'))
      expect(a.value()?.source).toBe('durable')
      expect(a.value()?.messages.length).toBeGreaterThan(0)
      const deleteSession = vi.spyOn(wiring.peekSyncHub()!, 'deleteSession')

      await withTimeout(p.chatGateway.clearMessages('s1'), 15000, 'clearMessages')
      await waitFor(() => a.value()?.source === 'none', 5000, 'none view after clear')
      expect(a.value()?.messages).toEqual([])
      expect(a.value()?.capabilities.send).toBe(true)
      expect(a.state()).toEqual({ status: 'live' })
      expect(a.statuses()).not.toContain('unavailable')
      expect(deleteSession).not.toHaveBeenCalled()

      p.router.on('fresh', role('chat', 'fresh'), answer('new start'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'fresh'), 15000)).toEqual({})
      await waitFor(() => a.value()?.source === 'durable', 5000, 'durable view after send')
      await waitFor(
        () => contents(a.value()).includes('assistant:new start'),
        5000,
        'fresh answer reaches the view'
      )
      expect(contents(a.value())).toEqual(['user:fresh', 'assistant:new start'])
      expect(a.statuses()).not.toContain('unavailable')
      expect(a.statuses()).not.toContain('error')
      expect(deleteSession).not.toHaveBeenCalled()
      expect(ipc.holds(7)).toBe(1)
    },
    T
  )
})

// ─── DI-7 ─────────────────────────────────────────────

describe('DI-7 清空旧格式会话', () => {
  it(
    'DI-7 旧格式视图上 clearMessages → none 视图（send:true）、没有 unavailable；存储类型换成 durable-sqlite-1；不 deleteSession',
    async () => {
      await bootProcess()
      const { p, wiring, window } = await wire()
      insert('old', { storageKind: 'harness-v3-jsonl' })
      writeFileSync(
        join(rig.sessionsDir, 'old.jsonl'),
        legacyJsonl('old', [legacyUser(1000, 'hi'), legacyAssistant(2000, 'hello')])
      )
      const a = await live(window(7), S('old'))
      expect(a.value()?.source).toBe('legacy')
      const deleteSession = vi.spyOn(wiring.peekSyncHub()!, 'deleteSession')

      await withTimeout(p.chatGateway.clearMessages('old'), 15000, 'clearMessages')
      await waitFor(() => a.value()?.source === 'none', 5000, 'none view after legacy clear')
      expect(a.value()?.capabilities).toEqual({ send: true, rollback: false, continue: false })
      expect(a.value()?.messages).toEqual([])
      expect(a.state()).toEqual({ status: 'live' })
      expect(a.statuses()).not.toContain('unavailable')
      expect(p.sessionRecords.pick('old', ['storageKind'])?.storageKind).toBe('durable-sqlite-1')
      expect(deleteSession).not.toHaveBeenCalled()
    },
    T
  )
})

// ─── DI-8 ─────────────────────────────────────────────

describe('DI-8 回退之后视图不用重拉', () => {
  it(
    'DI-8 gateway.rollbackMessage：看着的绑定一次 settle 之内 view.messages = listMessages；没有 loading / unavailable，不重新 hold',
    async () => {
      await bootProcess()
      const { p, ipc, window } = await wire()
      insert('s1')
      p.router.on('t1', role('chat', 'U1'), answer('A1'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'U1'), 15000)).toEqual({})
      p.router.on('t2', role('chat', 'U1'), answer('A2'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'U2'), 15000)).toEqual({})
      const w = window(7)
      const a = await live(w, S('s1'))
      await waitFor(() => (a.value()?.messages ?? []).length === 4, 5000, 'four messages')
      expect(contents(a.value())).toEqual(['user:U1', 'assistant:A1', 'user:U2', 'assistant:A2'])
      const u2 = a.value()!.messages[2]!
      const eventsBefore = a.events.length
      expect(ipc.holds(7)).toBe(1)

      expect(await withTimeout(p.chatGateway.rollbackMessage('s1', u2.id), 15000)).toBe(true)
      const listed = await p.chatGateway.listMessages('s1')
      expect(listed.map((m) => m.content)).toEqual(['U1', 'A1'])
      // 一次 settle 之内就到了 —— 不等、不重拉
      await settle()
      expect(a.value()?.messages).toEqual(json(listed))
      expect(a.state()).toEqual({ status: 'live' })
      const after = a.events.slice(eventsBefore)
      expect(after.some((event) => event.kind === 'value')).toBe(true)
      expect(after.filter((event) => event.kind === 'status')).toEqual([])
      expect(a.statuses()).not.toContain('loading')
      expect(a.statuses()).not.toContain('unavailable')
      expect(ipc.holds(7)).toBe(1)
    },
    T
  )
})

// ─── DI-9 ─────────────────────────────────────────────

describe('DI-9 IPC 端到端：chat-ui 的 store', () => {
  it(
    'DI-9 一轮工具 + 终答：store 的视图 = viewSnapshot；卡片 key 一路是 turn:1.0；放手之后不再钉住',
    async () => {
      await bootProcess()
      const { p, wiring, window } = await wire()
      insert('s1')

      useChatStore.setState({ sessionViews: {}, sessionStreams: {}, messages: [] })
      useChatStore.getState().setActiveSessionId('s1')
      const w = window(7)
      const sub = w.client.acquire<SessionView>(S('s1'))
      const stop = sub.subscribe((event) => {
        if (event.kind === 'value') applySessionView('s1', event.value)
      })
      await waitFor(() => sub.state().status === 'live', 10000, 'binding live')
      // 第一份值在订上之前就可能到了：补一次（store 写入是幂等的）
      applySessionView('s1', sub.value()!)
      expect(wiring.peekSyncHub()!.hasSubscribers('s1')).toBe(true)

      const keys: string[][] = []
      const off = useChatStore.subscribe((s) => {
        const items = buildVisibleItems(s.messages, selectIsStreaming(s), selectPendingPrompt(s))
        keys.push(items.filter((i) => i.key.startsWith('turn:')).map((i) => i.key))
      })

      p.router.on(
        'root',
        role('chat', 'go'),
        callTool('probe', {}, 'call-probe'),
        answer('final words')
      )
      expect(await withTimeout(p.chatGateway.prompt('s1', 'go'), 15000, 'prompt')).toEqual({})
      const session = p.host.get('s1')!
      await waitFor(
        async () => {
          const snapshot = await session.viewSnapshot()
          return (
            snapshot.run.state === 'idle' &&
            snapshot.messages.at(-1)?.content === 'final words' &&
            JSON.stringify(useChatStore.getState().sessionViews.s1) === JSON.stringify(snapshot)
          )
        },
        10000,
        'store converges on the snapshot'
      )
      await settle()
      off()

      const snapshot = await session.viewSnapshot()
      expect(useChatStore.getState().sessionViews.s1).toEqual(snapshot)
      expect(useChatStore.getState().messages).toEqual(snapshot.messages)
      expect(sub.value()).toEqual(snapshot)
      expect(snapshot.messages.at(-1)!.content).toBe('final words')
      // 工具确实跑过一轮（工具块在卡里）
      expect(JSON.stringify(snapshot.messages)).toContain('call-probe')
      // 卡片 key：有卡的每个状态里都恰是 turn:1.0
      const withCard = keys.filter((k) => k.length > 0)
      expect(withCard.length).toBeGreaterThan(0)
      expect(withCard.every((k) => k.length === 1 && k[0] === 'turn:1.0')).toBe(true)

      stop()
      expect(sub.release()).toBe(true)
      releaseSessionView('s1')
      await waitFor(
        () => !wiring.peekSyncHub()!.hasSubscribers('s1'),
        5000,
        's1 unpinned after release'
      )
      useChatStore.getState().setActiveSessionId(null)
    },
    T
  )
})

/**
 * 视图同步的桌面接线 —— S 用例（P3-05，docs/pi-durable/p3-050710a-test-design.md）：真 SessionHost + 真
 * SQLite + 真 sessionService / 网关 / messageService / 路由（夹具 `services/__tests__/support/desktopRig`），
 * 真 `registerSyncHandlers`（假 ipcMain、假 webContents），窗口里是真的 chord 绑定跑在 preload 的
 * `createSyncBridge` 上。
 *
 *   P3-05-18 isPinned 整合（maxIdleOpen 0：订阅着的空闲会话熬过修剪；客户端离开之后下一次修剪才关，PIN-09；
 *            agent 目标钉住它的根会话）
 *   P3-05-19 legacyView（真文件的那一半：旧格式视图、不 peek / open、不建 .sqlite、.jsonl 字节不变；读坏了 →
 *            空消息）
 *   P3-05-20 none → durable（没有存储 → none 视图、不建 .sqlite；发送之后 replaced 成 durable，门面不变）
 *   P3-14-11 resolveAgent 重启之后（翻转 P3-05-21 / PIN-10）：根会话没打开前订 agent → service_not_found
 *            （PIN-12）；订过会话（peek → 重建）之后订 agent → 它的 AgentView
 *   P3-05-22 删除（宿主 delete 挂着时 hub.deleteSession 还没调；放开后恰一次、在删行之前，PIN-07；客户端收到
 *            unavailable、再订阅 → service_not_found；没开过的会话也调；父子：先子后父）
 *   P3-05-23 清空 durable 会话（从不 deleteSession；replaced 成 none 视图、不是 unavailable；下一次发送 replaced
 *            成 durable 视图）
 *   P3-05-24 清空旧格式会话（PIN-06：none 视图 send:true、没有 unavailable；存储类型换掉；不 deleteSession）
 *   P3-10b-10 回退之后订阅着的客户端在帧冲刷内拿到 = listBySession 的 messages；门面不变，没有 replaced / unavailable
 *
 * 夹具必须第一个 import（它登记 vi.mock）。
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
  type Proc
} from '../../../services/__tests__/support/desktopRig'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createServiceSubscribeCall,
  replicatedState,
  type JsonValue,
  type ServiceProviderUpdate
} from '@earendil-works/chord'
import { CHAT_VIEW_SERVICE_ID, type SyncTarget } from '@shuvix/chat-protocol/sync'
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
  type SyncWindow,
  type TestBinding
} from './support/ipcRig'
import { agentViewOf } from './support/fakeSync'

const T = 30000

type Wiring = typeof import('../syncWiring')

interface Wired {
  readonly p: Proc
  readonly wiring: Wiring
  readonly ipc: FakeIpcMain
  readonly table: Map<number, FakeWebContents>
  window(id: number): SyncWindow
}

/** 这个进程的同步接线：真 registerSyncHandlers（假 ipcMain，webContents 表查找） */
async function wire(): Promise<Wired> {
  const p = proc()
  const wiring = await import('../syncWiring')
  // eslint-disable-next-line boundaries/dependencies -- 同步通道的两半（frontend/sync 的 hub 与 ipc 的 sync:invoke 处理器）在一个用例里接起来
  const { registerSyncHandlers } = await import('../../../ipc/syncHandlers')
  const ipc = new FakeIpcMain()
  const table = new Map<number, FakeWebContents>()
  registerSyncHandlers(ipc, { lookup: (id) => table.get(id) })
  return {
    p,
    wiring,
    ipc,
    table,
    window: (id) => {
      const wc = new FakeWebContents(id)
      table.set(id, wc)
      return syncWindow(wc, ipc)
    }
  }
}

const S = (sessionId: string): SyncTarget => ({ kind: 'session', sessionId })

async function bound(win: SyncWindow, target: SyncTarget): Promise<TestBinding> {
  const binding = win.bind(target)
  await withTimeout(binding.ready(), 10000, `binding ready ${JSON.stringify(target)}`)
  return binding
}

function types(updates: readonly ServiceProviderUpdate[]): string[] {
  return updates.map((update) => update.type)
}

const viewOf = (binding: TestBinding): SessionView | undefined =>
  binding.value() as SessionView | undefined

const codeOf = (error: unknown): string | undefined =>
  (error as { code?: unknown } | undefined)?.code as string | undefined

/** 有存储的会话：发一轮，等它答完（maxIdleOpen 0 时随后被 LRU 关掉） */
async function seed(p: Proc, sessionId: string, reply = 'ok'): Promise<void> {
  p.router.on(`seed-${sessionId}`, role('chat', `seed ${sessionId}`), answer(reply))
  expect(await withTimeout(p.chatGateway.prompt(sessionId, `seed ${sessionId}`), 15000)).toEqual({})
}

const sqlite = (sessionId: string): string => join(rig.sessionsDir, `${sessionId}.sqlite`)

beforeEach(async () => {
  await setupRig()
})

afterEach(async () => {
  try {
    ;(await import('../syncWiring')).resetSyncHubForTests()
  } catch {
    /* 没有进程 */
  }
  await teardownRig()
})

describe('P3-05-18 isPinned 整合（S）', () => {
  /** 修剪的触发：再开一条（有存储的）会话 —— 打开之后宿主修剪一次 */
  async function trimVia(p: Proc, sessionId: string): Promise<void> {
    await p.host.peek(sessionId)
    await settle()
  }

  it(
    'P3-05-18 订阅着的空闲 s1 熬过修剪；客户端离开之后下一次修剪才关它（hub 看到 remove）；agent 目标钉住根会话',
    async () => {
      // 进程 1（缺省 LRU）种好三条有存储的会话；进程 2 把 maxIdleOpen 设成 0。maxIdleOpen 0 下网关的发送
      // 本身会和「打开之后的修剪」赛跑（打开到受理之间会话是空闲的），所以修剪改由「再开一条会话」触发
      await bootProcess()
      insert('s1')
      insert('s2')
      insert('s3')
      for (const id of ['s1', 's2', 's3']) await seed(proc(), id)
      await crash({ deps: { maxIdleOpen: 0 } })
      const { p, wiring, window } = await wire()
      expect(p.host.openSessionIds()).toEqual([])

      const closed: Array<[string, string]> = []
      wiring.sessionHostHooks.onSessionClosed((id, reason) => void closed.push([id, reason]))

      const w7 = window(7)
      const a = await bound(w7, S('s1'))
      expect(viewOf(a)?.source).toBe('durable')
      await settle()
      expect(p.host.get('s1')).toBeDefined()
      expect(wiring.peekSyncHub()!.hasSubscribers('s1')).toBe(true)

      // 另一条会话打开 → 修剪：s1 被钉住，s2 被关
      await trimVia(p, 's2')
      await waitFor(() => p.host.get('s2') === undefined, 5000, 's2 closed by LRU')
      expect(p.host.get('s1')).toBeDefined()

      // 客户端离开：钉住松开，但退订不触发修剪（PIN-09）
      w7.wc.destroy()
      expect(wiring.peekSyncHub()!.hasSubscribers('s1')).toBe(false)
      await settle()
      expect(p.host.get('s1')).toBeDefined()
      // 下一次修剪才关它
      await trimVia(p, 's2')
      await waitFor(() => p.host.get('s1') === undefined, 5000, 's1 closed at the next trim')
      expect(closed).toContainEqual(['s1', 'remove'])

      // agent 目标钉住它的根会话（路由认得 a1 → s3；会话里的派生 agent 投影器换成一个假的）
      const agentState = replicatedState<AgentView>(agentViewOf('a1', 's3', 2))
      vi.spyOn(p.agentManager, 'locate').mockImplementation((id) =>
        id === 'a1' ? { sessionId: 's3', conversationId: 2 } : undefined
      )
      const realPeek = p.host.peek.bind(p.host)
      vi.spyOn(p.host, 'peek').mockImplementation(async (id) => {
        const session = await realPeek(id)
        if (session !== undefined && id === 's3') {
          vi.spyOn(session, 'agentProjector').mockResolvedValue({
            acquire: () => ({ state: agentState, release: () => {} })
          } as never)
        }
        return session
      })
      const w8 = window(8)
      const agent = await bound(w8, { kind: 'agent', agentId: 'a1' })
      expect((agent.value() as AgentView).agentId).toBe('a1')
      expect(wiring.peekSyncHub()!.hasSubscribers('s3')).toBe(true)
      await trimVia(p, 's2')
      await waitFor(() => p.host.get('s2') === undefined, 5000, 's2 closed by LRU (agent case)')
      expect(p.host.get('s3')).toBeDefined()
    },
    T
  )
})

describe('P3-05-19 legacyView（S）', () => {
  it(
    'P3-05-19 旧格式行 + 有效 .jsonl：旧格式视图（能力全关、消息 = readLegacyTranscript）；不 peek / open、不建 .sqlite、.jsonl 字节不变',
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

      const a = await bound(window(7), S('old'))
      const view = viewOf(a)!
      expect(view.source).toBe('legacy')
      expect(view.capabilities).toEqual({ send: false, rollback: false, continue: false })
      expect(view.messages).toEqual(JSON.parse(JSON.stringify(expected)))
      expect(peek).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      expect(existsSync(sqlite('old'))).toBe(false)
      expect(readFileSync(file).equals(bytes)).toBe(true)
    },
    T
  )

  it(
    'P3-05-19 旧格式行但 .jsonl 不在 / 读坏了 → 只读的旧格式视图、消息为空（PIN-05），不 peek',
    async () => {
      await bootProcess()
      const { p, window } = await wire()
      insert('gone', { storageKind: 'harness-v3-jsonl' })
      insert('bad', { storageKind: 'harness-v3-jsonl' })
      writeFileSync(join(rig.sessionsDir, 'bad.jsonl'), '{not json\n')
      const peek = vi.spyOn(p.host, 'peek')
      const w = window(7)
      for (const id of ['gone', 'bad']) {
        const view = viewOf(await bound(w, S(id)))!
        expect(view.source).toBe('legacy')
        expect(view.messages).toEqual([])
        expect(view.capabilities.send).toBe(false)
      }
      expect(peek).not.toHaveBeenCalled()
    },
    T
  )
})

describe('P3-05-20 none → durable（S）', () => {
  it(
    'P3-05-20 没有存储：none 视图 {send:true, rollback:false, continue:false}、不建 .sqlite；发送之后 replaced，门面不变、变成 durable',
    async () => {
      await bootProcess()
      const { p, window } = await wire()
      insert('s1')
      const a = await bound(window(7), S('s1'))
      const facade = a.facade()
      expect(viewOf(a)?.source).toBe('none')
      expect(viewOf(a)?.capabilities).toEqual({ send: true, rollback: false, continue: false })
      expect(existsSync(sqlite('s1'))).toBe(false)

      p.router.on('root', role('chat', 'hello'), answer('hi back'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'hello'), 15000)).toEqual({})
      await waitFor(() => viewOf(a)?.source === 'durable', 5000, 'durable view')
      expect(types(a.updates)).toContain('replaced')
      expect(a.facade()).toBe(facade)
      await waitFor(
        () => (viewOf(a)?.messages ?? []).some((m) => m.content === 'hi back'),
        5000,
        'answer reaches the view'
      )
      expect(a.errors).toEqual([])
    },
    T
  )
})

describe('P3-05-21 / P3-14-11 resolveAgent after a restart（S）', () => {
  it(
    'P3-14-11 (flips P3-05-21 / PIN-10) process 2: an agent subscribe before the root is open → service_not_found (PIN-12); after the session subscribe (peek → rebuild) → the AgentView',
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

      // 重启：根会话还没在这个进程里打开过 → 认不出（PIN-12：不加持久的 agentId → 会话查找）
      await crash()
      const { p, ipc, window } = await wire()
      expect(p.host.openSessionIds()).toEqual([])
      const w = window(7)
      const agentTarget: SyncTarget = { kind: 'agent', agentId: a1 }
      const call = createServiceSubscribeCall(
        'sub-a1',
        CHAT_VIEW_SERVICE_ID,
        'singleton'
      ) as unknown as JsonValue
      const reply = await ipc.invokeAs(w.wc, 'sync:invoke', agentTarget, call)
      expect(reply).toMatchObject({ ok: false, error: { code: 'service_not_found' } })
      const rejected = await w.sync.invoke(agentTarget, call).catch((error: unknown) => error)
      expect(codeOf(rejected)).toBe('service_not_found')

      // 先订会话（peek → 打开 → 重建），再订 agent：快照是 a1 的 AgentView
      const root = await bound(w, S('s1'))
      expect(viewOf(root)?.source).toBe('durable')
      const agent = await bound(w, agentTarget)
      const view = agent.value() as AgentView
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
        expect(view.messages).toEqual(JSON.parse(JSON.stringify(handle.state.value.messages)))
      } finally {
        handle.release()
      }
      expect(agent.errors).toEqual([])
    },
    T
  )
})

describe('P3-05-22 删除（S）', () => {
  it(
    'P3-05-22 宿主 delete 挂着时 hub.deleteSession 没调；放开后恰一次、在删行之前；客户端收到 unavailable，再订阅 → service_not_found',
    async () => {
      await bootProcess()
      const { p, wiring, window } = await wire()
      insert('s1')
      await seed(p, 's1')
      const w = window(7)
      const a = await bound(w, S('s1'))
      expect(viewOf(a)?.source).toBe('durable')

      const hub = wiring.peekSyncHub()!
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

      await settle()
      expect(types(a.updates).at(-1)).toBe('unavailable')
      expect(a.value()).toBeUndefined()
      expect(hub.hasSubscribers('s1')).toBe(false)

      const again = w.bind(S('s1'))
      const error = await again.ready().then(
        () => undefined,
        (reason: unknown) => reason
      )
      expect(codeOf(error)).toBe('service_not_found')
    },
    T
  )

  it(
    'P3-05-22 没开过的会话也调；父子：先子后父（各在自己的宿主 delete 之后）',
    async () => {
      await bootProcess()
      const { p, wiring, window } = await wire()
      // hub 在第一次同步调用时才建：先有一个客户端
      insert('watched')
      await bound(window(7), S('watched'))
      const hub = wiring.peekSyncHub()!
      const deleteSession = vi.spyOn(hub, 'deleteSession')
      const hostDelete = vi.spyOn(p.host, 'delete')

      insert('never')
      await withTimeout(p.sessionService.delete('never'), 15000)
      expect(deleteSession.mock.calls).toEqual([['never']])

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
    },
    T
  )
})

describe('P3-05-23 清空 durable 会话（S）', () => {
  it(
    'P3-05-23 gateway.clearMessages：从不 deleteSession；replaced 成 none 视图、没有 unavailable；下一次发送 replaced 成 durable',
    async () => {
      await bootProcess()
      const { p, wiring, window } = await wire()
      insert('s1')
      await seed(p, 's1')
      const a = await bound(window(7), S('s1'))
      expect(viewOf(a)?.source).toBe('durable')
      const deleteSession = vi.spyOn(wiring.peekSyncHub()!, 'deleteSession')

      await withTimeout(p.chatGateway.clearMessages('s1'), 15000, 'clearMessages')
      await waitFor(() => viewOf(a)?.source === 'none', 5000, 'none view after clear')
      expect(types(a.updates)).toContain('replaced')
      expect(types(a.updates)).not.toContain('unavailable')
      expect(viewOf(a)?.capabilities.send).toBe(true)
      expect(deleteSession).not.toHaveBeenCalled()

      const replacedBefore = types(a.updates).filter((t) => t === 'replaced').length
      p.router.on('fresh', role('chat', 'fresh'), answer('new start'))
      await withTimeout(p.chatGateway.prompt('s1', 'fresh'), 15000)
      await waitFor(() => viewOf(a)?.source === 'durable', 5000, 'durable view after send')
      expect(types(a.updates).filter((t) => t === 'replaced').length).toBeGreaterThan(
        replacedBefore
      )
      expect(types(a.updates)).not.toContain('unavailable')
      expect(deleteSession).not.toHaveBeenCalled()
    },
    T
  )
})

describe('P3-10b-10 回退之后视图不用重拉（S）', () => {
  it(
    'P3-10b-10 gateway.rollbackMessage：订阅着的客户端 view.messages 在帧冲刷内 = listBySession；门面不变，没有 replaced / unavailable',
    async () => {
      await bootProcess()
      const { p, window } = await wire()
      insert('s1')
      p.router.on('t1', role('chat', 'U1'), answer('A1'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'U1'), 15000)).toEqual({})
      p.router.on('t2', role('chat', 'U1'), answer('A2'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'U2'), 15000)).toEqual({})
      const a = await bound(window(7), S('s1'))
      const facade = a.facade()
      await waitFor(() => (viewOf(a)?.messages ?? []).length === 4, 5000, 'four messages')
      const u2 = viewOf(a)!.messages[2]!
      expect(u2.content).toBe('U2')
      const updatesBefore = a.updates.length

      expect(await withTimeout(p.chatGateway.rollbackMessage('s1', u2.id), 15000)).toBe(true)
      const listed = await p.chatGateway.listMessages('s1')
      expect(listed.map((m) => m.content)).toEqual(['U1', 'A1'])
      // 帧冲刷（hub 的 flush 排在 setTimeout 0 上）之内就到了 —— 不等、不重拉
      await settle()
      expect(viewOf(a)?.messages).toEqual(listed)
      expect(a.facade()).toBe(facade)
      const after = types(a.updates.slice(updatesBefore))
      expect(after).not.toContain('replaced')
      expect(after).not.toContain('unavailable')
      expect(a.errors).toEqual([])
    },
    T
  )
})

describe('P3-05-24 清空旧格式会话（S，PIN-06）', () => {
  it(
    'P3-05-24 旧格式视图上 clearMessages → none 视图（send:true）、没有 unavailable；存储类型换掉；不 deleteSession',
    async () => {
      await bootProcess()
      const { p, wiring, window } = await wire()
      insert('old', { storageKind: 'harness-v3-jsonl' })
      writeFileSync(
        join(rig.sessionsDir, 'old.jsonl'),
        legacyJsonl('old', [legacyUser(1000, 'hi'), legacyAssistant(2000, 'hello')])
      )
      const a = await bound(window(7), S('old'))
      expect(viewOf(a)?.source).toBe('legacy')
      const deleteSession = vi.spyOn(wiring.peekSyncHub()!, 'deleteSession')

      await withTimeout(p.chatGateway.clearMessages('old'), 15000, 'clearMessages')
      await waitFor(() => viewOf(a)?.source === 'none', 5000, 'none view after legacy clear')
      expect(viewOf(a)?.capabilities).toEqual({ send: true, rollback: false, continue: false })
      expect(viewOf(a)?.messages).toEqual([])
      expect(types(a.updates)).not.toContain('unavailable')
      expect(p.sessionRecords.pick('old', ['storageKind'])?.storageKind).toBe('durable-sqlite-1')
      expect(deleteSession).not.toHaveBeenCalled()
    },
    T
  )
})

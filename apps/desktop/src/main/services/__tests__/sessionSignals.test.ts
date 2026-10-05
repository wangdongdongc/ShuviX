/**
 * 会话信号接线（`services/sessionSignals`，P3-08）—— 真的 DurableSession（agent-runtime 的测试宿主 + faux 模型），
 * 接线经一个扇出挂在宿主的开 / 关钩子上，出口全是间谍：
 *
 *   P3-08-47 根会话的一对：agent_start / agent_end 恰各一次、次序对；agent_end 的键恰是 {type, sessionId, reason}
 *   P3-08-48 结局：流式中途中止 → aborted；最终失败 → error；退避中中止 → aborted；每种恰一对
 *   P3-08-50 投影句柄的寿命：打开时借一个；显式关 / LRU / 删除都还掉（没人再借 → 投影拆掉）；重开借新的；
 *            关掉之后没有任何生命周期事件；忙着被关不补 agent_end
 *   P3-08-53 派生对话（hook agent）的一对只给登记过的发，sessionId 是 agentId；没登记的什么都不发（PIN-19）
 *   P3-08-54 询问走 subscribeInputs：挂起 → askRaised 一次、ask_count 1；应答 → askResolved、ask_count 0；
 *            没有 input_request 广播；会话关掉 → 挂着的询问逐条撤回
 *   P3-08-56 失败文本（PIN-08）：最终失败之后 runErrorText 是投影里最后一条错误行的正文
 *   P3-08-09 就绪（PIN-09）：打开即登记一个就绪 promise，投影挂上才落定
 *
 * 不起 Electron：事件汇与同步接线换成替身（接线的扇出由用例自己给）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { DurableSession, SyncSessionClosedReason } from '@shuvix/agent-runtime'

vi.mock('../agentRuntimeAdapters', () => ({ electronEventSink: { broadcast: vi.fn() } }))
vi.mock('../../frontend/sync/syncWiring', () => ({
  sessionHostHooks: { onSessionOpened: () => () => {}, onSessionClosed: () => () => {} }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { createSessionSignals, type SessionSignals } from '../sessionSignals'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/host'
import {
  answer,
  modelError,
  stalled
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/faux'
import {
  hookRec,
  hostD,
  seedAgent,
  startRun
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/spawn'
import { backgroundContext as BG } from '../../../../../../packages/agent-runtime/src/durable/context'
import {
  sleep,
  waitFor,
  withTimeout
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/wait'

registerHostCleanup()

const T = 25000

/** 宿主开 / 关钩子的最小扇出 */
function fanout(): {
  opened: (session: DurableSession) => void
  closed: (sessionId: string, reason: SyncSessionClosedReason) => void
  onSessionOpened(listener: (session: DurableSession) => void): () => void
  onSessionClosed(listener: (sessionId: string, reason: SyncSessionClosedReason) => void): () => void
} {
  const opened = new Set<(session: DurableSession) => void>()
  const closed = new Set<(sessionId: string, reason: SyncSessionClosedReason) => void>()
  return {
    opened: (session) => [...opened].forEach((l) => l(session)),
    closed: (sessionId, reason) => [...closed].forEach((l) => l(sessionId, reason)),
    onSessionOpened: (l) => (opened.add(l), () => opened.delete(l)),
    onSessionClosed: (l) => (closed.add(l), () => closed.delete(l))
  }
}

interface Rig {
  t: TestHost
  signals: SessionSignals
  /** 余项出口：运行时自己的广播与接线的广播按到达次序混在一起 */
  events: ChatEvent[]
  raised: Array<[string, InputRequest]>
  resolved: Array<[string, string]>
}

let rigs: Rig[] = []
afterEach(() => {
  for (const rig of rigs) rig.signals.dispose()
  rigs = []
})

async function rigWith(
  options: Parameters<typeof makeHost>[0] & { registered?: (agentId: string) => boolean } = {}
): Promise<Rig> {
  const hooks = fanout()
  const { registered, ...hostOptions } = options
  const t = await makeHost({
    ephemeral: ['s1'],
    ...hostOptions,
    onSessionOpened: hooks.opened,
    onSessionClosed: hooks.closed
  })
  const raised: Rig['raised'] = []
  const resolved: Rig['resolved'] = []
  const signals = createSessionSignals({
    hooks,
    broadcast: (event) => t.broadcasts.push(event),
    askRaised: (sid, request) => raised.push([sid, request]),
    askResolved: (sid, id) => resolved.push([sid, id]),
    isRegisteredAgent: registered ?? (() => false),
    publishReadiness: false
  })
  const rig = { t, signals, events: t.broadcasts, raised, resolved }
  rigs.push(rig)
  return rig
}

const lifecycle = (events: ChatEvent[]): ChatEvent[] =>
  events.filter((e) => e.type === 'agent_start' || e.type === 'agent_end')

const flush = (): Promise<void> => sleep(20)

describe('P3-08-47 / 48 根会话的一对与结局', () => {
  it('P3-08-47 一轮普通回答：agent_created → agent_start → agent_end{ok} 各一次；agent_end 只有三个键', async () => {
    const { t, signals } = await rigWith()
    const session = await t.open('s1')
    await signals.ready('s1')
    t.kit.queue(answer('hello'))
    expect(await session.submitUser('hi')).toEqual({})
    await flush()
    const types = t.broadcasts
      .filter((e) => ['agent_created', 'agent_start', 'agent_end'].includes(e.type))
      .map((e) => e.type)
    expect(types).toEqual(['agent_created', 'agent_start', 'agent_end'])
    const end = t.broadcasts.find((e) => e.type === 'agent_end')!
    expect(end).toEqual({ type: 'agent_end', sessionId: 's1', reason: 'ok' })
    expect(Object.keys(end).sort()).toEqual(['reason', 'sessionId', 'type'])
  })

  it(
    'P3-08-48 流式中途中止 → aborted；最终失败 → error；各一对',
    async () => {
      const { t, signals } = await rigWith()
      const session = await t.open('s1')
      await signals.ready('s1')
      await primeRoot(session)
      const stall = stalled()
      t.kit.queue(stall.step)
      const sending = session.submitUser('go')
      await withTimeout(stall.reached, 5000, 'stalled')
      await session.abort()
      await sending
      await flush()
      t.kit.queue(modelError('503 boom'))
      await session.submitUser('again')
      await flush()
      expect(lifecycle(t.broadcasts)).toEqual([
        { type: 'agent_start', sessionId: 's1' },
        { type: 'agent_end', sessionId: 's1', reason: 'aborted' },
        { type: 'agent_start', sessionId: 's1' },
        { type: 'agent_end', sessionId: 's1', reason: 'error' }
      ])
    },
    T
  )

  it(
    'P3-08-48 退避中中止 → aborted（不是 error）',
    async () => {
      const { t, signals } = await rigWith({
        settingsOverrides: { retry: { enabled: true, baseDelayMs: 2000 }, compaction: { enabled: false } }
      })
      const session = await t.open('s1')
      await signals.ready('s1')
      await primeRoot(session)
      t.kit.queue(modelError('503 x'))
      const sending = session.submitUser('go')
      await waitFor(
        async () => (await session.viewSnapshot()).run.retry !== undefined,
        5000,
        'backoff'
      )
      await session.abort()
      await sending
      await flush()
      expect(lifecycle(t.broadcasts)).toEqual([
        { type: 'agent_start', sessionId: 's1' },
        { type: 'agent_end', sessionId: 's1', reason: 'aborted' }
      ])
    },
    T
  )

  it(
    'P3-08-56 最终失败之后：runErrorText = 投影里最后一条错误行的正文（PIN-08）',
    async () => {
      const { t, signals } = await rigWith()
      const session = await t.open('s1')
      await signals.ready('s1')
      t.kit.queue(modelError('429 Too Many Requests'))
      await session.submitUser('go')
      await flush()
      expect(signals.runErrorText('s1')).toContain('429 Too Many Requests')
      expect(signals.runErrorText('nope')).toBeUndefined()
    },
    T
  )
})

describe('P3-08-50 投影句柄的寿命', () => {
  it(
    '打开借一个；显式关还掉、投影拆掉；重开借新的；关掉之后没有生命周期事件；忙着被关不补 agent_end',
    async () => {
      // 落盘的会话（内存会话关掉就没了，也从不被 LRU 关）
      const { t, signals } = await rigWith({ ephemeral: [] })
      const session = await t.open('s1')
      await signals.ready('s1')
      expect(signals.heldSessions()).toEqual(['s1'])
      const first = await session.projector()
      expect(first.disposed).toBe(false)

      // 忙着被关
      await primeRoot(session)
      const stall = stalled()
      t.kit.queue(stall.step)
      void session.submitUser('go').catch(() => undefined)
      await withTimeout(stall.reached, 5000, 'stalled')
      await flush()
      const before = lifecycle(t.broadcasts).length
      await t.host.close('s1')
      await flush()
      expect(signals.heldSessions()).toEqual([])
      expect(first.disposed).toBe(true)
      expect(lifecycle(t.broadcasts).slice(before)).toEqual([])
      expect(lifecycle(t.broadcasts).at(-1)).toEqual({ type: 'agent_start', sessionId: 's1' })

      // 重开：新的句柄、新的投影
      const again = await t.open('s1')
      await signals.ready('s1')
      expect(signals.heldSessions()).toEqual(['s1'])
      const second = await again.projector()
      expect(second).not.toBe(first)
      expect(second.disposed).toBe(false)
    },
    T
  )

  it(
    'LRU 与删除也还掉句柄',
    async () => {
      const { t, signals } = await rigWith({ maxIdleOpen: 0, ephemeral: [] })
      await t.open('s1')
      await signals.ready('s1')
      await t.open('s2')
      await signals.ready('s2')
      await waitFor(() => !t.host.openSessionIds().includes('s1'), 5000, 'LRU close s1')
      await flush()
      expect(signals.heldSessions()).not.toContain('s1')
      await t.host.delete('s2')
      await flush()
      expect(signals.heldSessions()).toEqual([])
    },
    T
  )

  it('P3-08-09 打开即登记就绪：投影挂上之前不落定', async () => {
    const { t, signals } = await rigWith()
    const opening = t.open('s1')
    const session = await opening
    let ready = false
    void signals.ready('s1').then(() => (ready = true))
    expect(ready).toBe(false)
    await signals.ready('s1')
    expect(ready).toBe(true)
    expect(await session.projector()).toBeDefined()
  })
})

describe('P3-08-53 派生对话的一对（PIN-19）', () => {
  it(
    '登记过的 hook agent：一对、sessionId = agentId；根没有信号；没登记的什么都不发',
    async () => {
      for (const known of [true, false]) {
        const d = await hostD()
        const hooks = fanout()
        const events: ChatEvent[] = []
        const signals = createSessionSignals({
          hooks,
          broadcast: (event) => events.push(event),
          askRaised: () => {},
          askResolved: () => {},
          isRegisteredAgent: () => known,
          publishReadiness: false
        })
        hooks.opened(d.session)
        await signals.ready(d.session.sessionId)
        const seeded = await seedAgent(d.session, { record: hookRec() })
        d.t.kit.queue(answer('{"title":"t"}'))
        const submission = await startRun(d.session, seeded.conversationId, 'title please')
        await withTimeout(submission.wait(BG), 5000, 'hook run')
        await flush()
        expect(lifecycle(events)).toEqual(
          known
            ? [
                { type: 'agent_start', sessionId: 'sub-h1' },
                { type: 'agent_end', sessionId: 'sub-h1', reason: 'ok' }
              ]
            : []
        )
        signals.dispose()
      }
    },
    T
  )
})

describe('P3-08-54 询问走 subscribeInputs', () => {
  const probe = (id: string): InputRequest => ({
    id,
    kind: 'ask',
    toolName: 'probe',
    command: 'probe',
    createdAt: 0
  })

  it('挂起 → askRaised 一次、ask_count 1；应答 → askResolved、ask_count 0；没有 input_request 广播', async () => {
    const { t, signals, raised, resolved } = await rigWith()
    const session = await t.open('s1')
    await signals.ready('s1')
    const pending = session.requestUserInput(probe('r'))
    expect(raised).toEqual([['s1', probe('r')]])
    expect(session.respondToInput('r', { kind: 'ask', allowed: true }, { clientId: 'ipc:7' })).toBe(
      true
    )
    await pending
    expect(resolved).toEqual([['s1', 'r']])
    expect(t.broadcasts.filter((e) => e.type === 'ask_count')).toEqual([
      { type: 'ask_count', sessionId: 's1', count: 1 },
      { type: 'ask_count', sessionId: 's1', count: 0 }
    ])
    expect(t.broadcasts.some((e) => (e.type as string).startsWith('input_request'))).toBe(false)
  })

  it('会话关掉 → 挂着的询问逐条撤回，计数落回 0', async () => {
    const { t, signals, resolved } = await rigWith()
    const session = await t.open('s1')
    await signals.ready('s1')
    void session.requestUserInput(probe('a'))
    void session.requestUserInput(probe('b'))
    await t.host.close('s1')
    expect(resolved.map(([, id]) => id).sort()).toEqual(['a', 'b'])
    expect(t.broadcasts.filter((e) => e.type === 'ask_count').at(-1)).toEqual({
      type: 'ask_count',
      sessionId: 's1',
      count: 0
    })
  })
})

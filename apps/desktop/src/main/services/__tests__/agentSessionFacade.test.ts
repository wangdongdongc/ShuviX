/**
 * AgentSession —— DurableSession 之上的桌面门面（假 DurableSession，单元）。
 *
 *   D10-25 prompt 的映射：文本 / 图文 / 显示侧车；结果原样上交
 *   D10-26 session.prompt-accepted：受理那一刻（onAdmitted）恰发一次；被拒从不发；日历按 onAdmitted 的
 *          entryId 入账（P3-07，不再是随机键）
 *   D10-27 session.turn-completed：受理过的发送落定之后发；被拒不发；facts 为空不发、抛错不影响结果
 *   P3-12-05 continue 的埋点只在调用前被中断时发（PIN-15）；空闲无操作 / no_model 不发，no_model 报给界面
 *   D10-28 steer / followUp 委托；被拒 → 带原文的 reject；门面上没有 nextTurn（P3-11-06）
 *   P3-11-05 withdrawQueued 委托，结果（含 closed）原样上交
 *   D10-29 notify 只委托一次（门面没有自己的合并定时器）
 *   D10-30 其余委托：abort / setThinkingLevel / continue / 询问；isStreaming / 挂起询问现读
 *   D10-31 invalidate：destroyAgent 之后清 fileTime（恰一次）；销毁失败照样清；不碰审查 / 决策 / 存储
 *   D10-32 destroy：先中止 hook run → 等宿主 delete → 清 fileTime / 决策 / 审查；delete 失败照样清
 *   D10-34 失效的句柄：会话已关 → `{ error, code: 'closed' }`，从不悄悄重开
 *   WP2-57..62 来源与答题方（docs/sub-session-design.md §19.5 / §19.7）：被驱动的 prompt 记下父会话来源；
 *          人发的消息不带；回退后原样重发沿用的来源走第 5 个参数（WP2-58b）；admitSteer 带幂等键与来源、交回受理
 *          结果而不抛；respondToInput 把 meta 原样转下去
 *   WP2-81 输入来源（网关盖的章，2026-10-21）：steer / followUp 把它原样放进 durable 的选项（连同受理回调）；
 *          不是被驱动的 prompt 带着它 → options 只多一个 source；被驱动时来源恒取 drivingSourceOf，章不顶替它
 * （D10-33「门面从不授予已读」在 agentSessionBot.test.ts。）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fire: vi.fn<(trigger: string, payload: Record<string, unknown>) => void>(),
  abortSessionRuns: vi.fn<(sessionId: string) => void>(),
  facts: vi.fn<(sessionId: string) => Promise<Record<string, unknown> | null>>(),
  recordUserEntry: vi.fn<(sessionId: string, entryId: number | string) => void>(),
  resolveAgentProfileName: vi.fn<(sessionId: string) => string>(),
  clearFileTime: vi.fn<(sessionId: string) => void>(),
  clearReviewState: vi.fn<(sessionId: string) => void>(),
  clearSessionDecisions: vi.fn<(sessionId: string) => void>(),
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  warn: vi.fn(),
  calls: [] as string[]
}))

vi.mock('@shuvix/agent-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shuvix/agent-runtime')>()),
  clearReviewState: mocks.clearReviewState,
  clearSessionDecisions: mocks.clearSessionDecisions
}))
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../hookService', () => ({
  hookTriggers: { fire: mocks.fire },
  hookService: { abortSessionRuns: mocks.abortSessionRuns }
}))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: mocks.facts,
  isDefaultTitle: (title: string) => title === 'New chat'
}))
vi.mock('../sessionDayPromptService', () => ({ recordUserEntry: mocks.recordUserEntry }))
vi.mock('../sessionRecords', () => ({
  sessionRecords: {
    pick: () => ({ title: 'New chat' }),
    drivingSourceOf: (_id: string, driverId: string) => ({
      kind: 'parent-session',
      sessionId: driverId
    })
  }
}))
vi.mock('../sessionService', () => ({
  sessionService: { resolveAgentProfileName: mocks.resolveAgentProfileName }
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({ clearSession: mocks.clearFileTime }))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: mocks.broadcast }
}))
vi.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string>) => `${key}:${vars?.reason ?? ''}`
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {}, debug: () => {} })
}))

import type { AdmitResult } from '@shuvix/agent-runtime'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { AgentSession } from '../agentSession'
import {
  FakeDurableSession,
  fakeHost,
  gate,
  lockRecord,
  resetFakeHost
} from './support/fakeSessionHost'

const SID = 's1'

function facade(patch: Partial<FakeDurableSession> = {}): {
  durable: FakeDurableSession
  session: AgentSession
} {
  const durable = new FakeDurableSession(SID)
  Object.assign(durable, patch)
  return { durable, session: AgentSession.of(durable) }
}

/** 等 fire-and-forget 的 turn-completed 落定 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const fired = (trigger: string): Array<Record<string, unknown>> =>
  mocks.fire.mock.calls.filter(([name]) => name === trigger).map(([, payload]) => payload)

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === 'function') m.mockReset()
  mocks.calls.length = 0
  mocks.facts.mockResolvedValue({ title: 'New chat', turns: 1 })
  mocks.resolveAgentProfileName.mockReturnValue('chat')
  mocks.fire.mockImplementation((name) => void mocks.calls.push(`fire:${name}`))
  resetFakeHost()
})

describe('D10-25 prompt 的映射', () => {
  it('D10-25 纯文本 → submitUser(文本)', async () => {
    const { durable, session } = facade()
    await session.prompt('t')
    const [, content, options] = durable.callsOf('submitUser')[0]!
    expect(content).toBe('t')
    expect(options).not.toHaveProperty('display')
  })

  it('D10-25 带图 → [{text}, ...图]（次序不变）；显示侧车原样进 options.display', async () => {
    const { durable, session } = facade()
    const images = [
      { type: 'image' as const, data: 'AAA', mimeType: 'image/png' },
      { type: 'image' as const, data: 'BBB', mimeType: 'image/jpeg' }
    ]
    const display = { content: 'see {{shuvixInlineToken:a1}}', tokens: { a1: { type: 'at' } } }
    await session.prompt('look', images, display as never)
    const [, content, options] = durable.callsOf('submitUser')[0]!
    expect(content).toEqual([{ type: 'text', text: 'look' }, ...images])
    expect((options as { display: unknown }).display).toEqual(display)
  })

  it.each([
    [{ error: 'busy', code: 'busy' }],
    [{ error: 'Provider "Faux" model nope', code: 'no_model' }],
    [{ error: 'boom', code: 'model_error' }],
    [{ error: 'closed', code: 'closed' }]
  ] as const)('D10-25 结果原样上交：%o', async (result) => {
    const { durable, session } = facade()
    durable.submitResults = [{ ...result }]
    expect(await session.prompt('t')).toEqual(result)
  })
})

describe('D10-26 session.prompt-accepted', () => {
  it('D10-26 受理那一刻恰发一次（submitUser 还没落定）；档案名取锁里的那个', async () => {
    const submitGate = gate()
    const { durable, session } = facade({ submitGate })
    durable.lockOnFirstUse = lockRecord({ profileName: 'work' })
    const pending = session.prompt('hello')
    await vi.waitFor(() => expect(fired('session.prompt-accepted')).toHaveLength(1))
    expect(fired('session.prompt-accepted')[0]).toEqual({
      sessionId: SID,
      profileName: 'work',
      title: 'New chat',
      isDefaultTitle: true,
      promptText: 'hello'
    })
    // 受理即按当场落下的用户条目入账（P3-07 PIN-15：onAdmitted 的 entryId，不是随机键）
    expect(mocks.recordUserEntry.mock.calls).toEqual([[SID, 1]])
    submitGate.release()
    expect(await pending).toEqual({})
    expect(fired('session.prompt-accepted')).toHaveLength(1)
  })

  it('D10-26 没有锁时档案名按形态推导', async () => {
    const { session } = facade()
    await session.prompt('hi')
    expect(fired('session.prompt-accepted')[0]!.profileName).toBe('chat')
    expect(mocks.resolveAgentProfileName).toHaveBeenCalledWith(SID)
  })

  it.each([
    ['busy', { error: 'busy', code: 'busy' }, true],
    ['no_model', { error: 'no model', code: 'no_model' }, true],
    ['closed', { error: 'closed', code: 'closed' }, true],
    ['cancelled（创建被中止 → {}，没有受理）', {}, false]
  ] as const)('D10-26 %s：从不发、不入账', async (_label, result, admitDefault) => {
    const { durable, session } = facade()
    durable.submitResults = [{ ...result }]
    if (!admitDefault) durable.admit = false
    await session.prompt('x')
    await flush()
    expect(fired('session.prompt-accepted')).toEqual([])
    expect(mocks.recordUserEntry).not.toHaveBeenCalled()
  })
})

describe('D10-27 session.turn-completed', () => {
  it.each([
    ['done', {}],
    ['model_error', { error: 'boom', code: 'model_error' }]
  ] as const)(
    'D10-27 %s：落定之后发，payload = {sessionId, profileName, ...facts}，排在 prompt-accepted 之后',
    async (_label, result) => {
      const submitGate = gate()
      const { durable, session } = facade({ submitGate })
      durable.submitResults = [{ ...result }]
      const pending = session.prompt('hi')
      await vi.waitFor(() => expect(fired('session.prompt-accepted')).toHaveLength(1))
      expect(fired('session.turn-completed')).toEqual([])
      submitGate.release()
      await pending
      await flush()
      expect(fired('session.turn-completed')).toEqual([
        { sessionId: SID, profileName: 'chat', title: 'New chat', turns: 1 }
      ])
      expect(mocks.calls).toEqual(['fire:session.prompt-accepted', 'fire:session.turn-completed'])
    }
  )

  it('D10-27 被拒的发送不发', async () => {
    const { durable, session } = facade()
    durable.submitResults = [{ error: 'busy', code: 'busy' }]
    await session.prompt('hi')
    await flush()
    expect(fired('session.turn-completed')).toEqual([])
    expect(mocks.facts).not.toHaveBeenCalled()
  })

  it('D10-27 facts 为 null → 不发；facts 抛错 → 记日志，发送结果不受影响', async () => {
    const { session } = facade()
    mocks.facts.mockResolvedValueOnce(null)
    expect(await session.prompt('a')).toEqual({})
    await flush()
    expect(fired('session.turn-completed')).toEqual([])

    mocks.facts.mockRejectedValueOnce(new Error('facts exploded'))
    expect(await session.prompt('b')).toEqual({})
    await flush()
    expect(fired('session.turn-completed')).toEqual([])
    expect(mocks.warn.mock.calls.some(([line]) => String(line).includes('facts exploded'))).toBe(
      true
    )
  })

  it('D10-27 / P3-12-05 被中断时 continue() 落定之后同样发（PIN-19 / PIN-15），结果原样上交', async () => {
    const { durable, session } = facade({ interrupted: true })
    durable.continueResult = {}
    expect(await session.continue()).toEqual({})
    await flush()
    expect(fired('session.turn-completed')).toHaveLength(1)
    expect(durable.callsOf('continue')).toHaveLength(1)
  })

  it('P3-12-05 没被中断：continue() 是无操作，结果 {}，不发埋点（PIN-15）', async () => {
    const { durable, session } = facade()
    durable.continueResult = {}
    expect(await session.continue()).toEqual({})
    await flush()
    expect(fired('session.turn-completed')).toEqual([])
    expect(durable.callsOf('continue')).toHaveLength(1)
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('P3-12-05 被中断但模型被拒（no_model）：报给界面，不发埋点', async () => {
    const { durable, session } = facade({ interrupted: true })
    durable.continueResult = { error: 'Provider "Faux" model nope', code: 'no_model' }
    expect(await session.continue()).toEqual({
      error: 'Provider "Faux" model nope',
      code: 'no_model'
    })
    await flush()
    expect(fired('session.turn-completed')).toEqual([])
    expect(mocks.broadcast).toHaveBeenCalledTimes(1)
    expect(mocks.broadcast.mock.calls[0]![0]).toEqual({
      type: 'error',
      sessionId: SID,
      error: 'chat.agentNoModel:Provider "Faux" model nope'
    })
  })
})

describe('D10-28 steer / followUp', () => {
  it('D10-28 steer 与 followUp 委托（从不 submitUser）', async () => {
    const { durable, session } = facade()
    await session.steer('s')
    await session.followUp('f')
    expect(durable.callsOf('steer')).toEqual([['steer', 's']])
    expect(durable.callsOf('followUp')).toEqual([['followUp', 'f']])
    expect(durable.callsOf('submitUser')).toEqual([])
  })

  it('D10-28 受理被拒 → 带原文的 reject（模型被拒用本地化文案）', async () => {
    const { durable, session } = facade()
    durable.steerResult = { error: 'The conversation is closed', code: 'closed' }
    await expect(session.steer('s')).rejects.toThrow('The conversation is closed')
    durable.followUpResult = { error: 'Provider "Faux" model nope', code: 'no_model' }
    await expect(session.followUp('f')).rejects.toThrow(
      'chat.agentNoModel:Provider "Faux" model nope'
    )
  })

  it('P3-11-06 门面上没有「下一轮」（Q-P3-09）', () => {
    // @ts-expect-error nextTurn is gone end to end (Q-P3-09)
    expect(AgentSession.prototype.nextTurn).toBeUndefined()
  })
})

describe('P3-11-05 withdrawQueued', () => {
  it.each(['aborted', 'already_placed', 'settled', 'not_found', 'closed'] as const)(
    'P3-11-05 委托一次，结果 %s 原样上交',
    async (result) => {
      const { durable, session } = facade()
      durable.withdrawResult = result
      expect(await session.withdrawQueued(7)).toBe(result)
      expect(durable.callsOf('withdrawQueued')).toEqual([['withdrawQueued', 7]])
    }
  )
})

describe('D10-29 notify', () => {
  it('D10-29 委托一次；过 2 秒也没有别的提交（门面没有自己的合并窗口）', async () => {
    vi.useFakeTimers()
    try {
      const { durable, session } = facade()
      await session.notify('<sub-session/> done')
      expect(durable.callsOf('notify')).toEqual([['notify', '<sub-session/> done']])
      await vi.advanceTimersByTimeAsync(2000)
      expect(durable.calls.map(([name]) => name)).toEqual(['notify'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('D10-30 其余委托', () => {
  it('D10-30 abort / setThinkingLevel / continue / 询问；isStreaming 与挂起询问现读', async () => {
    const { durable, session } = facade()
    await session.abort()
    await session.setThinkingLevel('high')
    durable.continueResult = { error: 'boom', code: 'model_error' }
    expect(await session.continue()).toEqual({ error: 'boom', code: 'model_error' })
    const request = { id: 'r1', kind: 'ask', toolName: 'bash', createdAt: 0 } as never
    await session.requestUserInput(request)
    durable.respondResult = true
    expect(session.respondToInput('r1', { kind: 'ask', allowed: true } as never)).toBe(true)
    expect(durable.calls.map(([name]) => name)).toEqual([
      'abort',
      'setThinkingLevel',
      'continue',
      'requestUserInput',
      'respondToInput'
    ])
    expect(durable.callsOf('setThinkingLevel')).toEqual([['setThinkingLevel', 'high']])
    expect(durable.callsOf('requestUserInput')[0]).toEqual(['requestUserInput', request])

    expect(session.isStreaming).toBe(false)
    durable.busy = true
    expect(session.isStreaming).toBe(true)
    durable.pendingInputCount = 2
    durable.pendingInputSummaries = ['bash: ls', 'ask: ok?']
    expect(session.pendingInputCount).toBe(2)
    expect(session.pendingInputSummaries).toEqual(['bash: ls', 'ask: ok?'])
  })

  it('D10-30 门面缓存：同一个 DurableSession 恒是同一个门面，新实例是新门面', () => {
    const a = new FakeDurableSession(SID)
    const b = new FakeDurableSession(SID)
    expect(AgentSession.of(a)).toBe(AgentSession.of(a))
    expect(AgentSession.of(b)).not.toBe(AgentSession.of(a))
  })
})

describe('D10-31 invalidate', () => {
  it('D10-31 destroyAgent 挂着时还没清 fileTime；放行后 fileTime 恰一次；不碰审查 / 决策 / 存储', async () => {
    const destroyGate = gate()
    const { durable, session } = facade({ destroyGate, lock: lockRecord() })
    const pending = session.invalidate()
    await flush()
    expect(durable.callsOf('destroyAgent')).toHaveLength(1)
    expect(mocks.clearFileTime).not.toHaveBeenCalled()
    destroyGate.release()
    await pending
    expect(mocks.clearFileTime.mock.calls).toEqual([[SID]])
    expect(mocks.clearReviewState).not.toHaveBeenCalled()
    expect(mocks.clearSessionDecisions).not.toHaveBeenCalled()
    expect(fakeHost.callsOf('delete')).toEqual([])
  })

  it('D10-31 destroyAgent 抛错：清理照做，invalidate 照样落定', async () => {
    const { session } = facade({ destroyError: new Error('stuck') })
    await expect(session.invalidate()).resolves.toBeUndefined()
    expect(mocks.clearFileTime.mock.calls).toEqual([[SID]])
  })
})

describe('D10-32 destroy', () => {
  it('D10-32 先中止 hook run → 等宿主 delete（挂着时不清）→ fileTime / 决策 / 审查各恰一次', async () => {
    const { session } = facade()
    fakeHost.deleteGate = gate()
    const pending = session.destroy()
    await flush()
    expect(mocks.abortSessionRuns.mock.calls).toEqual([[SID]])
    expect(fakeHost.callsOf('delete')).toEqual([SID])
    expect(mocks.clearFileTime).not.toHaveBeenCalled()
    expect(mocks.clearReviewState).not.toHaveBeenCalled()
    fakeHost.deleteGate.release()
    await pending
    for (const spy of [mocks.clearFileTime, mocks.clearSessionDecisions, mocks.clearReviewState]) {
      expect(spy.mock.calls).toEqual([[SID]])
    }
  })

  it('D10-32 delete 抛错：清理照做', async () => {
    const { session } = facade()
    fakeHost.deleteError = new Error('locked file')
    await expect(session.destroy()).resolves.toBeUndefined()
    expect(mocks.clearReviewState.mock.calls).toEqual([[SID]])
  })
})

describe('D10-34 失效的句柄', () => {
  it('D10-34 会话已关：prompt → { error, code: closed }，不打开宿主、不报界面', async () => {
    const { session } = facade({ closed: true })
    const result = await session.prompt('late')
    expect(result.code).toBe('closed')
    expect(result.error).toBeTruthy()
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
})

describe('WP2 来源与答题方', () => {
  const PARENT = { kind: 'parent-session', sessionId: 'P1', title: '重构 parser' } as const

  it('WP2-57 被驱动的 prompt：options 带 requestId / driven，来源取 driven.parentId（没有 title）', async () => {
    const { durable, session } = facade()
    const driven = { parentId: 'P1', background: true }
    await session.prompt('t', undefined, undefined, { requestId: 'subsession:P1:3', driven })
    const [, , options] = durable.callsOf('submitUser')[0]!
    expect(options).toMatchObject({ requestId: 'subsession:P1:3', driven })
    expect((options as { source?: unknown }).source).toStrictEqual({
      kind: 'parent-session',
      sessionId: 'P1'
    })
  })

  it('WP2-58 人发的消息（不带 drive，带不带显示侧车都一样）：没有 source / requestId / driven 键', async () => {
    const { durable, session } = facade()
    await session.prompt('t')
    await session.prompt('t', undefined, { content: 'x', tokens: {} } as never)
    for (const [, , options] of durable.callsOf('submitUser')) {
      expect(options).not.toHaveProperty('source')
      expect(options).not.toHaveProperty('requestId')
      expect(options).not.toHaveProperty('driven')
    }
  })

  it('WP2-58b / RSRC-26 不是被驱动、却带着沿用的来源（回退后原样重发，§19.7）：options 只多一个 source；被驱动时来源恒取 drive，第 5 个参数不顶替它', async () => {
    const { durable, session } = facade()
    await session.prompt('t', undefined, undefined, undefined, PARENT)
    const [, , resent] = durable.callsOf('submitUser')[0]!
    expect((resent as { source?: unknown }).source).toStrictEqual(PARENT)
    expect(resent).not.toHaveProperty('requestId')
    expect(resent).not.toHaveProperty('driven')

    const driven = { parentId: 'P2', background: false }
    await session.prompt(
      't',
      undefined,
      undefined,
      { requestId: 'subsession:P2:4', driven },
      PARENT
    )
    const [, , options] = durable.callsOf('submitUser')[1]!
    expect(options).toMatchObject({ requestId: 'subsession:P2:4', driven })
    expect((options as { source?: unknown }).source).toStrictEqual({
      kind: 'parent-session',
      sessionId: 'P2'
    })
  })

  it('WP2-59 admitSteer：文本与幂等键 / 来源原样交给 durable.steer（连同门面的受理回调），结果原样交回', async () => {
    const { durable, session } = facade()
    durable.steerResult = { submissionId: 5 as AdmitResult['submissionId'] }
    expect(
      await session.admitSteer('go', { requestId: 'subsession-steer:P1:9', source: PARENT })
    ).toStrictEqual({ submissionId: 5 })
    expect(durable.callsOf('steer')).toEqual([['steer', 'go']])
    const options = durable.steerOptions[0]!
    expect(options.requestId).toBe('subsession-steer:P1:9')
    expect(options.source).toBe(PARENT)
    expect(typeof options.onAdmitted).toBe('function')
    expect(typeof options.onPlaced).toBe('function')
  })

  it.each([
    [{ error: 'The conversation is busy', code: 'busy' }, 'The conversation is busy'],
    [
      { error: 'Provider "Faux" model nope', code: 'no_model' },
      'chat.agentNoModel:Provider "Faux" model nope'
    ],
    [{ error: 'Session s1 is closed', code: 'closed' }, 'Session s1 is closed']
  ] as const)(
    'WP2-60 admitSteer 被拒（%o）→ 交回而不抛：error 是给人读的文案，code 保留',
    async (result, text) => {
      const { durable, session } = facade()
      durable.steerResult = { ...result }
      await expect(session.admitSteer('go', { requestId: 'r', source: PARENT })).resolves.toEqual({
        error: text,
        code: result.code
      })
    }
  )

  it('WP2-61 界面的 steer 形状不变：options 里没有 requestId / source；被拒仍带原文 reject', async () => {
    const { durable, session } = facade()
    await session.steer('s')
    expect(durable.steerOptions[0]).not.toHaveProperty('requestId')
    expect(durable.steerOptions[0]).not.toHaveProperty('source')
    durable.steerResult = { error: 'The conversation is closed', code: 'closed' }
    await expect(session.steer('s')).rejects.toThrow('The conversation is closed')
  })

  it('WP2-62 respondToInput：meta（含答题方）原样转给 durable；不带 meta 时仍两参调用', () => {
    const { durable, session } = facade()
    durable.respondResult = true
    const response: InputResponse = { kind: 'choice', selections: ['A'] }
    const meta = { clientId: 'parent:P1', answeredBy: PARENT }
    expect(session.respondToInput('c1', response, meta)).toBe(true)
    expect(session.respondToInput('c2', response)).toBe(true)
    expect(durable.callsOf('respondToInput')).toEqual([
      ['respondToInput', 'c1', response],
      ['respondToInput', 'c2', response]
    ])
    expect(durable.respondArgs).toHaveLength(2)
    expect(durable.respondArgs[0]!.arity).toBe(3)
    expect(durable.respondArgs[0]!.meta).toBe(meta)
    expect(durable.respondArgs[1]).toStrictEqual({ arity: 2 })
  })

  describe('WP2-81 输入来源（网关按连接盖的章）原样交给 durable', () => {
    const LOCAL = { kind: 'local' } as const
    const REMOTE = {
      kind: 'remote',
      clientId: 'ws:4',
      address: '192.168.1.20',
      userAgent: 'UA'
    } as const

    it('WP2-81 steer(text, LOCAL) → durable.steer 的选项里 source 就是它（同一个对象），受理回调都在', async () => {
      const { durable, session } = facade()
      await session.steer('s', LOCAL)
      expect(durable.callsOf('steer')).toEqual([['steer', 's']])
      const options = durable.steerOptions[0]!
      expect(options.source).toBe(LOCAL)
      expect(options).not.toHaveProperty('requestId')
      expect(typeof options.onAdmitted).toBe('function')
      expect(typeof options.onPlaced).toBe('function')
    })

    it('WP2-81 followUp(text, REMOTE) → durable.followUp 的选项里 source 就是它；不带来源 → 没有 source 键', async () => {
      const { durable, session } = facade()
      await session.followUp('f', REMOTE)
      await session.followUp('g')
      expect(durable.callsOf('followUp')).toEqual([
        ['followUp', 'f'],
        ['followUp', 'g']
      ])
      expect(durable.followUpOptions[0]!.source).toBe(REMOTE)
      expect(typeof durable.followUpOptions[0]!.onAdmitted).toBe('function')
      expect(typeof durable.followUpOptions[0]!.onPlaced).toBe('function')
      expect(durable.followUpOptions[1]).not.toHaveProperty('source')
      expect(durable.callsOf('submitUser')).toEqual([])
    })

    it('WP2-81 prompt(…, undefined, REMOTE) → options 只多一个 source（REMOTE），没有 requestId / driven', async () => {
      const { durable, session } = facade()
      await session.prompt('t', undefined, undefined, undefined, REMOTE)
      const [, , options] = durable.callsOf('submitUser')[0]!
      expect((options as { source?: unknown }).source).toStrictEqual(REMOTE)
      expect(options).not.toHaveProperty('requestId')
      expect(options).not.toHaveProperty('driven')
    })

    it('WP2-81 被驱动的 prompt 又带着 REMOTE → 来源取 drivingSourceOf（驱动它的会话），REMOTE 不顶替它', async () => {
      const { durable, session } = facade()
      const driven = { parentId: 'P3', background: false }
      await session.prompt(
        't',
        undefined,
        undefined,
        { requestId: 'subsession:P3:1', driven },
        REMOTE
      )
      const [, , options] = durable.callsOf('submitUser')[0]!
      expect(options).toMatchObject({ requestId: 'subsession:P3:1', driven })
      expect((options as { source?: unknown }).source).toStrictEqual({
        kind: 'parent-session',
        sessionId: 'P3'
      })
    })
  })
})

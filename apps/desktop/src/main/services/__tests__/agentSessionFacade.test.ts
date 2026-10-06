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
  sessionRecords: { pick: () => ({ title: 'New chat' }) }
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

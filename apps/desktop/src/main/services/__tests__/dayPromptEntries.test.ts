/**
 * P3-07 · 日历按用户条目 id 入账（AgentSession 门面 → sessionDayPromptService，假 DurableSession、假 DAO）。
 * 真的 S 用例（真宿主、真 DB）在 projectionReads.test.ts（P3-07-16 / 17 / 19 / 20）。
 *
 *   17 被拒（busy / no_model / closed / 创建被取消）不入账、不 touchActive；重新挂上（driven、已有 requestId）
 *      不入账；steer / followUp 被拒同样不入账
 *   18 排队的发送（PIN-15）：受理时不入账；放下时一行，条目 = 放下的那个，日子按放下那一刻（23:59:59 受理、
 *      00:00:01 放下 → 第二天）；撤回的从不入账；空闲发送就算两个回调都带条目也只一行、一次 touchActive
 *   19 steer / followUp（PIN-16）：忙时 steer 在放下时入账；空闲 followUp 在受理时入账
 *   20 排除项照旧：内存会话（活着 / 已删）与 Chrome 标签页会话经新路径也不入账、不 touchActive
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  insert: vi.fn<
    (row: { sessionId: string; entryId: string; day: string; timestamp: number }) => boolean
  >(() => true),
  touchActive: vi.fn<(id: string) => void>(),
  pickSettings: vi.fn<(id: string, keys: string[]) => Record<string, unknown> | undefined>(
    () => ({})
  ),
  fire: vi.fn()
}))

vi.mock('../../dao/sessionDayPromptDao', () => ({
  localDayKey: (ts: number): string => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  },
  sessionDayPromptDao: {
    insert: mocks.insert,
    sessionsOnDay: () => [],
    daysInMonth: () => [],
    firstEntryOnDay: () => undefined,
    deleteBySessionId: vi.fn()
  }
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    touchActive: mocks.touchActive,
    pickSettings: mocks.pickSettings,
    pick: () => undefined
  }
}))
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../hookService', () => ({
  hookTriggers: { fire: mocks.fire },
  hookService: { abortSessionRuns: vi.fn() }
}))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: async () => null,
  isDefaultTitle: () => false
}))
vi.mock('../sessionService', () => ({
  sessionService: { resolveAgentProfileName: () => 'chat' }
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({ clearSession: vi.fn() }))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { AgentSession } from '../agentSession'
import { sessionRecords } from '../sessionRecords'
import { FakeDurableSession, resetFakeHost } from './support/fakeSessionHost'

let seq = 0
function facade(patch: Partial<FakeDurableSession> = {}): {
  durable: FakeDurableSession
  session: AgentSession
} {
  const durable = new FakeDurableSession(`s${++seq}`)
  Object.assign(durable, patch)
  return { durable, session: AgentSession.of(durable) }
}

const rows = (): Array<{ sessionId: string; entryId: string; day: string; timestamp: number }> =>
  mocks.insert.mock.calls.map(([row]) => row)

beforeEach(() => {
  mocks.insert.mockReset().mockReturnValue(true)
  mocks.touchActive.mockReset()
  mocks.pickSettings.mockReset().mockReturnValue({})
  mocks.fire.mockReset()
  sessionRecords.clearEphemeralForTests()
  resetFakeHost()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('P3-07-17 refusals and reattach', () => {
  it.each([
    ['busy', { error: 'busy', code: 'busy' }, true],
    ['no_model', { error: 'no model', code: 'no_model' }, true],
    ['closed', { error: 'closed', code: 'closed' }, true],
    ['cancelled (creation aborted → {} with no admission)', {}, false]
  ] as const)('P3-07-17 %s: no row, no touchActive', async (_label, result, admits) => {
    const { durable, session } = facade()
    durable.submitResults = [{ ...result }]
    if (!admits) durable.admit = false
    await session.prompt('x')
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('P3-07-17 a reattach (driven, existing requestId) adds no row', async () => {
    const { durable, session } = facade()
    durable.requestStates.set('subsession:p:1', 'pending')
    expect(
      await session.prompt('again', undefined, undefined, {
        requestId: 'subsession:p:1',
        driven: { parentId: 'p', background: false }
      })
    ).toEqual({})
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('P3-07-17 a refused steer / followUp adds no row', async () => {
    const { durable, session } = facade()
    durable.steerResult = { error: 'busy', code: 'busy' }
    durable.followUpResult = { error: 'no model', code: 'no_model' }
    await expect(session.steer('s')).rejects.toThrow()
    await expect(session.followUp('f')).rejects.toThrow()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('P3-07-17 an admitted prompt records the onAdmitted entry id (String) once', async () => {
    const { durable, session } = facade({ nextEntryId: 41 })
    expect(await session.prompt('hi')).toEqual({})
    expect(rows()).toMatchObject([{ sessionId: durable.sessionId, entryId: '41' }])
    expect(mocks.touchActive).toHaveBeenCalledTimes(1)
  })
})

describe('P3-07-18 queued sends through onPlaced (PIN-15)', () => {
  it('P3-07-18 admitted at 23:59:59, placed at 00:00:01: nothing at admission; one row at placement with the placed id and the next day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 4, 23, 59, 59))
    const { durable, session } = facade({ queueAdmissions: true, nextEntryId: 7 })
    expect(await session.prompt('later')).toEqual({})
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()

    vi.setSystemTime(new Date(2026, 9, 5, 0, 0, 1))
    expect(durable.placeQueued()).toBe(7)
    expect(rows()).toEqual([
      {
        sessionId: durable.sessionId,
        entryId: '7',
        day: '2026-10-05',
        timestamp: new Date(2026, 9, 5, 0, 0, 1).getTime()
      }
    ])
    expect(mocks.touchActive).toHaveBeenCalledTimes(1)
  })

  it('P3-07-18 a withdrawn send (never placed) never gets a row', async () => {
    const { durable, session } = facade({ queueAdmissions: true })
    expect(await session.prompt('withdrawn')).toEqual({})
    // 撤回（abortSubmission → aborted）：运行时从不调 onPlaced
    durable.queued.length = 0
    expect(durable.placeQueued()).toBeUndefined()
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('P3-07-18 an idle send that delivers both onAdmitted{entryId} and onPlaced gives one row and one touchActive', async () => {
    const { durable, session } = facade()
    durable.submitUser = async (_content, options = {}) => {
      options.onAdmitted?.({ entryId: 5 })
      options.onPlaced?.({ entryId: 5 })
      return {}
    }
    expect(await session.prompt('both')).toEqual({})
    expect(rows()).toMatchObject([{ entryId: '5' }])
    expect(mocks.touchActive).toHaveBeenCalledTimes(1)
  })
})

describe('P3-07-19 steer and followUp (PIN-16)', () => {
  it('P3-07-19 a steer while busy records at placement with the placed id', async () => {
    const { durable, session } = facade({ busy: true, queueAdmissions: true, nextEntryId: 12 })
    await session.steer('mid-run')
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(durable.placeQueued()).toBe(12)
    expect(rows()).toMatchObject([{ sessionId: durable.sessionId, entryId: '12' }])
    expect(mocks.touchActive).toHaveBeenCalledTimes(1)
  })

  it('P3-07-19 an idle followUp records at admission', async () => {
    const { durable, session } = facade({ nextEntryId: 3 })
    await session.followUp('next')
    expect(rows()).toMatchObject([{ sessionId: durable.sessionId, entryId: '3' }])
  })
})

describe('P3-07-20 exclusions are kept on the entry-id path', () => {
  function insertEphemeral(id: string): void {
    sessionRecords.insert(
      {
        id,
        title: id,
        projectId: null,
        parentId: null,
        settings: {},
        createdAt: 1,
        updatedAt: 1,
        lastActiveAt: 1
      },
      { ephemeral: true }
    )
  }

  it('P3-07-20 a live ephemeral session: prompt / steer / followUp record nothing', async () => {
    const durable = new FakeDurableSession('mem-live')
    insertEphemeral('mem-live')
    const session = AgentSession.of(durable)
    await session.prompt('a')
    await session.steer('b')
    await session.followUp('c')
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('P3-07-20 a deleted ephemeral session (wasEphemeral): a late placement records nothing', async () => {
    const durable = new FakeDurableSession('mem-gone')
    durable.queueAdmissions = true
    insertEphemeral('mem-gone')
    const session = AgentSession.of(durable)
    await session.prompt('late')
    sessionRecords.deleteById('mem-gone')
    expect(sessionRecords.wasEphemeral('mem-gone')).toBe(true)
    durable.placeQueued()
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('P3-07-20 a chromeTab session records nothing', async () => {
    mocks.pickSettings.mockReturnValue({ chromeTab: { installId: 'i', runId: 'r', tabId: 5 } })
    const { session } = facade()
    await session.prompt('tab')
    await session.followUp('tab 2')
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })
})

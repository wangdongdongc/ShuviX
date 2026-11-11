/**
 * 发送的图片进文件库（agentSession.ts 的 libraryImageCallback；docs/file-library-design.md §5、§10，
 * 测试设计 docs/file-library-l1-tests.md §8.3）。套路同 dayPromptEntries.test.ts：假 DurableSession、DAO 替身、
 * sessionRecords 用真的；`../fileLibrary` 的 keepSentImages 换成间谍（外面包一层，回新建的原生 Promise）。
 *
 *   AS-LIB-1 受理时带条目 id：keepSentImages 恰调一次 (sid, 41, [img1, img2])，字节与发送的相同；交给模型的 content 里仍有两张图
 *   AS-LIB-2 排队发送：放下时（条目 7）才调；放下之前撤回 → 从不调；空闲发送 onAdmitted{5} 与 onPlaced{5} 都到 → 只调一次
 *   AS-LIB-3 不调：没有图、图是空数组、发送被拒（busy、no_model）
 *   AS-LIB-4 临时会话不进库（§10）：内存会话（活着、删掉后 wasEphemeral）与 Chrome 标签页会话不调；发送照常成功
 *   AS-LIB-5 keepSentImages reject：prompt 仍回 {}，记一条 warn，没有未处理的 Promise 拒绝
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Image = { type: 'image'; data: string; mimeType: string }

const mocks = vi.hoisted(() => ({
  insert: vi.fn(() => true),
  pick: vi.fn<(id: string, keys: string[]) => Record<string, unknown> | undefined>(() => undefined),
  touchActive: vi.fn<(id: string) => void>(),
  pickSettings: vi.fn<(id: string, keys: string[]) => Record<string, unknown> | undefined>(
    () => ({})
  ),
  fire: vi.fn(),
  keepSentImages: vi.fn<(sid: string, entryId: number, images: Image[]) => void>(),
  /** 给了就让 keepSentImages 回一个以它 reject 的 Promise */
  rejection: undefined as Error | undefined,
  warn: vi.fn()
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
    pick: mocks.pick
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
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {}, debug: () => {} })
}))
// 间谍外面包一层：vi.fn 自己回的 Promise 会被它记 settledResults 时挂上处理器，reject 了也不算「未处理」，
// AS-LIB-5 就量不出来
vi.mock('../fileLibrary', () => ({
  keepSentImages: (sid: string, entryId: number, images: Image[]): Promise<string[]> => {
    mocks.keepSentImages(sid, entryId, images)
    return mocks.rejection ? Promise.reject(mocks.rejection) : Promise.resolve([])
  }
}))

import { AgentSession } from '../agentSession'
import { sessionRecords } from '../sessionRecords'
import { FakeDurableSession, resetFakeHost } from './support/fakeSessionHost'

const IMG1: Image = {
  type: 'image',
  data: Buffer.from('png-one').toString('base64'),
  mimeType: 'image/png'
}
const IMG2: Image = {
  type: 'image',
  data: Buffer.from('jpeg-two').toString('base64'),
  mimeType: 'image/jpeg'
}

let seq = 0
function facade(patch: Partial<FakeDurableSession> = {}): {
  durable: FakeDurableSession
  session: AgentSession
} {
  const durable = new FakeDurableSession(`lib${++seq}`)
  Object.assign(durable, patch)
  return { durable, session: AgentSession.of(durable) }
}

/** 交给运行时的 user content（submitUser 的第一个参数） */
const submittedContent = (durable: FakeDurableSession): unknown =>
  durable.calls.find((c) => c[0] === 'submitUser')?.[1]

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

beforeEach(() => {
  mocks.insert.mockReset().mockReturnValue(true)
  mocks.touchActive.mockReset()
  mocks.pickSettings.mockReset().mockReturnValue({})
  mocks.pick.mockReset().mockReturnValue(undefined)
  mocks.fire.mockReset()
  mocks.keepSentImages.mockReset()
  mocks.rejection = undefined
  mocks.warn.mockReset()
  sessionRecords.clearEphemeralForTests()
  resetFakeHost()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AS-LIB-1 受理时有条目 id', () => {
  it('keepSentImages 恰调一次 (sid, 41, [img1, img2])；交给模型的 content 里仍有两张图', async () => {
    const { durable, session } = facade({ nextEntryId: 41 })
    expect(await session.prompt('look', [IMG1, IMG2])).toEqual({})

    expect(mocks.keepSentImages).toHaveBeenCalledTimes(1)
    const [sid, entryId, images] = mocks.keepSentImages.mock.calls[0]
    expect(sid).toBe(durable.sessionId)
    expect(entryId).toBe(41)
    expect(images).toEqual([IMG1, IMG2])
    expect(images.map((i) => i.data)).toEqual([IMG1.data, IMG2.data])

    expect(submittedContent(durable)).toEqual([{ type: 'text', text: 'look' }, IMG1, IMG2])
  })
})

describe('AS-LIB-2 排队发送', () => {
  it('受理时没有条目、放下时条目 7 → 在放下时调一次，带 7', async () => {
    const { durable, session } = facade({ queueAdmissions: true, nextEntryId: 7 })
    expect(await session.prompt('later', [IMG1])).toEqual({})
    expect(mocks.keepSentImages).not.toHaveBeenCalled()

    expect(durable.placeQueued()).toBe(7)
    expect(mocks.keepSentImages).toHaveBeenCalledTimes(1)
    expect(mocks.keepSentImages).toHaveBeenCalledWith(durable.sessionId, 7, [IMG1])
  })

  it('放下之前撤回 → 从不调', async () => {
    const { durable, session } = facade({ queueAdmissions: true })
    expect(await session.prompt('withdrawn', [IMG1])).toEqual({})
    durable.queued.length = 0
    expect(durable.placeQueued()).toBeUndefined()
    expect(mocks.keepSentImages).not.toHaveBeenCalled()
  })

  it('空闲发送 onAdmitted{5} 与 onPlaced{5} 都到 → 只调一次', async () => {
    const { durable, session } = facade()
    durable.submitUser = async (_content, options = {}) => {
      options.onAdmitted?.({ entryId: 5 })
      options.onPlaced?.({ entryId: 5 })
      return {}
    }
    expect(await session.prompt('both', [IMG1, IMG2])).toEqual({})
    expect(mocks.keepSentImages).toHaveBeenCalledTimes(1)
    expect(mocks.keepSentImages).toHaveBeenCalledWith(durable.sessionId, 5, [IMG1, IMG2])
  })
})

describe('AS-LIB-3 不调的情况', () => {
  it('没有图 / 图是空数组', async () => {
    const { session } = facade()
    expect(await session.prompt('text only')).toEqual({})
    expect(await session.prompt('empty', [])).toEqual({})
    expect(mocks.keepSentImages).not.toHaveBeenCalled()
  })

  it.each([
    ['busy', { error: 'busy', code: 'busy' }],
    ['no_model', { error: 'no model', code: 'no_model' }]
  ] as const)('发送被拒（%s）', async (_label, result) => {
    const { durable, session } = facade()
    durable.submitResults = [{ ...result }]
    expect(await session.prompt('x', [IMG1])).toEqual(result)
    expect(mocks.keepSentImages).not.toHaveBeenCalled()
  })
})

describe('AS-LIB-4 临时会话不进库（§10）', () => {
  it('活着的内存会话：不调，发送照常', async () => {
    const durable = new FakeDurableSession('mem-lib-live')
    insertEphemeral('mem-lib-live')
    const session = AgentSession.of(durable)
    expect(await session.prompt('a', [IMG1])).toEqual({})
    expect(submittedContent(durable)).toEqual([{ type: 'text', text: 'a' }, IMG1])
    expect(mocks.keepSentImages).not.toHaveBeenCalled()
  })

  it('删掉后的内存会话（wasEphemeral）：迟到的放下也不调', async () => {
    const durable = new FakeDurableSession('mem-lib-gone')
    durable.queueAdmissions = true
    insertEphemeral('mem-lib-gone')
    const session = AgentSession.of(durable)
    expect(await session.prompt('late', [IMG1])).toEqual({})
    sessionRecords.deleteById('mem-lib-gone')
    expect(sessionRecords.wasEphemeral('mem-lib-gone')).toBe(true)
    durable.placeQueued()
    expect(mocks.keepSentImages).not.toHaveBeenCalled()
  })

  it('删掉之后才发送的（wasEphemeral）：不调', async () => {
    insertEphemeral('mem-lib-was')
    sessionRecords.deleteById('mem-lib-was')
    const durable = new FakeDurableSession('mem-lib-was')
    const session = AgentSession.of(durable)
    expect(await session.prompt('after', [IMG1])).toEqual({})
    expect(mocks.keepSentImages).not.toHaveBeenCalled()
  })

  it('Chrome 标签页会话：不调，发送照常', async () => {
    mocks.pickSettings.mockReturnValue({ chromeTab: { installId: 'i', runId: 'r', tabId: 5 } })
    const { durable, session } = facade()
    expect(await session.prompt('tab', [IMG1])).toEqual({})
    expect(submittedContent(durable)).toEqual([{ type: 'text', text: 'tab' }, IMG1])
    expect(mocks.keepSentImages).not.toHaveBeenCalled()
  })
})

describe('AS-LIB-5 keepSentImages reject', () => {
  it('prompt 仍回 {}，记一条 warn，没有未处理的 Promise 拒绝', async () => {
    const unhandled: unknown[] = []
    // 截住这条用例里的 unhandledRejection（真有就记下来判红，而不是交给 vitest 的全局处理器）
    const saved = process.listeners('unhandledRejection')
    process.removeAllListeners('unhandledRejection')
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      mocks.rejection = new Error('disk full')
      const { session } = facade({ nextEntryId: 3 })
      expect(await session.prompt('img', [IMG1])).toEqual({})
      expect(mocks.keepSentImages).toHaveBeenCalledTimes(1)
      // 走过一轮事件循环：.catch 的回调跑完，Node 也判过一次未处理的拒绝
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    } finally {
      process.off('unhandledRejection', onUnhandled)
      for (const listener of saved) {
        process.on('unhandledRejection', listener as (...args: unknown[]) => void)
      }
    }
    expect(unhandled).toEqual([])
    const warns = mocks.warn.mock.calls.filter(([m]) => /disk full/.test(String(m)))
    expect(warns).toHaveLength(1)
  })
})

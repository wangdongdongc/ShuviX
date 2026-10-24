/**
 * 日历入账（P3-07：按 durable 的用户条目 id，`recordUserEntry`）、排除项与读侧过滤。
 *
 *   recordUserEntry 行 = `{sessionId, entryId: String(entryId), day: localDayKey(ts), timestamp}`；
 *         重播（insert 回 false）不 touchActive；timestamp 缺省 = 此刻
 *   DP-C  Chrome 标签页会话不入账（合法绑定才算）
 *   P3-07-21 旁听删掉了（PIN-17）：electronEventSink 广播一条 user_message 不写任何一行；
 *         `recordFromUserMessageEvent` 既不导出、也不被 agentRuntimeAdapters 引用
 *
 *   DP-T1 内存会话（sessionRecords.isEphemeral）不入账：不 insert、不 touchActive、不查 settings；
 *         时钟往前走之后它的 lastActiveAt 也没动
 *   DP-T2 已删的内存会话（wasEphemeral）同样不入账 —— 迟到的落下不给它补一行日历
 *   DP-N  会话建成入账（recordSessionCreated）：entryId = CREATED_ENTRY_ID，不 touchActive；
 *         内存会话、Chrome 标签页会话不入账
 *   DP-O1 来源种类（2026-10-24）：recordUserEntry(sid, id, ts, 'trigger') 的行带 origin；不带 → 没有 origin（NULL）；
 *         内存会话、Chrome 标签页会话带着来源也不入账
 *
 * 下面几组接上真库（node:sqlite 内存库跑全部迁移，DAO 用真 SQL，`mocks.db` 设上时 DAO 替身全部转给真件），
 * 测 service 的口径与 SQL 合起来的结果：
 *   DP-A1 activeSessionsOnDay 数人打过消息的会话，含临时会话（没有项目）；隐藏载体项目（知识库 / 注册表 / 技能 /
 *         __daily__ / __tracking__）不算
 *   DP-A2 没盖来源的行（旧行）按人算
 *   DP-A3 当天只有建成那一行 → 0
 *   DP-A4 当天只有 trigger（bot 自己的运行）或 parent-session / session 的行 → 0
 *   DP-C3 日历不变：只有 trigger 行的会话照样在 sessionsOnDay / daysInMonth 里；打开跟踪项（__tracking__ 下的建成行）
 *         不添日历圆点
 *   DP-R1 sessionsActiveBetween 去掉隐藏项目的会话
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ChatEvent } from '@shuvix/chat-protocol/events'

const mocks = vi.hoisted(() => ({
  insert: vi.fn<
    (row: {
      sessionId: string
      entryId: string
      day: string
      timestamp: number
      origin?: string
    }) => boolean
  >(() => true),
  touchActive: vi.fn(),
  sessionsOnDay: vi.fn((): Array<{ id: string; projectId: string | null }> => []),
  daysInMonth: vi.fn((): Array<{ day: string; projectId: string | null }> => []),
  firstEntryOnDay: vi.fn((): string | undefined => undefined),
  frontendBroadcast: vi.fn(),
  notify: vi.fn(),
  pickSettings: vi.fn<(id: string, keys: string[]) => Record<string, unknown> | undefined>(
    () => ({})
  ),
  /** DP-A / DP-C3 / DP-R1 接上的真库：设上时 DAO 替身的每个方法都转给真 DAO（真 SQL） */
  db: null as unknown
}))

function localDayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

vi.mock('../../dao/database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return mocks.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (mocks.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => mocks.db } }
})
vi.mock('../../dao/sessionDayPromptDao', async (importOriginal) => {
  const real = (await importOriginal<typeof import('../../dao/sessionDayPromptDao')>())
    .sessionDayPromptDao
  return {
    CREATED_ENTRY_ID: 'created',
    localDayKey,
    sessionDayPromptDao: {
      insert: (row: Parameters<typeof real.insert>[0]) =>
        mocks.db ? real.insert(row) : mocks.insert(row),
      sessionsOnDay: (day: string) => (mocks.db ? real.sessionsOnDay(day) : mocks.sessionsOnDay()),
      daysInMonth: (year: number, month: number) =>
        mocks.db ? real.daysInMonth(year, month) : mocks.daysInMonth(),
      firstEntryOnDay: (sessionId: string, day: string) =>
        mocks.db ? real.firstEntryOnDay(sessionId, day) : mocks.firstEntryOnDay(),
      humanActiveOnDay: (day: string) => real.humanActiveOnDay(day),
      activityBetween: (startDay: string, endDay: string) => real.activityBetween(startDay, endDay),
      deleteBySessionId: vi.fn()
    }
  }
})
vi.mock('../../dao/sessionDao', () => ({
  // 缺省是普通会话：设置里没有 chromeTab（Chrome 标签页会话不进日历，见 DP-C*）。
  // pick 只给 DP-T*：插内存会话时 sessionRecords 要先问库里有没有同 id 的行
  sessionDao: {
    touchActive: mocks.touchActive,
    pickSettings: mocks.pickSettings,
    pick: () => undefined
  }
}))
vi.mock('../../frontend/core', () => ({
  chatFrontendRegistry: { broadcast: mocks.frontendBroadcast, hasCapability: vi.fn(() => false) }
}))
vi.mock('../notificationService', () => ({ notifyOnChatEvent: mocks.notify }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import * as dayPromptService from '../sessionDayPromptService'
import {
  activeSessionsOnDay,
  daysInMonth,
  firstEntryOnDay,
  recordSessionCreated,
  recordUserEntry,
  sessionsActiveBetween,
  sessionsOnDay
} from '../sessionDayPromptService'
import { electronEventSink } from '../agentRuntimeAdapters'
import { sessionRecords } from '../sessionRecords'
import { migrations } from '../../dao/migrations'
import { KNOWLEDGE_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
import { REGISTRY_NOTE_PROJECT_IDS } from '@shuvix/chat-protocol/registryNotes'
import { SKILL_DEFAULT_PROJECT_ID } from '@shuvix/chat-protocol/skillNotes'
import { DAILY_PROJECT_ID } from '@shuvix/chat-protocol/dailyNotes'
import { TRACKING_PROJECT_ID } from '@shuvix/chat-protocol/trackingNotes'

beforeEach(() => {
  mocks.insert.mockReset().mockReturnValue(true)
  mocks.touchActive.mockReset()
  mocks.sessionsOnDay.mockReset().mockReturnValue([])
  mocks.daysInMonth.mockReset().mockReturnValue([])
  mocks.firstEntryOnDay.mockReset().mockReturnValue(undefined)
  mocks.frontendBroadcast.mockReset()
  mocks.notify.mockReset()
  mocks.pickSettings.mockReset().mockReturnValue({})
  sessionRecords.clearEphemeralForTests()
})

const T_NOON = new Date(2026, 8, 18, 12).getTime()

describe('recordUserEntry', () => {
  it('用户条目入账（entryId 存成 String(entryId)）并 touchActive', () => {
    recordUserEntry('s1', 7, T_NOON)
    expect(mocks.insert).toHaveBeenCalledWith({
      sessionId: 's1',
      entryId: '7',
      day: '2026-09-18',
      timestamp: T_NOON
    })
    expect(mocks.touchActive).toHaveBeenCalledWith('s1')
  })

  it('同一条目重播（insert 返回 false）不 touchActive', () => {
    mocks.insert.mockReturnValue(false)
    recordUserEntry('s1', 7, T_NOON)
    expect(mocks.insert).toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('timestamp 缺省 = 此刻（排队的发送按放下那一刻算哪一天）', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 8, 19, 0, 0, 1))
      recordUserEntry('s1', 3)
      expect(mocks.insert.mock.calls[0]![0]).toMatchObject({
        entryId: '3',
        day: '2026-09-19',
        timestamp: new Date(2026, 8, 19, 0, 0, 1).getTime()
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('P3-07-21 user_message 旁听删掉了（PIN-17）', () => {
  it('P3-07-21 electronEventSink 广播根会话一轮的开始（user_message 已不存在，P3-08）：前端照发，不写任何一行、不 touchActive', () => {
    const event: ChatEvent = { type: 'agent_start', sessionId: 's1' }
    electronEventSink.broadcast(event)
    expect(mocks.frontendBroadcast).toHaveBeenCalledWith(event)
    expect(mocks.notify).toHaveBeenCalledWith(event)
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('P3-07-21 静态：recordFromUserMessageEvent 不再导出，agentRuntimeAdapters 不引用它', () => {
    expect('recordFromUserMessageEvent' in dayPromptService).toBe(false)
    expect('recordUserPrompt' in dayPromptService).toBe(false)
    const source = readFileSync(join(__dirname, '..', 'agentRuntimeAdapters.ts'), 'utf8')
    expect(source).not.toContain('recordFromUserMessageEvent')
    expect(source).not.toMatch(/from '\.\/sessionDayPromptService'/)
  })
})

/**
 * Chrome 标签页会话不进日历：它是某个标签页的临时对话，标签页一关就删 —— 日历上留一个点，
 * 点进去却是一条已经不存在的会话。判定按 `settings.chromeTab` 是不是**合法绑定**
 * （chat-protocol 的 chromeTabOf）：字段不全的算普通会话，照常入账。
 */
describe('DP-C Chrome 标签页会话不入账', () => {
  const TAB = { installId: 'i1', runId: 'r1', tabId: 5 }

  it('DP-C1 合法绑定：recordUserEntry 不入账、不 touchActive；按 (sid, [chromeTab]) 查', () => {
    mocks.pickSettings.mockReturnValue({ chromeTab: TAB })
    recordUserEntry('tab-1', 1, T_NOON)
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
    expect(mocks.pickSettings.mock.calls).toEqual([['tab-1', ['chromeTab']]])
  })

  it.each([
    ['tabId 是字符串', { ...TAB, tabId: '5' }],
    ['tabId 是 -1', { ...TAB, tabId: -1 }],
    ['缺 installId', { runId: 'r1', tabId: 5 }]
  ])('DP-C2 绑定不合法（%s）→ 普通会话，照常入账', (_label, chromeTab) => {
    mocks.pickSettings.mockReturnValue({ chromeTab })
    recordUserEntry('s9', 4, T_NOON)
    expect(mocks.pickSettings).toHaveBeenCalledWith('s9', ['chromeTab'])
    expect(mocks.insert).toHaveBeenCalledWith({
      sessionId: 's9',
      entryId: '4',
      day: '2026-09-18',
      timestamp: T_NOON
    })
    expect(mocks.touchActive).toHaveBeenCalledWith('s9')
  })

  it('DP-C2 会话行不存在（pickSettings 回 undefined）→ 照常入账', () => {
    mocks.pickSettings.mockReturnValue(undefined)
    recordUserEntry('ghost', 5, T_NOON)
    expect(mocks.insert).toHaveBeenCalledTimes(1)
  })
})

/**
 * 内存会话（只在内存里、宿主一关就没）不记活跃：不进日历、不动 lastActiveAt。
 * 删掉之后也一样 —— 一行日历指向一条从没落过库、此刻也已不在内存里的会话，点进去什么都没有。
 */
describe('DP-T 内存会话不入账', () => {
  const T0 = new Date(2026, 8, 18, 9).getTime()

  function insertEphemeral(id: string): void {
    sessionRecords.insert(
      {
        id,
        title: id,
        projectId: null,
        parentId: null,
        settings: {},
        createdAt: T0,
        updatedAt: T0,
        lastActiveAt: T0
      },
      { ephemeral: true }
    )
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('DP-T1 活着的内存会话：不 insert、不 touchActive、不查 settings；lastActiveAt 不动', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    insertEphemeral('mem-1')
    vi.setSystemTime(T0 + 60_000)

    recordUserEntry('mem-1', 1)

    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
    expect(mocks.pickSettings).not.toHaveBeenCalled()
    expect(sessionRecords.findById('mem-1')).toMatchObject({ lastActiveAt: T0, updatedAt: T0 })
  })

  it('DP-T2 已删的内存会话：同样不入账', () => {
    insertEphemeral('mem-2')
    sessionRecords.deleteById('mem-2')
    expect(sessionRecords.wasEphemeral('mem-2')).toBe(true)

    recordUserEntry('mem-2', 3, T_NOON)

    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
    expect(mocks.pickSettings).not.toHaveBeenCalled()
  })

  it('DP-T 对照：同一时刻的普通会话照常入账', () => {
    insertEphemeral('mem-3')
    recordUserEntry('s1', 4, T_NOON)
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    expect(mocks.touchActive).toHaveBeenCalledWith('s1')
  })
})

describe('DP-N 会话建成入账', () => {
  it('DP-N1 一行 entryId = created、按建成时刻落日；不 touchActive（建行时 lastActiveAt 已是此刻）', () => {
    recordSessionCreated('s1', T_NOON)
    expect(mocks.insert).toHaveBeenCalledWith({
      sessionId: 's1',
      entryId: 'created',
      day: '2026-09-18',
      timestamp: T_NOON
    })
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('DP-N2 Chrome 标签页会话不入账', () => {
    mocks.pickSettings.mockReturnValue({ chromeTab: { installId: 'i1', runId: 'r1', tabId: 5 } })
    recordSessionCreated('tab-1', T_NOON)
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('DP-N3 内存会话不入账', () => {
    sessionRecords.insert(
      {
        id: 'mem-n',
        title: 'mem-n',
        projectId: null,
        parentId: null,
        settings: {},
        createdAt: T_NOON,
        updatedAt: T_NOON,
        lastActiveAt: T_NOON
      },
      { ephemeral: true }
    )
    recordSessionCreated('mem-n', T_NOON)
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})

describe('sessionsOnDay 隐藏项目过滤', () => {
  it('知识库载体会话不进日历列表', () => {
    mocks.sessionsOnDay.mockReturnValue([
      { id: 'hidden', projectId: KNOWLEDGE_PROJECT_ID },
      { id: 'visible', projectId: 'p1' }
    ])
    expect(sessionsOnDay('2026-09-18').map((s) => s.id)).toEqual(['visible'])
  })
})

describe('daysInMonth 隐藏项目过滤', () => {
  it('只有隐藏项目开口的日子不占圆点', () => {
    mocks.daysInMonth.mockReturnValue([
      { day: '2026-09-18', projectId: KNOWLEDGE_PROJECT_ID },
      { day: '2026-09-18', projectId: 'p1' },
      { day: '2026-09-19', projectId: KNOWLEDGE_PROJECT_ID }
    ])
    expect(daysInMonth(2026, 9)).toEqual(['2026-09-18'])
  })
})

describe('firstEntryOnDay', () => {
  it('无行 → null', () => {
    expect(firstEntryOnDay('s1', '2026-09-18')).toBeNull()
  })
})

describe('DP-O1 来源种类', () => {
  it("DP-O1 recordUserEntry(sid, id, ts, 'trigger') → 行带 origin；照常 touchActive", () => {
    recordUserEntry('s1', 7, T_NOON, 'trigger')
    expect(mocks.insert).toHaveBeenCalledWith({
      sessionId: 's1',
      entryId: '7',
      day: '2026-09-18',
      timestamp: T_NOON,
      origin: 'trigger'
    })
    expect(mocks.touchActive).toHaveBeenCalledWith('s1')
  })

  it('DP-O1 不带来源（或空串）→ 行里没有 origin 键（落库 NULL）', () => {
    recordUserEntry('s1', 8, T_NOON)
    recordUserEntry('s1', 9, T_NOON, '')
    expect(mocks.insert.mock.calls.map(([row]) => row)).toEqual([
      { sessionId: 's1', entryId: '8', day: '2026-09-18', timestamp: T_NOON },
      { sessionId: 's1', entryId: '9', day: '2026-09-18', timestamp: T_NOON }
    ])
  })

  it('DP-O1 内存会话、Chrome 标签页会话带着来源也不入账', () => {
    sessionRecords.insert(
      {
        id: 'mem-o',
        title: 'mem-o',
        projectId: null,
        parentId: null,
        settings: {},
        createdAt: T_NOON,
        updatedAt: T_NOON,
        lastActiveAt: T_NOON
      },
      { ephemeral: true }
    )
    recordUserEntry('mem-o', 1, T_NOON, 'trigger')
    mocks.pickSettings.mockReturnValue({ chromeTab: { installId: 'i1', runId: 'r1', tabId: 5 } })
    recordUserEntry('tab-o', 1, T_NOON, 'chrome')
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })
})

describe('DP-A / DP-C3 / DP-R1（真库）', () => {
  const DAY = '2026-10-24'
  const T = (hour: number): number => new Date(2026, 9, 24, hour).getTime()
  let db: DatabaseSync

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    for (const m of migrations) m.up(db as never)
    mocks.db = db
  })

  afterEach(() => {
    mocks.db = null
    db.close()
  })

  function addSession(id: string, projectId: string | null = null): void {
    db.prepare(
      'INSERT INTO sessions (id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, `title ${id}`, projectId, null, '{}', 1, 1, 1)
  }

  const HIDDEN = [
    KNOWLEDGE_PROJECT_ID,
    REGISTRY_NOTE_PROJECT_IDS.bot,
    SKILL_DEFAULT_PROJECT_ID,
    DAILY_PROJECT_ID,
    TRACKING_PROJECT_ID
  ]

  it('DP-A1 数人打过消息的会话：临时会话（没有项目）算，普通项目算；隐藏载体项目都不算', () => {
    addSession('temp', null)
    recordUserEntry('temp', 1, T(9), 'local')
    addSession('proj', 'p1')
    recordUserEntry('proj', 1, T(10), 'remote')
    recordUserEntry('proj', 2, T(11), 'local') // 同一会话两条：只算一次
    HIDDEN.forEach((projectId, i) => {
      addSession(`hidden-${i}`, projectId)
      recordUserEntry(`hidden-${i}`, 1, T(12), 'local')
    })
    expect(HIDDEN.every(Boolean)).toBe(true)
    expect(activeSessionsOnDay(DAY)).toBe(2)
    expect(activeSessionsOnDay('2026-10-25')).toBe(0)
  })

  it('DP-A2 没盖来源的行（旧行 / 发送时没盖章）按人算', () => {
    addSession('legacy', 'p1')
    recordUserEntry('legacy', 1, T(9))
    expect(activeSessionsOnDay(DAY)).toBe(1)
  })

  it('DP-A3 当天只有建成那一行 → 0', () => {
    addSession('fresh', 'p1')
    recordSessionCreated('fresh', T(9))
    expect(activeSessionsOnDay(DAY)).toBe(0)
  })

  it('DP-A4 当天只有 trigger（bot 自己的运行）或 parent-session / session 的行 → 0；混进一条人打的就算', () => {
    addSession('bot-run', null)
    recordSessionCreated('bot-run', T(18))
    recordUserEntry('bot-run', 1, T(18), 'trigger')
    addSession('child', 'p1')
    recordUserEntry('child', 1, T(10), 'parent-session')
    addSession('driven', 'p1')
    recordUserEntry('driven', 1, T(11), 'session')
    expect(activeSessionsOnDay(DAY)).toBe(0)

    // 用户在 bot 的会话里接着说了一句：这条会话算人打过
    recordUserEntry('bot-run', 2, T(19), 'local')
    expect(activeSessionsOnDay(DAY)).toBe(1)
  })

  it('DP-C3 日历不变：只有 trigger 行的会话照样列出、占圆点；打开跟踪项（__tracking__ 下的建成行）不添圆点', () => {
    addSession('bot-run', null)
    recordUserEntry('bot-run', 1, T(18), 'trigger')
    expect(sessionsOnDay(DAY).map((s) => s.id)).toEqual(['bot-run'])
    expect(daysInMonth(2026, 10)).toEqual([DAY])

    addSession('note', TRACKING_PROJECT_ID)
    recordSessionCreated('note', new Date(2026, 9, 23, 9).getTime())
    expect(sessionsOnDay('2026-10-23')).toEqual([])
    expect(daysInMonth(2026, 10)).toEqual([DAY])
    // 行确实落了（隐藏靠读侧过滤）
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM session_day_prompts WHERE sessionId = 'note'").get()
    ).toEqual({ n: 1 })
  })

  it('DP-R1 sessionsActiveBetween 去掉隐藏项目的会话；别的会话带 origins 与 lastAt', () => {
    addSession('temp', null)
    recordUserEntry('temp', 1, T(9), 'local')
    recordUserEntry('temp', 2, T(10), 'trigger')
    HIDDEN.forEach((projectId, i) => {
      addSession(`hidden-${i}`, projectId)
      recordUserEntry(`hidden-${i}`, 1, T(12), 'local')
    })
    const rows = sessionsActiveBetween('2026-10-23', DAY)
    expect(rows.map((r) => [r.session.id, r.origins, r.lastAt])).toEqual([
      ['temp', ['local', 'trigger'], T(10)]
    ])
  })
})

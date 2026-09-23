/**
 * 日历入账：user_message 旁听、系统通知/指令注入不入账、eventSink 接线。
 *
 *   DP-T1 内存会话（sessionRecords.isEphemeral）不入账：不 insert、不 touchActive、不查 settings；
 *         时钟往前走之后它的 lastActiveAt 也没动
 *   DP-T2 已删的内存会话（wasEphemeral）同样不入账 —— 迟到的 user_message 不给它补一行日历
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

const mocks = vi.hoisted(() => ({
  insert: vi.fn<
    (row: { sessionId: string; entryId: string; day: string; timestamp: number }) => boolean
  >(() => true),
  touchActive: vi.fn(),
  sessionsOnDay: vi.fn((): Array<{ id: string; projectId: string | null }> => []),
  daysInMonth: vi.fn((): Array<{ day: string; projectId: string | null }> => []),
  firstEntryOnDay: vi.fn((): string | undefined => undefined),
  frontendBroadcast: vi.fn(),
  notify: vi.fn(),
  pickSettings: vi.fn<(id: string, keys: string[]) => Record<string, unknown> | undefined>(
    () => ({})
  )
}))

function localDayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

vi.mock('../../dao/sessionDayPromptDao', () => ({
  localDayKey,
  sessionDayPromptDao: {
    insert: mocks.insert,
    sessionsOnDay: mocks.sessionsOnDay,
    daysInMonth: mocks.daysInMonth,
    firstEntryOnDay: mocks.firstEntryOnDay,
    deleteBySessionId: vi.fn()
  }
}))
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
vi.mock('../stepPersistPipeline', () => ({ transformToolResultForPersist: vi.fn() }))
vi.mock('../httpLogService', () => ({ httpLogService: { updateUsage: vi.fn() } }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  daysInMonth,
  firstEntryOnDay,
  recordFromUserMessageEvent,
  recordUserPrompt,
  sessionsOnDay
} from '../sessionDayPromptService'
import { electronEventSink } from '../agentRuntimeAdapters'
import { sessionRecords } from '../sessionRecords'
import { KNOWLEDGE_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'

function userMsg(over: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    sessionId: 's1',
    role: 'user',
    type: 'text',
    content: 'hello',
    model: '',
    createdAt: new Date(2026, 8, 18, 12).getTime(),
    metadata: null,
    ...over
  } as ChatMessage
}

function userEvent(message: ChatMessage, sessionId = 's1'): ChatEvent {
  return { type: 'user_message', sessionId, message: JSON.stringify(message) }
}

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

describe('recordUserPrompt', () => {
  it('普通用户消息入账并 touchActive', () => {
    const msg = userMsg({ id: 'e1' })
    recordUserPrompt('s1', msg)
    expect(mocks.insert).toHaveBeenCalledWith({
      sessionId: 's1',
      entryId: 'e1',
      day: '2026-09-18',
      timestamp: msg.createdAt
    })
    expect(mocks.touchActive).toHaveBeenCalledWith('s1')
  })

  it('同一 entry 重播（insert 返回 false）不 touchActive', () => {
    mocks.insert.mockReturnValue(false)
    recordUserPrompt('s1', userMsg({ id: 'e1' }))
    expect(mocks.insert).toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('isSystemNotice 不入账', () => {
    recordUserPrompt(
      's1',
      userMsg({
        id: 'n1',
        metadata: { isSystemNotice: true },
        content: '<background-task></background-task>'
      })
    )
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('isInstructionInjection 不入账', () => {
    recordUserPrompt(
      's1',
      userMsg({
        id: 'i1',
        metadata: { isInstructionInjection: true, instructionFilename: 'CLAUDE.md' }
      })
    )
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('助手消息不入账', () => {
    recordUserPrompt('s1', {
      id: 'a1',
      sessionId: 's1',
      role: 'assistant',
      type: 'message',
      content: 'ok',
      blocks: [{ type: 'text', text: 'ok' }],
      model: 'm',
      createdAt: 1,
      metadata: null
    })
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})

describe('recordFromUserMessageEvent', () => {
  it('解析 user_message 后入账', () => {
    recordFromUserMessageEvent(userEvent(userMsg({ id: 'e2' })))
    expect(mocks.insert.mock.calls[0][0].entryId).toBe('e2')
  })

  it('非 user_message 忽略', () => {
    recordFromUserMessageEvent({ type: 'agent_end', sessionId: 's1' } as ChatEvent)
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('载荷不是 JSON 时不抛', () => {
    expect(() =>
      recordFromUserMessageEvent({ type: 'user_message', sessionId: 's1', message: 'not-json' })
    ).not.toThrow()
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})

describe('electronEventSink 旁听 user_message', () => {
  it('broadcast 同时到达前端、通知决策器和日历入账（合成事件，不经 prompt）', () => {
    // CAL-08：入账钉的是旁听 eventSink，不是 chatGateway.prompt。steer/followUp/nextTurn
    // 一旦落树成 user_message 也走这一条。
    const event = userEvent(userMsg({ id: 'e3' }))
    electronEventSink.broadcast(event)
    expect(mocks.frontendBroadcast).toHaveBeenCalledWith(event)
    expect(mocks.notify).toHaveBeenCalledWith(event)
    expect(mocks.insert.mock.calls[0][0].entryId).toBe('e3')
    expect(mocks.touchActive).toHaveBeenCalledWith('s1')
  })

  it('系统通知广播不入账', () => {
    electronEventSink.broadcast(
      userEvent(userMsg({ id: 'n2', metadata: { isSystemNotice: true } }))
    )
    expect(mocks.frontendBroadcast).toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})

/**
 * Chrome 标签页会话不进日历：它是某个标签页的临时对话，标签页一关就删 —— 日历上留一个点，
 * 点进去却是一条已经不存在的会话。判定按 `settings.chromeTab` 是不是**合法绑定**
 * （chat-protocol 的 chromeTabOf）：字段不全的算普通会话，照常入账。
 */
describe('DP-C Chrome 标签页会话不入账', () => {
  const TAB = { installId: 'i1', runId: 'r1', tabId: 5 }

  it('DP-C1 合法绑定：recordUserPrompt 不入账、不 touchActive；按 (sid, [chromeTab]) 查', () => {
    mocks.pickSettings.mockReturnValue({ chromeTab: TAB })
    recordUserPrompt('tab-1', userMsg({ id: 'e1', sessionId: 'tab-1' }))
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
    expect(mocks.pickSettings.mock.calls).toEqual([['tab-1', ['chromeTab']]])
  })

  it('DP-C1 经 recordFromUserMessageEvent / electronEventSink 同样不入账（前端照发）', () => {
    mocks.pickSettings.mockReturnValue({ chromeTab: TAB })
    recordFromUserMessageEvent(userEvent(userMsg({ id: 'e2', sessionId: 'tab-1' }), 'tab-1'))
    const event = userEvent(userMsg({ id: 'e3', sessionId: 'tab-1' }), 'tab-1')
    electronEventSink.broadcast(event)
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
    expect(mocks.frontendBroadcast).toHaveBeenCalledWith(event)
  })

  it.each([
    ['tabId 是字符串', { ...TAB, tabId: '5' }],
    ['tabId 是 -1', { ...TAB, tabId: -1 }],
    ['缺 installId', { runId: 'r1', tabId: 5 }]
  ])('DP-C2 绑定不合法（%s）→ 普通会话，照常入账', (_label, chromeTab) => {
    mocks.pickSettings.mockReturnValue({ chromeTab })
    const msg = userMsg({ id: 'e4', sessionId: 's9' })
    recordUserPrompt('s9', msg)
    expect(mocks.pickSettings).toHaveBeenCalledWith('s9', ['chromeTab'])
    expect(mocks.insert).toHaveBeenCalledWith({
      sessionId: 's9',
      entryId: 'e4',
      day: '2026-09-18',
      timestamp: msg.createdAt
    })
    expect(mocks.touchActive).toHaveBeenCalledWith('s9')
  })

  it('DP-C2 会话行不存在（pickSettings 回 undefined）→ 照常入账', () => {
    mocks.pickSettings.mockReturnValue(undefined)
    recordUserPrompt('ghost', userMsg({ id: 'e5', sessionId: 'ghost' }))
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

    recordUserPrompt('mem-1', userMsg({ id: 'e1', sessionId: 'mem-1', createdAt: Date.now() }))
    recordFromUserMessageEvent(userEvent(userMsg({ id: 'e2', sessionId: 'mem-1' }), 'mem-1'))

    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
    expect(mocks.pickSettings).not.toHaveBeenCalled()
    expect(sessionRecords.findById('mem-1')).toMatchObject({ lastActiveAt: T0, updatedAt: T0 })
  })

  it('DP-T2 已删的内存会话：同样不入账', () => {
    insertEphemeral('mem-2')
    sessionRecords.deleteById('mem-2')
    expect(sessionRecords.wasEphemeral('mem-2')).toBe(true)

    recordUserPrompt('mem-2', userMsg({ id: 'e3', sessionId: 'mem-2' }))

    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
    expect(mocks.pickSettings).not.toHaveBeenCalled()
  })

  it('DP-T 对照：同一时刻的普通会话照常入账', () => {
    insertEphemeral('mem-3')
    recordUserPrompt('s1', userMsg({ id: 'e4' }))
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    expect(mocks.touchActive).toHaveBeenCalledWith('s1')
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

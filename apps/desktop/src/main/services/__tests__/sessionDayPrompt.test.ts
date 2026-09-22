/**
 * 日历入账：user_message 旁听、系统通知/指令注入不入账、eventSink 接线。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
  notify: vi.fn()
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
  // 普通会话：设置里没有 chromeTab（Chrome 标签页会话不进日历，见 recordUserPrompt）
  sessionDao: { touchActive: mocks.touchActive, pickSettings: () => ({}) }
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

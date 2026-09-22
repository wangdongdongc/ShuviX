/**
 * electronEventSink（agentRuntimeAdapters.ts）的一条旁路：每条 ChatEvent 除了发给聊天前端、通知决策器、
 * 日历入账，还要交给 Chrome 桥的 `observeChromeTabRun` —— 标签页会话一轮的起止就是那个浏览器的调试
 * 租约（一轮跑完释放 Chrome 里的调试横幅）。租约**不经侧边栏**记：侧边栏关着、连接断过，一轮照样
 * 有始有终。
 *
 * 前三个出口换成 spy；`observeChromeTabRun` 是**穿透到真实现**的 spy（sessionDao 是一张
 * pickSettings 的内存表），所以同一条链路也验到了租约真的记在那个浏览器的状态上。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'

const mocks = vi.hoisted(() => ({
  frontendBroadcast: vi.fn(),
  notify: vi.fn(),
  record: vi.fn(),
  settings: new Map<string, Record<string, unknown>>(),
  pickSettings: vi.fn()
}))

vi.mock('../../frontend/core', () => ({
  chatFrontendRegistry: { broadcast: mocks.frontendBroadcast, hasCapability: vi.fn(() => false) }
}))
vi.mock('../notificationService', () => ({ notifyOnChatEvent: mocks.notify }))
vi.mock('../sessionDayPromptService', () => ({ recordFromUserMessageEvent: mocks.record }))
vi.mock('../stepPersistPipeline', () => ({ transformToolResultForPersist: vi.fn() }))
vi.mock('../httpLogService', () => ({ httpLogService: { updateUsage: vi.fn() } }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../dao/sessionDao', () => ({ sessionDao: { pickSettings: mocks.pickSettings } }))
vi.mock('../chromeBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chromeBridge')>()
  return { ...actual, observeChromeTabRun: vi.fn(actual.observeChromeTabRun) }
})

import { electronEventSink } from '../agentRuntimeAdapters'
import {
  chromeBrowserState,
  existingChromeBrowserState,
  observeChromeTabRun
} from '../chromeBridge'
import { ChromeBrowserState } from '../chromeBridge/browserState'

beforeEach(() => {
  for (const m of [mocks.frontendBroadcast, mocks.notify, mocks.record]) m.mockReset()
  vi.mocked(observeChromeTabRun).mockClear()
  mocks.settings.clear()
  mocks.pickSettings.mockReset()
  mocks.pickSettings.mockImplementation((id: string, keys: string[]) => {
    const s = mocks.settings.get(id)
    return s ? Object.fromEntries(keys.map((k) => [k, structuredClone(s[k])])) : undefined
  })
})

describe('ES-1 每条事件都交给四个出口', () => {
  it.each<ChatEvent>([
    { type: 'agent_start', sessionId: 's1' },
    { type: 'text_delta', sessionId: 's1', delta: 'x' },
    { type: 'user_message', sessionId: 's1', message: '{}' },
    { type: 'input_request_resolved', sessionId: 's1', requestId: 'r' },
    { type: 'agent_end', sessionId: 's1' }
  ])('ES-1 $type → 前端、通知、日历、Chrome 租约各收到同一个事件一次', (event) => {
    electronEventSink.broadcast(event)
    for (const spy of [mocks.frontendBroadcast, mocks.notify, mocks.record]) {
      expect(spy.mock.calls).toEqual([[event]])
      expect(spy.mock.calls[0][0]).toBe(event)
    }
    expect(vi.mocked(observeChromeTabRun).mock.calls).toEqual([[event]])
    expect(vi.mocked(observeChromeTabRun).mock.calls[0][0]).toBe(event)
  })
})

describe('ES-2 经事件流记下标签页会话的轮次（真的租约）', () => {
  it('ES-2 标签页会话的 agent_start / agent_end → 那个浏览器的 beginRun / endRun', () => {
    mocks.settings.set('tab-es2', { chromeTab: { installId: 'i-es2', runId: 'r1', tabId: 5 } })
    const state = chromeBrowserState('i-es2')
    const begin = vi.spyOn(state, 'beginRun')
    const endRun = vi.spyOn(state, 'endRun')

    electronEventSink.broadcast({ type: 'agent_start', sessionId: 'tab-es2' })
    expect(begin.mock.calls).toEqual([['tab-es2']])
    electronEventSink.broadcast({ type: 'agent_end', sessionId: 'tab-es2' })
    expect(endRun.mock.calls).toEqual([['tab-es2']])
  })

  it('ES-2 桌面会话的一轮 → 不碰任何浏览器状态', () => {
    mocks.settings.set('desk-es2', { enabledTools: [] })
    const begin = vi.spyOn(ChromeBrowserState.prototype, 'beginRun')
    const endRun = vi.spyOn(ChromeBrowserState.prototype, 'endRun')
    try {
      electronEventSink.broadcast({ type: 'agent_start', sessionId: 'desk-es2' })
      electronEventSink.broadcast({ type: 'agent_end', sessionId: 'desk-es2' })
      expect(mocks.pickSettings).toHaveBeenCalledWith('desk-es2', ['chromeTab'])
      expect(begin).not.toHaveBeenCalled()
      expect(endRun).not.toHaveBeenCalled()
      expect(mocks.frontendBroadcast).toHaveBeenCalledTimes(2)
    } finally {
      begin.mockRestore()
      endRun.mockRestore()
    }
  })

  it('ES-2 逐 token 的事件不查库（这条旁路每个 token 都会走一遍）', () => {
    mocks.settings.set('tab-es2b', { chromeTab: { installId: 'i-es2b', runId: 'r1', tabId: 5 } })
    for (let i = 0; i < 20; i++) {
      electronEventSink.broadcast({ type: 'text_delta', sessionId: 'tab-es2b', delta: 'x' })
    }
    expect(mocks.pickSettings).not.toHaveBeenCalled()
    expect(existingChromeBrowserState('i-es2b')).toBeUndefined()
  })
})

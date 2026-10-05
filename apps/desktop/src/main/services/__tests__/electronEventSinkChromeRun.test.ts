/**
 * electronEventSink（agentRuntimeAdapters.ts）的一条旁路：每条 ChatEvent 除了发给聊天前端、通知决策器，
 * 还要交给 Chrome 桥的 `observeChromeTabRun`（日历入账不再旁听事件流，P3-07 PIN-17） —— 标签页会话一轮的起止就是那个浏览器的调试
 * 租约（一轮跑完释放 Chrome 里的调试横幅）。租约**不经侧边栏**记：侧边栏关着、连接断过，一轮照样
 * 有始有终。
 *
 * 前两个出口换成 spy；`observeChromeTabRun` 是**穿透到真实现**的 spy（sessionDao 是一张
 * pickSettings 的内存表），所以同一条链路也验到了租约真的记在那个浏览器的状态上。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'

const mocks = vi.hoisted(() => ({
  frontendBroadcast: vi.fn(),
  notify: vi.fn(),
  settings: new Map<string, Record<string, unknown>>(),
  pickSettings: vi.fn()
}))

vi.mock('../../frontend/core', () => ({
  chatFrontendRegistry: { broadcast: mocks.frontendBroadcast, hasCapability: vi.fn(() => false) }
}))
vi.mock('../notificationService', () => ({ notifyOnChatEvent: mocks.notify }))
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
  for (const m of [mocks.frontendBroadcast, mocks.notify]) m.mockReset()
  vi.mocked(observeChromeTabRun).mockClear()
  mocks.settings.clear()
  mocks.pickSettings.mockReset()
  mocks.pickSettings.mockImplementation((id: string, keys: string[]) => {
    const s = mocks.settings.get(id)
    return s ? Object.fromEntries(keys.map((k) => [k, structuredClone(s[k])])) : undefined
  })
})

describe('ES-1 每条事件都交给三个出口', () => {
  it.each<ChatEvent>([
    { type: 'agent_start', sessionId: 's1' },
    { type: 'mcp_connecting', sessionId: 's1', server: 'x', connecting: true },
    { type: 'ask_count', sessionId: 's1', count: 2 },
    { type: 'error', sessionId: 's1', error: 'boom' },
    { type: 'agent_end', sessionId: 's1', reason: 'ok' }
  ])('ES-1 $type → 前端、通知、Chrome 租约各收到同一个事件一次', (event) => {
    electronEventSink.broadcast(event)
    for (const spy of [mocks.frontendBroadcast, mocks.notify]) {
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
    electronEventSink.broadcast({ type: 'agent_end', sessionId: 'tab-es2', reason: 'ok' })
    expect(endRun.mock.calls).toEqual([['tab-es2']])
  })

  it.each(['ok', 'aborted', 'error'] as const)(
    'P3-08-57 agent_end{%s} → endRun 恰一次（每种结局都还租约）',
    (reason) => {
      const sid = `tab-57-${reason}`
      mocks.settings.set(sid, { chromeTab: { installId: `i-57-${reason}`, runId: 'r1', tabId: 5 } })
      const state = chromeBrowserState(`i-57-${reason}`)
      const begin = vi.spyOn(state, 'beginRun')
      const endRun = vi.spyOn(state, 'endRun')
      electronEventSink.broadcast({ type: 'agent_start', sessionId: sid })
      electronEventSink.broadcast({ type: 'agent_end', sessionId: sid, reason })
      expect(begin.mock.calls).toEqual([[sid]])
      expect(endRun.mock.calls).toEqual([[sid]])
    }
  )

  it('P3-08-57 派生 agent 的一对（sessionId = agentId，不是标签页会话）→ 不碰租约', () => {
    const begin = vi.spyOn(ChromeBrowserState.prototype, 'beginRun')
    const endRun = vi.spyOn(ChromeBrowserState.prototype, 'endRun')
    try {
      electronEventSink.broadcast({ type: 'agent_start', sessionId: 'agent-a1' })
      electronEventSink.broadcast({ type: 'agent_end', sessionId: 'agent-a1', reason: 'ok' })
      expect(begin).not.toHaveBeenCalled()
      expect(endRun).not.toHaveBeenCalled()
    } finally {
      begin.mockRestore()
      endRun.mockRestore()
    }
  })

  it('ES-2 桌面会话的一轮 → 不碰任何浏览器状态', () => {
    mocks.settings.set('desk-es2', { enabledTools: [] })
    const begin = vi.spyOn(ChromeBrowserState.prototype, 'beginRun')
    const endRun = vi.spyOn(ChromeBrowserState.prototype, 'endRun')
    try {
      electronEventSink.broadcast({ type: 'agent_start', sessionId: 'desk-es2' })
      electronEventSink.broadcast({ type: 'agent_end', sessionId: 'desk-es2', reason: 'ok' })
      expect(mocks.pickSettings).toHaveBeenCalledWith('desk-es2', ['chromeTab'])
      expect(begin).not.toHaveBeenCalled()
      expect(endRun).not.toHaveBeenCalled()
      expect(mocks.frontendBroadcast).toHaveBeenCalledTimes(2)
    } finally {
      begin.mockRestore()
      endRun.mockRestore()
    }
  })

  it('ES-2 生命周期之外的事件不查库（这条旁路每条事件都会走一遍）', () => {
    mocks.settings.set('tab-es2b', { chromeTab: { installId: 'i-es2b', runId: 'r1', tabId: 5 } })
    for (let i = 0; i < 20; i++) {
      electronEventSink.broadcast({ type: 'ask_count', sessionId: 'tab-es2b', count: i })
    }
    expect(mocks.pickSettings).not.toHaveBeenCalled()
    expect(existingChromeBrowserState('i-es2b')).toBeUndefined()
  })
})

describe('P3-08-47 三个出口各自隔离', () => {
  it('P3-08-47 通知出口抛错 → 前端注册表与 Chrome 租约照样收到同一个事件', () => {
    mocks.notify.mockImplementation(() => {
      throw new Error('notification boom')
    })
    mocks.settings.set('tab-47', { chromeTab: { installId: 'i-47', runId: 'r1', tabId: 5 } })
    const state = chromeBrowserState('i-47')
    const endRun = vi.spyOn(state, 'endRun')
    const event: ChatEvent = { type: 'agent_end', sessionId: 'tab-47', reason: 'error' }
    expect(() => electronEventSink.broadcast(event)).not.toThrow()
    expect(mocks.frontendBroadcast.mock.calls).toEqual([[event]])
    expect(vi.mocked(observeChromeTabRun).mock.calls).toEqual([[event]])
    expect(endRun.mock.calls).toEqual([['tab-47']])
  })

  it('P3-08-47 前端注册表抛错 → 通知与租约照样收到', () => {
    mocks.frontendBroadcast.mockImplementation(() => {
      throw new Error('registry boom')
    })
    const event: ChatEvent = { type: 'agent_start', sessionId: 'desk-47' }
    expect(() => electronEventSink.broadcast(event)).not.toThrow()
    expect(mocks.notify.mock.calls).toEqual([[event]])
    expect(vi.mocked(observeChromeTabRun).mock.calls).toEqual([[event]])
  })
})

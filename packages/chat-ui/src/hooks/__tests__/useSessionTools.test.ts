/**
 * useSessionTools 的 store 半边 —— 输入框工具选择器与会话设置扩展能力卡共用的那份数据：
 *
 *   - `applySessionToolState`：`agent.init` 的结果进 store（此刻有没有运行时 + 勾选原值），
 *     勾选写回会话设置，**只动 enabledTools 一个键**；
 *   - `setAgentCreated`：只读态的开关（`agent_created` / `agent_closing` 事件驱动），状态没变
 *     不换引用、关掉时删键；
 *   - `refreshSessionTools`：回拉一次 `agent.init`（写入被拒之后靠它回到真实状态），失败的回拉
 *     不改 store。
 *
 * 不建 hook 测试设施（无 jsdom / renderHook）：hook 本身只是这几样的组合，交互由 e2e 在真实 UI 里钉。
 * `useSessionTools.ts` 自引用包入口（getHostApi / getSessionChannelApi），而入口会带上模块加载期就读
 * `window.location` 的 useSessionInit —— node 环境下必须把包入口整个顶掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  init: vi.fn()
}))

vi.mock('@shuvix/chat-ui', () => ({
  getHostApi: () => null,
  getSessionChannelApi: () => ({ agent: { init: mocks.init } })
}))

import { useChatStore, type Session, type SessionSettings } from '../../stores/chatStore'
import { applySessionToolState, refreshSessionTools } from '../useSessionTools'

const SID = 's1'

const seedSession = (): Session => ({
  id: SID,
  title: 'S1',
  projectId: null,
  parentId: null,
  settings: { autoAllow: true, enabledTools: ['skill:old'] },
  createdAt: 0,
  updatedAt: 0,
  lastActiveAt: 0
})

const settingsOf = (id: string): SessionSettings | undefined =>
  useChatStore.getState().sessions.find((s) => s.id === id)?.settings

beforeEach(() => {
  mocks.init.mockReset()
  useChatStore.setState({ sessions: [seedSession()], sessionAgentCreated: {} })
})

describe('useSessionTools 的 store 读写', () => {
  it('EXT-U-19 applySessionToolState：写入「有运行时」与勾选原值，会话的其它设置不被冲掉', () => {
    applySessionToolState(SID, { created: true, enabledTools: ['mcp:a'] })
    // 整份替换的是 enabledTools 这一个键：autoAllow 被冲掉的话，打开一条会话就会悄悄恢复询问
    expect(settingsOf(SID)).toEqual({ autoAllow: true, enabledTools: ['mcp:a'] })
    expect(useChatStore.getState().sessionAgentCreated[SID]).toBe(true)
  })

  it('EXT-U-19 setAgentCreated：重复置真不换引用，置假删掉该键', () => {
    const { setAgentCreated } = useChatStore.getState()
    setAgentCreated(SID, true)
    const before = useChatStore.getState().sessionAgentCreated
    // 事件会重复到达（init 打底 + agent_created）：不变就不换引用，订阅者不白白重渲染
    setAgentCreated(SID, true)
    expect(useChatStore.getState().sessionAgentCreated).toBe(before)

    setAgentCreated(SID, false)
    expect(SID in useChatStore.getState().sessionAgentCreated).toBe(false)
  })

  it('EXT-U-19 refreshSessionTools：init 失败时 store 原样不动，成功才写入', async () => {
    const sessionsBefore = useChatStore.getState().sessions
    const createdBefore = useChatStore.getState().sessionAgentCreated
    mocks.init.mockResolvedValueOnce({ success: false, created: true, enabledTools: ['mcp:bad'] })
    await refreshSessionTools(SID)
    expect(mocks.init).toHaveBeenCalledWith({ sessionId: SID })
    expect(useChatStore.getState().sessions).toBe(sessionsBefore)
    expect(useChatStore.getState().sessionAgentCreated).toBe(createdBefore)
    expect(settingsOf(SID)).toEqual({ autoAllow: true, enabledTools: ['skill:old'] })

    mocks.init.mockResolvedValueOnce({ success: true, created: true, enabledTools: ['mcp:ok'] })
    await refreshSessionTools(SID)
    expect(settingsOf(SID)).toEqual({ autoAllow: true, enabledTools: ['mcp:ok'] })
    expect(useChatStore.getState().sessionAgentCreated[SID]).toBe(true)
  })
})

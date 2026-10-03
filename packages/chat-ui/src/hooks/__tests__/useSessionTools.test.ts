/**
 * useSessionTools 的 store 半边 —— 输入框工具选择器与会话设置扩展能力卡共用的那份数据：
 *
 *   - `applySessionToolState`：`agent.init` 的结果进 store（此刻有没有运行时 + 勾选原值），
 *     勾选写回会话设置，**只动 enabledTools 一个键**；
 *   - `setAgentCreated`：只读态的开关（`agent_created` / `agent_closing` 事件驱动），状态没变
 *     不换引用、关掉时删键；
 *   - `refreshSessionTools`：回拉一次 `agent.init`（写入被拒之后靠它回到真实状态），失败的回拉
 *     不改 store；
 *   - `writeSessionTools` / `addSessionTools`（WS-U）：整份替换 / 补缺项的写入口。`null` 是欢迎页的
 *     草稿（`welcomeEnabledTools`，只改 store、不走 IPC）；会话则先乐观写 store 再落库，只读态
 *     （有运行时 / 关停中）与渠道端（无 HostApi）什么也不做，被拒就回拉真实状态。
 *
 * 不建 hook 测试设施（无 jsdom / renderHook）：hook 本身只是这几样的组合，交互由 e2e 在真实 UI 里钉。
 * `useSessionTools.ts` 自引用包入口（getHostApi / getSessionChannelApi），而入口会带上模块加载期就读
 * `window.location` 的 useSessionInit —— node 环境下必须把包入口整个顶掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  updateEnabledTools:
    vi.fn<(params: { id: string; enabledTools: string[] }) => Promise<{ success: boolean }>>(),
  /** 有没有宿主（渠道端 = 没有 HostApi） */
  hasHost: false
}))

vi.mock('@shuvix/chat-ui', () => ({
  getHostApi: () =>
    mocks.hasHost ? { session: { updateEnabledTools: mocks.updateEnabledTools } } : null,
  getSessionChannelApi: () => ({ agent: { init: mocks.init } })
}))

import { useChatStore, type Session, type SessionSettings } from '../../stores/chatStore'
import {
  addSessionTools,
  applySessionToolState,
  refreshSessionTools,
  writeSessionTools
} from '../useSessionTools'

const SID = 's1'

const seedSession = (): Session => ({
  id: SID,
  title: 'S1',
  projectId: null,
  parentId: null,
  settings: { allowList: ['Read(/a)'], enabledTools: ['skill:old'] },
  createdAt: 0,
  updatedAt: 0,
  lastActiveAt: 0
})

const settingsOf = (id: string): SessionSettings | undefined =>
  useChatStore.getState().sessions.find((s) => s.id === id)?.settings

beforeEach(() => {
  mocks.init.mockReset()
  mocks.updateEnabledTools.mockReset().mockResolvedValue({ success: true })
  mocks.hasHost = false
  useChatStore.setState({
    sessions: [seedSession()],
    sessionAgentCreated: {},
    sessionClosing: {},
    welcomeEnabledTools: []
  })
})

describe('useSessionTools 的 store 读写', () => {
  it('EXT-U-19 applySessionToolState：写入「有运行时」与勾选原值，会话的其它设置不被冲掉', () => {
    applySessionToolState(SID, { created: true, enabledTools: ['mcp:a'] })
    // 整份替换的是 enabledTools 这一个键：allowList 被冲掉的话，打开一条会话就会悄悄丢掉「允许并记住」的路径
    expect(settingsOf(SID)).toEqual({ allowList: ['Read(/a)'], enabledTools: ['mcp:a'] })
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
    expect(settingsOf(SID)).toEqual({ allowList: ['Read(/a)'], enabledTools: ['skill:old'] })

    mocks.init.mockResolvedValueOnce({ success: true, created: true, enabledTools: ['mcp:ok'] })
    await refreshSessionTools(SID)
    expect(settingsOf(SID)).toEqual({ allowList: ['Read(/a)'], enabledTools: ['mcp:ok'] })
    expect(useChatStore.getState().sessionAgentCreated[SID]).toBe(true)
  })
})

describe('WS-U 欢迎页草稿与补缺项的写入口', () => {
  const welcome = (): string[] => useChatStore.getState().welcomeEnabledTools

  it('WS-U-1 writeSessionTools(null, next) 有宿主 → 草稿整份换成 next；零 IPC；会话不动', async () => {
    mocks.hasHost = true
    const sessionsBefore = useChatStore.getState().sessions
    await writeSessionTools(null, ['skill:a', 'mcp:b'])
    expect(welcome()).toEqual(['skill:a', 'mcp:b'])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
    expect(mocks.init).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions).toBe(sessionsBefore)

    // 整份替换：空数组就是清空
    await writeSessionTools(null, [])
    expect(welcome()).toEqual([])
  })

  it('WS-U-2 没有宿主（渠道端）→ 草稿与会话都不变', async () => {
    useChatStore.setState({ welcomeEnabledTools: ['skill:keep'] })
    const before = useChatStore.getState()
    await writeSessionTools(null, ['skill:a'])
    await writeSessionTools(SID, ['skill:a'])
    expect(welcome()).toBe(before.welcomeEnabledTools)
    expect(useChatStore.getState().sessions).toBe(before.sessions)
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
  })

  it('WS-U-3 addSessionTools(null, names)：只补缺项、原有的在前保序；零 IPC', async () => {
    mocks.hasHost = true
    useChatStore.setState({ welcomeEnabledTools: ['skill:a', 'mcp:x'] })
    await addSessionTools(null, ['mcp:x', 'skill:new', 'skill:a', 'mcp:y'])
    // 已有的不再追加第二份（去重），缺的按 names 的顺序接在后面
    expect(welcome()).toEqual(['skill:a', 'mcp:x', 'skill:new', 'mcp:y'])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
  })

  it('WS-U-3 addSessionTools(null, names) 全都有了 → 不写（草稿引用不变）', async () => {
    mocks.hasHost = true
    useChatStore.setState({ welcomeEnabledTools: ['skill:a', 'mcp:x'] })
    const before = welcome()
    await addSessionTools(null, ['mcp:x', 'skill:a'])
    expect(welcome()).toBe(before)
    await addSessionTools(null, [])
    expect(welcome()).toBe(before)
  })

  it('WS-U-4 addSessionTools(sid, names)：读 store 里该会话此刻的勾选、乐观写 store、恰一次 updateEnabledTools', async () => {
    mocks.hasHost = true
    let finish!: (v: { success: boolean }) => void
    mocks.updateEnabledTools.mockReturnValue(new Promise((r) => (finish = r)))

    // 渲染时的勾选是 skill:old；调用前一刻 store 已变成 skill:old + mcp:now —— 读的是此刻那份
    useChatStore.getState().updateSessionSettings(SID, { enabledTools: ['skill:old', 'mcp:now'] })
    const pending = addSessionTools(SID, ['skill:req', 'mcp:now'])

    // 落库还没回：store 已经是新值（乐观），其它设置键不被冲掉
    expect(settingsOf(SID)).toEqual({
      allowList: ['Read(/a)'],
      enabledTools: ['skill:old', 'mcp:now', 'skill:req']
    })
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: SID,
      enabledTools: ['skill:old', 'mcp:now', 'skill:req']
    })
    finish({ success: true })
    await pending
    expect(mocks.init).not.toHaveBeenCalled()
    // 会话路径不碰欢迎页草稿
    expect(welcome()).toEqual([])
  })

  it('WS-U-4 addSessionTools(sid, names) 全都有了 → 零 IPC、store 引用不变', async () => {
    mocks.hasHost = true
    const before = useChatStore.getState().sessions
    await addSessionTools(SID, ['skill:old'])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions).toBe(before)
  })

  it.each<[string, Record<string, unknown>]>([
    ['sessionAgentCreated[sid]', { sessionAgentCreated: { [SID]: true } }],
    ['sessionClosing[sid]', { sessionClosing: { [SID]: true } }]
  ])('WS-U-5 %s 为真 → 零 IPC、store 不变（write 与 add 都是）', async (_label, patch) => {
    mocks.hasHost = true
    useChatStore.setState(patch)
    const before = useChatStore.getState().sessions
    await writeSessionTools(SID, ['skill:x'])
    await addSessionTools(SID, ['skill:x'])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions).toBe(before)
    expect(settingsOf(SID)?.enabledTools).toEqual(['skill:old'])
  })

  it('WS-U-5 别的会话只读不影响这一条：照常写入', async () => {
    mocks.hasHost = true
    useChatStore.setState({
      sessionAgentCreated: { other: true },
      sessionClosing: { other2: true }
    })
    await addSessionTools(SID, ['skill:x'])
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
  })

  it('WS-U-6 被拒（success:false）→ 回拉 init：勾选回落 init 那份，created 置真', async () => {
    mocks.hasHost = true
    mocks.updateEnabledTools.mockResolvedValue({ success: false })
    mocks.init.mockResolvedValue({ success: true, created: true, enabledTools: ['mcp:real'] })

    await addSessionTools(SID, ['skill:x'])
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: SID,
      enabledTools: ['skill:old', 'skill:x']
    })
    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect(mocks.init).toHaveBeenCalledWith({ sessionId: SID })
    expect(settingsOf(SID)).toEqual({ allowList: ['Read(/a)'], enabledTools: ['mcp:real'] })
    expect(useChatStore.getState().sessionAgentCreated[SID]).toBe(true)
  })

  it('WS-U-7 会话不在 store 里 → 此刻的勾选按 [] 算，缺项全数写入', async () => {
    mocks.hasHost = true
    await addSessionTools('ghost', ['skill:a', 'mcp:b'])
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: 'ghost',
      enabledTools: ['skill:a', 'mcp:b']
    })
    // store 里也不凭空长出这条会话
    expect(useChatStore.getState().sessions.map((x) => x.id)).toEqual([SID])
  })

  it('WS-U-8 welcomeEnabledTools 初始为 []；setWelcomeEnabledTools 整份替换', () => {
    expect(useChatStore.getInitialState().welcomeEnabledTools).toEqual([])
    const { setWelcomeEnabledTools } = useChatStore.getState()
    setWelcomeEnabledTools(['skill:a', 'mcp:b'])
    expect(welcome()).toEqual(['skill:a', 'mcp:b'])
    setWelcomeEnabledTools(['mcp:c'])
    expect(welcome()).toEqual(['mcp:c'])
    setWelcomeEnabledTools([])
    expect(welcome()).toEqual([])
  })
})

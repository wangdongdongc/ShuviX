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
 *     草稿（`welcomeEnabledTools`，只改 store、不走 IPC）；会话则先乐观写 store 再落库，渠道端（无
 *     HostApi）什么也不做，被拒 / IPC 抛错就回拉真实状态。`addSessionTools` 把被取消的档案声明项也算缺
 *     （撤掉 `-<name>` 记号），比的是**列表**而不是生效状态（WS-U-9）。
 *   - 有 agent 时也能改（2026-10-26，RU-10..12）：`sessionAgentCreated[sid]` 为真 → 先过
 *     `confirmAgentChange`（预判会不会打穿提示词缓存，保不住就问用户），答应了才乐观写 store、再落库；
 *     不答应什么都不写。没有 agent → 不预判、不等任何东西，store 与 IPC 当场同步发出（欢迎页直接发送时
 *     斜杠命令的依赖项要赶在 prompt 之前到主进程）。关停中（`sessionClosing`）不再挡写入。
 *
 * 不建 hook 测试设施（无 jsdom / renderHook）：hook 本身只是这几样的组合，交互由 e2e 在真实 UI 里钉。
 * `useSessionTools.ts` 自引用包入口（getHostApi / getSessionChannelApi），而入口会带上模块加载期就读
 * `window.location` 的 useSessionInit —— node 环境下必须把包入口整个顶掉。确认那一道
 * （`components/chat/CacheBreakConfirm` 的 `confirmAgentChange`）也顶掉：它的弹框与预判各有
 * cacheBreakConfirm.dom.test.tsx 钉着，这里只看写入口怎么用它的答复。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  updateEnabledTools:
    vi.fn<(params: { id: string; enabledTools: string[] }) => Promise<{ success: boolean }>>(),
  /** 改锁住的 agent 之前那一道（预判 + 问用户）：缺省答应 */
  confirm: vi.fn<(sessionId: string, change: { enabledTools?: string[] }) => Promise<boolean>>(),
  /** 有没有宿主（渠道端 = 没有 HostApi） */
  hasHost: false
}))

vi.mock('@shuvix/chat-ui', () => ({
  getHostApi: () =>
    mocks.hasHost ? { session: { updateEnabledTools: mocks.updateEnabledTools } } : null,
  getSessionChannelApi: () => ({ agent: { init: mocks.init } })
}))

vi.mock('../../components/chat/CacheBreakConfirm', () => ({
  confirmAgentChange: mocks.confirm
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
  settings: { agentProfile: 'coding', enabledTools: ['mcp:old'] },
  createdAt: 0,
  updatedAt: 0,
  lastActiveAt: 0
})

const settingsOf = (id: string): SessionSettings | undefined =>
  useChatStore.getState().sessions.find((s) => s.id === id)?.settings

beforeEach(() => {
  mocks.init.mockReset()
  mocks.updateEnabledTools.mockReset().mockResolvedValue({ success: true })
  mocks.confirm.mockReset().mockResolvedValue(true)
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
    // 整份替换的是 enabledTools 这一个键：别的键（这里是子会话钉着的档案）被冲掉的话，打开一条会话就会悄悄丢掉它
    expect(settingsOf(SID)).toEqual({ agentProfile: 'coding', enabledTools: ['mcp:a'] })
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
    expect(settingsOf(SID)).toEqual({ agentProfile: 'coding', enabledTools: ['mcp:old'] })

    mocks.init.mockResolvedValueOnce({ success: true, created: true, enabledTools: ['mcp:ok'] })
    await refreshSessionTools(SID)
    expect(settingsOf(SID)).toEqual({ agentProfile: 'coding', enabledTools: ['mcp:ok'] })
    expect(useChatStore.getState().sessionAgentCreated[SID]).toBe(true)
  })
})

describe('WS-U 欢迎页草稿与补缺项的写入口', () => {
  const welcome = (): string[] => useChatStore.getState().welcomeEnabledTools

  it('WS-U-1 writeSessionTools(null, next) 有宿主 → 草稿整份换成 next；零 IPC；会话不动', async () => {
    mocks.hasHost = true
    const sessionsBefore = useChatStore.getState().sessions
    await writeSessionTools(null, ['mcp:a', 'mcp:b'])
    expect(welcome()).toEqual(['mcp:a', 'mcp:b'])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
    expect(mocks.init).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions).toBe(sessionsBefore)

    // 整份替换：空数组就是清空
    await writeSessionTools(null, [])
    expect(welcome()).toEqual([])
  })

  it('WS-U-2 没有宿主（渠道端）→ 草稿与会话都不变', async () => {
    useChatStore.setState({ welcomeEnabledTools: ['mcp:keep'] })
    const before = useChatStore.getState()
    await writeSessionTools(null, ['mcp:a'])
    await writeSessionTools(SID, ['mcp:a'])
    expect(welcome()).toBe(before.welcomeEnabledTools)
    expect(useChatStore.getState().sessions).toBe(before.sessions)
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
  })

  it('WS-U-3 addSessionTools(null, names)：只补缺项、原有的在前保序；零 IPC', async () => {
    mocks.hasHost = true
    useChatStore.setState({ welcomeEnabledTools: ['mcp:a', 'mcp:x'] })
    await addSessionTools(null, ['mcp:x', 'mcp:new', 'mcp:a', 'mcp:y'])
    // 已有的不再追加第二份（去重），缺的按 names 的顺序接在后面
    expect(welcome()).toEqual(['mcp:a', 'mcp:x', 'mcp:new', 'mcp:y'])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
  })

  it('WS-U-3 addSessionTools(null, names) 全都有了 → 不写（草稿引用不变）', async () => {
    mocks.hasHost = true
    useChatStore.setState({ welcomeEnabledTools: ['mcp:a', 'mcp:x'] })
    const before = welcome()
    await addSessionTools(null, ['mcp:x', 'mcp:a'])
    expect(welcome()).toBe(before)
    await addSessionTools(null, [])
    expect(welcome()).toBe(before)
  })

  it('WS-U-4 addSessionTools(sid, names) 没有 agent：读 store 里该会话此刻的勾选、当场乐观写 store、恰一次 updateEnabledTools，不预判', async () => {
    mocks.hasHost = true
    let finish!: (v: { success: boolean }) => void
    mocks.updateEnabledTools.mockReturnValue(new Promise((r) => (finish = r)))

    // 渲染时的勾选是 mcp:old；调用前一刻 store 已变成 mcp:old + mcp:now —— 读的是此刻那份
    useChatStore.getState().updateSessionSettings(SID, { enabledTools: ['mcp:old', 'mcp:now'] })
    const pending = addSessionTools(SID, ['mcp:req', 'mcp:now'])

    // 同步就发生了（中间没有任何 await）：store 已经是新值（乐观），其它设置键不被冲掉；IPC 已发出
    expect(settingsOf(SID)).toEqual({
      agentProfile: 'coding',
      enabledTools: ['mcp:old', 'mcp:now', 'mcp:req']
    })
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: SID,
      enabledTools: ['mcp:old', 'mcp:now', 'mcp:req']
    })
    expect(mocks.confirm).not.toHaveBeenCalled()
    finish({ success: true })
    await pending
    expect(mocks.init).not.toHaveBeenCalled()
    // 会话路径不碰欢迎页草稿
    expect(welcome()).toEqual([])
  })

  it('WS-U-4 addSessionTools(sid, names) 有 agent：先预判，答应之后才乐观写 store；store 在 IPC 落定之前就是新值', async () => {
    mocks.hasHost = true
    useChatStore.setState({ sessionAgentCreated: { [SID]: true } })
    let answer!: (v: boolean) => void
    mocks.confirm.mockReturnValue(new Promise((r) => (answer = r)))
    let finish!: (v: { success: boolean }) => void
    mocks.updateEnabledTools.mockReturnValue(new Promise((r) => (finish = r)))

    const pending = addSessionTools(SID, ['mcp:req'])
    // 预判还没答：store 不动、不落库
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(SID, {
      enabledTools: ['mcp:old', 'mcp:req']
    })
    expect(settingsOf(SID)?.enabledTools).toEqual(['mcp:old'])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()

    answer(true)
    await vi.waitFor(() => expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1))
    // 落库还没回：store 已经是新值（乐观）
    expect(settingsOf(SID)).toEqual({
      agentProfile: 'coding',
      enabledTools: ['mcp:old', 'mcp:req']
    })
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: SID,
      enabledTools: ['mcp:old', 'mcp:req']
    })
    finish({ success: true })
    await pending
    expect(mocks.init).not.toHaveBeenCalled()
  })

  it('WS-U-4 addSessionTools(sid, names) 全都有了 → 零 IPC、store 引用不变', async () => {
    mocks.hasHost = true
    const before = useChatStore.getState().sessions
    await addSessionTools(SID, ['mcp:old'])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions).toBe(before)
  })

  it('WS-U-5 sessionAgentCreated[sid] 为真 → 先预判、答应后恰一次 IPC、store 写成新值（write 与 add 都是）', async () => {
    mocks.hasHost = true
    useChatStore.setState({ sessionAgentCreated: { [SID]: true } })
    await writeSessionTools(SID, ['mcp:x'])
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(SID, { enabledTools: ['mcp:x'] })
    expect(mocks.updateEnabledTools).toHaveBeenCalledExactlyOnceWith({
      id: SID,
      enabledTools: ['mcp:x']
    })
    expect(settingsOf(SID)?.enabledTools).toEqual(['mcp:x'])

    await addSessionTools(SID, ['mcp:y'])
    expect(mocks.confirm).toHaveBeenCalledTimes(2)
    expect(mocks.confirm).toHaveBeenLastCalledWith(SID, { enabledTools: ['mcp:x', 'mcp:y'] })
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(2)
    expect(settingsOf(SID)?.enabledTools).toEqual(['mcp:x', 'mcp:y'])
    // 预判在前、落库在后
    expect(mocks.confirm.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.updateEnabledTools.mock.invocationCallOrder[1]
    )
  })

  it('WS-U-5 只有 sessionClosing[sid] 为真（关停中）→ 不挡写入：不预判、恰一次 IPC、store 写成新值', async () => {
    mocks.hasHost = true
    useChatStore.setState({ sessionClosing: { [SID]: true } })
    await writeSessionTools(SID, ['mcp:x'])
    await addSessionTools(SID, ['mcp:y'])
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.updateEnabledTools.mock.calls).toEqual([
      [{ id: SID, enabledTools: ['mcp:x'] }],
      [{ id: SID, enabledTools: ['mcp:x', 'mcp:y'] }]
    ])
    expect(settingsOf(SID)?.enabledTools).toEqual(['mcp:x', 'mcp:y'])
  })

  it('WS-U-5 别的会话只读不影响这一条：照常写入', async () => {
    mocks.hasHost = true
    useChatStore.setState({
      sessionAgentCreated: { other: true },
      sessionClosing: { other2: true }
    })
    await addSessionTools(SID, ['mcp:x'])
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
  })

  it('WS-U-6 被拒（success:false）→ 回拉 init：勾选回落 init 那份，created 置真', async () => {
    mocks.hasHost = true
    mocks.updateEnabledTools.mockResolvedValue({ success: false })
    mocks.init.mockResolvedValue({ success: true, created: true, enabledTools: ['mcp:real'] })

    await addSessionTools(SID, ['mcp:x'])
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: SID,
      enabledTools: ['mcp:old', 'mcp:x']
    })
    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect(mocks.init).toHaveBeenCalledWith({ sessionId: SID })
    expect(settingsOf(SID)).toEqual({ agentProfile: 'coding', enabledTools: ['mcp:real'] })
    expect(useChatStore.getState().sessionAgentCreated[SID]).toBe(true)
  })

  it('WS-U-7 会话不在 store 里 → 此刻的勾选按 [] 算，缺项全数写入', async () => {
    mocks.hasHost = true
    await addSessionTools('ghost', ['mcp:a', 'mcp:b'])
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: 'ghost',
      enabledTools: ['mcp:a', 'mcp:b']
    })
    // store 里也不凭空长出这条会话
    expect(useChatStore.getState().sessions.map((x) => x.id)).toEqual([SID])
  })

  it('WS-U-9 addSessionTools(sid) 撤掉被点名项的取消记号、补上名字、别的取消记号不动；列表没变 → 零 IPC', async () => {
    mocks.hasHost = true
    useChatStore
      .getState()
      .updateSessionSettings(SID, { enabledTools: ['-mcp:browser', 'mcp:a', '-mcp:z'] })

    await addSessionTools(SID, ['mcp:browser'])
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: SID,
      enabledTools: ['mcp:a', '-mcp:z', 'mcp:browser']
    })
    expect(settingsOf(SID)?.enabledTools).toEqual(['mcp:a', '-mcp:z', 'mcp:browser'])

    // 已经勾着：列表不变 → 不写
    const before = useChatStore.getState().sessions
    await addSessionTools(SID, ['mcp:browser'])
    await addSessionTools(SID, ['mcp:a'])
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().sessions).toBe(before)
  })

  it('WS-U-9 比的是列表而不是生效状态：声明项缺省开着、勾选里没有它的名字 → 照样补上名字（写一次）', async () => {
    mocks.hasHost = true
    useChatStore.getState().updateSessionSettings(SID, { enabledTools: [] })
    await addSessionTools(SID, ['mcp:browser'])
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: SID,
      enabledTools: ['mcp:browser']
    })
  })

  it('WS-U-9 addSessionTools(null) 欢迎页草稿同理：撤掉取消记号、补名字；零 IPC；已勾着 → 草稿引用不变', async () => {
    mocks.hasHost = true
    useChatStore.setState({ welcomeEnabledTools: ['-mcp:browser', 'mcp:a', '-mcp:z'] })
    await addSessionTools(null, ['mcp:browser'])
    expect(welcome()).toEqual(['mcp:a', '-mcp:z', 'mcp:browser'])

    const before = welcome()
    await addSessionTools(null, ['mcp:browser'])
    expect(welcome()).toBe(before)
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
  })

  it('WS-U-9 有运行时也撤：先预判，答应后撤掉取消记号、补上名字并落库', async () => {
    mocks.hasHost = true
    useChatStore.getState().updateSessionSettings(SID, { enabledTools: ['-mcp:browser', 'mcp:a'] })
    useChatStore.setState({ sessionAgentCreated: { [SID]: true } })
    await addSessionTools(SID, ['mcp:browser'])
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(SID, {
      enabledTools: ['mcp:a', 'mcp:browser']
    })
    expect(mocks.updateEnabledTools).toHaveBeenCalledExactlyOnceWith({
      id: SID,
      enabledTools: ['mcp:a', 'mcp:browser']
    })
    expect(settingsOf(SID)?.enabledTools).toEqual(['mcp:a', 'mcp:browser'])
  })

  it('WS-U-8 welcomeEnabledTools 初始为 []；setWelcomeEnabledTools 整份替换', () => {
    expect(useChatStore.getInitialState().welcomeEnabledTools).toEqual([])
    const { setWelcomeEnabledTools } = useChatStore.getState()
    setWelcomeEnabledTools(['mcp:a', 'mcp:b'])
    expect(welcome()).toEqual(['mcp:a', 'mcp:b'])
    setWelcomeEnabledTools(['mcp:c'])
    expect(welcome()).toEqual(['mcp:c'])
    setWelcomeEnabledTools([])
    expect(welcome()).toEqual([])
  })
})

describe('RU 有 agent 时的写入：先过缓存确认', () => {
  it('RU-10 有 agent：预判在 store 更新之前，store 更新在 IPC 之前；没有 agent：不预判，store 与 IPC 同步发出', async () => {
    mocks.hasHost = true
    const order: string[] = []
    mocks.confirm.mockImplementation(async () => {
      order.push(`confirm:${settingsOf(SID)?.enabledTools?.join(',')}`)
      return true
    })
    mocks.updateEnabledTools.mockImplementation(async () => {
      order.push(`ipc:${settingsOf(SID)?.enabledTools?.join(',')}`)
      return { success: true }
    })

    useChatStore.setState({ sessionAgentCreated: { [SID]: true } })
    await writeSessionTools(SID, ['mcp:a'])
    // 预判那一刻 store 还是旧值；IPC 那一刻已经是新值
    expect(order).toEqual(['confirm:mcp:old', 'ipc:mcp:a'])

    order.length = 0
    useChatStore.setState({ sessionAgentCreated: {} })
    const pending = writeSessionTools(SID, ['mcp:b'])
    // 没有 agent：调用一返回（还没有任何 await 落定）store 与 IPC 就都到了
    expect(order).toEqual(['ipc:mcp:b'])
    expect(settingsOf(SID)?.enabledTools).toEqual(['mcp:b'])
    await pending
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
  })

  it('RU-11 有 agent、缓存保不住、用户取消 → 零 IPC、store 不变、不回拉', async () => {
    mocks.hasHost = true
    useChatStore.setState({ sessionAgentCreated: { [SID]: true } })
    mocks.confirm.mockResolvedValue(false)
    const before = useChatStore.getState().sessions
    await writeSessionTools(SID, ['mcp:x'])
    await addSessionTools(SID, ['mcp:y'])
    expect(mocks.confirm).toHaveBeenCalledTimes(2)
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
    expect(mocks.init).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions).toBe(before)
    expect(settingsOf(SID)?.enabledTools).toEqual(['mcp:old'])
  })

  it('RU-12 欢迎页（null）→ 不预判、只改草稿；没有宿主 → 什么都不做（也不预判）', async () => {
    mocks.hasHost = true
    useChatStore.setState({ sessionAgentCreated: { [SID]: true } })
    await writeSessionTools(null, ['mcp:a'])
    await addSessionTools(null, ['mcp:b'])
    expect(useChatStore.getState().welcomeEnabledTools).toEqual(['mcp:a', 'mcp:b'])
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()

    mocks.hasHost = false
    await writeSessionTools(SID, ['mcp:x'])
    await writeSessionTools(null, ['mcp:x'])
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
    expect(settingsOf(SID)?.enabledTools).toEqual(['mcp:old'])
    expect(useChatStore.getState().welcomeEnabledTools).toEqual(['mcp:a', 'mcp:b'])
  })

  it('RU-12 IPC 抛错 → 不冒成未处理的 rejection，回拉 init 回到真实状态', async () => {
    mocks.hasHost = true
    mocks.updateEnabledTools.mockRejectedValue(new Error('ipc down'))
    mocks.init.mockResolvedValue({ success: true, created: false, enabledTools: ['mcp:real'] })
    await expect(writeSessionTools(SID, ['mcp:x'])).resolves.toBeUndefined()
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.init).toHaveBeenCalledExactlyOnceWith({ sessionId: SID })
    expect(settingsOf(SID)).toEqual({ agentProfile: 'coding', enabledTools: ['mcp:real'] })
  })
})

/**
 * 子会话运行器 —— 「agent 自己开会话、替用户发消息」的全部业务规则都在这里
 * （工具层只是翻译层，见 tools/__tests__/session.test.ts）。
 *
 * 钉的是五条会被日后「优化」掉的性质：
 *   - **准入**：只有普通会话能开子会话，且只能驱动**自己的**子会话 —— 越权在这一层落空，
 *     错误文案顺带给出合法 id（纠正性引导，模型才有下一步可走）；
 *   - **发送必须走 chatGateway.prompt**：那是 IPC `agent:prompt` 的同一个函数。绕过它，
 *     「子会话表现与普通会话一致」就从第一天起带例外；
 *   - **超时不杀**：到点降级成后台，子会话继续跑（与 bash 的有意分歧 —— 这里杀的是一段
 *     用户看得见、可能已经改了半个仓库的对话）；
 *   - **后台回执不带内容**：内容会永久留在父会话上下文里并被每一步重发（bash 同款纪律）；
 *   - **忙就拒绝、不排队**：一个忙着的子会话是父级该知道并作决策的状态。
 *
 * mock 手法照 sessionServiceNotebookProfile.test.ts：vi.mock + 动态 import；
 * dao / sessionService / gateway / messageService 全部换假件。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pick: vi.fn<(id: string, cols: string[]) => unknown>(),
  pickSettings: vi.fn<(id: string, keys: string[]) => unknown>(),
  findChildren: vi.fn<(id: string) => Array<Record<string, unknown>>>(),
  create: vi.fn(),
  updateTitle: vi.fn(),
  updateAgentProfile: vi.fn(),
  resolveAgentProfileName: vi.fn(),
  resolveRunConfig: vi.fn(),
  getAgentSession: vi.fn(),
  gatewayPrompt: vi.fn(),
  appendModelChange: vi.fn(),
  appendThinkingLevelChange: vi.fn(),
  appendActiveToolsChange: vi.fn(),
  findLastBySession: vi.fn()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.pick,
    pickSettings: mocks.pickSettings,
    findChildren: mocks.findChildren
  }
}))
vi.mock('../../services/sessionService', () => ({
  sessionService: {
    create: mocks.create,
    updateTitle: mocks.updateTitle,
    updateAgentProfile: mocks.updateAgentProfile,
    resolveAgentProfileName: mocks.resolveAgentProfileName,
    resolveRunConfig: mocks.resolveRunConfig,
    getAgentSession: mocks.getAgentSession
  }
}))
vi.mock('../../frontend/core', () => ({ chatGateway: { prompt: mocks.gatewayPrompt } }))
vi.mock('../../services/messageService', () => ({
  messageService: { findLastBySession: mocks.findLastBySession }
}))
vi.mock('../../services/sessionStorage', () => ({
  appendModelChange: mocks.appendModelChange,
  appendThinkingLevelChange: mocks.appendThinkingLevelChange,
  appendActiveToolsChange: mocks.appendActiveToolsChange
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

type Mod = typeof import('../subSessionRunner')
let mod: Mod
let runner: Mod['subSessionRunner']

const PARENT = 'parent-1'
const CHILD = 'child-1'

/** 一个假的子会话运行时（AgentSession 的最小面：状态两个 getter + abort/notify） */
function fakeAgent(over: Partial<{ isStreaming: boolean; pendingInputCount: number }> = {}): {
  isStreaming: boolean
  pendingInputCount: number
  pendingInputSummaries: string[]
  abort: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
} {
  return {
    isStreaming: over.isStreaming ?? false,
    pendingInputCount: over.pendingInputCount ?? 0,
    pendingInputSummaries: [],
    abort: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined)
  }
}

/** 缺省世界：父会话是普通会话、子会话是它的孩子、都没有活跃运行时 */
function defaultWorld(): void {
  mocks.pick.mockImplementation((id: string) => {
    if (id === PARENT) return { settings: {}, parentId: null, title: 'Parent', updatedAt: 1 }
    if (id === CHILD) return { settings: {}, parentId: PARENT, title: 'Child', updatedAt: 2 }
    return undefined
  })
  // sessionService.create 已按会话形态把默认档案落进 settings（父会话无项目 ⇒ 'chat'）
  mocks.pickSettings.mockReturnValue({ agentProfile: 'chat' })
  mocks.findChildren.mockReturnValue([])
  mocks.getAgentSession.mockReturnValue(undefined)
  // 发送成功 = 落定为 {}；带 error 才是「没发出去」
  mocks.gatewayPrompt.mockResolvedValue({})
  mocks.findLastBySession.mockResolvedValue(undefined)
  mocks.resolveRunConfig.mockResolvedValue({
    model: null,
    thinkingLevel: 'medium',
    enabledTools: []
  })
  mocks.resolveAgentProfileName.mockReturnValue('chat')
  mocks.updateAgentProfile.mockResolvedValue({ success: true, applied: { tools: [] } })
  mocks.create.mockReturnValue({ id: CHILD, title: 'Child' })
}

beforeAll(async () => {
  mod = await import('../subSessionRunner')
  runner = mod.subSessionRunner
})

beforeEach(() => {
  vi.useRealTimers()
  for (const fn of Object.values(mocks)) fn.mockReset()
  defaultWorld()
})

const err = (r: unknown): string => (r as { error: string }).error

describe('准入 —— 谁能开子会话', () => {
  it('聊天会话拒绝（它没有根 agent，开子会话不表达任何东西）', async () => {
    mocks.pick.mockReturnValue({ settings: { bot: 'a' }, parentId: null })
    expect(err(await runner.create(PARENT, {}))).toMatch(/Chat sessions/)
    expect(err(runner.list(PARENT))).toMatch(/Chat sessions/)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('笔记本会话拒绝（人格钉死在 notebook 基座，产物是那份笔记）', async () => {
    mocks.pick.mockReturnValue({ settings: { notebookPath: 'n.md' }, parentId: null })
    expect(err(await runner.create(PARENT, {}))).toMatch(/Notebook sessions/)
  })

  it('子会话自己不能再开子会话（嵌套只允许一层）', async () => {
    mocks.pick.mockReturnValue({ settings: {}, parentId: 'someone' })
    expect(err(await runner.create(CHILD, {}))).toMatch(/nesting is limited to one level/)
  })

  it('没有会话行（workflow 的无会话上下文 run）→ 说清这里没有可用的子会话能力', async () => {
    mocks.pick.mockReturnValue(undefined)
    expect(err(await runner.create('nowhere', {}))).toMatch(/not attached to a session/)
  })
})

describe('越权 —— 只能驱动自己的子会话', () => {
  it('别人的子会话 / 不存在的 id：拒绝，并列出自己合法的 id（模型才有下一步）', async () => {
    mocks.pick.mockImplementation((id: string) => {
      if (id === PARENT) return { settings: {}, parentId: null }
      if (id === 'stranger') return { settings: {}, parentId: 'other-parent' }
      return undefined
    })
    mocks.findChildren.mockReturnValue([{ id: 'mine-1', title: 'Mine' }])

    for (const target of ['stranger', 'ghost']) {
      const res = await runner.prompt({
        parentId: PARENT,
        childId: target,
        message: 'x',
        background: false,
        timeoutSeconds: 5
      })
      expect(err(res)).toContain('is not a sub-session of this session')
      expect(err(res)).toContain('mine-1')
    }
    expect(mocks.gatewayPrompt).not.toHaveBeenCalled()
  })
})

describe('create —— 继承与上限', () => {
  it('父级给了标题 ⇒ 记 origin=user（刻意命名，auto-title 的 refine 不该覆盖它）', async () => {
    await runner.create(PARENT, { title: '  重构 parser  ' })
    expect(mocks.create).toHaveBeenCalledWith({ parentId: PARENT, title: '重构 parser' })
    expect(mocks.updateTitle).toHaveBeenCalledWith(CHILD, '重构 parser', 'user')
  })

  it('父级不给标题 ⇒ 不写标题（留默认标题给 auto-title 接管）', async () => {
    await runner.create(PARENT, {})
    expect(mocks.create).toHaveBeenCalledWith({ parentId: PARENT })
    expect(mocks.updateTitle).not.toHaveBeenCalled()
  })

  it('模型种子取父会话当前模型 —— 不种就会回落全局默认（用 opus 干活、子会话掉默认）', async () => {
    mocks.resolveRunConfig.mockResolvedValue({
      model: { provider: 'p', model: 'opus', capabilities: {} },
      thinkingLevel: 'medium',
      enabledTools: []
    })
    await runner.create(PARENT, {})
    expect(mocks.appendModelChange).toHaveBeenCalledWith(CHILD, 'p', 'opus')
  })

  it('档案自己声明了模型 ⇒ 以档案为准，不再拿父会话的模型盖回去', async () => {
    mocks.resolveAgentProfileName.mockReturnValue('coding')
    mocks.updateAgentProfile.mockResolvedValue({
      success: true,
      applied: { model: { provider: 'p', model: 'declared', capabilities: {} }, tools: [] }
    })
    mocks.resolveRunConfig.mockResolvedValue({
      model: { provider: 'p', model: 'opus', capabilities: {} },
      thinkingLevel: 'medium',
      enabledTools: []
    })
    await runner.create(PARENT, {})
    expect(mocks.updateAgentProfile).toHaveBeenCalledWith(CHILD, 'coding')
    expect(mocks.appendModelChange).not.toHaveBeenCalled()
  })

  it('与建会话时落下的档案相同 ⇒ 不再显式切一次（切会连带把工具勾选清空）', async () => {
    mocks.resolveAgentProfileName.mockReturnValue('chat')
    mocks.pickSettings.mockReturnValue({ agentProfile: 'chat' })
    await runner.create(PARENT, {})
    expect(mocks.updateAgentProfile).not.toHaveBeenCalled()
  })

  it('父会话档案与默认落值不同 ⇒ 显式切过去（子会话跟随父会话人格）', async () => {
    mocks.resolveAgentProfileName.mockReturnValue('coding')
    mocks.pickSettings.mockReturnValue({ agentProfile: 'chat' })
    await runner.create(PARENT, {})
    expect(mocks.updateAgentProfile).toHaveBeenCalledWith(CHILD, 'coding')
  })

  it('档案不合法不让整个创建失败：会话已建好且可用（回落 default），照常返回 id', async () => {
    mocks.updateAgentProfile.mockResolvedValue({ success: false, error: 'not session-aware' })
    const res = await runner.create(PARENT, { agentProfile: 'wiki-writer' })
    expect(res).toMatchObject({ id: CHILD })
  })

  it('总数上限：到顶就拒绝并列出现有子会话（让模型复用而不是继续开）', async () => {
    mocks.findChildren.mockReturnValue(
      Array.from({ length: mod.MAX_SUB_SESSIONS }, (_, i) => ({ id: `s${i}`, title: `T${i}` }))
    )
    const res = await runner.create(PARENT, {})
    expect(err(res)).toContain(`${mod.MAX_SUB_SESSIONS}/${mod.MAX_SUB_SESSIONS}`)
    expect(err(res)).toContain('s0')
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

describe('prompt —— 前台 / 后台 / 超时 / 中止', () => {
  const send = (
    over: Partial<{ background: boolean; timeoutSeconds: number; signal: AbortSignal }> = {}
  ): Promise<unknown> =>
    runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: '干活',
      background: over.background ?? false,
      timeoutSeconds: over.timeoutSeconds ?? 60,
      signal: over.signal
    })

  it('走 chatGateway.prompt（IPC agent:prompt 的同一个函数），不自建发送路径', async () => {
    await send()
    expect(mocks.gatewayPrompt).toHaveBeenCalledWith(CHILD, '干活')
  })

  it('空消息拒绝（一条空的用户消息不是「代替用户发送」）', async () => {
    const res = await runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: '   ',
      background: false,
      timeoutSeconds: 5
    })
    expect(err(res)).toMatch(/non-empty string/)
    expect(mocks.gatewayPrompt).not.toHaveBeenCalled()
  })

  it('前台：等整轮结束，返回末条消息正文', async () => {
    mocks.findLastBySession.mockResolvedValue({ role: 'assistant', content: 'DONE.' })
    expect(await send()).toEqual({ kind: 'answered', answer: 'DONE.' })
  })

  it('末条是错误事件 ⇒ 照样回，并标 isError（父级要看到同一份事实）', async () => {
    mocks.findLastBySession.mockResolvedValue({ role: 'system_notify', content: 'boom' })
    expect(await send()).toEqual({ kind: 'answered', answer: 'boom', isError: true })
  })

  it('忙就拒绝、不排队：一个忙着的子会话是父级该知道的状态', async () => {
    mocks.getAgentSession.mockReturnValue(fakeAgent({ isStreaming: true }))
    expect(err(await send())).toMatch(/is running/)
    expect(mocks.gatewayPrompt).not.toHaveBeenCalled()
  })

  it('卡在 ask 上：拒绝，并且**不建议等** —— 它不会自己好起来，还要把问的是什么带出来', async () => {
    const asking = fakeAgent({ pendingInputCount: 1 })
    asking.pendingInputSummaries = ['bash: find . -name "*.txt"']
    mocks.getAgentSession.mockReturnValue(asking)
    const msg = err(await send())
    expect(msg).toContain('will NOT proceed on its own')
    expect(msg).toContain('find . -name')
    // 「等它然后 read」在这里是错的建议，实测里正是它把模型带进空转
    expect(msg).not.toMatch(/wait and then read/i)
  })

  it('后台：立刻回执，不等整轮', async () => {
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    expect(await send({ background: true })).toEqual({ kind: 'started' })
    release()
  })

  it('后台跑完向**父会话**回报，且回执不带内容（内容会被每一步重发）', async () => {
    const parentAgent = fakeAgent()
    mocks.getAgentSession.mockImplementation((id: string) =>
      id === PARENT ? parentAgent : undefined
    )
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    await send({ background: true })
    release()
    await vi.waitFor(() => expect(parentAgent.notify).toHaveBeenCalled())

    const notice = parentAgent.notify.mock.calls[0][0] as string
    expect(notice).toContain(CHILD)
    expect(notice).toContain('wait-for-sub-sessions')
    // 回执里不该出现子会话的答复正文
    expect(notice).not.toContain('DONE.')
  })

  it('前台超时：降级成后台，**不中止**子会话（bash 杀进程，这里不杀对话）', async () => {
    const childAgent = fakeAgent()
    mocks.getAgentSession.mockImplementation((id: string) =>
      id === CHILD ? childAgent : undefined
    )
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    const res = await send({ timeoutSeconds: 1 })
    expect(res).toEqual({ kind: 'timeout' })
    expect(childAgent.abort).not.toHaveBeenCalled()
    release()
  })

  it('超时时若卡在询问上 ⇒ 报「它不会自己好起来」，而不是「还在跑」', async () => {
    // 派活时必须空闲（否则命中忙碌拒绝，走不到超时那一支）
    const asking = fakeAgent()
    mocks.getAgentSession.mockImplementation((id: string) => (id === CHILD ? asking : undefined))
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    const pending = send({ timeoutSeconds: 1 })
    // 等待期间它去问了用户（忙碌判定是同步的，此刻已经过去了）
    asking.isStreaming = true
    asking.pendingInputCount = 1
    asking.pendingInputSummaries = ['bash: rm -rf build']
    const res = await pending
    // 「还在跑，回头再来收」在这里是错的：没人回答它就一直停着
    expect(err(res)).toContain('will NOT proceed on its own')
    expect(err(res)).toContain('rm -rf build')
    expect(asking.abort).not.toHaveBeenCalled()
    release()
  })

  it('降级之后那一轮跑完照样回报（否则父级永远等不到「它好了」）', async () => {
    const parentAgent = fakeAgent()
    mocks.getAgentSession.mockImplementation((id: string) =>
      id === PARENT ? parentAgent : undefined
    )
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    await send({ timeoutSeconds: 1 })
    release()
    await vi.waitFor(() => expect(parentAgent.notify).toHaveBeenCalled())
  })

  it('父会话被停止（signal）⇒ 级联中止子会话当前 run', async () => {
    const childAgent = fakeAgent()
    mocks.getAgentSession.mockImplementation((id: string) =>
      id === CHILD ? childAgent : undefined
    )
    const ac = new AbortController()
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    const pending = send({ signal: ac.signal, timeoutSeconds: 60 })
    ac.abort()
    // abort 之后 runner 会 await 那一轮真正落定
    await vi.waitFor(() => expect(childAgent.abort).toHaveBeenCalled())
    release()
    expect(await pending).toMatchObject({ kind: 'answered' })
  })

  it('后台形态**不**跟随父会话中止（那正是后台的意义）', async () => {
    const childAgent = fakeAgent()
    mocks.getAgentSession.mockImplementation((id: string) =>
      id === CHILD ? childAgent : undefined
    )
    const ac = new AbortController()
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    await send({ background: true, signal: ac.signal })
    ac.abort()
    await Promise.resolve()
    expect(childAgent.abort).not.toHaveBeenCalled()
    release()
  })

  it('并发上限按**父会话**计（不是全局），到顶就拒绝', async () => {
    const busy = fakeAgent({ isStreaming: true })
    const children = Array.from({ length: mod.MAX_RUNNING_SUB_SESSIONS + 1 }, (_, i) => `c${i}`)
    mocks.pick.mockImplementation((id: string) => {
      if (id === PARENT) return { settings: {}, parentId: null }
      if (children.includes(id)) return { settings: {}, parentId: PARENT, title: id }
      return undefined
    })
    mocks.findChildren.mockReturnValue(children.map((id) => ({ id, title: id })))

    const releases: Array<() => void> = []
    mocks.gatewayPrompt.mockImplementation(
      () =>
        new Promise<void>((r) => {
          releases.push(r)
        })
    )
    // 起满 N 个后台运行；它们的状态由「活跃运行时在跑」表达
    for (const id of children.slice(0, mod.MAX_RUNNING_SUB_SESSIONS)) {
      await runner.prompt({
        parentId: PARENT,
        childId: id,
        message: 'go',
        background: true,
        timeoutSeconds: 60
      })
    }
    // 只有前 N 个在跑：第 N+1 个自己是**空闲**的，所以拒绝只可能来自并发上限
    // （若它也 busy，忙拒绝会先命中，这条用例就测不到上限了）
    const runningIds = new Set(children.slice(0, mod.MAX_RUNNING_SUB_SESSIONS))
    mocks.getAgentSession.mockImplementation((id: string) =>
      runningIds.has(id) ? busy : undefined
    )

    const res = await runner.prompt({
      parentId: PARENT,
      childId: children[mod.MAX_RUNNING_SUB_SESSIONS],
      message: 'go',
      background: true,
      timeoutSeconds: 60
    })
    expect(err(res)).toContain('Too many sub-sessions running')
    expect(err(res)).toContain(`${mod.MAX_RUNNING_SUB_SESSIONS}/${mod.MAX_RUNNING_SUB_SESSIONS}`)
    for (const r of releases) r()
  })
})

describe('并发与失败 —— 实测里那条错误链的两个断点', () => {
  it('同一轮里的第二条 prompt 当场被拒（同步占位先于异步的忙碌判定）', async () => {
    // 实测:两个 prompt 在一条 assistant 消息里并发进来,运行时还没建出来 →
    // statusOf 双双判「空闲」放行 → 第二条被 pi 拒 busy,而那个错误被吞掉,
    // 回到模型眼里成了「已提交、排队中」
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    const first = runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'A',
      background: true,
      timeoutSeconds: 60
    })
    const second = await runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'B',
      background: true,
      timeoutSeconds: 60
    })
    expect(err(second)).toContain('one turn at a time')
    // 只发出去一条
    expect(mocks.gatewayPrompt).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  it('发送失败 ⇒ 报错，且说清「没排队」（不是「发出去了没回话」）', async () => {
    mocks.gatewayPrompt.mockResolvedValue({ error: 'agent is busy' })
    const res = await runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'x',
      background: false,
      timeoutSeconds: 5
    })
    expect(err(res)).toContain('NOT delivered')
    expect(err(res)).toContain('agent is busy')
    expect(err(res)).toContain('Nothing is queued')
  })

  it('后台形态的发送失败也报错 —— 假回执会让父级去等一个没开始的活', async () => {
    mocks.gatewayPrompt.mockResolvedValue({ error: 'agent is busy' })
    const res = await runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'x',
      background: true,
      timeoutSeconds: 5
    })
    expect(err(res)).toContain('NOT delivered')
  })
})

describe('完成通知 —— 说实话，且不重复', () => {
  it('自己停掉的那次**不通知**（停它的就是父级，它早就知道）', async () => {
    const parentAgent = fakeAgent()
    // 派活时子会话必须是空闲的（否则命中忙碌拒绝，压根不会有 run）
    const childAgent = fakeAgent()
    mocks.getAgentSession.mockImplementation((id: string) =>
      id === PARENT ? parentAgent : childAgent
    )
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    await runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'go',
      background: true,
      timeoutSeconds: 60
    })
    childAgent.isStreaming = true
    await runner.stop(PARENT, CHILD)
    release()
    // 实测里这条通知反而把父级叫醒去「收」一个它刚亲手停掉的东西，白烧一轮
    await new Promise((r) => setTimeout(r, 300))
    expect(parentAgent.notify).not.toHaveBeenCalled()
  })

  it('卡在等批准时跑完的通知：说清在等批准并带出问题，而不是「跑完了」', async () => {
    const parentAgent = fakeAgent()
    const childAgent = fakeAgent()
    mocks.getAgentSession.mockImplementation((id: string) =>
      id === PARENT ? parentAgent : childAgent
    )
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    await runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'go',
      background: true,
      timeoutSeconds: 60
    })
    childAgent.pendingInputCount = 1
    childAgent.pendingInputSummaries = ['bash: rm -rf build']
    release()
    await vi.waitFor(() => expect(parentAgent.notify).toHaveBeenCalled())
    const notice = parentAgent.notify.mock.calls[0][0] as string
    expect(notice).toContain('ask the user for approval')
    expect(notice).toContain('rm -rf build')
    expect(notice).not.toContain('has finished')
  })

  it('已经有人在 wait 它 ⇒ 不再补一条通知（否则父级把刚拿到的又读一遍）', async () => {
    const parentAgent = fakeAgent()
    const busy = fakeAgent()
    mocks.getAgentSession.mockImplementation((id: string) => (id === PARENT ? parentAgent : busy))
    mocks.findChildren.mockReturnValue([{ id: CHILD, title: 'Child', updatedAt: 1 }])
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    await runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'go',
      background: true,
      timeoutSeconds: 60
    })
    busy.isStreaming = true
    const waiting = runner.wait({ parentId: PARENT, childId: CHILD, timeoutSeconds: 30 })
    busy.isStreaming = false
    release()
    await waiting
    await new Promise((r) => setTimeout(r, 300))
    expect(parentAgent.notify).not.toHaveBeenCalled()
  })
})

describe('wait —— 替掉 sleep 轮询的那个原语', () => {
  /** 让下一次 gatewayPrompt 挂住；返回放行它的函数 */
  function startBackground(): () => void {
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    return release
  }

  it('全部空闲时立刻返回（不为一个已经跑完的任务空等）', async () => {
    mocks.findChildren.mockReturnValue([{ id: CHILD, title: 'Child', updatedAt: 1 }])
    mocks.findLastBySession.mockResolvedValue({ role: 'assistant', content: 'DONE.' })
    const res = (await runner.wait({ parentId: PARENT, timeoutSeconds: 5 })) as {
      kind: string
      results: Array<{ answer?: string }>
    }
    expect(res.kind).toBe('settled')
    expect(res.results[0].answer).toBe('DONE.')
  })

  it('挂住直到子会话落定，并**一次交回答复** —— 省掉「再 read 一遍」的那一轮请求', async () => {
    mocks.findChildren.mockReturnValue([{ id: CHILD, title: 'Child', updatedAt: 1 }])
    const busy = fakeAgent({ isStreaming: true })
    mocks.getAgentSession.mockReturnValue(busy)
    const release = startBackground()
    await runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'go',
      background: true,
      timeoutSeconds: 60
    })

    const pending = runner.wait({ parentId: PARENT, timeoutSeconds: 30 })
    // 还在跑：等待没有落定
    let resolved = false
    void pending.then(() => (resolved = true))
    await new Promise((r) => setTimeout(r, 300))
    expect(resolved).toBe(false)

    mocks.findLastBySession.mockResolvedValue({ role: 'assistant', content: 'LATE ANSWER.' })
    busy.isStreaming = false
    release()
    const res = (await pending) as { kind: string; results: Array<{ answer?: string }> }
    expect(res.kind).toBe('settled')
    expect(res.results[0].answer).toBe('LATE ANSWER.')
  })

  it('超时：如实回报仍在跑，且**不中止**子会话（等待是只读动作）', async () => {
    mocks.findChildren.mockReturnValue([{ id: CHILD, title: 'Child', updatedAt: 1 }])
    const busy = fakeAgent({ isStreaming: true })
    mocks.getAgentSession.mockReturnValue(busy)
    const release = startBackground()
    await runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'go',
      background: true,
      timeoutSeconds: 60
    })

    const res = (await runner.wait({ parentId: PARENT, timeoutSeconds: 1 })) as { kind: string }
    expect(res.kind).toBe('timeout')
    expect(busy.abort).not.toHaveBeenCalled()
    release()
  })

  it('卡在等批准：不再等（它不会自己好起来），但外层状态是 blocked 而不是 settled', async () => {
    mocks.findChildren.mockReturnValue([{ id: CHILD, title: 'Child', updatedAt: 1 }])
    const asking = fakeAgent({ isStreaming: true, pendingInputCount: 1 })
    asking.pendingInputSummaries = ['bash: rm -rf build']
    mocks.getAgentSession.mockReturnValue(asking)
    const res = (await runner.wait({
      parentId: PARENT,
      childId: CHILD,
      timeoutSeconds: 30
    })) as { kind: string; results: Array<{ status: string; blockedOn?: string[] }> }
    // settled 会被父级读成「成了」；这里必须是另一个词
    expect(res.kind).toBe('blocked')
    expect(res.results[0].status).toBe('waiting-input')
    // 问的是什么要带出来 —— 没有它父级连转告用户都做不到
    expect(res.results[0].blockedOn).toEqual(['bash: rm -rf build'])
  })

  it('父会话被停止：立刻返回，**不**级联杀子会话（后台的活不该被连累）', async () => {
    mocks.findChildren.mockReturnValue([{ id: CHILD, title: 'Child', updatedAt: 1 }])
    const busy = fakeAgent({ isStreaming: true })
    mocks.getAgentSession.mockReturnValue(busy)
    const ac = new AbortController()
    const pending = runner.wait({
      parentId: PARENT,
      childId: CHILD,
      timeoutSeconds: 30,
      signal: ac.signal
    })
    ac.abort()
    expect(((await pending) as { kind: string }).kind).toBe('aborted')
    expect(busy.abort).not.toHaveBeenCalled()
  })

  it('越权 id 与非普通会话走同一套准入', async () => {
    mocks.pick.mockImplementation((id: string) =>
      id === PARENT ? { settings: {}, parentId: null } : { settings: {}, parentId: 'other' }
    )
    expect(
      err(await runner.wait({ parentId: PARENT, childId: 'stranger', timeoutSeconds: 5 }))
    ).toContain('is not a sub-session')
  })
})

describe('list / read / stop', () => {
  it('list：状态取自运行时 —— 用户自己在子会话里发消息同样算 running', async () => {
    mocks.findChildren.mockReturnValue([
      { id: 'a', title: 'A', updatedAt: 1 },
      { id: 'b', title: 'B', updatedAt: 2 }
    ])
    mocks.getAgentSession.mockImplementation((id: string) =>
      id === 'a' ? fakeAgent({ isStreaming: true }) : undefined
    )
    const res = runner.list(PARENT) as { subSessions: Array<{ id: string; status: string }> }
    expect(res.subSessions.map((s) => [s.id, s.status])).toEqual([
      ['a', 'running'],
      ['b', 'idle']
    ])
  })

  it('read：还没回话时不编造答复', async () => {
    const res = (await runner.read(PARENT, CHILD)) as { answer?: string }
    expect(res.answer).toBeUndefined()
  })

  it('stop：有活跃运行时才 abort；没有就如实说没在跑', async () => {
    expect(await runner.stop(PARENT, CHILD)).toEqual({ stopped: false })
    const child = fakeAgent({ isStreaming: true })
    mocks.getAgentSession.mockReturnValue(child)
    expect(await runner.stop(PARENT, CHILD)).toEqual({ stopped: true })
    expect(child.abort).toHaveBeenCalled()
  })

  it('stop 也走同一套准入（不能停别人的子会话）', async () => {
    mocks.pick.mockImplementation((id: string) =>
      id === PARENT ? { settings: {}, parentId: null } : { settings: {}, parentId: 'other' }
    )
    expect(err(await runner.stop(PARENT, 'stranger'))).toContain('is not a sub-session')
  })
})

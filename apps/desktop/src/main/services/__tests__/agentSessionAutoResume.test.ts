/**
 * AgentSession —— 后台完成通知的三岔（自动续跑）。
 *
 * 契约：
 *   运行中          → steer 插进当前 run（runtime.notify 内部处理）
 *   空闲 + 允许续跑 → **自己起一轮**（runtime.resume）
 *   空闲 + 不允许   → 退回 notify 排队，**通知一条不丢**
 *
 * 「不允许」只有两种：全局设置明确写 'false'，或这条会话刚被显式停过（到下一条用户消息为止）。
 * 后者不是丢通知 —— 它退回排队路径；要的是「用户喊停之后会话就收敛，直到他再开口」。
 *
 * 刻意**没有**续跑次数上限：一个 agent 拿着完整状态决定下一步是它的活，该防的是
 * 「工具让它看不见真实状态」。所以这里也没有对应的用例 —— 没有那条规则可钉。
 *
 * 构造走 Object.create：AgentSession.create 要装配整条创建管线（档案/工具/模型），
 * 而本组用例只关心 notify 的分支，注入一个假 runtime 即可。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settingsGet: vi.fn<(key: string) => string | undefined>()
}))

vi.mock('../settingsService', () => ({ settingsService: { get: mocks.settingsGet } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/sessionDao', () => ({ sessionDao: {} }))
vi.mock('../agentService', () => ({ agentService: {} }))
vi.mock('../../agents/agentHost', () => ({ agentFactory: {} }))
vi.mock('../workflowService', () => ({ workflowTriggers: { fire: vi.fn() } }))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(),
  isDefaultTitle: vi.fn()
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({ clearSession: vi.fn() }))
vi.mock('../sshManager', () => ({ sshManager: { disconnect: vi.fn(async () => {}) } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

type Mod = typeof import('../agentSession')
/**
 * 实例类型经工厂方法取 —— AgentSession 的构造器是 private，`InstanceType<...>` 拿不到它
 * （那正是「只能经 create 装配」这条纪律在类型层的体现）。
 */
type Session = Awaited<ReturnType<Mod['AgentSession']['create']>>
let mod: Mod

/** 假运行时：只保留 notify 分支会碰到的那几个面 */
function fakeRuntime(isStreaming = false): {
  isStreaming: boolean
  notify: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
} {
  return {
    isStreaming,
    notify: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(true),
    abort: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined)
  }
}

function makeSession(runtime: ReturnType<typeof fakeRuntime>): {
  session: Session
  runtime: ReturnType<typeof fakeRuntime>
} {
  const session = Object.create(mod.AgentSession.prototype) as Session
  Object.assign(session, {
    sessionId: 's1',
    created: { runtime, dispose: vi.fn() },
    runtime,
    stoppedByUser: false,
    pendingNotices: [],
    resumeTimer: null
  })
  return { session, runtime }
}

/** 等过合并窗口（500ms）+ 一点余量 */
const afterCoalesce = (): Promise<void> => new Promise((r) => setTimeout(r, 700))

beforeAll(async () => {
  mod = await import('../agentSession')
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settingsGet.mockReturnValue(undefined)
})

describe('运行中 —— 插进当前 run，不起新一轮', () => {
  it('isStreaming ⇒ 走 notify(steer)，立刻送达（不进合并窗口）', async () => {
    const { session, runtime } = makeSession(fakeRuntime(true))
    await session.notify('<sub-session/> done')
    expect(runtime.notify).toHaveBeenCalledWith('<sub-session/> done')
    expect(runtime.resume).not.toHaveBeenCalled()
  })
})

describe('空闲 —— 自动续跑', () => {
  it('缺省开：没有设置键也照样续跑，通知就是那一轮的输入', async () => {
    const { session, runtime } = makeSession(fakeRuntime())
    await session.notify('task A done')
    await afterCoalesce()
    expect(runtime.resume).toHaveBeenCalledWith('task A done')
    expect(runtime.notify).not.toHaveBeenCalled()
  })

  it('设置写坏（乱值）仍按开处理 —— 只有明确的 false 才关', async () => {
    mocks.settingsGet.mockReturnValue('sure')
    const { session, runtime } = makeSession(fakeRuntime())
    await session.notify('x')
    await afterCoalesce()
    expect(runtime.resume).toHaveBeenCalled()
  })

  it('同一窗口内到达的多条合并成一轮（3 件事同时好了不该起 3 轮）', async () => {
    const { session, runtime } = makeSession(fakeRuntime())
    await session.notify('A done')
    await session.notify('B done')
    await session.notify('C done')
    await afterCoalesce()
    expect(runtime.resume).toHaveBeenCalledTimes(1)
    const text = runtime.resume.mock.calls[0][0] as string
    expect(text).toContain('A done')
    expect(text).toContain('B done')
    expect(text).toContain('C done')
  })

  it('起轮失败（用户抢先发话，pi 拒 busy）⇒ 退回排队，通知不丢', async () => {
    const { session, runtime } = makeSession(fakeRuntime())
    runtime.resume.mockResolvedValue(false)
    await session.notify('late')
    await afterCoalesce()
    expect(runtime.resume).toHaveBeenCalled()
    expect(runtime.notify).toHaveBeenCalledWith('late')
  })
})

describe('不允许续跑 —— 退回排队路径（不是丢通知）', () => {
  it('全局设置 false：不起轮，改走 notify', async () => {
    mocks.settingsGet.mockImplementation((key) =>
      key === mod.AUTO_RESUME_KEY ? 'false' : undefined
    )
    const { session, runtime } = makeSession(fakeRuntime())
    await session.notify('done')
    expect(runtime.notify).toHaveBeenCalledWith('done')
    expect(runtime.resume).not.toHaveBeenCalled()
  })

  it('刚被显式停过：不起轮 —— 按完停止两秒后又自己说话，是没听懂停止', async () => {
    const { session, runtime } = makeSession(fakeRuntime())
    await session.abort()
    await session.notify('done')
    expect(runtime.notify).toHaveBeenCalledWith('done')
    expect(runtime.resume).not.toHaveBeenCalled()
  })

  it('用户再开口（prompt）后恢复：收敛只持续到下一条用户消息', async () => {
    const { session, runtime } = makeSession(fakeRuntime())
    await session.abort()
    await session.prompt('接着弄')
    await session.notify('done')
    await afterCoalesce()
    expect(runtime.resume).toHaveBeenCalledWith('done')
  })
})

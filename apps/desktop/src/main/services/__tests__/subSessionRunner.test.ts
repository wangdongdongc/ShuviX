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
 * mock 手法照 sessionServicePinAgentProfile.test.ts：vi.mock + 动态 import；
 * dao / sessionService / gateway / messageService 全部换假件。
 *
 * P2-10：答复取自子会话门面的 `lastAnswer`（新格式会话；旧格式子会话的「末条消息」只留一条用例，
 * PIN-12）；完成通知不再经后台任务枢纽，而是由运行时的 `onDrivenSettled` 喂给 runner 的处理器
 * （这里直接调它，送达是 `sessionService.deliverSubSessionNotice`）；发送带幂等键与 driven 标记。
 *
 * 两处刻意**不给**的成员：`sessionDao.pickSettings`（runner 不再读子会话的戳 —— 留着会让
 * 「又开始比对戳」的回归静默通过）与 `sessionService.resolveAgentProfileName`（不点名就什么
 * 也不写，父子形态天然一致，runner 不需要知道父会话跑的是哪个基座）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi, type Mock } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { emptySessionView, type SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { isSystemNoticeText } from '@shuvix/chat-protocol/systemNoticeContract'
import type { PromptOutcome } from '../subSessionRunner'

const mocks = vi.hoisted(() => ({
  pick: vi.fn<(id: string, cols: string[]) => unknown>(),
  findChildren: vi.fn<(id: string) => Array<Record<string, unknown>>>(),
  create: vi.fn(),
  updateTitle: vi.fn(),
  pinAgentProfile: vi.fn(),
  resolveRunConfig: vi.fn(),
  getAgentSession: vi.fn(),
  peekAgentSession: vi.fn(),
  ensureAgentSession: vi.fn(),
  deliver: vi.fn(),
  gatewayPrompt: vi.fn(),
  // §19：往子会话这一轮里插话走网关的 steerDriven（S1）
  gatewaySteerDriven: vi.fn(),
  // §19：sessionService / 全局 broker 的应答入口 —— 代答**不该**经过它们（S8，反向断言用）
  respondToInput: vi.fn(),
  brokerRespond: vi.fn(),
  // §19：后台任务枢纽的通知投递（S5：询问通知走枢纽，完成通知走 deliver）
  hubDeliver: vi.fn(),
  recordSessionModel: vi.fn(),
  recordSessionThinkingLevel: vi.fn(),
  findLastBySession: vi.fn(),
  warn: vi.fn(),
  durable: { value: true }
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.pick,
    findChildren: mocks.findChildren
  }
}))
vi.mock('../../services/sessionService', () => ({
  sessionService: {
    create: mocks.create,
    updateTitle: mocks.updateTitle,
    pinAgentProfile: mocks.pinAgentProfile,
    resolveRunConfig: mocks.resolveRunConfig,
    getAgentSession: mocks.getAgentSession,
    peekAgentSession: mocks.peekAgentSession,
    ensureAgentSession: mocks.ensureAgentSession,
    deliverSubSessionNotice: mocks.deliver,
    respondToInput: mocks.respondToInput
  }
}))
vi.mock('../../frontend/core', () => ({
  chatGateway: { prompt: mocks.gatewayPrompt, steerDriven: mocks.gatewaySteerDriven }
}))
// 全局 broker 按 requestId 遍历所有会话认领：代答绝不走它（ask 的 id 是 provider 的 toolCallId，会话之间会撞）
vi.mock('../userInputBroker', () => ({
  respondToUserInput: mocks.brokerRespond,
  registerUserInputParticipant: vi.fn(),
  requestUserInputFor: vi.fn(),
  resetUserInputParticipantsForTests: vi.fn()
}))
vi.mock('../../services/messageService', () => ({
  messageService: { findLastBySession: mocks.findLastBySession }
}))
vi.mock('../../services/sessionStorage', () => ({
  // 缺省都是新格式会话（答复问门面的 lastAnswer）；旧格式那一条用例把它关掉（PIN-12）
  isDurableSession: () => mocks.durable.value,
  recordSessionModel: mocks.recordSessionModel,
  recordSessionThinkingLevel: mocks.recordSessionThinkingLevel
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() })
}))

type Mod = typeof import('../subSessionRunner')
let mod: Mod
let runner: Mod['subSessionRunner']
let registry: typeof import('../taskRegistry')

const PARENT = 'parent-1'
const CHILD = 'child-1'

/** 与运行时 `PendingInputRequests.summaries` 同一种写法（工具名: 命令 / 问题） */
function summaryOf(request: InputRequest): string {
  const r = request as { kind: string; toolName: string; command?: string; question?: string }
  return [r.toolName, r.command ?? r.question ?? r.kind].filter(Boolean).join(': ')
}

/** 一个假的子会话运行时（AgentSession 的最小面：状态 getter + abort/notify + P2-10 的读路径 + §19 的询问面） */
interface FakeAgent {
  sessionId: string
  isStreaming: boolean
  isInterrupted: boolean
  /**
   * 可脚本的询问表（§19，S2）：`pendingInputs()` / `pendingInputCount` / `pendingInputSummaries` 都从它派生
   * （再加上旧写法直接设的计数 / 摘要 —— 那些用例只设摘要，渲染与改动前一致）
   */
  asks: InputRequest[]
  pendingInputCount: number
  pendingInputSummaries: string[]
  /** true = respondToInput 认领不到（用户先在子会话里答了） */
  respondRefuses: boolean
  /** sessionView() 交的视图（缺省空视图） */
  view: SessionView | undefined
  drivenRun: unknown
  abort: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  lastAnswer: ReturnType<typeof vi.fn>
  requestState: ReturnType<typeof vi.fn>
  resumeInterrupted: ReturnType<typeof vi.fn>
  taskLiveness: ReturnType<typeof vi.fn>
  respondToInput: Mock<(requestId: string, response?: InputResponse, meta?: unknown) => boolean>
  sessionView: ReturnType<typeof vi.fn>
  inputSources: ReturnType<typeof vi.fn>
  pendingInputs: () => InputRequest[]
}

function fakeAgent(
  over: Partial<{ isStreaming: boolean; pendingInputCount: number; isInterrupted: boolean }> = {},
  sessionId: string = CHILD
): FakeAgent {
  // 旧写法：直接设计数 / 摘要（摘要按 `工具: 命令` 还原成权限卡）
  let extraCount = over.pendingInputCount ?? 0
  let extraSummaries: string[] = []
  const agent: FakeAgent = {
    sessionId,
    isStreaming: over.isStreaming ?? false,
    isInterrupted: over.isInterrupted ?? false,
    asks: [],
    get pendingInputCount(): number {
      return agent.asks.length + extraCount
    },
    set pendingInputCount(n: number) {
      extraCount = n
    },
    // blockedError 的「只有用户能答」那一支读的是摘要，不是 pendingInputs()：两者必须同源
    get pendingInputSummaries(): string[] {
      return [...agent.asks.map(summaryOf), ...extraSummaries]
    },
    set pendingInputSummaries(list: string[]) {
      extraSummaries = list
    },
    respondRefuses: false,
    view: undefined,
    drivenRun: undefined,
    abort: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    lastAnswer: vi.fn().mockResolvedValue(undefined),
    requestState: vi.fn().mockResolvedValue('none'),
    resumeInterrupted: vi.fn().mockResolvedValue({}),
    taskLiveness: vi.fn().mockResolvedValue(undefined),
    // S3：模拟真实顺序 —— 认得的 id 先从表里移除，再同步调 runner 的落定钩子（真 PendingInputRequests.settle
    // 先 delete 再调钩子，main 入口再转给 runner）；不认得 / 用户先答了 → false
    respondToInput: vi.fn(
      (requestId: string, _response?: InputResponse, _meta?: unknown): boolean => {
        if (agent.respondRefuses) return false
        const at = agent.asks.findIndex((a) => a.id === requestId)
        if (at < 0) return false
        agent.asks.splice(at, 1)
        runner.onAskResolved(agent.sessionId, requestId)
        return true
      }
    ),
    // S7：userIntervened / answeredAsk 读这两样；不给就每次走 catch 打 warn
    sessionView: vi.fn(
      async (): Promise<SessionView> => agent.view ?? emptySessionView(agent.sessionId)
    ),
    inputSources: vi.fn(async (): Promise<Map<string, unknown>> => new Map()),
    pendingInputs: (): InputRequest[] => [
      ...agent.asks,
      ...extraSummaries.map((summary, i): InputRequest => {
        const [toolName, ...rest] = summary.split(': ')
        return { id: `ask-${i}`, kind: 'ask', toolName, command: rest.join(': '), createdAt: 0 }
      })
    ]
  }
  return agent
}

/** ask 工具的一道选择题（§19：父会话能代答的那一种） */
function choice(
  id: string,
  question: string,
  options: Array<{ label: string; description: string }>
): InputRequest {
  return { id, kind: 'choice', toolName: 'ask', question, options, createdAt: 0 }
}

/** 一张权限卡（只有用户能批） */
function approval(id: string, toolName: string, command: string): InputRequest {
  return { id, kind: 'ask', toolName, command, createdAt: 0 }
}

const q1 = (): InputRequest =>
  choice('q1', 'Keep the old API?', [
    { label: 'A', description: 'keep a shim' },
    { label: 'B', description: '' }
  ])
const q2 = (): InputRequest =>
  choice('q2', 'Which dir?', [
    { label: 'X', description: '' },
    { label: 'Y', description: '' }
  ])
const q3 = (): InputRequest =>
  choice('q3', 'Third?', [
    { label: 'Yes', description: '' },
    { label: 'No', description: '' }
  ])
const ap = (): InputRequest => approval('ap1', 'bash', 'rm -rf build')
/** 用户（或别的答题方）在卡片上点了一个选项 */
const picked = (label: string): InputResponse => ({ kind: 'choice', selections: [label] })

/** 没开着的子会话被 peek 打开之后的那个门面（lastAnswer / requestState 从它读） */
let closedChild: ReturnType<typeof fakeAgent>

/** 运行时报来的一次 driven 落定（P2-09 的 DrivenSettledEvent） */
function settled(
  over: Partial<{
    sessionId: string
    requestId: string
    background: boolean
    reason: string
  }> = {}
): Parameters<Mod['subSessionRunner']['onDrivenSettled']>[0] {
  const sessionId = over.sessionId ?? CHILD
  return {
    sessionId,
    parentId: PARENT,
    requestId: over.requestId ?? 'subsession:parent-1:1',
    background: over.background ?? true,
    conversationId: 1 as never,
    submissionId: 42 as never,
    noticeRequestId: `subsession-done:${sessionId}:42`,
    result: {},
    record:
      over.reason === undefined ? { status: 'done' } : { status: 'unanswered', reason: over.reason }
  }
}

/** 上一次 gatewayPrompt 的幂等键 */
const lastRequestId = (): string =>
  (mocks.gatewayPrompt.mock.calls.at(-1)![4] as { requestId: string }).requestId

/** 缺省世界：父会话是普通会话、子会话是它的孩子、都没有活跃运行时 */
function defaultWorld(): void {
  mocks.pick.mockImplementation((id: string) => {
    if (id === PARENT) return { settings: {}, parentId: null, title: 'Parent', updatedAt: 1 }
    if (id === CHILD) return { settings: {}, parentId: PARENT, title: 'Child', updatedAt: 2 }
    return undefined
  })
  mocks.findChildren.mockReturnValue([])
  mocks.getAgentSession.mockReturnValue(undefined)
  closedChild = fakeAgent()
  mocks.peekAgentSession.mockImplementation(
    async (id: string) => mocks.getAgentSession(id) ?? (id === CHILD ? closedChild : undefined)
  )
  mocks.ensureAgentSession.mockImplementation(async (id: string) => mocks.getAgentSession(id))
  mocks.deliver.mockResolvedValue(undefined)
  mocks.durable.value = true
  // 发送成功 = 落定为 {}；带 error 才是「没发出去」
  mocks.gatewayPrompt.mockResolvedValue({})
  // 插话送到 = {}（§19.6：网关回报受理结果）
  mocks.gatewaySteerDriven.mockResolvedValue({})
  mocks.findLastBySession.mockResolvedValue(undefined)
  mocks.resolveRunConfig.mockResolvedValue({ model: null, thinkingLevel: 'medium' })
  // 点名的档案缺省钉得上（普通具名档案，没声明模型也没声明 mcp:/skill:）
  mocks.pinAgentProfile.mockResolvedValue({ success: true, applied: { tools: [] } })
  mocks.create.mockReturnValue({ id: CHILD, title: 'Child' })
}

let frontendRegistry: (typeof import('../../frontend/core/ChatFrontendRegistry'))['chatFrontendRegistry']

beforeAll(async () => {
  mod = await import('../subSessionRunner')
  runner = mod.subSessionRunner
  registry = await import('../taskRegistry')
  // S5：枢纽的通知器（产品里由 sessionService 注入；这里 sessionService 是假件，不接就没人收询问通知）
  registry.setTaskNotifier((sessionId, text) => mocks.hubDeliver(sessionId, text))
  ;({ chatFrontendRegistry: frontendRegistry } =
    await import('../../frontend/core/ChatFrontendRegistry'))
})

beforeEach(() => {
  vi.useRealTimers()
  // 枢纽与 runner 的记账都是进程内单例，上一条用例的残留不该漏进下一条
  registry.taskRegistry.killAll()
  runner.resetForTests()
  for (const fn of Object.values(mocks)) if (typeof fn === 'function') fn.mockReset()
  defaultWorld()
})

const err = (r: unknown): string => (r as { error: string }).error

describe('准入 —— 谁能开子会话', () => {
  it('笔记本会话拒绝（人格钉死在 notebook 基座，产物是那份笔记）', async () => {
    mocks.pick.mockReturnValue({ settings: { notebookPath: 'n.md' }, parentId: null })
    expect(err(await runner.create(PARENT, {}))).toMatch(/Notebook sessions/)
  })

  it('bot 会话（settings.bot）**通过** —— 它开子会话正是干活的唯一方式', async () => {
    // 这条是整个 bot 特性的结构前提，也是最容易被顺手做掉的一条：准入这三道门
    // 长得都像「特殊形态一律拒绝」，而 bot 会话恰恰是一条**普通有根会话** ——
    // 它的工具面里没有 bash、没有 write，真要干活只能开子会话（人设不跟着过去，因此
    // 「人设影响怎么说话、不影响怎么干活」才成立）。谁把它加进上面那条拒绝里，
    // 特性当场死透而别的用例一条都不会红
    mocks.pick.mockImplementation((id: string) => {
      if (id === PARENT) return { settings: { bot: 'scout' }, parentId: null, title: 'Bot' }
      if (id === CHILD) return { settings: {}, parentId: PARENT, title: 'Child', updatedAt: 2 }
      return undefined
    })
    expect(await runner.create(PARENT, {})).not.toHaveProperty('error')
    expect(mocks.create).toHaveBeenCalledWith({ parentId: PARENT })
    expect(runner.list(PARENT)).not.toHaveProperty('error')
  })

  it('子会话自己不能再开子会话（嵌套只允许一层）', async () => {
    mocks.pick.mockReturnValue({ settings: {}, parentId: 'someone' })
    expect(err(await runner.create(CHILD, {}))).toMatch(/nesting is limited to one level/)
  })

  it('没有会话行（无会话上下文的派发）→ 说清这里没有可用的子会话能力', async () => {
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
      thinkingLevel: 'medium'
    })
    await runner.create(PARENT, {})
    expect(mocks.recordSessionModel).toHaveBeenCalledWith(CHILD, 'p', 'opus')
  })

  /** 父会话此刻的模型类运行配置（模型 / 思考档位）—— 种子的来源 */
  const parentConfig = (): void => {
    mocks.resolveRunConfig.mockResolvedValue({
      model: { provider: 'p', model: 'opus', capabilities: {} },
      thinkingLevel: 'medium'
    })
  }

  it('SR-1 不点名 ⇒ 零档案动作：pinAgentProfile 不被调用，父级的模型 / 思考档位照常种', async () => {
    // 不点名就什么也不写：projectId 恒随父，父子推导出同一个基座。曾经这里会「读子会话的戳
    // 与父会话档案比对、不同就切一次」—— 那条路已经不存在，回来就是回归。
    // 扩展能力勾选不归 runner 种：它是 settings 的键，sessionService.create 已从父会话抄过去
    parentConfig()
    await runner.create(PARENT, {})
    expect(mocks.pinAgentProfile).not.toHaveBeenCalled()
    expect(mocks.recordSessionModel).toHaveBeenCalledWith(CHILD, 'p', 'opus')
    expect(mocks.recordSessionThinkingLevel).toHaveBeenCalledWith(CHILD, 'medium')
  })

  it('SR-2 点名即钉且 trim：恰一次，顺序在 create 之后、resolveRunConfig 之前', async () => {
    await runner.create(PARENT, { agentProfile: '  coding ' })
    expect(mocks.pinAgentProfile).toHaveBeenCalledTimes(1)
    expect(mocks.pinAgentProfile).toHaveBeenCalledWith(CHILD, 'coding')
    // 钉在种子之前：档案的种子（pin 内部写的 mcp:/skill: 替换）必须先落，seedRunConfig
    // 才知道「档案有没有意见」；建会话又必须在钉之前 —— 钉的是一条已经存在的子会话
    const order = [mocks.create, mocks.pinAgentProfile, mocks.resolveRunConfig].map(
      (m) => m.mock.invocationCallOrder[0]
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('SR-3 档案声明压过继承：声明了模型 ⇒ 不再种父级的模型；没声明思考档位 ⇒ 档位仍随父', async () => {
    parentConfig()
    mocks.pinAgentProfile.mockResolvedValue({
      success: true,
      applied: { model: { provider: 'p', model: 'declared', capabilities: {} }, tools: ['skill:x'] }
    })
    await runner.create(PARENT, { agentProfile: 'declared-prof' })
    expect(mocks.recordSessionModel).not.toHaveBeenCalled()
    // 档案没声明思考档位 ⇒ 随父
    expect(mocks.recordSessionThinkingLevel).toHaveBeenCalledWith(CHILD, 'medium')
  })

  it('SR-4 档案没声明模型 ⇒ 模型与思考档位随父（工具的「空声明不算意见」归 pinAgentProfile，见 PIN-7）', async () => {
    parentConfig()
    mocks.pinAgentProfile.mockResolvedValue({ success: true, applied: { tools: [] } })
    await runner.create(PARENT, { agentProfile: 'coding' })
    expect(mocks.recordSessionModel).toHaveBeenCalledWith(CHILD, 'p', 'opus')
    expect(mocks.recordSessionThinkingLevel).toHaveBeenCalledWith(CHILD, 'medium')
  })

  it('SR-5 被拒不失败：会话已建好且可用（落在自己形态的基座上），照常返回 id，模型与思考档位按父级种，并留一行 warn', async () => {
    parentConfig()
    mocks.pinAgentProfile.mockResolvedValue({
      success: false,
      error:
        '"work" is a base profile; omit agent_profile to run the sub-session on this session\'s own base'
    })
    const res = await runner.create(PARENT, { agentProfile: 'work' })
    expect(res).toEqual({ id: CHILD, title: 'Child' })
    // 拒绝 = 档案没有意见：继承照旧（模型与思考档位都按父会话种）
    expect(mocks.recordSessionModel).toHaveBeenCalledWith(CHILD, 'p', 'opus')
    expect(mocks.recordSessionThinkingLevel).toHaveBeenCalledWith(CHILD, 'medium')
    // 日志是「点名没生效」唯一可查的线索：带上点的名字与拒绝理由
    const warned = mocks.warn.mock.calls.map((c) => String(c[0]))
    expect(warned.some((m) => m.includes('work') && m.includes('base profile'))).toBe(true)
  })

  it('SR-6 空白点名视同不点名：pinAgentProfile 不被调用', async () => {
    await runner.create(PARENT, { agentProfile: '   ' })
    expect(mocks.pinAgentProfile).not.toHaveBeenCalled()
  })

  it('SR-7 档案声明了思考档位（off）⇒ runner 不再种父级的档位（pin 已写过种子），模型仍随父', async () => {
    // 再写一条父会话的档位会排在档案种子之后、把它盖掉 —— titler 那样声明了 off 的档案
    // 在子会话里就又跑回父会话的 medium 了
    parentConfig()
    mocks.pinAgentProfile.mockResolvedValue({
      success: true,
      applied: { thinkingLevel: 'off', tools: [] }
    })
    await runner.create(PARENT, { agentProfile: 'quiet-prof' })
    expect(mocks.recordSessionThinkingLevel).not.toHaveBeenCalled()
    expect(mocks.recordSessionModel).toHaveBeenCalledWith(CHILD, 'p', 'opus')
  })

  it('SR-8 档案模型与思考档位都声明了 ⇒ runner 两个种子都不写（两项都是档案的意见）', async () => {
    parentConfig()
    mocks.pinAgentProfile.mockResolvedValue({
      success: true,
      applied: {
        model: { provider: 'p', model: 'declared', capabilities: {} },
        thinkingLevel: 'xhigh',
        tools: []
      }
    })
    await runner.create(PARENT, { agentProfile: 'full-prof' })
    expect(mocks.recordSessionModel).not.toHaveBeenCalled()
    expect(mocks.recordSessionThinkingLevel).not.toHaveBeenCalled()
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

  it('走 chatGateway.prompt（IPC agent:prompt 的同一个函数），不自建发送路径；带幂等键与 driven 标记', async () => {
    await send()
    expect(mocks.gatewayPrompt).toHaveBeenCalledWith(CHILD, '干活', undefined, undefined, {
      // 没有工具任务的调用方：一个从不重新挂上的临时键（PIN-18）
      requestId: expect.stringMatching(/^subsession:parent-1:adhoc-/),
      driven: { parentId: PARENT, background: false }
    })
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

  it('前台：等整轮结束，返回子会话这一轮的回答（lastAnswer）', async () => {
    closedChild.lastAnswer.mockResolvedValue({ text: 'DONE.' })
    expect(await send()).toEqual({ kind: 'answered', id: CHILD, answer: 'DONE.' })
  })

  it('这一轮以错误收场 ⇒ 照样回，并标 isError（父级要看到同一份事实）', async () => {
    closedChild.lastAnswer.mockResolvedValue({ text: 'boom', isError: true })
    expect(await send()).toEqual({ kind: 'answered', id: CHILD, answer: 'boom', isError: true })
  })

  it('旧格式子会话（PIN-12）：照旧读末条消息', async () => {
    mocks.durable.value = false
    mocks.findLastBySession.mockResolvedValue({ role: 'system_notify', content: 'old boom' })
    expect(await send()).toEqual({ kind: 'answered', id: CHILD, answer: 'old boom', isError: true })
    expect(closedChild.lastAnswer).not.toHaveBeenCalled()
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
    expect(await send({ background: true })).toEqual({ kind: 'started', id: CHILD })
    release()
  })

  it('后台跑完向**父会话**回报，且回执不带内容（内容会被每一步重发）', async () => {
    closedChild.lastAnswer.mockResolvedValue({ text: 'DONE.' })
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    await send({ background: true })
    release()
    await runner.onDrivenSettled(settled({ requestId: lastRequestId() }))
    expect(mocks.deliver).toHaveBeenCalledTimes(1)
    const [parentId, notice, noticeId] = mocks.deliver.mock.calls[0] as [string, string, string]
    expect(parentId).toBe(PARENT)
    expect(noticeId).toBe(`subsession-done:${CHILD}:42`)
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
    expect(res).toEqual({ kind: 'timeout', id: CHILD })
    expect(childAgent.abort).not.toHaveBeenCalled()
    release()
  })

  it('发出之后、挂上等待之前子会话已停在询问上（走「重新挂上后检查一次状态」那一支，询问钩子没调）⇒ 当场交回询问（§19.3），绝不说「还在跑」', async () => {
    // 这条**不**经 onAskRaised：状态是在 prompt 的 `await noteSupersede` 期间改的，建任务之后那次
    // 「已经在等输入就 update」的检查（本为重新挂上而设）让它当场交回。钩子那条路见 §19 B 的 WP3-09 起。
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
    const res = (await pending) as { kind?: string; error?: string }
    // 「还在跑，回头再来收」在这里是错的：没人回答它就一直停着 —— 前台等待把那条询问交回来
    expect(res.error).toBeUndefined()
    expect(res.kind).toBe('input')
    expect(asking.abort).not.toHaveBeenCalled()
    release()
  })

  it('降级之后那一轮跑完照样回报（否则父级永远等不到「它好了」）', async () => {
    let release!: () => void
    mocks.gatewayPrompt.mockReturnValue(
      new Promise<{ error?: string }>((r) => {
        release = () => r({})
      })
    )
    await send({ timeoutSeconds: 1 })
    release()
    await runner.onDrivenSettled(settled({ requestId: lastRequestId(), background: false }))
    expect(mocks.deliver).toHaveBeenCalledTimes(1)
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

  it('旧格式（只读）子会话的发送失败：说清只读、可以 read，不叫父级「空闲了再发」', async () => {
    mocks.durable.value = false
    mocks.pick.mockImplementation((id: string) => {
      if (id === PARENT) return { settings: {}, parentId: null, title: 'Parent', updatedAt: 1 }
      if (id === CHILD)
        return {
          settings: {},
          parentId: PARENT,
          title: 'Child',
          updatedAt: 2,
          storageKind: 'harness-v3-jsonl'
        }
      return undefined
    })
    mocks.gatewayPrompt.mockResolvedValue({ error: 'read-only' })
    const res = await runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'x',
      background: false,
      timeoutSeconds: 5
    })
    expect(err(res)).toContain('NOT delivered')
    expect(err(res)).toContain('read-only')
    expect(err(res)).toContain('read-sub-session')
    expect(err(res)).not.toContain('send again when it is idle')
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
    // 派活时子会话必须是空闲的（否则命中忙碌拒绝，压根不会有 run）
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
    await runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'go',
      background: true,
      timeoutSeconds: 60
    })
    const requestId = lastRequestId()
    childAgent.isStreaming = true
    await runner.stop(PARENT, CHILD)
    release()
    // 实测里这条通知反而把父级叫醒去「收」一个它刚亲手停掉的东西，白烧一轮
    await runner.onDrivenSettled(settled({ requestId, reason: 'aborted' }))
    expect(mocks.deliver).not.toHaveBeenCalled()
  })

  it('卡在等批准时跑完的通知：说清在等批准并带出问题，而不是「跑完了」', async () => {
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
    await runner.onDrivenSettled(settled({ requestId: lastRequestId() }))
    const notice = mocks.deliver.mock.calls[0][1] as string
    expect(notice).toContain('ask the user for approval')
    expect(notice).toContain('rm -rf build')
    expect(notice).not.toContain('has finished')
  })

  it('已经有人在 wait 它 ⇒ 不再补一条通知（否则父级把刚拿到的又读一遍）', async () => {
    const busy = fakeAgent()
    mocks.getAgentSession.mockImplementation((id: string) => (id === CHILD ? busy : undefined))
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
    const requestId = lastRequestId()
    busy.isStreaming = true
    const waiting = runner.wait({ parentId: PARENT, childId: CHILD, timeoutSeconds: 30 })
    // 落定报来时 wait 正握着它（让 wait 先走到挂住那一步）
    await new Promise((r) => setTimeout(r, 20))
    await runner.onDrivenSettled(settled({ requestId }))
    busy.isStreaming = false
    release()
    await waiting
    expect(mocks.deliver).not.toHaveBeenCalled()
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
    closedChild.lastAnswer.mockResolvedValue({ text: 'DONE.' })
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

    busy.lastAnswer.mockResolvedValue({ text: 'LATE ANSWER.' })
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
    expect(await runner.stop(PARENT, CHILD)).toEqual({ stopped: false, id: CHILD })
    const child = fakeAgent({ isStreaming: true })
    mocks.getAgentSession.mockReturnValue(child)
    expect(await runner.stop(PARENT, CHILD)).toEqual({ stopped: true, id: CHILD })
    expect(child.abort).toHaveBeenCalled()
  })

  it('stop 也走同一套准入（不能停别人的子会话）', async () => {
    mocks.pick.mockImplementation((id: string) =>
      id === PARENT ? { settings: {}, parentId: null } : { settings: {}, parentId: 'other' }
    )
    expect(err(await runner.stop(PARENT, 'stranger'))).toContain('is not a sub-session')
  })
})

// ─── §19 父会话介入自己发起的那一轮（询问通知 / 代答 / 插话） ─────────────────────────
//
// 判据（§19.2）：子会话此刻这一轮是本进程替这个父会话驱动的、绑定的后台任务还活着。询问钩子
// （main 入口经 `setSessionAskObserver` 接进来的 onAskRaised / onAskResolved）在这里由 `raise` 与假门面的
// respondToInput 直接调（runner 单测里没有 index.ts）。枢纽是真的（桌面实例，合并窗口 250ms），时钟是假的：
// wait 的 200ms 轮询、后台 50ms 确认窗、前台超时、合并窗口都走同一个假时钟。
// 期望以 §19.10（含测试设计阶段改过的第 11–18 条）与源码为准。

const CHILD2 = 'child-2'
/** 这一轮的幂等键 = 枢纽里的任务 id（工具给 `subsession:<父会话>:<工具任务>`） */
const R = (n: number): string => `subsession:${PARENT}:${n}`
const STEER_RID = `subsession-steer:${PARENT}:9`

type Release = (result?: { error?: string; code?: string }) => void
type Runner = Mod['subSessionRunner']

/** 成功的结果（带 error 就让用例当场失败，而不是在后面的断言里含糊地红） */
function ok<T>(result: { error: string } | T): T {
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`unexpected error: ${(result as { error: string }).error}`)
  }
  return result as T
}

describe('§19 父会话介入自己发起的那一轮', () => {
  let child: FakeAgent

  const task = (rid: string): ReturnType<typeof registry.taskRegistry.get> =>
    registry.taskRegistry.get(rid)
  const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms)
  }

  /** S9：让下一次 gatewayPrompt 挂住；交回放行它的函数（缺省落定为 {} = 发出去了、这一轮正常结束） */
  function hold(): Release {
    let release!: (result: { error?: string; code?: string }) => void
    mocks.gatewayPrompt.mockReturnValueOnce(
      new Promise<{ error?: string; code?: string }>((r) => {
        release = r
      })
    )
    return (result = {}) => release(result)
  }

  /** S11：prompt 在建任务之前还有几次 await —— 等到任务出现（建任务与挂上等待者在同一段同步代码里） */
  async function untilTask(rid: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (registry.taskRegistry.get(rid)) return
      await Promise.resolve()
    }
    throw new Error(`任务 ${rid} 一直没建出来`)
  }

  /** 后台发一轮、过完 50ms 确认窗拿到启动回执；这一轮扣在闸门上（交回放行它的函数） */
  async function startBackground(
    n = 7,
    agent: FakeAgent = child
  ): Promise<{ rid: string; release: Release }> {
    const release = hold()
    const rid = R(n)
    const pending = runner.prompt({
      parentId: PARENT,
      childId: agent.sessionId,
      message: 'go',
      background: true,
      timeoutSeconds: 60,
      requestId: rid
    })
    await untilTask(rid)
    agent.isStreaming = true
    await advance(60)
    expect(await pending).toEqual({ kind: 'started', id: agent.sessionId })
    return { rid, release }
  }

  /** 前台发一轮、挂上等待（不推进时钟）；交回那次调用的 promise */
  async function startForeground(
    opts: { timeoutSeconds?: number; signal?: AbortSignal } = {}
  ): Promise<{
    rid: string
    release: Release
    pending: Promise<{ error: string } | PromptOutcome>
  }> {
    const release = hold()
    const rid = R(7)
    const pending = runner.prompt({
      parentId: PARENT,
      childId: CHILD,
      message: 'go',
      background: false,
      timeoutSeconds: opts.timeoutSeconds ?? 60,
      signal: opts.signal,
      requestId: rid
    })
    await untilTask(rid)
    child.isStreaming = true
    return { rid, release, pending }
  }

  /** S4：子会话弹出一条询问（模拟 main 入口的接线：询问此刻已在挂着的表里，再同步调钩子） */
  function raise(request: InputRequest, agent: FakeAgent = child): void {
    agent.asks.push(request)
    agent.isStreaming = true
    runner.onAskRaised(agent.sessionId, request)
  }

  /** 这一轮跑完：询问清空、不在跑，放行发送并等 runner 销账 */
  async function finishTurn(release: Release, agent: FakeAgent = child): Promise<void> {
    agent.asks = []
    agent.isStreaming = false
    release()
    await runner.drainForTests()
  }

  /** D 组的缺省前置：后台这一轮在跑（绑定任务活着）、停在 q1 上 */
  async function askingInBackground(): Promise<{ rid: string; release: Release }> {
    const turn = await startBackground()
    raise(q1())
    return turn
  }

  /** 前台这一轮因一条询问当场交回（WP3-09 的前置） */
  async function foregroundInput(
    request: InputRequest = q1()
  ): Promise<{ rid: string; release: Release; res: PromptOutcome }> {
    const { rid, release, pending } = await startForeground()
    raise(request)
    return { rid, release, res: ok(await pending) }
  }

  const answer = (
    over: Partial<Parameters<Runner['answer']>[0]> = {}
  ): ReturnType<Runner['answer']> =>
    runner.answer({
      parentId: PARENT,
      childId: CHILD,
      selections: ['A'],
      background: false,
      timeoutSeconds: 60,
      ...over
    })

  /** 后台代答：过完确认窗再拿结果（被拒的当场就有，推进时钟不碍事） */
  async function answerInBackground(
    over: Partial<Parameters<Runner['answer']>[0]> = {}
  ): ReturnType<Runner['answer']> {
    const pending = answer({ background: true, ...over })
    await advance(60)
    return pending
  }

  const steer = (over: Partial<Parameters<Runner['steer']>[0]> = {}): ReturnType<Runner['steer']> =>
    runner.steer({
      parentId: PARENT,
      childId: CHILD,
      message: 'also X',
      requestId: STEER_RID,
      ...over
    })

  /** 第 i 次枢纽投递的正文 */
  const hubText = (i = 0): string => mocks.hubDeliver.mock.calls[i][1] as string
  const count = (text: string, needle: string): number => text.split(needle).length - 1

  /** 某个会话行换一份（其余照缺省世界） */
  function overridePick(id: string, row: Record<string, unknown>): void {
    const base = mocks.pick.getMockImplementation()!
    mocks.pick.mockImplementation((asked: string, cols: string[]) =>
      asked === id ? row : base(asked, cols)
    )
  }

  /** 第二条子会话（WP3-50 ④ / WP3-77..82） */
  function addSecondChild(): FakeAgent {
    const other = fakeAgent({}, CHILD2)
    overridePick(CHILD2, { settings: {}, parentId: PARENT, title: 'Child 2', updatedAt: 3 })
    mocks.findChildren.mockReturnValue([
      { id: CHILD, title: 'Child', updatedAt: 2 },
      { id: CHILD2, title: 'Child 2', updatedAt: 3 }
    ])
    mocks.getAgentSession.mockImplementation((id: string) =>
      id === CHILD ? child : id === CHILD2 ? other : undefined
    )
    return other
  }

  beforeEach(() => {
    vi.useFakeTimers()
    // S6：infoOf 从 findChildren 取行 —— 不给就没有 info（WP3-16 专门测那一种）
    mocks.findChildren.mockReturnValue([{ id: CHILD, title: 'Child', updatedAt: 2 }])
    child = fakeAgent()
    mocks.getAgentSession.mockImplementation((id: string) => (id === CHILD ? child : undefined))
  })

  // ── A. 询问让绑定任务进出「等待输入」 ─────────────────────────────

  describe('A. 询问让绑定任务进出「等待输入」', () => {
    it('WP3-01 后台这一轮停下来问 ⇒ 绑定任务进 waiting-input：不落定、不中止、不另发', async () => {
      const { rid, release } = await startBackground()
      raise(q1())
      expect(task(rid)).toMatchObject({ status: 'waiting-input', endedAt: null })
      expect(child.abort).not.toHaveBeenCalled()
      expect(mocks.gatewayPrompt).toHaveBeenCalledTimes(1)
      release()
    })

    it('WP3-02 两条一起挂着：答掉一条仍在等输入，最后一条答掉才回到 running（仍不落定）', async () => {
      const { rid, release } = await startBackground()
      raise(q1())
      raise(q2())
      expect(child.respondToInput('q1', picked('A'))).toBe(true)
      // 还挂着一条：onAskResolved 读的是计数
      expect(task(rid)?.status).toBe('waiting-input')
      expect(child.respondToInput('q2', picked('X'))).toBe(true)
      expect(task(rid)).toMatchObject({ status: 'running', endedAt: null })
      release()
    })

    it('WP3-03 用户自己在子会话里发起的一轮（runner 从没驱动过它）：不建任务、不通知', async () => {
      child.isStreaming = true
      expect(() => raise(q1())).not.toThrow()
      await advance(300)
      expect(registry.taskRegistry.list(PARENT)).toEqual([])
      expect(registry.taskRegistry.runningCount(PARENT)).toBe(0)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
      expect(mocks.deliver).not.toHaveBeenCalled()
    })

    it('WP3-04 这一轮已落定之后再问：原任务仍是 done（对已结束的任务 update 无效），不通知', async () => {
      const { rid, release } = await startBackground()
      await finishTurn(release)
      expect(task(rid)?.status).toBe('done')
      raise(q1())
      await advance(300)
      expect(task(rid)?.status).toBe('done')
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
    })

    it('WP3-05 换进程（枢纽与 runner 的记账清空）之后的询问钩子：不抛、不建任务、不通知 —— 父会话要等自己重跑那次调用', async () => {
      const { rid, release } = await startBackground()
      raise(q1())
      registry.taskRegistry.killAll()
      runner.resetForTests()
      expect(() => {
        raise(q2())
        runner.onAskResolved(CHILD, 'q1')
      }).not.toThrow()
      await advance(300)
      expect(task(rid)).toBeUndefined()
      expect(registry.taskRegistry.list(PARENT)).toEqual([])
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
      release()
    })

    it('WP3-06 绑定任务已被杀（删会话的级联）、run 还没销账：boundRun 失效 —— 不更新、不通知，answer / steer 都拒', async () => {
      const { release } = await startBackground()
      registry.taskRegistry.killBySession(PARENT)
      raise(q1())
      await advance(300)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
      expect(err(await answerInBackground())).toContain('not in a turn you are driving now')
      expect(child.respondToInput).not.toHaveBeenCalled()
      expect(err(await steer())).toContain('was not started by you')
      expect(mocks.gatewaySteerDriven).not.toHaveBeenCalled()
      release()
    })

    it('WP3-07 main 入口对每一条开着的会话都调这对钩子：没有驱动的会话、父会话自己、不存在的 id —— 都不抛、不碰枢纽', async () => {
      expect(() => {
        runner.onAskRaised('random-id', q1())
        runner.onAskRaised(PARENT, q1())
        runner.onAskResolved('random-id', 'x')
        runner.onAskResolved(PARENT, 'q1')
      }).not.toThrow()
      await advance(300)
      expect(registry.taskRegistry.list(PARENT)).toEqual([])
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
    })

    it('WP3-08 任务面板第一次能显示「等待输入」：bg_task 广播依次出现 waiting-input 与 running 的快照', async () => {
      const spy = vi.spyOn(frontendRegistry, 'broadcast')
      try {
        const { rid, release } = await startBackground()
        raise(q1())
        child.respondToInput('q1', picked('A'))
        const statuses = spy.mock.calls
          .map(([event]) => event as { type: string; task?: { taskId: string; status: string } })
          .filter((e) => e.type === 'bg_task' && e.task?.taskId === rid)
          .map((e) => e.task!.status)
        expect(statuses).toContain('waiting-input')
        expect(statuses.slice(statuses.indexOf('waiting-input'))).toEqual([
          'waiting-input',
          'running'
        ])
        release()
      } finally {
        spy.mockRestore()
      }
    })
  })

  // ── B. 前台等待当场交回 ─────────────────────────────────────────

  describe('B. 前台等待当场交回询问', () => {
    it('WP3-09 前台 prompt 等着时子会话弹出选择题（经 onAskRaised 钩子）⇒ 不等超时当场交回 input，带完整的询问；不中止', async () => {
      // 不推进时钟：这次返回不是超时降级
      const { res, release } = await foregroundInput()
      expect(res).toMatchObject({ kind: 'input', id: CHILD })
      expect(res.info?.status).toBe('waiting-input')
      expect(res.info?.pendingAsks).toEqual([
        {
          id: 'q1',
          kind: 'question',
          question: 'Keep the old API?',
          options: [
            { label: 'A', description: 'keep a shim' },
            { label: 'B', description: '' }
          ],
          answerable: true
        }
      ])
      expect(child.abort).not.toHaveBeenCalled()
      release()
    })

    it('WP3-10 交回之后这一轮仍在：任务没落定、仍在等输入、转为脱离', async () => {
      const { rid, release } = await foregroundInput()
      expect(task(rid)).toMatchObject({ endedAt: null, status: 'waiting-input', detached: true })
      release()
    })

    it('WP3-11 同一条询问已由这次调用交回 ⇒ 窗口结束也不再通知', async () => {
      const { release } = await foregroundInput()
      await advance(300)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
      release()
    })

    it('WP3-12 交回之后这一轮跑完：照常经完成通知回报，并能叫醒父会话（wake）', async () => {
      const { rid, release } = await foregroundInput()
      await finishTurn(release)
      await runner.onDrivenSettled(settled({ requestId: rid, background: false }))
      expect(mocks.deliver).toHaveBeenCalledTimes(1)
      expect(mocks.deliver.mock.calls[0][3]).toEqual({ wake: true })
    })

    it('WP3-13 前台等待遇到权限卡也当场交回（§19.10 第 2 条），询问是 approval 摘要', async () => {
      const { res, release } = await foregroundInput(ap())
      expect(res.kind).toBe('input')
      expect(res.info?.pendingAsks).toEqual([
        { id: 'ap1', kind: 'approval', summary: 'bash: rm -rf build' }
      ])
      release()
    })

    it('WP3-14 重新挂上（幂等键 pending）时子会话已停在询问上：当场交回 input（不报忙、不说卡住），枢纽不再补通知', async () => {
      const rid = R(7)
      child.requestState.mockImplementation(async (id: string) => (id === rid ? 'pending' : 'none'))
      // 打开时被重新问了一遍：那时还没有绑定的 run，钩子什么都不做
      raise(q1())
      expect(registry.taskRegistry.list(PARENT)).toEqual([])
      const release = hold()
      const res = ok(
        await runner.prompt({
          parentId: PARENT,
          childId: CHILD,
          message: 'go',
          background: false,
          timeoutSeconds: 60,
          requestId: rid
        })
      )
      expect(res).toMatchObject({ kind: 'input', id: CHILD })
      expect(res.info?.pendingAsks).toEqual([
        expect.objectContaining({ id: 'q1', answerable: true })
      ])
      expect(task(rid)?.status).toBe('waiting-input')
      // update 先于 join 排了一次通知，但 join 当场交回时已记成看过：到点交回空
      await advance(300)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
      release()
    })

    it('WP3-15 同 WP3-14 但后台：确认窗里就把询问交回（裁决 3：结果是 input 而不是 started），枢纽不再补通知；跑完照常通知', async () => {
      const rid = R(7)
      child.requestState.mockImplementation(async (id: string) => (id === rid ? 'pending' : 'none'))
      raise(q1())
      const release = hold()
      const res = ok(
        await runner.prompt({
          parentId: PARENT,
          childId: CHILD,
          message: 'go',
          background: true,
          timeoutSeconds: 60,
          requestId: rid
        })
      )
      expect(res).toMatchObject({ kind: 'input', id: CHILD })
      expect(res.info?.pendingAsks?.map((a) => a.id)).toEqual(['q1'])
      await advance(300)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
      // 这一轮仍是后台的、没人在等它：跑完照常通知、叫醒父会话
      await finishTurn(release)
      await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
      expect(mocks.deliver).toHaveBeenCalledTimes(1)
      expect(mocks.deliver.mock.calls[0][3]).toEqual({ wake: true })
    })

    it('WP3-16 交回时子会话行恰好不见了：结果没有 info，但询问照样记成看过（裁决 9）—— 之后只通知新的那条', async () => {
      mocks.findChildren.mockReturnValue([])
      const { res, release } = await foregroundInput()
      expect(res).toEqual({ kind: 'input', id: CHILD })
      await advance(300)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
      raise(q2())
      await advance(260)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(1)
      expect(hubText()).toContain('<question ask_id="q2">')
      expect(hubText()).not.toContain('ask_id="q1"')
      release()
    })
  })

  // ── C. 没人等时的通知 ──────────────────────────────────────────

  describe('C. 没人等时经枢纽通知父会话', () => {
    it('WP3-17 / WP3-18 后台这一轮停在选择题上、没人在等：合并窗口结束恰一条通知，走枢纽（不是完成通知那条路）', async () => {
      await startBackground()
      raise(q1())
      await advance(260)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(1)
      const [sessionId, text] = mocks.hubDeliver.mock.calls[0] as [string, string]
      expect(sessionId).toBe(PARENT)
      expect(
        text.startsWith('<sub-session id="child-1" title="Child" status="waiting-input">')
      ).toBe(true)
      expect(text.endsWith('</sub-session>')).toBe(true)
      expect(text).toContain('It stopped to ask a question in the turn you started.')
      expect(text).toContain('<question ask_id="q1">')
      expect(text).toContain('Keep the old API?')
      expect(text).toContain('1. A — keep a shim')
      // 没有描述的选项不带破折号
      expect(text).toContain('\n2. B\n')
      expect(text).toContain('answer-sub-session')
      expect(text).not.toContain('for="user"')
      expect(text).not.toContain('<blocked-on-user-approval>')
      // WP3-18：完成通知那条路（sessionService.deliverSubSessionNotice）没被用
      expect(mocks.deliver).not.toHaveBeenCalled()
    })

    it('WP3-19 窗口里用户先答掉了：通知文本到窗口结束才求值，那时没有没看过的询问 ⇒ 不发', async () => {
      await startBackground()
      raise(q1())
      await advance(100)
      child.respondToInput('q1', picked('A'))
      await advance(200)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
    })

    it('WP3-20 窗口里这一轮落定了（询问还留在表里）⇒ 不发', async () => {
      const { release } = await startBackground()
      raise(q1())
      // 只放行这一轮，不清询问：隔离「这一轮已结束」这一条
      release()
      await runner.drainForTests()
      await advance(300)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
    })

    it('WP3-21 wait 正握着这条子会话：wait 自己交回（asking），枢纽不通知', async () => {
      await startBackground()
      const waiting = runner.wait({ parentId: PARENT, childId: CHILD, timeoutSeconds: 30 })
      await advance(0)
      raise(q1())
      await advance(300)
      expect(ok(await waiting).kind).toBe('asking')
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
    })

    it('WP3-22 同一窗口里先后两条询问：并成一条通知、一个 <sub-session> 块，两道题按出现次序', async () => {
      await startBackground()
      raise(q1())
      raise(q2())
      await advance(260)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(1)
      const text = hubText()
      expect(count(text, '<sub-session')).toBe(1)
      expect(count(text, '<question')).toBe(2)
      expect(text.indexOf('ask_id="q1"')).toBeLessThan(text.indexOf('ask_id="q2"'))
    })

    it('WP3-23 已经通知过 q1（仍挂着）之后又来 q2：第二条通知只说 q2', async () => {
      await startBackground()
      raise(q1())
      await advance(260)
      raise(q2())
      await advance(260)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(2)
      const second = hubText(1)
      expect(second).toContain('ask_id="q2"')
      expect(second).not.toContain('ask_id="q1"')
      expect(second).not.toContain('Keep the old API?')
    })

    it('WP3-24 前台已因 q1 交回、用户在子会话里先答掉了它，之后再问 q2：通知只含 q2，仍能代答（这一轮仍是父会话发起的）', async () => {
      const { release } = await foregroundInput()
      // 先到者胜：用户在子会话里答了（不经父会话）
      expect(child.respondToInput('q1', picked('A'))).toBe(true)
      raise(q2())
      await advance(260)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(1)
      const text = hubText()
      expect(text).toContain('<question ask_id="q2">')
      expect(text).not.toContain('ask_id="q1"')
      expect(text).not.toContain('for="user"')
      expect(text).toContain('answer-sub-session')
      release()
    })

    it('WP3-25 停在权限卡上：同路通知，内容只是转告（是什么、只有用户能解、该做什么）', async () => {
      await startBackground()
      raise(ap())
      await advance(260)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(1)
      const text = hubText()
      expect(text).toContain(
        'It stopped to ask the user for approval in the turn you started and cannot continue until the user answers in that session.'
      )
      expect(text).toContain('<blocked-on-user-approval>')
      expect(text).toContain('- bash: rm -rf build')
      expect(text).toContain('you cannot answer it')
      expect(text).toContain('stop-sub-session')
      expect(text).not.toContain('<question')
      expect(text).not.toContain('answer-sub-session')
    })

    it('WP3-26 同一窗口里权限卡与选择题都有：按选择题开头，<question> 块在前、权限卡合成一块放最后', async () => {
      await startBackground()
      raise(ap())
      raise(q1())
      await advance(260)
      const text = hubText()
      expect(text.split('\n')[1]).toBe('It stopped to ask a question in the turn you started.')
      expect(text.indexOf('<question ask_id="q1">')).toBeGreaterThan(-1)
      expect(text.indexOf('<question ask_id="q1">')).toBeLessThan(
        text.indexOf('<blocked-on-user-approval>')
      )
    })

    it('WP3-27 通知正文按形状认得出是系统通知（不记成用户说的话）—— 选择题、权限卡，以及与后台任务通知拼在一起', async () => {
      await startBackground()
      raise(q1())
      await advance(260)
      const question = hubText(0)
      child.respondToInput('q1', picked('A'))
      raise(ap())
      await advance(260)
      const approvalText = hubText(1)
      expect(approvalText).toContain('<blocked-on-user-approval>')
      const combined = `${question}\n\n<background-task id="t1" status="exited">\nexit 0\n</background-task>`
      expect(isSystemNoticeText(question)).toBe(true)
      expect(isSystemNoticeText(approvalText)).toBe(true)
      expect(isSystemNoticeText(combined)).toBe(true)
    })

    it('WP3-28 标题 / 询问 id 是 LLM 写的：开标签里属性转义；问题正文原样（多行保留、不改写）', async () => {
      overridePick(CHILD, { settings: {}, parentId: PARENT, title: 'Re"fac\ntor', updatedAt: 2 })
      await startBackground()
      raise(choice('c"1', 'Line one "quoted"\nline two', [{ label: 'A', description: '' }]))
      await advance(260)
      const text = hubText()
      expect(text.split('\n')[0]).toBe(
        `<sub-session id="child-1" title="Re'fac tor" status="waiting-input">`
      )
      expect(text).toContain(`<question ask_id="c'1">\nLine one "quoted"\nline two\n1. A\n`)
    })

    it('WP3-29 停止已下令、还没落定（用户从面板停）：之后弹出的询问不通知 —— 落定那条规则管它', async () => {
      const { rid, release } = await startBackground()
      expect(registry.taskRegistry.stop(rid, { by: 'user' })).toBe(true)
      raise(q1())
      await advance(300)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
      release()
    })

    it('WP3-30 窗口里换了一轮（A 落定、同一子会话起了 B 又问 q3）：恰一块通知、只说 q3 —— A 那块按「绑定的不再是它」交回空', async () => {
      const a = await startBackground(7)
      raise(q1())
      // 窗口内：q1 被答掉、A 跑完
      child.respondToInput('q1', picked('A'))
      await finishTurn(a.release)
      // 同一子会话新的后台一轮 B（发送时子会话空闲，否则被拒）
      const b = await startBackground(8)
      raise(q3())
      await advance(300)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(1)
      const text = hubText()
      expect(count(text, '<sub-session')).toBe(1)
      expect(text).toContain('ask_id="q3"')
      expect(text).not.toContain('ask_id="q1"')
      b.release()
    })

    it('WP3-31 同一 id 被重新问了一遍（superseded 重问）：按 id 记，同一条只告诉一次', async () => {
      await startBackground()
      raise(q1())
      await advance(260)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(1)
      child.asks = [q1()]
      runner.onAskRaised(CHILD, child.asks[0])
      await advance(260)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(1)
    })

    it('WP3-32 后台 prompt 的 50ms 确认窗里就弹出询问：由那次调用交回（裁决 3：结果 input），枢纽不补通知；跑完照常通知', async () => {
      const release = hold()
      const rid = R(7)
      const pending = runner.prompt({
        parentId: PARENT,
        childId: CHILD,
        message: 'go',
        background: true,
        timeoutSeconds: 60,
        requestId: rid
      })
      await untilTask(rid)
      child.isStreaming = true
      await advance(10)
      raise(q1())
      const res = ok(await pending)
      expect(res).toMatchObject({ kind: 'input', id: CHILD })
      expect(res.info?.pendingAsks).toEqual([
        expect.objectContaining({ id: 'q1', kind: 'question', answerable: true })
      ])
      await advance(400)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
      await finishTurn(release)
      await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
      expect(mocks.deliver).toHaveBeenCalledTimes(1)
      expect(mocks.deliver.mock.calls[0][3]).toEqual({ wake: true })
    })
  })

  // ── D. answer-sub-session ──────────────────────────────────────

  describe('D. answer-sub-session', () => {
    it('WP3-33 应答只送进这条子会话自己：答题方只走附带信息（clientId parent:… + answeredBy），载荷里没有 answeredBy', async () => {
      await askingInBackground()
      expect(await answerInBackground({ timeoutSeconds: 5 })).toEqual({
        kind: 'started',
        id: CHILD
      })
      expect(child.respondToInput).toHaveBeenCalledTimes(1)
      expect(child.respondToInput).toHaveBeenCalledWith(
        'q1',
        { kind: 'choice', selections: ['A'] },
        {
          clientId: 'parent:parent-1',
          answeredBy: { kind: 'parent-session', sessionId: 'parent-1', title: 'Parent' }
        }
      )
      expect(child.respondToInput.mock.calls[0][1]).not.toHaveProperty('answeredBy')
    })

    it('WP3-34 父会话行没有标题：answeredBy 恰为 {kind, sessionId}（没有 title 键）', async () => {
      overridePick(PARENT, { settings: {}, parentId: null, updatedAt: 1 })
      await askingInBackground()
      ok(await answerInBackground())
      const meta = child.respondToInput.mock.calls[0][2] as { answeredBy: unknown }
      expect(meta.answeredBy).toStrictEqual({ kind: 'parent-session', sessionId: PARENT })
    })

    it('WP3-35 selections 先 trim、去重、丢空串，保持首次出现顺序', async () => {
      await askingInBackground()
      ok(await answerInBackground({ selections: ['A', ' A ', 'B', ''] }))
      expect(child.respondToInput.mock.calls[0][1]).toEqual({
        kind: 'choice',
        selections: ['A', 'B']
      })
    })

    it.each([
      [
        '只给 message（两头空白去掉）',
        { selections: undefined, message: '  keep it  ' },
        { kind: 'other', text: 'keep it' }
      ],
      [
        'selections 是空数组 + message：空数组不算给了 selections',
        { selections: [], message: 'x' },
        { kind: 'other', text: 'x' }
      ]
    ])('WP3-36 %s ⇒ 用自己的话回答（other）', async (_label, over, sent) => {
      await askingInBackground()
      ok(await answerInBackground(over))
      expect(child.respondToInput.mock.calls[0][1]).toEqual(sent)
    })

    it('WP3-37 selections 与 message 二选一：都给就拒绝，什么都不发', async () => {
      await askingInBackground()
      const msg = err(await answerInBackground({ selections: ['A'], message: 'x' }))
      expect(msg).toContain('either')
      expect(msg).toContain('Nothing was sent')
      expect(child.respondToInput).not.toHaveBeenCalled()
    })

    it.each([
      ['什么都不给', { selections: undefined }],
      ['message 全是空白', { selections: undefined, message: '   ' }],
      ['selections 只有空白', { selections: ['  '] }]
    ])('WP3-38 %s ⇒ 拒绝，并列出全部选项', async (_label, over) => {
      await askingInBackground()
      const msg = err(await answerInBackground(over))
      expect(msg).toContain('`selections`')
      expect(msg).toContain('`message`')
      expect(msg).toContain('- A')
      expect(msg).toContain('- B')
      expect(child.respondToInput).not.toHaveBeenCalled()
    })

    it.each([
      [['a'], '"a"'],
      [['A', 'C'], '"C"']
    ])(
      'WP3-39 selections %j 对不上选项（逐字、大小写敏感）⇒ 拒绝，只点名对不上的那几个',
      async (selections, named) => {
        await askingInBackground()
        const msg = err(await answerInBackground({ selections }))
        expect(msg).toContain(`Not an option: ${named}.`)
        expect(msg).toContain('Nothing was sent')
        expect(msg).toContain('`message`')
        expect(msg).toContain('- A')
        expect(msg).toContain('- B')
        expect(child.respondToInput).not.toHaveBeenCalled()
      }
    )

    it('WP3-40 label 自带首尾空白：按 trim 之后匹配，送出去的是原 label', async () => {
      await startBackground()
      raise(
        choice('q1', 'Keep?', [
          { label: ' A ', description: '' },
          { label: 'B', description: '' }
        ])
      )
      ok(await answerInBackground({ selections: ['A'] }))
      expect(child.respondToInput.mock.calls[0][1]).toEqual({
        kind: 'choice',
        selections: [' A ']
      })
    })

    it('WP3-41 不给 ask_id、另外还挂着一张权限卡：只数选择题，答的是 q1', async () => {
      await askingInBackground()
      raise(ap())
      const res = ok(await answerInBackground())
      expect(child.respondToInput).toHaveBeenCalledTimes(1)
      expect(child.respondToInput.mock.calls[0][0]).toBe('q1')
      // 权限卡还挂着：确认窗里当场交回（这一轮仍在等用户批）
      expect(res.kind).toBe('input')
    })

    it('WP3-42 两道选择题都挂着、不给 ask_id ⇒ 问「哪一道」，列出 id 与问题（换行压成空格）', async () => {
      await askingInBackground()
      raise(
        choice('q2', 'Which\ndir?', [
          { label: 'X', description: '' },
          { label: 'Y', description: '' }
        ])
      )
      const msg = err(await answerInBackground())
      expect(msg.startsWith('Which question?')).toBe(true)
      expect(msg).toContain('  q1  Keep the old API?')
      expect(msg).toContain('  q2  Which dir?')
      expect(child.respondToInput).not.toHaveBeenCalled()
    })

    it('WP3-43 ask_id 点名一道不存在的题：有可答的就列出来；只挂着权限卡就不列', async () => {
      await askingInBackground()
      const listed = err(await answerInBackground({ askId: 'nope' }))
      expect(listed).toContain('No question "nope"')
      expect(listed).toContain('Waiting questions:')
      expect(listed).toContain('q1  Keep the old API?')

      // 只挂着权限卡
      child.asks = [ap()]
      const bare = err(await answerInBackground({ askId: 'nope' }))
      expect(bare).toContain('No question "nope"')
      expect(bare).not.toContain('Waiting questions')
      expect(child.respondToInput).not.toHaveBeenCalled()
    })

    it('WP3-44 只挂着权限卡：点名它（裁决 7：明说只有用户能批）或不点名（只有用户能解的那种拒绝）都不应答', async () => {
      await startBackground()
      raise(ap())
      const named = err(await answerInBackground({ askId: 'ap1' }))
      expect(named).toContain('"ap1" is an approval prompt — only the user can answer it')
      expect(named).toContain('stop-sub-session')
      expect(named).toContain('Nothing was sent.')
      expect(named).not.toContain('answer-sub-session')
      expect(named).not.toContain('Questions you may answer')

      const unnamed = err(await answerInBackground())
      expect(unnamed).toContain('rm -rf build')
      expect(unnamed).toContain('Tell the user')
      expect(unnamed).toContain('stop-sub-session')
      expect(unnamed).not.toContain('answer-sub-session')
      expect(child.respondToInput).not.toHaveBeenCalled()
    })

    it('WP3-45 同时挂着 q1 与权限卡、ask_id 点名权限卡：拒绝（明说只有用户能批），并附上可答的那几道', async () => {
      await askingInBackground()
      raise(ap())
      const msg = err(await answerInBackground({ askId: 'ap1' }))
      expect(msg).toContain('"ap1" is an approval prompt — only the user can answer it')
      expect(msg).toContain('Nothing was sent.')
      expect(msg).toContain('Questions you may answer:')
      expect(msg).toContain('  q1  Keep the old API?')
      expect(child.respondToInput).not.toHaveBeenCalled()
    })

    it('WP3-45b ask_id 点名的题已经不在挂着、而转写里它已有回答 ⇒ 拒绝并带出那个回答（多半是用户先答了，裁决 6）', async () => {
      await askingInBackground()
      // 用户先在子会话里答了 q1；转写里那次 ask 调用已经有结果
      child.respondToInput('q1', picked('B'))
      child.view = {
        ...emptySessionView(CHILD),
        messages: [
          {
            id: '5',
            role: 'assistant',
            type: 'message',
            blocks: [
              {
                type: 'tool',
                toolCallId: 'q1',
                toolName: 'ask',
                result: 'User selected:\n  B'
              }
            ],
            metadata: null
          } as never
        ]
      }
      const msg = err(await answerInBackground({ askId: 'q1' }))
      expect(msg).toContain('Question "q1" in sub-session "Child" was already answered')
      expect(msg).toContain('most likely by the user')
      expect(msg).toContain(': User selected: B. Nothing was sent.')
      expect(child.respondToInput).toHaveBeenCalledTimes(1)
    })

    /** 转写里有一次已经答过的 ask（toolCallId = q1） */
    const answeredInTranscript = (): SessionView => ({
      ...emptySessionView(CHILD),
      messages: [
        {
          id: '5',
          role: 'assistant',
          type: 'message',
          blocks: [
            { type: 'tool', toolCallId: 'q1', toolName: 'ask', result: 'User selected:\n  B' }
          ],
          metadata: null
        } as never
      ]
    })

    /** 父会话那一轮停在 q1 上、用户先在子会话里答了，这一轮随即跑完（绑定任务已落定，boundRun 不在） */
    async function answeredThenSettled(): Promise<void> {
      const { rid, release } = await askingInBackground()
      child.respondToInput('q1', picked('B'))
      child.view = answeredInTranscript()
      await finishTurn(release)
      expect(task(rid)?.status).toBe('done')
    }

    it('WP3-45c 这一轮已落定之后再点名一道已答的题：「已经答过」先于「这一轮归不归你」报，带出那个回答，不应答', async () => {
      await answeredThenSettled()
      const msg = err(await answerInBackground({ askId: 'q1' }))
      expect(msg).toContain('Question "q1" in sub-session "Child" was already answered')
      expect(msg).toContain(': User selected: B. Nothing was sent.')
      expect(msg).not.toContain('not waiting for an answer')
      expect(msg).not.toContain('not in a turn you are driving now')
      // 只有用户那一次
      expect(child.respondToInput).toHaveBeenCalledTimes(1)
    })

    it('WP3-45c 反向：这一轮已落定、ask_id 指向转写里没有的 id ⇒ 仍是原来的 not-waiting / not-yours 文案', async () => {
      await answeredThenSettled()
      // 子会话空闲、没挂询问：不在等回答
      const idle = err(await answerInBackground({ askId: 'nope' }))
      expect(idle).toContain('is not waiting for an answer (status: idle)')
      expect(idle).not.toContain('already answered')

      // 用户随后在子会话里起了新的一轮、又问了 q2：那一轮不是父会话的
      child.isStreaming = true
      child.asks.push(q2())
      const notYours = err(await answerInBackground({ askId: 'nope' }))
      expect(notYours).toContain('not in a turn you are driving now')
      expect(notYours).not.toContain('already answered')
      expect(child.respondToInput).toHaveBeenCalledTimes(1)
    })

    it('WP3-46 用户自己在子会话里发起的一轮里的提问：不是父会话的 —— 拒绝、不应答', async () => {
      child.isStreaming = true
      child.asks.push(q1())
      const msg = err(await answerInBackground())
      expect(msg).toContain('not in a turn you are driving now')
      expect(msg).toContain("the user's to answer")
      expect(msg).toContain('Nothing was sent.')
      expect(child.respondToInput).not.toHaveBeenCalled()
    })

    it('WP3-47 父会话那一轮已落定，之后用户的新一轮问 q1：同 WP3-46', async () => {
      const { release } = await startBackground()
      await finishTurn(release)
      child.isStreaming = true
      child.asks.push(q1())
      const msg = err(await answerInBackground())
      expect(msg).toContain('not in a turn you are driving now')
      expect(msg).toContain("the user's to answer")
      expect(child.respondToInput).not.toHaveBeenCalled()
    })

    it('WP3-48 子会话没开着：不在等回答 —— 从不为此打开会话', async () => {
      mocks.getAgentSession.mockImplementation(() => undefined)
      const msg = err(await answerInBackground())
      expect(msg).toContain('is not waiting for an answer (status: idle)')
      expect(msg).toContain('Nothing was sent')
      expect(mocks.peekAgentSession).not.toHaveBeenCalled()
      expect(mocks.ensureAgentSession).not.toHaveBeenCalled()
    })

    it('WP3-49 绑定任务活着但没挂任何询问 ⇒ 不在等回答', async () => {
      await startBackground()
      expect(err(await answerInBackground())).toContain(
        'is not waiting for an answer. Nothing was sent.'
      )
    })

    it.each([
      [
        '① 父会话是笔记本会话',
        (): void => overridePick(PARENT, { settings: { notebookPath: 'n.md' }, parentId: null }),
        CHILD,
        ['Notebook sessions']
      ],
      [
        '② 父会话自己是子会话',
        (): void => overridePick(PARENT, { settings: {}, parentId: 'grand', title: 'Parent' }),
        CHILD,
        ['nesting is limited to one level']
      ],
      [
        '③ childId 是别人的子会话',
        (): void => overridePick('stranger', { settings: {}, parentId: 'other', title: 'S' }),
        'stranger',
        ['is not a sub-session of this session', `${CHILD}  Child`]
      ],
      ['④ 两条子会话、省略 id', (): void => void addSecondChild(), '', ['Which sub-session?']]
    ])(
      'WP3-50 %s ⇒ 与 prompt 同一套准入：拒绝、不应答',
      async (_label, arrange, childId, expected) => {
        await askingInBackground()
        arrange()
        const msg = err(await answerInBackground({ childId }))
        for (const part of expected) expect(msg).toContain(part)
        expect(child.respondToInput).not.toHaveBeenCalled()
      }
    )

    it('WP3-50 ⑤ 恰一条子会话、省略 id ⇒ 自动补全到那一条并受理', async () => {
      await askingInBackground()
      ok(await answerInBackground({ childId: '' }))
      expect(child.respondToInput).toHaveBeenCalledWith('q1', picked('A'), expect.anything())
    })

    it('WP3-51 用户先答了（respond 认领不到）：前台也立刻如实回「什么都没发」，不挂住；记账没被改坏 —— 跑完照发一次完成通知', async () => {
      const { rid, release } = await askingInBackground()
      child.respondRefuses = true
      // 不推进时钟也返回
      const msg = err(await answer())
      expect(msg).toContain('already answered')
      expect(msg).toContain('nothing was sent')
      expect(msg).toContain('read-sub-session')
      await finishTurn(release)
      await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
      expect(mocks.deliver).toHaveBeenCalledTimes(1)
    })

    it('WP3-52 不经全局：broker 的 respondToUserInput、sessionService.respondToInput、网关都没被用来应答', async () => {
      await askingInBackground()
      ok(await answerInBackground())
      expect(child.respondToInput).toHaveBeenCalledTimes(1)
      expect(mocks.brokerRespond).not.toHaveBeenCalled()
      expect(mocks.respondToInput).not.toHaveBeenCalled()
      // 网关只有那一次 prompt，没有为代答另发什么
      expect(mocks.gatewayPrompt).toHaveBeenCalledTimes(1)
      expect(mocks.gatewaySteerDriven).not.toHaveBeenCalled()
    })

    it('WP3-53 前台代答：应答之后接着在前台等这一轮，跑完交回这一轮的答复', async () => {
      const { release } = await askingInBackground()
      let returned = false
      const pending = answer({ timeoutSeconds: 60 }).then((r) => {
        returned = true
        return r
      })
      // 先确认仍在等（S3 让任务回到 running，join 挂住而不是当场交回）
      await advance(1000)
      expect(returned).toBe(false)
      child.lastAnswer.mockResolvedValue({ text: 'DONE' })
      child.isStreaming = false
      release()
      const res = ok(await pending)
      expect(res).toMatchObject({ kind: 'answered', id: CHILD, answer: 'DONE' })
      expect(res.info).toBeDefined()
      expect(res.info?.status).not.toBe('waiting-input')
    })

    it.each([
      ['落定先报来、前台代答还在等', 'settled-first'],
      ['前台代答先交回、落定后报来', 'answer-first']
    ])('WP3-54 %s ⇒ 都不发完成通知（前台已交回答复）', async (_label, order) => {
      const { rid, release } = await askingInBackground()
      child.lastAnswer.mockResolvedValue({ text: 'DONE' })
      const pending = answer()
      await advance(0)
      child.isStreaming = false
      if (order === 'settled-first') {
        await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
        release()
        expect(ok(await pending).kind).toBe('answered')
      } else {
        release()
        expect(ok(await pending).kind).toBe('answered')
        await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
      }
      expect(mocks.deliver).not.toHaveBeenCalled()
    })

    it('WP3-55 前台代答之后子会话又问了一道：再次当场交回（只带新的那道），不通知；之后跑完又脱离了 —— 完成通知一次', async () => {
      const { rid, release } = await askingInBackground()
      const pending = answer()
      await advance(0)
      raise(q2())
      const res = ok(await pending)
      expect(res).toMatchObject({ kind: 'input', id: CHILD })
      expect(res.info?.pendingAsks).toEqual([
        expect.objectContaining({ id: 'q2', kind: 'question' })
      ])
      await advance(300)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
      await finishTurn(release)
      await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
      expect(mocks.deliver).toHaveBeenCalledTimes(1)
    })

    it('WP3-56 两道都挂着、点名答 q1：不等 —— 立刻交回还挂着的 q2，任务仍在等输入', async () => {
      const { rid, release } = await askingInBackground()
      raise(q2())
      const res = ok(await answer({ askId: 'q1' }))
      expect(res.kind).toBe('input')
      expect(res.info?.pendingAsks?.map((a) => a.id)).toEqual(['q2'])
      expect(task(rid)?.status).toBe('waiting-input')
      release()
    })

    it('WP3-57 前台代答到点：降级（不中止），之后跑完完成通知一次、能叫醒父会话', async () => {
      const { rid, release } = await askingInBackground()
      const pending = answer({ timeoutSeconds: 1 })
      await advance(1000)
      expect(await pending).toEqual({ kind: 'timeout', id: CHILD })
      expect(child.abort).not.toHaveBeenCalled()
      await finishTurn(release)
      await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
      expect(mocks.deliver).toHaveBeenCalledTimes(1)
      expect(mocks.deliver.mock.calls[0][3]).toEqual({ wake: true })
    })

    it('WP3-58 前台代答时父会话被停：级联中止子会话（经任务的 stop），收尾之后交回答复，完成通知不发', async () => {
      const { rid, release } = await askingInBackground()
      const ac = new AbortController()
      const pending = answer({ signal: ac.signal })
      ac.abort()
      expect(child.abort).toHaveBeenCalledTimes(1)
      child.isStreaming = false
      release()
      expect(ok(await pending).kind).toBe('answered')
      await runner.onDrivenSettled(settled({ requestId: rid, background: true, reason: 'aborted' }))
      expect(mocks.deliver).not.toHaveBeenCalled()
    })

    it('WP3-59 后台代答：立刻回执；父会话之后被停**不**级联；跑完完成通知一次、能叫醒父会话', async () => {
      const { rid, release } = await askingInBackground()
      const ac = new AbortController()
      expect(await answerInBackground({ signal: ac.signal })).toEqual({
        kind: 'started',
        id: CHILD
      })
      ac.abort()
      expect(child.abort).not.toHaveBeenCalled()
      await finishTurn(release)
      await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
      expect(mocks.deliver).toHaveBeenCalledTimes(1)
      expect(mocks.deliver.mock.calls[0][3]).toEqual({ wake: true })
    })

    it('WP3-60 前台 prompt 已因 q1 交回（记账 released）、再前台代答到跑完：交回答复，完成通知不发（记账改回 held）', async () => {
      const { rid, release } = await foregroundInput()
      const pending = answer()
      await advance(1000)
      child.lastAnswer.mockResolvedValue({ text: 'DONE' })
      child.isStreaming = false
      release()
      expect(ok(await pending)).toMatchObject({ kind: 'answered', answer: 'DONE' })
      await runner.onDrivenSettled(settled({ requestId: rid, background: false }))
      expect(mocks.deliver).not.toHaveBeenCalled()
    })

    it('WP3-61 前台超时降级之后才问：这一轮仍是父会话的 —— 通知里没有 for="user"，代答受理', async () => {
      const { pending } = await startForeground({ timeoutSeconds: 1 })
      await advance(1000)
      expect(await pending).toEqual({ kind: 'timeout', id: CHILD })
      raise(q1())
      await advance(260)
      expect(hubText()).toContain('<question ask_id="q1">')
      expect(hubText()).not.toContain('for="user"')
      expect(await answerInBackground()).toEqual({ kind: 'started', id: CHILD })
      expect(child.respondToInput).toHaveBeenCalledWith('q1', picked('A'), expect.anything())
    })

    it('WP3-62 换进程之后重跑同一次代答（子会话的 ask 重跑、同一 id 再挂）：绝不答第二次，文案说明可能重启过（裁决 4）', async () => {
      const { release } = await askingInBackground()
      registry.taskRegistry.killAll()
      runner.resetForTests()
      child.asks = [q1()]
      runner.onAskRaised(CHILD, child.asks[0])
      const msg = err(await answerInBackground())
      expect(child.respondToInput).not.toHaveBeenCalled()
      expect(msg).toContain('not in a turn you are driving now')
      expect(msg).toContain('the app restarted since')
      expect(msg).toContain('Nothing was sent.')
      release()
    })
  })

  // ── E. steer-sub-session ───────────────────────────────────────

  describe('E. steer-sub-session', () => {
    it('WP3-63 自己发起、正在跑的那一轮：走网关的 steerDriven（trim、幂等键、父会话），不另发、不另建任务', async () => {
      await startBackground()
      expect(await steer({ message: '  also X  ' })).toEqual({ id: CHILD, title: 'Child' })
      expect(mocks.gatewaySteerDriven).toHaveBeenCalledTimes(1)
      expect(mocks.gatewaySteerDriven).toHaveBeenCalledWith(CHILD, 'also X', {
        requestId: STEER_RID,
        parentId: PARENT
      })
      expect(mocks.gatewayPrompt).toHaveBeenCalledTimes(1)
      expect(registry.taskRegistry.list(PARENT)).toHaveLength(1)
    })

    it('WP3-64 子会话空闲、没有驱动：拒绝，指向 prompt-sub-session', async () => {
      const msg = err(await steer())
      expect(msg).toContain('is idle')
      expect(msg).toContain('prompt-sub-session')
      expect(mocks.gatewaySteerDriven).not.toHaveBeenCalled()
    })

    it.each([
      [
        '开着、被中断',
        (): void => {
          child.isInterrupted = true
        }
      ],
      [
        '没开着、DB 镜像 runState interrupted',
        (): void => {
          mocks.getAgentSession.mockImplementation(() => undefined)
          overridePick(CHILD, {
            settings: { runState: 'interrupted' },
            parentId: PARENT,
            title: 'Child',
            updatedAt: 2
          })
        }
      ]
    ])('WP3-65 %s ⇒ 拒绝：新的 prompt 会重来', async (_label, arrange) => {
      arrange()
      const msg = err(await steer())
      expect(msg).toContain('interrupted')
      expect(msg).toContain('prompt-sub-session')
      expect(mocks.gatewaySteerDriven).not.toHaveBeenCalled()
    })

    it('WP3-66 在跑的这一轮是用户自己发起的：拒绝', async () => {
      child.isStreaming = true
      expect(err(await steer())).toContain('was not started by you')
      expect(mocks.gatewaySteerDriven).not.toHaveBeenCalled()
    })

    it('WP3-67 卡在可代答的提问上：拒绝，指向 answer-sub-session（想说的话放进 message）', async () => {
      await askingInBackground()
      const msg = err(await steer())
      expect(msg).toContain('answer-sub-session')
      expect(msg).toContain('`message`')
      expect(mocks.gatewaySteerDriven).not.toHaveBeenCalled()
    })

    it('WP3-68 只卡在权限卡上：拒绝，转告用户（不提 answer-sub-session）', async () => {
      await startBackground()
      raise(ap())
      const msg = err(await steer())
      expect(msg).toContain('rm -rf build')
      expect(msg).toContain('Tell the user')
      expect(msg).not.toContain('answer-sub-session')
      expect(mocks.gatewaySteerDriven).not.toHaveBeenCalled()
    })

    it.each([
      ['settled，这一轮仍在跑', 'settled', true],
      ['pending，这一轮仍在跑', 'pending', true],
      ['settled，子会话此刻已空闲且没有驱动', 'settled', false]
    ])(
      'WP3-69 子会话已认得这个幂等键（%s）⇒ 重跑：照报送达过、不再发（幂等检查先于状态检查）',
      async (_label, state, driven) => {
        if (driven) await startBackground()
        child.requestState.mockImplementation(async (id: string) =>
          id === STEER_RID ? state : 'none'
        )
        expect(await steer()).toEqual({ id: CHILD, title: 'Child', earlier: true })
        expect(mocks.gatewaySteerDriven).not.toHaveBeenCalled()
      }
    )

    it('WP3-70 网关回报没送到（busy）：如实说没送到、没排队', async () => {
      await startBackground()
      mocks.gatewaySteerDriven.mockResolvedValue({ error: 'The agent is busy', code: 'busy' })
      const msg = err(await steer())
      expect(msg).toContain('NOT delivered')
      expect(msg).toContain('The agent is busy')
      expect(msg).toContain('Nothing was queued')
    })

    it('WP3-71 空消息：拒绝在任何判定之前（不问幂等键、不碰网关）', async () => {
      expect(err(await steer({ message: '   ' }))).toContain('non-empty')
      expect(mocks.gatewaySteerDriven).not.toHaveBeenCalled()
      expect(child.requestState).not.toHaveBeenCalled()
    })

    it('WP3-72 准入：笔记本父会话、别人的子会话拒绝；恰一条子会话省略 id ⇒ 补全并送达', async () => {
      await startBackground()
      overridePick('stranger', { settings: {}, parentId: 'other', title: 'S' })
      expect(err(await steer({ childId: 'stranger' }))).toContain(
        'is not a sub-session of this session'
      )
      expect(await steer({ childId: '' })).toEqual({ id: CHILD, title: 'Child' })
      expect(mocks.gatewaySteerDriven).toHaveBeenCalledTimes(1)
      overridePick(PARENT, { settings: { notebookPath: 'n.md' }, parentId: null })
      expect(err(await steer())).toContain('Notebook sessions')
      expect(mocks.gatewaySteerDriven).toHaveBeenCalledTimes(1)
    })

    it('WP3-73 steer 不改记账：这一轮跑完，结果仍由原来那次 prompt 的路交回 —— 完成通知恰一次', async () => {
      const { rid, release } = await startBackground()
      ok(await steer())
      await finishTurn(release)
      await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
      expect(mocks.deliver).toHaveBeenCalledTimes(1)
    })

    it('WP3-74 现状（§19.10 第 6 条，已知窄窗口）：检查之后、送达之前这一轮刚好结束 —— 照报送达，没有绑定任务', async () => {
      const { release } = await startBackground()
      mocks.gatewaySteerDriven.mockImplementation(async () => {
        child.isStreaming = false
        release()
        await runner.drainForTests()
        return {}
      })
      expect(await steer()).toEqual({ id: CHILD, title: 'Child' })
      expect(registry.taskRegistry.list(PARENT).map((t) => t.status)).toEqual(['done'])
    })
  })

  // ── F. wait 的外层状态与 prompt 的拒绝 ─────────────────────────

  describe('F. wait 的外层状态与 prompt 的拒绝', () => {
    it('WP3-75 自己发起的那一轮停在可代答的提问上：wait 外层是 asking，结果里带完整询问', async () => {
      await askingInBackground()
      const res = ok(await runner.wait({ parentId: PARENT, timeoutSeconds: 5 }))
      expect(res.kind).toBe('asking')
      expect(res.results[0].pendingAsks?.[0]).toMatchObject({
        id: 'q1',
        kind: 'question',
        answerable: true
      })
    })

    it('WP3-76 用户自己那一轮里的提问：wait 外层是 blocked，询问标成不能代答', async () => {
      child.isStreaming = true
      child.asks.push(q1())
      const res = ok(await runner.wait({ parentId: PARENT, childId: CHILD, timeoutSeconds: 5 }))
      expect(res.kind).toBe('blocked')
      expect(res.results[0].pendingAsks?.[0]).toMatchObject({ id: 'q1', answerable: false })
    })

    it('WP3-77 两条：A 在父会话这一轮里问、B 只挂权限卡 ⇒ asking（有一条能代答就是 asking），B 的是 approval', async () => {
      const other = addSecondChild()
      await askingInBackground()
      raise(ap(), other)
      const res = ok(await runner.wait({ parentId: PARENT, timeoutSeconds: 5 }))
      expect(res.kind).toBe('asking')
      expect(res.results.find((r) => r.id === CHILD2)?.pendingAsks).toEqual([
        { id: 'ap1', kind: 'approval', summary: 'bash: rm -rf build' }
      ])
    })

    it('WP3-78 现状（裁决 2）：wait 握着两条、A 问了之后 wait 随即被中止 ⇒ aborted，结果里 A 带着 q1；那条询问不补通知', async () => {
      const other = addSecondChild()
      await startBackground(7)
      await startBackground(8, other)
      const ac = new AbortController()
      const waiting = runner.wait({ parentId: PARENT, timeoutSeconds: 30, signal: ac.signal })
      await advance(0)
      raise(q1())
      ac.abort()
      const res = ok(await waiting)
      expect(res.kind).toBe('aborted')
      expect(res.results.find((r) => r.id === CHILD)?.pendingAsks?.[0]).toMatchObject({
        id: 'q1'
      })
      await advance(300)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
    })

    it('WP3-79 wait 只握着 B：A 的询问照常通知（只说 A）', async () => {
      const other = addSecondChild()
      await startBackground(7)
      await startBackground(8, other)
      const waiting = runner.wait({ parentId: PARENT, childId: CHILD2, timeoutSeconds: 30 })
      await advance(0)
      raise(q1())
      await advance(260)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(1)
      expect(hubText()).toContain('id="child-1"')
      expect(hubText()).not.toContain(CHILD2)
      other.isStreaming = false
      await advance(200)
      expect(ok(await waiting).kind).toBe('settled')
    })

    it('WP3-80 再 prompt 撞上自己那一轮停在可代答的提问上（裁决 1）：拒绝文案指向 answer-sub-session 并带 ask_id，不另发', async () => {
      await askingInBackground()
      const msg = err(
        await runner.prompt({
          parentId: PARENT,
          childId: CHILD,
          message: 'next',
          background: false,
          timeoutSeconds: 60
        })
      )
      expect(msg).toContain('answer-sub-session')
      expect(msg).toContain('ask_id q1')
      expect(msg).not.toContain('wait-for-sub-sessions')
      expect(mocks.gatewayPrompt).toHaveBeenCalledTimes(1)
    })

    it('WP3-81 prompt 撞上用户自己那一轮里的提问：拒绝，转告用户（不提 answer-sub-session）', async () => {
      child.isStreaming = true
      child.asks.push(q1())
      const msg = err(
        await runner.prompt({
          parentId: PARENT,
          childId: CHILD,
          message: 'next',
          background: false,
          timeoutSeconds: 60
        })
      )
      expect(msg).toContain('will NOT proceed on its own')
      expect(msg).toContain('Tell the user')
      expect(msg).not.toContain('answer-sub-session')
      expect(mocks.gatewayPrompt).not.toHaveBeenCalled()
    })

    it('WP3-82 wait 握着两条、A 停下来问（裁决 11）：不再陪着 B 等 —— 返回 asking 带 A 的 q1，B 仍在跑；交回之前已记成看过，枢纽不再通知', async () => {
      const other = addSecondChild()
      await startBackground(7)
      await startBackground(8, other)
      const waiting = runner.wait({ parentId: PARENT, timeoutSeconds: 30 })
      await advance(0)
      raise(q1())
      await advance(300)
      const res = ok(await waiting)
      expect(res.kind).toBe('asking')
      expect(res.results.find((r) => r.id === CHILD)?.pendingAsks?.[0]).toMatchObject({
        id: 'q1',
        answerable: true
      })
      expect(res.results.find((r) => r.id === CHILD2)?.status).toBe('running')
      await advance(500)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
    })
  })

  // ── J. 竞态与记账 ──────────────────────────────────────────────

  describe('J. 竞态与记账', () => {
    it('WP3-104 应答与这一轮结束交错（应答返回之前这一轮已经放行）：交回 answered，不挂死、不报超时；完成通知不发', async () => {
      const { rid, release } = await askingInBackground()
      child.lastAnswer.mockResolvedValue({ text: 'DONE' })
      child.respondToInput.mockImplementation((requestId: string): boolean => {
        child.asks = child.asks.filter((a) => a.id !== requestId)
        runner.onAskResolved(CHILD, requestId)
        child.isStreaming = false
        release()
        return true
      })
      expect(ok(await answer())).toMatchObject({ kind: 'answered', answer: 'DONE' })
      await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
      expect(mocks.deliver).not.toHaveBeenCalled()
    })

    it.each([
      ['落定报在先交回 input 的那次之后、另一次还在等时', 'between'],
      ['两次代答都收尾之后才报来', 'late']
    ])(
      'WP3-105 并行两次前台代答（同一子会话两道题）、%s ⇒ 一次 input、一次 answered，完成通知 0 次（按 holders 计，裁决 5）',
      async (_label, order) => {
        const { rid, release } = await askingInBackground()
        raise(q2())
        child.lastAnswer.mockResolvedValue({ text: 'DONE' })
        const first = answer({ askId: 'q1' })
        const second = answer({ askId: 'q2', selections: ['X'] })
        // 答掉 q1 时 q2 还挂着：先返回的那次是 input
        expect(ok(await first).kind).toBe('input')
        if (order === 'between') {
          await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
        }
        child.isStreaming = false
        release()
        expect(ok(await second)).toMatchObject({ kind: 'answered', answer: 'DONE' })
        if (order === 'late') {
          await runner.onDrivenSettled(settled({ requestId: rid, background: true }))
        }
        expect(mocks.deliver).not.toHaveBeenCalled()
      }
    )

    it('WP3-106 前台 prompt 因 q1 交回 → 前台代答 q1 → 子会话问 q2 → 前台代答 q2 → 跑完：依次 input / input / answered；没有任何通知；任务恰一条、最后 done', async () => {
      const { rid, release, res: first } = await foregroundInput()
      const secondPending = answer()
      raise(q2())
      const second = ok(await secondPending)
      const thirdPending = answer({ selections: ['X'] })
      child.lastAnswer.mockResolvedValue({ text: 'DONE' })
      child.isStreaming = false
      release()
      const third = ok(await thirdPending)
      expect([first.kind, second.kind, third.kind]).toEqual(['input', 'input', 'answered'])
      await advance(300)
      await runner.onDrivenSettled(settled({ requestId: rid, background: false }))
      expect(mocks.hubDeliver).not.toHaveBeenCalled()
      expect(mocks.deliver).not.toHaveBeenCalled()
      expect(registry.taskRegistry.list(PARENT).map((t) => t.status)).toEqual(['done'])
    })

    it('WP3-107 read 交出去的询问记成看过（裁决 8）：窗口结束不再通知；list 不渲染询问、不记 —— 之后的新询问照常通知', async () => {
      await askingInBackground()
      const read = ok(await runner.read(PARENT, CHILD))
      expect(read.info.pendingAsks?.map((a) => a.id)).toEqual(['q1'])
      await advance(300)
      expect(mocks.hubDeliver).not.toHaveBeenCalled()

      raise(q2())
      ok(runner.list(PARENT))
      await advance(300)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(1)
      expect(hubText()).toContain('ask_id="q2"')
      expect(hubText()).not.toContain('ask_id="q1"')
    })

    it('WP3-108 「看过」按轮记、落定时清掉：新的一轮里与上一轮同 id 的询问照常通知（provider 每轮从 call_0 数起）', async () => {
      const a = await startBackground(7)
      raise(q1())
      await advance(260)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(1)
      await finishTurn(a.release)
      const b = await startBackground(8)
      raise(q1())
      await advance(260)
      expect(mocks.hubDeliver).toHaveBeenCalledTimes(2)
      expect(hubText(1)).toContain('<question ask_id="q1">')
      b.release()
    })
  })

  // ── K. 守护 ─────────────────────────────────────────────────

  it('WP3-109 main 入口：询问钩子的两路（桌面通知 / 子会话运行器）各自接上，且各自 try 隔离（一路抛错不拦另一路）', () => {
    // initSharedWindowServices 不导出：只能读源码
    const source = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8')
    const start = source.indexOf('setSessionAskObserver({')
    expect(start).toBeGreaterThan(-1)
    const observer = source.slice(start, source.indexOf('\n  })', start))
    expect(observer).toMatch(
      /askRaised:[\s\S]*?eachSafely\(\s*\(\) => notifyAskRaised\(sessionId, request\),\s*\(\) => subSessionRunner\.onAskRaised\(sessionId, request\)\s*\)/
    )
    expect(observer).toMatch(
      /askResolved:[\s\S]*?eachSafely\(\s*\(\) => notifyAskResolved\(sessionId, requestId\),\s*\(\) => subSessionRunner\.onAskResolved\(sessionId, requestId\)\s*\)/
    )
    // 每一路各包一个 try：一路抛错只记日志，循环接着调下一路
    expect(source).toMatch(
      /const eachSafely = \(\.\.\.calls: Array<\(\) => void>\): void => \{\s*for \(const call of calls\) \{\s*try \{\s*call\(\)\s*\} catch/
    )
  })
})

/**
 * sessionService.pinAgentProfile —— 给**刚建好的子会话**钉父级点名的档案。
 *
 * 它是 `settings.agentProfile` 如今唯一的写入口（session 工具 `create-sub-session` 的
 * `agent_profile`，经 subSessionRunner.create 调用）。钉的是：
 *   - **准入三拒**：非子会话（含会话不存在）/ 未知名 / 基座名（work / chat / notebook）——
 *     且每一种拒绝都**零副作用**：不落库、不失效运行时、不往会话树写种子、不广播；
 *     非子会话那一拒还在 getProfile 之前（方法体第一句）。曾经的第四拒「未声明
 *     `shuvix-session-awareness`」随该键退役而消失：其余任何档案都可以被点名；
 *   - 基座拒绝的判据是**名字**：子会话不点名就自然落到自己形态的基座上，点名一个基座
 *     只会得到说不清的组合；
 *   - **成功链顺序**：落库 → invalidateAgent → 种子（模型 / mcp:/skill: 工具）→ 广播。
 *     落库在 invalidate 前、种子在 invalidate 后：钉档案与重建之间不能有一个还在写树的旧运行时；
 *   - **工具种子**：声明了 mcp:/skill: 就整份替换扩展能力勾选（`settings.enabledTools`）；
 *     没声明就不写 —— 勾选已在 create 时从父会话抄好，空声明不算意见；
 *   - 模型三态：可解析 → 写种子 + `applied.model`；不可解析 → 不写、`modelUnavailable` 回传原值、
 *     其余照常；未声明 → 不去解析。
 *
 * mock 面照旧（import 图全换假件，只留 chat-protocol / agent-runtime 真件）。`isSessionProfile`
 * 在假件里用**真判据**复算（`!BASE_PROFILE_NAMES.has(name)`，名单常量取真件）
 * —— 真 agentService 要 electron + 用户目录，本文件够不到；假件退化成「恒 true」会让基座那一拒
 * 失去意义。invalidateAgent 用实例级 spy（经 this. 动态派发可拦截，保留穿透：底层
 * SessionManager.remove 对无运行时的会话直接 resolve）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi, type MockInstance } from 'vitest'
import { BASE_PROFILE_NAMES, type AgentProfile } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoUpdateSettings: vi.fn(),
  getProfile: vi.fn<(name: string) => unknown>(),
  resolveProfileModelSpec: vi.fn(),
  appendModelChange: vi.fn(),
  broadcastSessionConfigChanged: vi.fn()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pick: mocks.daoPick, updateSettings: mocks.daoUpdateSettings }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: {} }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/projectDao', () => ({ projectDao: {} }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: {} }))
vi.mock('../messageService', () => ({ messageService: {} }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: vi.fn(),
  addSessionTreePin: vi.fn(),
  appendModelChange: mocks.appendModelChange
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({ getTempWorkspace: vi.fn(), getToolResultsBase: vi.fn() }))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../toolAggregator', () => ({
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../agentService', () => ({
  agentService: {
    getProfile: mocks.getProfile,
    // 与 agentService.isSessionProfile 同一条表达式（名单常量取真件）
    isSessionProfile: (p: AgentProfile) => !BASE_PROFILE_NAMES.has(p.name)
  }
}))
vi.mock('../agentSession', () => ({ AgentSession: class {} }))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({
  resolveProfileModelSpec: mocks.resolveProfileModelSpec
}))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: mocks.broadcastSessionConfigChanged,
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../userInputBroker', () => ({ registerUserInputParticipant: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

let sessionService: (typeof import('../sessionService'))['sessionService']
let invalidateSpy: MockInstance<(sessionId: string) => Promise<void>>

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  invalidateSpy = vi.spyOn(sessionService, 'invalidateAgent')
})
beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  invalidateSpy.mockClear()
  // 缺省：被测会话是一条子会话（准入第一关放行），各例只改自己关心的那一格
  mocks.daoPick.mockReturnValue({ parentId: 'P' })
})

const SID = 'child-1'

/** 一份档案（name 决定基座判定，那是准入唯一看的东西） */
const profile = (
  name: string,
  over: Partial<Pick<AgentProfile, 'tools' | 'model'>> = {}
): Partial<AgentProfile> => ({
  name,
  tools: over.tools ?? ['read'],
  ...(over.model ? { model: over.model } : {})
})

type PinResult = Awaited<ReturnType<(typeof sessionService)['pinAgentProfile']>>

const pin = (name: string): Promise<PinResult> => sessionService.pinAgentProfile(SID, name)

/** 拒绝路径的零副作用：落库 / 失效 / 两种种子 / 广播 / 模型解析一个都不许发生 */
function expectNoSideEffects(): void {
  expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
  expect(invalidateSpy).not.toHaveBeenCalled()
  expect(mocks.appendModelChange).not.toHaveBeenCalled()
  expect(mocks.broadcastSessionConfigChanged).not.toHaveBeenCalled()
  expect(mocks.resolveProfileModelSpec).not.toHaveBeenCalled()
}

describe('准入 —— 三种拒绝，都零副作用', () => {
  it.each([
    ['根会话（parentId 为 null）', { parentId: null }],
    ['会话不存在', undefined]
  ])('PIN-1 非子会话拒绝（%s）：错误含 Only a sub-session，且先于 getProfile', async (_l, row) => {
    // 守在方法体第一句：拒绝必须先于 getProfile / 落库 / 种子 / invalidate
    mocks.daoPick.mockReturnValue(row)
    mocks.getProfile.mockReturnValue(profile('coding'))
    const res = await pin('coding')
    expect(res.success).toBe(false)
    expect(res.error).toContain('Only a sub-session')
    expect(mocks.getProfile).not.toHaveBeenCalled()
    expectNoSideEffects()
  })

  it('PIN-2 未知名：错误为 Unknown agent "x"，零副作用', async () => {
    mocks.getProfile.mockReturnValue(undefined)
    const res = await pin('x')
    expect(res).toEqual({ success: false, error: 'Unknown agent "x"' })
    expectNoSideEffects()
  })

  it.each(['work', 'chat', 'notebook'])(
    'PIN-3 基座名 %s 拒绝：错误含 base profile 与 omit agent_profile',
    async (name) => {
      // 用户覆盖的 work.md 也是基座（判名字）。错误文案里的「omit agent_profile」是模型的下一步
      mocks.getProfile.mockReturnValue(profile(name))
      const res = await pin(name)
      expect(res.success).toBe(false)
      expect(res.error).toContain('base profile')
      expect(res.error).toContain('omit agent_profile')
      expectNoSideEffects()
    }
  )

  it.each(['wiki-writer', 'titler', 'my-plain-agent'])(
    'PIN-4 曾经只可派发的档案 %s 现在照常钉得上 —— 会话感知这道门已退役',
    async (name) => {
      mocks.getProfile.mockReturnValue(profile(name))
      const res = await pin(name)
      expect(res.success).toBe(true)
      expect(mocks.daoUpdateSettings).toHaveBeenCalledWith(SID, { agentProfile: name })
    }
  )
})

describe('成功链', () => {
  it('PIN-5 普通具名档案：落库 → invalidate → 工具种子 → 广播，返回 applied', async () => {
    mocks.getProfile.mockReturnValue(profile('myprof', { tools: ['read', 'skill:x', 'mcp:y'] }))
    const res = await pin('myprof')

    // 返回值全等：applied.tools 是 mcp:/skill: 那一截；未声明模型 → model 缺省、无 modelUnavailable
    expect(res).toEqual({
      success: true,
      applied: { model: undefined, tools: ['skill:x', 'mcp:y'] },
      modelUnavailable: undefined
    })
    // 两次落库：先钉档案；工具种子是扩展能力勾选（settings.enabledTools）的整份替换
    expect(mocks.daoUpdateSettings.mock.calls).toEqual([
      [SID, { agentProfile: 'myprof' }],
      [SID, { enabledTools: ['skill:x', 'mcp:y'] }]
    ])
    expect(invalidateSpy).toHaveBeenCalledWith(SID)
    expect(mocks.broadcastSessionConfigChanged).toHaveBeenCalledWith(SID)
    // 未声明模型：压根不去解析
    expect(mocks.resolveProfileModelSpec).not.toHaveBeenCalled()

    // 顺序：钉档案在 invalidate 之前（解绑必须发生在关停之后，之后写种子才不会和旧运行时
    // 抢着写），种子在 invalidate 之后，广播殿后
    const [profileWrite, toolsWrite] = mocks.daoUpdateSettings.mock.invocationCallOrder
    const order = [
      profileWrite,
      invalidateSpy.mock.invocationCallOrder[0],
      toolsWrite,
      mocks.broadcastSessionConfigChanged.mock.invocationCallOrder[0]
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('PIN-6a 模型声明且可解析：写模型种子，applied.model 全等解析结果，无 modelUnavailable', async () => {
    const resolved = { provider: 'openai', model: 'gpt-x', capabilities: { vision: true } }
    mocks.getProfile.mockReturnValue(profile('withmodel', { model: 'openai/gpt-x' }))
    mocks.resolveProfileModelSpec.mockReturnValue(resolved)

    const res = await pin('withmodel')
    expect(mocks.resolveProfileModelSpec).toHaveBeenCalledWith('openai/gpt-x')
    expect(mocks.appendModelChange).toHaveBeenCalledWith(SID, 'openai', 'gpt-x')
    expect(res.success).toBe(true)
    expect(res.applied?.model).toEqual(resolved)
    expect(res.modelUnavailable).toBeUndefined()
  })

  it('PIN-6b 模型声明但不可解析：不写模型种子、modelUnavailable 回传原始串，success 仍 true，工具种子与广播照常', async () => {
    mocks.getProfile.mockReturnValue(
      profile('badmodel', { model: 'openai/nope', tools: ['read', 'skill:x'] })
    )
    mocks.resolveProfileModelSpec.mockReturnValue(null)

    const res = await pin('badmodel')
    expect(res.success).toBe(true)
    expect(res.applied?.model).toBeUndefined()
    expect(res.modelUnavailable).toBe('openai/nope')
    expect(mocks.appendModelChange).not.toHaveBeenCalled()
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith(SID, { enabledTools: ['skill:x'] })
    expect(mocks.broadcastSessionConfigChanged).toHaveBeenCalledWith(SID)
    // 档案本身照常生效（落库 + 失效重建）—— 模型不可用不阻断钉档案
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith(SID, { agentProfile: 'badmodel' })
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
  })

  it('PIN-7 工具种子：声明了才整份替换勾选；没声明 mcp:/skill: 就不写（空声明不算意见）', async () => {
    // 内置 coding / explore 之流只列内置工具：按「完整声明」清空的话，每条子会话都会被摘掉
    // 项目的 MCP 与 skill。勾选已在 create 时从父会话抄好，档案没意见就不该碰它
    mocks.getProfile.mockReturnValue(profile('builtin-only', { tools: ['read', 'bash'] }))
    const res = await pin('builtin-only')
    expect(mocks.daoUpdateSettings.mock.calls).toEqual([[SID, { agentProfile: 'builtin-only' }]])
    expect(res.applied?.tools).toEqual([])

    // 只留小写 mcp:/skill: 前缀的（归一在解析侧，这里不再归一）
    mocks.daoUpdateSettings.mockClear()
    mocks.getProfile.mockReturnValue(
      profile('mixed', { tools: ['MCP:Ctx7', 'skill:a', 'mcp:b', 'read'] })
    )
    const mixed = await pin('mixed')
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith(SID, {
      enabledTools: ['skill:a', 'mcp:b']
    })
    expect(mixed.applied?.tools).toEqual(['skill:a', 'mcp:b'])
  })
})

describe('PIN-8 拒绝矩阵：拒绝路径不回传半截结果', () => {
  it.each([
    [
      '非子会话',
      (): void => {
        mocks.daoPick.mockReturnValue({ parentId: null })
        mocks.getProfile.mockReturnValue(profile('coding'))
      },
      'coding'
    ],
    [
      '未知名',
      (): void => {
        mocks.getProfile.mockReturnValue(undefined)
      },
      'ghost'
    ],
    [
      '基座名',
      (): void => {
        mocks.getProfile.mockReturnValue(profile('work', { model: 'openai/gpt-x' }))
      },
      'work'
    ]
  ])(
    '%s：applied 与 modelUnavailable 都不存在，只有 success 与 error 两个键',
    async (_l, arrange, name) => {
      arrange()
      const res = await pin(name)
      expect(res.success).toBe(false)
      expect(res.applied).toBeUndefined()
      expect(res.modelUnavailable).toBeUndefined()
      expect(Object.keys(res).sort()).toEqual(['error', 'success'])
      expectNoSideEffects()
    }
  )
})

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
 *   - **成功链顺序**：落库 → invalidateAgent → 种子（模型 / 思考档位）→ 广播。
 *     落库在 invalidate 前、种子在 invalidate 后：钉档案与重建之间不能有一个还在写树的旧运行时；
 *   - **工具不写进勾选**：档案声明的 mcp:/skill: 经 createAgent 的名单归一恒生效，
 *     扩展能力勾选（`settings.enabledTools`）留着 create 时从父会话抄来的那份；
 *     `applied.tools` 只回传声明的那截；
 *   - 模型三态：可解析 → 写种子 + `applied.model`；不可解析 → 不写、`modelUnavailable` 回传原值、
 *     其余照常；未声明 → 不去解析；
 *   - 思考档位（`shuvix-thinking`）两态：声明了 → 写种子 + `applied.thinkingLevel`（档位是枚举值，
 *     没有「不可用」一说 —— 模型那一行不可解析也照写）；未声明 → 不写（seedRunConfig 会补父会话的）；
 *   - **只由宿主派发的档案**（permission-reviewer）当作不存在：与未知名同一句 `Unknown agent "…"`
 *     （与派发工具同一口径，不给模型「换条路再试」的理由），用户按名覆盖了同名文件也一样（PIN-3b）。
 *
 * mock 面照旧（import 图全换假件，只留 chat-protocol / agent-runtime 真件）。`isSessionProfile`
 * 在假件里用**真判据**复算（`!BASE_PROFILE_NAMES.has(name) && !HOST_ONLY_PROFILE_NAMES.has(name)`，
 * 名单常量取真件）—— 真 agentService 要 electron + 用户目录，本文件够不到；假件退化成「恒 true」
 * 会让基座那一拒失去意义。invalidateAgent 用实例级 spy（经 this. 动态派发可拦截，保留穿透：底层
 * SessionManager.remove 对无运行时的会话直接 resolve）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi, type MockInstance } from 'vitest'
import {
  BASE_PROFILE_NAMES,
  HOST_ONLY_PROFILE_NAMES,
  type AgentProfile
} from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoUpdateSettings: vi.fn(),
  getProfile: vi.fn<(name: string) => unknown>(),
  resolveProfileModelSpec: vi.fn(),
  appendModelChange: vi.fn(),
  appendThinkingLevelChange: vi.fn(),
  broadcastSessionConfigChanged: vi.fn(),
  daoTouchActive: vi.fn()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.daoPick,
    updateSettings: mocks.daoUpdateSettings,
    touchActive: mocks.daoTouchActive
  }
}))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: {} }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/projectDao', () => ({ projectDao: {} }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: {} }))
vi.mock('../messageService', () => ({ messageService: {} }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: vi.fn(),
  appendModelChange: mocks.appendModelChange,
  appendThinkingLevelChange: mocks.appendThinkingLevelChange
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
    isSessionProfile: (p: AgentProfile) =>
      !BASE_PROFILE_NAMES.has(p.name) && !HOST_ONLY_PROFILE_NAMES.has(p.name)
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
  over: Partial<Pick<AgentProfile, 'tools' | 'model' | 'thinkingLevel'>> = {}
): Partial<AgentProfile> => ({
  name,
  tools: over.tools ?? ['read'],
  ...(over.model ? { model: over.model } : {}),
  ...(over.thinkingLevel ? { thinkingLevel: over.thinkingLevel } : {})
})

type PinResult = Awaited<ReturnType<(typeof sessionService)['pinAgentProfile']>>

const pin = (name: string): Promise<PinResult> => sessionService.pinAgentProfile(SID, name)

/** 拒绝路径的零副作用：落库 / 失效 / 两种种子（模型 / 思考档位）/ 广播 / 模型解析一个都不许发生 */
function expectNoSideEffects(): void {
  expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
  expect(invalidateSpy).not.toHaveBeenCalled()
  expect(mocks.appendModelChange).not.toHaveBeenCalled()
  expect(mocks.appendThinkingLevelChange).not.toHaveBeenCalled()
  expect(mocks.broadcastSessionConfigChanged).not.toHaveBeenCalled()
  expect(mocks.resolveProfileModelSpec).not.toHaveBeenCalled()
  expect(mocks.daoTouchActive).not.toHaveBeenCalled()
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

  it.each([
    ['内置', 'builtin'],
    ['用户按名覆盖的同名文件', 'user']
  ] as const)(
    'PIN-3b 权限审查员（%s）当作不存在：Unknown agent "permission-reviewer"（与派发工具同一口径），零副作用',
    async (_l, source) => {
      // 带着模型与思考档位两种声明：拒绝必须先于两种种子（expectNoSideEffects 逐一查）
      mocks.getProfile.mockReturnValue({
        ...profile('permission-reviewer', { model: 'openai/gpt-x', thinkingLevel: 'off' }),
        source
      })
      const res = await pin('permission-reviewer')
      // toStrictEqual：只有 success 与 error 两个键 —— 不回传半截结果，也不是「基座」那句
      // 带下一步提示的拒绝（那句会告诉模型这个名字确实存在）
      expect(res).toStrictEqual({ success: false, error: 'Unknown agent "permission-reviewer"' })
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
  it('PIN-5 普通具名档案：落库 → invalidate → 广播，返回 applied（声明的工具不写进勾选）', async () => {
    mocks.getProfile.mockReturnValue(profile('myprof', { tools: ['read', 'skill:x', 'mcp:y'] }))
    const res = await pin('myprof')

    // 返回值全等：applied.tools 是 mcp:/skill: 那一截；未声明模型 → model 缺省、无 modelUnavailable；
    // 未声明思考档位 → thinkingLevel 缺省
    expect(res).toEqual({
      success: true,
      applied: { model: undefined, thinkingLevel: undefined, tools: ['skill:x', 'mcp:y'] },
      modelUnavailable: undefined
    })
    // toEqual 不区分「缺省」与「值为 undefined」，思考档位那一格单独钉：没声明就不写种子、不回传 ——
    // 写了（哪怕写的是缺省档）就会盖掉 seedRunConfig 随后补上的父会话档位
    expect(res.applied?.thinkingLevel).toBeUndefined()
    expect(mocks.appendThinkingLevelChange).not.toHaveBeenCalled()
    // 只落库一次：钉档案。档案声明的 mcp:/skill: 经 createAgent 的名单归一恒生效，
    // 不写进扩展能力勾选 —— 写了只会替换掉从父会话继承来的那份
    expect(mocks.daoUpdateSettings.mock.calls).toEqual([[SID, { agentProfile: 'myprof' }]])
    expect(invalidateSpy).toHaveBeenCalledWith(SID)
    expect(mocks.broadcastSessionConfigChanged).toHaveBeenCalledWith(SID)
    // 钉档案不是用户在这条会话上点选
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()
    // 未声明模型：压根不去解析
    expect(mocks.resolveProfileModelSpec).not.toHaveBeenCalled()

    // 顺序：钉档案在 invalidate 之前（解绑必须发生在关停之后，之后写种子才不会和旧运行时
    // 抢着写），广播殿后
    const [profileWrite] = mocks.daoUpdateSettings.mock.invocationCallOrder
    const order = [
      profileWrite,
      invalidateSpy.mock.invocationCallOrder[0],
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

  it('PIN-6b 模型声明但不可解析：不写模型种子、modelUnavailable 回传原始串，success 仍 true，广播照常', async () => {
    mocks.getProfile.mockReturnValue(
      profile('badmodel', { model: 'openai/nope', tools: ['read', 'skill:x'] })
    )
    mocks.resolveProfileModelSpec.mockReturnValue(null)

    const res = await pin('badmodel')
    expect(res.success).toBe(true)
    expect(res.applied?.model).toBeUndefined()
    expect(res.modelUnavailable).toBe('openai/nope')
    expect(mocks.appendModelChange).not.toHaveBeenCalled()
    expect(res.applied?.tools).toEqual(['skill:x'])
    expect(mocks.broadcastSessionConfigChanged).toHaveBeenCalledWith(SID)
    // 档案本身照常生效（落库 + 失效重建）—— 模型不可用不阻断钉档案
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith(SID, { agentProfile: 'badmodel' })
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
  })

  it('PIN-7 声明的 mcp:/skill: 永不写进勾选：继承来的那份原样留着，applied.tools 只回传声明的那截', async () => {
    // 声明经名单归一恒生效；写进勾选只剩「替换掉从父会话继承来的」这一个作用 ——
    // 内置 coding 声明了 skill:builtin:drawing，那样每条 coding 子会话都会丢掉项目的 MCP 与 skill
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
    expect(mocks.daoUpdateSettings.mock.calls).toEqual([[SID, { agentProfile: 'mixed' }]])
    expect(mixed.applied?.tools).toEqual(['skill:a', 'mcp:b'])
  })

  it('PIN-9 档案声明思考档位 off：思考种子恰写一次、applied.thinkingLevel 回传；顺序 invalidate → 种子 → 广播', async () => {
    // off 是最该钉的一档：它是一个声明（「这个 agent 不思考」），不是「没声明」
    mocks.getProfile.mockReturnValue(profile('quiet', { thinkingLevel: 'off' }))
    const res = await pin('quiet')

    expect(res.success).toBe(true)
    expect(mocks.appendThinkingLevelChange.mock.calls).toEqual([[SID, 'off']])
    expect(res.applied?.thinkingLevel).toBe('off')
    // 种子在失效之后（旧运行时已不会再写树）、广播之前（前端收到通知时树上已经是新档位）
    const order = [
      invalidateSpy.mock.invocationCallOrder[0],
      mocks.appendThinkingLevelChange.mock.invocationCallOrder[0],
      mocks.broadcastSessionConfigChanged.mock.invocationCallOrder[0]
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // 只声明了档位：模型那一行不动（不解析、不写种子）
    expect(mocks.resolveProfileModelSpec).not.toHaveBeenCalled()
    expect(mocks.appendModelChange).not.toHaveBeenCalled()
  })

  it('PIN-10 模型不可解析 + 声明 low：思考种子照写、applied.thinkingLevel 回传；modelUnavailable 回传原串、不写模型种子', async () => {
    // 两行各管各的：档位是枚举值，没有「不可用」一说，不该被模型那一行的失败连带丢掉
    mocks.getProfile.mockReturnValue(
      profile('lowthink', { model: 'openai/nope', thinkingLevel: 'low' })
    )
    mocks.resolveProfileModelSpec.mockReturnValue(null)

    const res = await pin('lowthink')
    expect(res.success).toBe(true)
    expect(mocks.appendThinkingLevelChange.mock.calls).toEqual([[SID, 'low']])
    expect(res.applied?.thinkingLevel).toBe('low')
    expect(res.modelUnavailable).toBe('openai/nope')
    expect(res.applied?.model).toBeUndefined()
    expect(mocks.appendModelChange).not.toHaveBeenCalled()
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
        // 带着模型与思考档位两种声明：拒绝必须先于两种种子（expectNoSideEffects 逐一查）
        mocks.getProfile.mockReturnValue(
          profile('work', { model: 'openai/gpt-x', thinkingLevel: 'off' })
        )
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

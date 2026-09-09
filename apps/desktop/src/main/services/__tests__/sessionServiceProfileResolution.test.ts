/**
 * sessionService —— 会话根 Agent 档案的**形态推导**（`resolveAgentProfileName`）与「创建不落戳」。
 *
 * 契约（改制后）：档案不是用户选的，由会话形态推导 ——
 *   - 聊天会话（`bot` 有值 / 遗留 `bots` 非空）→ **null**（无根），判定先于一切；
 *   - 笔记本会话（`notebookPath` 非空）→ `notebook`；
 *   - 其余按形态：有项目 `work`、无项目 `chat`；
 *   - **只有子会话**（`parentId` 非空）读 `settings.agentProfile`，且档案 md 还在才用；
 *   - 根会话上残留的戳（含旧基座名 `default`）**被忽略、不迁移、不清洗**；
 *   - `create` 不再写 `agentProfile` 键 —— 唯一写入口是子会话的 `pinAgentProfile`。
 *
 * 钉的是三条日后最容易被「顺手统一」做坏的性质：
 *   1. 读面：新实现只调 `sessionDao.pick(id, ['projectId','parentId','settings'])`，形态全部
 *      来自那一行 —— 所以这里的形态一律用 `daoPick` 的返回值表达，`pickSettings` 只是
 *      `resolveSessionAgentContext` 的旁路；
 *   2. 「根会话不读戳」是「旧数据只是遗留」这条承诺的唯一守卫：谁把 `parentId` 那个条件删掉，
 *      改制前切换时代的全部会话会集体换人格，而默认配置下没有任何报错；
 *   3. 「创建时定型」曾经存在过（`settings.agentProfile` 在 create 落显式值）——
 *      RP-11 守的就是它不被加回来。
 *
 * mock 面沿用 sessionServiceUserInput.test.ts（import 图全换假件，`AgentSession.create`
 * 可捕获，logger 的 warn 可捕获）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { AgentProfile } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoPickSettings: vi.fn<(id: string, keys: string[]) => unknown>(),
  daoUpdateSettings: vi.fn(),
  daoInsert: vi.fn(),
  getProfile: vi.fn<(name: string) => unknown>(),
  readSessionRunConfig: vi.fn(),
  findModelsByProvider: vi.fn(() => []),
  findByKey: vi.fn<(key: string) => string | undefined>(),
  projectPick: vi.fn(),
  agentCreate: vi.fn(),
  warn: vi.fn()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    updateSettings: mocks.daoUpdateSettings,
    insert: mocks.daoInsert,
    deleteById: vi.fn(),
    findChildren: vi.fn(() => []),
    updateProjectId: vi.fn(),
    updateTitle: vi.fn()
  }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findModelsByProvider: mocks.findModelsByProvider,
    findEnabled: vi.fn(() => []),
    findEnabledModels: vi.fn(() => [])
  }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: mocks.findByKey } }))
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: mocks.readSessionRunConfig,
  addSessionTreePin: vi.fn(),
  appendModelChange: vi.fn(),
  appendActiveToolsChange: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results'
}))
vi.mock('../toolAggregator', () => ({
  getDefaultEnabledTools: vi.fn(() => []),
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../botService', () => ({
  botService: {
    abortSession: vi.fn(async () => {}),
    isActive: vi.fn(() => false)
  }
}))
vi.mock('../agentService', () => ({ agentService: { getProfile: mocks.getProfile } }))
vi.mock('../agentSession', () => ({ AgentSession: { create: mocks.agentCreate } }))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../userInputBroker', () => ({ registerUserInputParticipant: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
}))

let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

let seq = 0
let SID = ''

beforeEach(() => {
  seq += 1
  SID = `rp-${seq}`
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.findModelsByProvider.mockReturnValue([])
  mocks.findByKey.mockReturnValue(undefined)
  mocks.readSessionRunConfig.mockResolvedValue({})
  mocks.projectPick.mockReturnValue(undefined)
  mocks.daoPick.mockReturnValue(undefined)
  mocks.daoPickSettings.mockReturnValue(undefined)
  mocks.getProfile.mockReturnValue(undefined)
})

/** 一份会话行的形态（`pick` 无论要哪几列都回整行；`pickSettings` 回 settings 那一格） */
interface Shape {
  projectId?: string | null
  parentId?: string | null
  settings?: Record<string, unknown>
}

/** 让被测会话呈现某种形态 —— 形态只来自 `pick` 那一行，见文件头第 1 条 */
function world(shape: Shape): void {
  const row = {
    projectId: shape.projectId ?? null,
    parentId: shape.parentId ?? null,
    settings: shape.settings
  }
  mocks.daoPick.mockReturnValue(row)
  mocks.daoPickSettings.mockReturnValue(shape.settings)
}

/** 一份真存在的档案（getProfile 有值即可，resolve 只看「在不在」） */
const existing = (name: string): Partial<AgentProfile> => ({
  name,
  tools: []
})

const resolve = (): string | null => sessionService.resolveAgentProfileName(SID)

describe('RP-1 聊天会话恒 null —— 无根判定先于一切', () => {
  it.each([
    ['bot 有值', { bot: 'scout' }],
    ['遗留 bots 非空', { bots: ['a'] }],
    ['bot 与 notebookPath 同在', { bot: 'scout', notebookPath: 'notes/a.md' }],
    ['bot 与子会话戳同在', { bot: 'scout', agentProfile: 'coding' }]
  ])('%s → 严格 null，且 getProfile 零调用', (_label, settings) => {
    // 返回类型是可空的：把「这个会话没有档案」变成编译期事实。有人改成回落 work
    // 就把聊天会话变成了有根会话 —— botService 那份参与方与 session 这份会同时认领它
    world({ projectId: 'p1', parentId: 'P', settings })
    expect(resolve()).toBeNull()
    expect(mocks.getProfile).not.toHaveBeenCalled()
  })
})

describe('RP-2 笔记本会话恒 notebook', () => {
  it.each([
    ['有项目、根会话', { projectId: 'p1', parentId: null }],
    ['无项目、根会话', { projectId: null, parentId: null }],
    ['子会话且带戳', { projectId: 'p1', parentId: 'P' }]
  ])("%s：notebookPath 非空 → 'notebook'，忽略 agentProfile 且不查档案", (_label, shape) => {
    // 防「notebook 也去读戳」的顺手统一：笔记本判定在戳之前，子会话也不例外
    world({ ...shape, settings: { notebookPath: 'notes/a.md', agentProfile: 'coding' } })
    expect(resolve()).toBe('notebook')
    expect(mocks.getProfile).not.toHaveBeenCalled()
  })

  it('notebookPath 为空串 = 非笔记本 → 走形态', () => {
    world({ projectId: null, settings: { notebookPath: '' } })
    expect(resolve()).toBe('chat')
  })
})

describe('RP-3 根会话按形态：有项目 work / 无项目 chat', () => {
  it("有项目 → 'work'；不查档案、不读设置项", () => {
    world({ projectId: 'p1', parentId: null, settings: {} })
    expect(resolve()).toBe('work')
    expect(mocks.getProfile).not.toHaveBeenCalled()
    // 「默认项目智能体 / 默认聊天智能体」两个设置项已删：这里读任何设置都是复活的迹象
    expect(mocks.findByKey).not.toHaveBeenCalled()
  })

  it("无项目 → 'chat'；settings 整格为 undefined 的行同样", () => {
    world({ projectId: null, parentId: null, settings: {} })
    expect(resolve()).toBe('chat')

    world({ projectId: null, parentId: null, settings: undefined })
    expect(resolve()).toBe('chat')
    expect(mocks.getProfile).not.toHaveBeenCalled()
    expect(mocks.findByKey).not.toHaveBeenCalled()
  })
})

describe('RP-4 根会话残留戳被忽略、不迁移', () => {
  it.each([
    ['coding 在项目会话上', 'p1', 'coding', 'work'],
    ['旧基座名 default 在项目会话上', 'p1', 'default', 'work'],
    ['work 在无项目会话上', null, 'work', 'chat'],
    ['chat 在项目会话上', 'p1', 'chat', 'work']
  ])('%s → 仍按形态；不查档案、不清洗、不告警', (_label, projectId, stamped, expected) => {
    // 这是「旧数据只是遗留」承诺的唯一守卫。getProfile 给一份真存在的档案 —— 谁把
    // `parentId` 那个条件删掉，这里会拿到戳而不是形态基座
    world({ projectId, parentId: null, settings: { agentProfile: stamped } })
    mocks.getProfile.mockImplementation((name) => existing(name))
    expect(resolve()).toBe(expected)
    expect(mocks.getProfile).not.toHaveBeenCalled()
    // 不迁移：戳留在 settings 里只是遗留数据，不写库、不 warn（几百条老会话每次打开都
    // 告警一次，只会把真正该看的日志淹掉）
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(mocks.warn).not.toHaveBeenCalled()
  })
})

describe('RP-5 / RP-6 / RP-7 子会话（parentId 非空）才读戳', () => {
  it('RP-5 戳生效：档案还在 → 该名字，getProfile 恰以它调用一次', () => {
    world({ projectId: 'p1', parentId: 'P', settings: { agentProfile: 'coding' } })
    mocks.getProfile.mockReturnValue(existing('coding'))
    expect(resolve()).toBe('coding')
    expect(mocks.getProfile.mock.calls).toEqual([['coding']])
  })

  it.each([
    ['有项目 → work', 'p1', 'work'],
    ['无项目 → chat', null, 'chat']
  ])('RP-6 戳的档案已被删：回落**形态基座**（%s），warn 一次，不清戳', (_l, projectId, base) => {
    // 回落形态基座而不是一律 work：无项目父级开的子会话没有理由突然变成项目人格。
    // 不清戳：删了档案再放回来就恢复 —— 「顺手清戳」会让恢复失效
    world({ projectId, parentId: 'P', settings: { agentProfile: 'ghost' } })
    mocks.getProfile.mockReturnValue(undefined)
    expect(resolve()).toBe(base)
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    const msg = String(mocks.warn.mock.calls[0][0])
    expect(msg).toContain('ghost')
    expect(msg).toContain(SID)
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
  })

  it('RP-7 无戳的子会话随父形态（projectId 恒随父，形态天然一致），不查档案', () => {
    world({ projectId: 'p-parent', parentId: 'P', settings: {} })
    expect(resolve()).toBe('work')

    world({ projectId: null, parentId: 'P', settings: {} })
    expect(resolve()).toBe('chat')
    expect(mocks.getProfile).not.toHaveBeenCalled()
  })
})

describe('RP-8 / RP-9 边界', () => {
  it("RP-8 会话不存在（pick 为 undefined）：不抛，返回 'chat'（钉现状）", () => {
    // 现状：无行 = 无项目 = chat。日后若改成 null，DefaultChatGateway.listTools 那句
    // `?? WORK_PROFILE_NAME` 只兜 null，要一起改
    mocks.daoPick.mockReturnValue(undefined)
    expect(() => resolve()).not.toThrow()
    expect(resolve()).toBe('chat')
  })

  it('RP-9 bots 为空数组不劫持：根会话按形态；子会话才读戳', () => {
    // settings 的 JSON patch 没有删键路径，群聊时代「移除全部成员」只能写 `[]`，而 `[]` 是 truthy
    world({ projectId: 'p1', parentId: null, settings: { bots: [] } })
    expect(resolve()).toBe('work')

    world({ projectId: null, parentId: null, settings: { bots: [], agentProfile: 'coding' } })
    mocks.getProfile.mockReturnValue(existing('coding'))
    expect(resolve()).toBe('chat')
    expect(mocks.getProfile).not.toHaveBeenCalled()

    world({ projectId: null, parentId: 'P', settings: { bots: [], agentProfile: 'coding' } })
    expect(resolve()).toBe('coding')
  })
})

describe('RP-10 推导结果真的送进了运行时（resolveAgentProfileName → SessionManager → AgentSession.create）', () => {
  const fakeAgent = { name: 'fake' }

  it("项目根会话：AgentSession.create 收到 profileName 'work'", async () => {
    world({ projectId: 'p1', parentId: null, settings: {} })
    mocks.projectPick.mockReturnValue({ path: '/proj', settings: {} })
    mocks.agentCreate.mockResolvedValue(fakeAgent)

    expect(await sessionService.ensureAgentSession(SID)).toBe(fakeAgent)
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1)
    expect(mocks.agentCreate.mock.calls[0][0]).toMatchObject({
      sessionId: SID,
      profileName: 'work',
      workingDirectory: '/proj'
    })
  })

  it('带戳子会话：profileName 是戳的档案名', async () => {
    world({ projectId: 'p1', parentId: 'P', settings: { agentProfile: 'coding' } })
    mocks.getProfile.mockReturnValue(existing('coding'))
    mocks.agentCreate.mockResolvedValue(fakeAgent)

    await sessionService.ensureAgentSession(SID)
    expect(mocks.agentCreate.mock.calls[0][0]).toMatchObject({ profileName: 'coding' })
  })

  it('聊天会话：create 不被调用，ensure 返回 undefined（无根）', async () => {
    world({ projectId: null, parentId: null, settings: { bot: 'scout' } })
    mocks.agentCreate.mockResolvedValue(fakeAgent)

    expect(await sessionService.ensureAgentSession(SID)).toBeUndefined()
    expect(mocks.agentCreate).not.toHaveBeenCalled()
  })
})

describe('RP-11 create 不再落戳', () => {
  /** 最近一次落库的 settings */
  const insertedSettings = (): Record<string, unknown> =>
    (mocks.daoInsert.mock.calls.at(-1)![0] as { settings: Record<string, unknown> }).settings

  it.each([
    ['有项目', () => sessionService.create({ projectId: 'p1' })],
    ['无项目', () => sessionService.create({})],
    [
      '子会话（父行有项目）',
      () => {
        mocks.daoPick.mockReturnValue({ projectId: 'p-parent', settings: {} })
        return sessionService.create({ parentId: 'P' })
      }
    ],
    ['笔记本', () => sessionService.create({ notebookPath: 'notes/a.md' })],
    ['聊天会话', () => sessionService.create({ bot: 'scout' })]
  ])('%s：落库 settings 里没有 agentProfile 键；不读设置项、不查档案', (_label, create) => {
    create()
    expect(mocks.daoInsert).toHaveBeenCalledTimes(1)
    // `in` 而不是 toMatchObject：缺省的 undefined 也能过宽松比较，而「键在不在」正是支点
    expect('agentProfile' in insertedSettings()).toBe(false)
    expect(mocks.findByKey).not.toHaveBeenCalled()
    expect(mocks.getProfile).not.toHaveBeenCalled()
  })
})

/**
 * sessionService —— bot 会话的创建与判定。
 *
 * 契约：一条 bot 会话就是一条**普通有根会话**，只多一个 `settings.bot`。它在创建那一刻
 * 定死，之后**不可换绑** —— 换一个 bot 就是另开一条会话，因为这条会话的全部历史都是那个
 * bot 说的话。于是这里能测的只有创建那一刻写了什么、以及判定谁说了算：
 *
 *   - BSess-1/2/3 `create` 只在 bot 非空白时写这一个键，且不顺手写别的形态键；
 *   - BSess-4 判定对不存在的会话不抛（注入侧在每次建根 Agent 时都会问一次）；
 *   - BSess-5 **没有换绑入口** —— 这是上面那条产品裁决的唯一守卫；
 *   - BSess-Sub 子会话**不继承** bot：这是「人设影响怎么说话、不影响怎么干活」那条
 *     结构保证在创建侧的一半（另一半在 agentSessionBot.test.ts 的 AG-5）；
 *   - BSess-6 主进程专用的 `triggerRun` 选项只给 bot 根会话写键；不是 bot 会话时 `workProject` 不看；
 *   - BSess-7 `updateProjectId` 不收 bot 会话、也不收挂着工作项目引用的会话（回 false、什么都不写），普通会话照旧。
 *
 * 形态推导（bot → 基座 `bot`）归 sessionServiceProfileResolution.test.ts 的 RP-12…16，
 * 这里不重复。mock 面：import 图全换假件，`sessionDao.insert` 是落库的观测点。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  projectPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoPickSettings: vi.fn<(id: string, keys: string[]) => unknown>(),
  daoUpdateSettings: vi.fn(),
  daoUpdateProjectId: vi.fn(),
  daoInsert: vi.fn(),
  listChanged: vi.fn(),
  getProfile: vi.fn()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    updateSettings: mocks.daoUpdateSettings,
    updateProjectId: mocks.daoUpdateProjectId,
    insert: mocks.daoInsert,
    findChildren: vi.fn(() => []),
    deleteById: vi.fn()
  }
}))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../sessionDayPromptService', () => ({
  recordUserEntry: vi.fn(),
  recordSessionCreated: vi.fn()
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
// create 为项目会话读项目的扩展能力（继承进 settings.enabledTools）
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  isDurableSession: () => true,
  readSessionRunConfig: vi.fn(),
  recordSessionModel: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (id: string) => `/nonexistent/shuvix-unit/tmp/${id}`,
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results'
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../toolAggregator', () => ({
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
// 会话权限表（services/acl）不在这组用例里：建会话时的生成、删会话时的清理换成空操作
vi.mock('../acl', () => ({ sessionAcl: { initialize: vi.fn(), deleteSession: vi.fn() } }))
vi.mock('../agentService', () => ({ agentService: { getProfile: mocks.getProfile } }))
// 会话运行时换成假宿主 / 假门面（真模块的依赖图带模型注册表、事件适配器）
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../agentSession', async () =>
  (await import('./support/fakeSessionHost')).agentSessionModuleMock()
)
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: mocks.listChanged,
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

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.daoPick.mockReturnValue(undefined)
  mocks.daoPickSettings.mockReturnValue(undefined)
})

/** 最近一次落库的整行 */
const inserted = (): { projectId: string | null; settings: Record<string, unknown> } =>
  mocks.daoInsert.mock.calls.at(-1)![0]

describe('BSess-1 / 2 / 3 —— create 写了什么', () => {
  it('BSess-1 create({bot}) 写入 trim 后的 settings.bot，且不顺手写别的形态键', () => {
    // trim 与 boundBotOf 同口径：写入侧与判定侧都剪一次，谁也不必假设对方剪过。
    // 不写 agentProfile：档案由形态推导（RP-12），落一个戳就是把裁决过的推导变成一份快照
    const session = sessionService.create({ bot: '  scout  ' })
    const settings = inserted().settings
    expect(settings.bot).toBe('scout')
    expect('agentProfile' in settings).toBe(false)
    expect('bots' in settings).toBe(false)
    expect('notebookPath' in settings).toBe(false)
    // 它是一条普通会话：有 id、有标题、不是子会话
    expect(session.parentId).toBeNull()
  })

  it('BSess-2 create({bot: 空白}) 一个键都不写 —— 是普通会话，不是坏掉的 bot 会话', () => {
    // 写下一个空串会造出一条判定为 false、却带着 bot 键的会话 —— 谁将来写了
    // `'bot' in settings` 就会认领它
    for (const bot of ['', '   ', '\t\n']) {
      mocks.daoInsert.mockClear()
      sessionService.create({ bot })
      expect('bot' in inserted().settings, JSON.stringify(bot)).toBe(false)
    }
  })

  it('BSess-3 create({bot, projectId}) —— bot 会话只归属 bot：项目记成工作项目的引用 + 路径快照，不当成员', () => {
    // 2026-10-31 用户裁定：bot 会话收拢到 bot 名下、不再归属项目；项目只是它的工作位置，设置经引用照常生效
    // （chat-protocol projectContextIdOf）。旧入口传 projectId、新入口传 workProject，落下来是同一份
    mocks.projectPick.mockReturnValue({ path: '/work/p1' })
    const session = sessionService.create({ bot: 'scout', projectId: 'p1' })
    expect(inserted().projectId).toBeNull()
    expect(inserted().settings.bot).toBe('scout')
    expect(inserted().settings.workProject).toBe('p1')
    expect(inserted().settings.workingDirectory).toBe('/work/p1')
    expect(session.projectId).toBeNull()
    sessionService.create({ bot: 'scout', workProject: 'p1' })
    expect(inserted().projectId).toBeNull()
    expect(inserted().settings.workProject).toBe('p1')
  })

  it('BSess-3b 工作项目不在 / 是隐藏承载项目 → 临时：不记引用、不写路径', () => {
    mocks.projectPick.mockReturnValue(undefined)
    sessionService.create({ bot: 'scout', workProject: 'gone' })
    expect(inserted().projectId).toBeNull()
    expect('workProject' in inserted().settings).toBe(false)
    expect('workingDirectory' in inserted().settings).toBe(false)
    mocks.projectPick.mockReturnValue({ path: '/x' })
    sessionService.create({ bot: 'scout', workProject: '__agents__' })
    expect('workProject' in inserted().settings).toBe(false)
  })

  it('BSess-Sub 子会话不继承 bot —— 干活的那条会话不带人设', () => {
    // 这是「人设影响怎么说话、不影响怎么干活」在创建侧的一半：父会话 settings 里只有
    // 扩展能力勾选被抄过去。bot 若跟着传，子会话的根 Agent 会按 bot 基座起来，
    // 而那条会话恰恰是用来干活的（另一半守卫在 agentSessionBot.test.ts 的 AG-5）
    mocks.daoPick.mockReturnValue({
      projectId: 'p1',
      settings: { bot: 'scout', enabledTools: ['mcp:from-parent'] }
    })
    sessionService.create({ parentId: 'P' })
    const settings = inserted().settings
    expect('bot' in settings).toBe(false)
    // 对照组：该继承的那一项确实继承了（否则这条用例可能只是在测一个空 settings）
    expect(settings.enabledTools).toEqual(['mcp:from-parent'])
    expect(inserted().projectId).toBe('p1')
  })
})

describe('BSess-4 / 5 —— 判定与「没有换绑入口」', () => {
  it('BSess-4 isBotSession 对不存在的会话 → false，不抛', () => {
    // 注入侧在每次建根 Agent 时都会问一次，而会话可能刚被删掉（级联删子会话的竞态）。
    // 抛出去会让「打开一条会话」整个失败
    mocks.daoPickSettings.mockReturnValue(undefined)
    expect(() => sessionService.isBotSession('ghost')).not.toThrow()
    expect(sessionService.isBotSession('ghost')).toBe(false)

    mocks.daoPickSettings.mockReturnValue({ bot: 'scout' })
    expect(sessionService.isBotSession('s1')).toBe(true)
    mocks.daoPickSettings.mockReturnValue({ bot: '   ' })
    expect(sessionService.isBotSession('s1')).toBe(false)
  })

  it('BSess-5 没有换绑入口：sessionService 上不存在 setBot 之类的方法', () => {
    // 裁决过的产品形态：换一个 bot 就是另开一条会话，因为这条会话的全部历史都是那个 bot
    // 说的话 —— 换绑之后历史里的人格会当场对不上。旧聊天会话曾有 `setBot` / `rewriteBot`
    // （群聊时代遗留的会话要重新选一个），随旧 Bots 一并拆除；这条守卫在有人加回来时先响
    const surface = sessionService as unknown as Record<string, unknown>
    for (const gone of ['setBot', 'rewriteBot', 'updateBot', 'changeBot', 'markRead']) {
      expect(surface[gone], `${gone} 不该存在`).toBeUndefined()
    }
    // 正控制组：判定与创建这两个口在（证明这条断言不是在测一个拼错的对象）
    expect(typeof surface.isBotSession).toBe('function')
    expect(typeof surface.create).toBe('function')
  })
})

describe('BSess-6 —— 主进程专用的创建选项与 workProject 的适用范围', () => {
  it('BSess-6 options.triggerRun 只给 bot 根会话写 settings.triggerRun: true；不给就没有这个键', () => {
    // 触发器开出来的运行会话（botTriggerService）被侧栏折进「定时运行」—— 它只能由主进程在创建时标，
    // 所以是 options 而不是 SessionCreateParams 里的字段（IPC 传不进来）
    sessionService.create({ bot: 'scout' }, { triggerRun: true })
    expect(inserted().settings.triggerRun).toBe(true)

    sessionService.create({ bot: 'scout' })
    expect('triggerRun' in inserted().settings).toBe(false)

    sessionService.create({ bot: 'scout' }, { triggerRun: false })
    expect('triggerRun' in inserted().settings).toBe(false)
  })

  it('BSess-6 不是 bot 会话、或是子会话 → 给了 triggerRun 也不写', () => {
    sessionService.create({ title: 'plain' }, { triggerRun: true })
    expect('triggerRun' in inserted().settings).toBe(false)

    sessionService.create({ bot: '   ' }, { triggerRun: true })
    expect('triggerRun' in inserted().settings).toBe(false)

    // 子会话：父会话在（daoPick 恒回父会话那一行）
    mocks.daoPick.mockReturnValue({ projectId: null, settings: { bot: 'scout' } })
    sessionService.create({ parentId: 'P', bot: 'scout' }, { triggerRun: true })
    expect('triggerRun' in inserted().settings).toBe(false)
  })

  it('BSess-6 SessionCreateParams 里的 triggerRun 不算数（只有 options 那一个入口）', () => {
    sessionService.create({ bot: 'scout', triggerRun: true } as never)
    expect('triggerRun' in inserted().settings).toBe(false)
  })

  it('BSess-6 不是 bot 会话时 workProject 不看：不写引用；只给 projectId 的普通会话照旧是成员', () => {
    mocks.projectPick.mockReturnValue({ path: '/work/p1' })
    sessionService.create({ workProject: 'p1' })
    expect(inserted().projectId).toBeNull()
    expect('workProject' in inserted().settings).toBe(false)
    expect('workingDirectory' in inserted().settings).toBe(false)

    sessionService.create({ projectId: 'p1', workProject: 'p2' })
    expect(inserted().projectId).toBe('p1')
    expect('workProject' in inserted().settings).toBe(false)
  })
})

describe('BSess-7 —— bot 会话不能挪进项目', () => {
  it('BSess-7 updateProjectId 对 bot 会话 → false，不写库、不广播', () => {
    mocks.daoPick.mockReturnValue({ settings: { bot: 'scout', workProject: 'p1' } })
    expect(sessionService.updateProjectId('B', 'p2')).toBe(false)
    expect(sessionService.updateProjectId('B', null)).toBe(false)

    mocks.daoPick.mockReturnValue({ settings: { bot: 'scout' } })
    expect(sessionService.updateProjectId('B', 'p2')).toBe(false)

    expect(mocks.daoUpdateProjectId).not.toHaveBeenCalled()
    expect(mocks.listChanged).not.toHaveBeenCalled()
  })

  it('BSess-7 挂着工作项目引用的会话（bot 会话的子会话、fork）同样 → false', () => {
    mocks.daoPick.mockReturnValue({ settings: { workProject: 'p1', enabledTools: [] } })
    expect(sessionService.updateProjectId('C', 'p2')).toBe(false)
    expect(mocks.daoUpdateProjectId).not.toHaveBeenCalled()
    expect(mocks.listChanged).not.toHaveBeenCalled()
  })

  it('BSess-7 对照组：普通会话照旧挪得进去 → true，写库、广播', () => {
    mocks.daoPick.mockReturnValue({ settings: { enabledTools: [] } })
    expect(sessionService.updateProjectId('S', 'p2')).toBe(true)
    expect(mocks.daoUpdateProjectId).toHaveBeenCalledWith('S', 'p2')
    expect(mocks.listChanged).toHaveBeenCalledTimes(1)

    // 空白的 bot 键不算 bot 会话（boundBotOf 同口径）
    mocks.daoPick.mockReturnValue({ settings: { bot: '  ', workProject: '  ' } })
    expect(sessionService.updateProjectId('S2', null)).toBe(true)
    expect(mocks.daoUpdateProjectId).toHaveBeenLastCalledWith('S2', null)
  })
})

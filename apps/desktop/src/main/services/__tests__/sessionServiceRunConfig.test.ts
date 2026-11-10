/**
 * sessionService —— 会话此刻实际在用的模型类运行配置（`resolveRunConfig`）。
 *
 * 它有两个读者：子会话种子（subSessionRunner.create）与 hook run 没锁时的模型选择（hookService 的
 * `hookRunModel` → `resolveHookRunModel` 的 selection）。返回会话的模型**连同思考档位**：hook 派出的 agent
 * 与任何派发一样继承会话的档位，想不思考就在它的 agent md 里声明 `shuvix-thinking`。
 *（P2-13：原先 hook 读的是包在它外面的 `resolveRunModelConfig`，P2-08 换成锁优先的解析后它没有调用方了，
 * 随之删掉；RC-1..5 原样搬到 `resolveRunConfig` 上。）
 *
 * 钉的是：
 *   - RC-1 有模型 → 模型三件（provider / model / capabilities）+ 会话档位；
 *   - RC-2 每一档原样带出 —— off 也是一档（会话选了「不思考」），不是「没有」；RC-2b 推理模型 + 配了
 *     与之不同的默认思考等级时也原样带出（默认档只管没设过的会话）；
 *   - RC-3 解析后的值而非「树上显式写过的」：树上没写档位 → 回落默认档，与 `initAgent` 给前端的
 *     那一格相同（hook agent 继承的，就是用户在选择器里看到的）；树上没写模型 → 回落默认模型；
 *     RC-3c..f 默认档来自设置 `general.defaultThinkingLevel`：推理模型用它（与 initAgent 同值）、
 *     非推理模型照旧 off、配置值不是可选档 → DEFAULT_THINKING_LEVEL、连模型都回落到默认模型时同样适用；
 *   - RC-4 没有可用模型 → model 为 null（hook 据此跳过 `no-model`），哪怕树上写着档位；
 *   - RC-5 会话不存在 → null，且不去读会话树；
 *   - RC-6 会话的档案（形态基座 chat / work …）声明的 `shuvix-model` / `shuvix-thinking` 是会话没选过时的缺省，
 *     夹在会话自己的选择与全局默认之间（2026-11-10 用户报告：新建会话不认 agent md 里配的模型）：
 *     没选过 → 档案的模型（initAgent 给选择器的也是它）；选过 → 会话的，档案的模型连解析都不解析；
 *     档案的模型此刻不可用 → 全局默认；档位同理；档案按形态取（有项目 → work）。
 *   - RC-7 `newSessionDefaults`（欢迎页的选择器读的）：一条还没建的会话用同一条规则解析 —— 无项目读 chat、
 *     有项目读 work 的声明，没声明 → 全局默认；与一条刚建、什么都没选过的会话 initAgent 报的相同。
 *
 * mock 面沿用 sessionServiceProfileResolution.test.ts（import 图全换假件）。会话树只经
 * `readSessionRunConfig` 读；设置项与提供商目录是回落默认模型（与默认思考等级）的来源。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import {
  DEFAULT_THINKING_LEVEL,
  SELECTABLE_THINKING_LEVELS
} from '@shuvix/chat-protocol/types/thinking'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoPickSettings: vi.fn<(id: string, keys: string[]) => unknown>(),
  daoUpdateSettings: vi.fn(),
  readSessionRunConfig: vi.fn(),
  findModelsByProvider: vi.fn<(providerId: string) => unknown[]>(),
  findEnabled: vi.fn<() => unknown[]>(),
  findEnabledModels: vi.fn<(providerId: string) => unknown[]>(),
  findByKey: vi.fn<(key: string) => string | undefined>(),
  projectPick: vi.fn(),
  getProfile: vi.fn<(name: string) => unknown>(),
  resolveProfileModelSpec: vi.fn<(spec: string) => unknown>()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    updateSettings: mocks.daoUpdateSettings,
    insert: vi.fn(),
    deleteById: vi.fn(),
    findChildren: vi.fn(() => []),
    updateProjectId: vi.fn(),
    updateTitle: vi.fn()
  }
}))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findModelsByProvider: mocks.findModelsByProvider,
    findEnabled: mocks.findEnabled,
    findEnabledModels: mocks.findEnabledModels
  }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: mocks.findByKey } }))
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  isDurableSession: () => true,
  readSessionRunConfig: mocks.readSessionRunConfig,
  recordSessionModel: vi.fn(),
  recordSessionThinkingLevel: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
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
vi.mock('../../agents/agentHost', () => ({
  resolveProfileModelSpec: mocks.resolveProfileModelSpec
}))
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
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

const SID = 'rc-1'

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  // 缺省世界：一条存在的无项目根会话（勾选键已补过，首次解析不落库）；树上什么都没写、
  // 没配默认模型、提供商目录为空 —— 各例只改自己关心的那一格
  const settings = { enabledTools: [] }
  mocks.daoPick.mockReturnValue({ projectId: null, parentId: null, settings })
  mocks.daoPickSettings.mockReturnValue(settings)
  tree({})
  mocks.findModelsByProvider.mockReturnValue([])
  mocks.findEnabled.mockReturnValue([])
  mocks.findEnabledModels.mockReturnValue([])
  mocks.findByKey.mockReturnValue(undefined)
  mocks.projectPick.mockReturnValue(undefined)
  mocks.getProfile.mockReturnValue(undefined)
  mocks.resolveProfileModelSpec.mockReturnValue(null)
})

/** 会话树上显式写过的模型类配置（readSessionRunConfig 的真实形状：没写过的键是 null） */
function tree(written: { provider?: string; model?: string; thinkingLevel?: string }): void {
  mocks.readSessionRunConfig.mockResolvedValue({
    provider: null,
    model: null,
    thinkingLevel: null,
    ...written
  })
}

/** 提供商目录里某个模型的能力（provider_models 表里存的是 JSON 串） */
function catalog(providerId: string, modelId: string, capabilities: object): void {
  mocks.findModelsByProvider.mockImplementation((p) =>
    p === providerId ? [{ modelId, capabilities: JSON.stringify(capabilities) }] : []
  )
}

/** 设置表里的值（findByKey 只按字面键答，没列出的键 → undefined） */
function settingsTable(values: Record<string, string>): void {
  mocks.findByKey.mockImplementation((key) => values[key])
}

describe('resolveRunConfig —— 会话的模型连同思考档位（子会话种子 / hook 没锁时的选择）', () => {
  it('RC-1 有模型：返回模型三件 + 会话的思考档位', async () => {
    tree({ provider: 'p1', model: 'm1', thinkingLevel: 'high' })
    catalog('p1', 'm1', { reasoning: true })

    expect(await sessionService.resolveRunConfig(SID)).toEqual({
      model: { provider: 'p1', model: 'm1', capabilities: { reasoning: true } },
      thinkingLevel: 'high'
    })
  })

  it.each([...SELECTABLE_THINKING_LEVELS])(
    'RC-2 树上的档位原样带出：%s（off 也是会话的一种选择，不能当「没有」丢掉）',
    async (level) => {
      tree({ provider: 'p1', model: 'm1', thinkingLevel: level })
      expect((await sessionService.resolveRunConfig(SID))?.thinkingLevel).toBe(level)
    }
  )

  it.each([...SELECTABLE_THINKING_LEVELS])(
    'RC-2b 推理模型、配了不同的默认思考等级，树上的档位仍原样带出：%s',
    async (level) => {
      tree({ provider: 'p1', model: 'm1', thinkingLevel: level })
      catalog('p1', 'm1', { reasoning: true })
      // 挑一个与显式档不同的默认档：off → xhigh，其余 → off
      settingsTable({ 'general.defaultThinkingLevel': level === 'off' ? 'xhigh' : 'off' })
      expect((await sessionService.resolveRunConfig(SID))?.thinkingLevel).toBe(level)
    }
  )

  it('RC-3a 树上没写档位：带的是回落后的默认档（推理模型 → 缺省档，否则 off），与 initAgent 给前端的那一格相同', async () => {
    tree({ provider: 'p1', model: 'm1' })
    expect((await sessionService.resolveRunConfig(SID))?.thinkingLevel).toBe('off')

    catalog('p1', 'm1', { reasoning: true })
    const cfg = await sessionService.resolveRunConfig(SID)
    expect(cfg?.thinkingLevel).toBe(DEFAULT_THINKING_LEVEL)
    // 用户在选择器里看到的档位 = hook agent 继承的档位
    const init = await sessionService.initAgent(SID)
    expect(cfg?.thinkingLevel).toBe(init.modelMetadata.thinkingLevel)
  })

  it('RC-3b 树上没写模型：回落默认模型（解析后的值，不是「显式写过的」），档位照带', async () => {
    tree({ thinkingLevel: 'low' })
    const defaults: Record<string, string> = {
      'general.defaultProvider': 'p-default',
      'general.defaultModel': 'm-default'
    }
    mocks.findByKey.mockImplementation((key) => defaults[key])
    mocks.findEnabled.mockReturnValue([{ id: 'p-default' }])
    mocks.findEnabledModels.mockImplementation((p) =>
      p === 'p-default' ? [{ modelId: 'm-default' }] : []
    )

    expect(await sessionService.resolveRunConfig(SID)).toEqual({
      model: { provider: 'p-default', model: 'm-default', capabilities: {} },
      thinkingLevel: 'low'
    })
  })

  it('RC-3c 树上没写档位、推理模型、默认思考等级配成 xhigh → xhigh，与 initAgent 给前端的那一格相同', async () => {
    tree({ provider: 'p1', model: 'm1' })
    catalog('p1', 'm1', { reasoning: true })
    settingsTable({ 'general.defaultThinkingLevel': 'xhigh' })

    const cfg = await sessionService.resolveRunConfig(SID)
    expect(cfg?.thinkingLevel).toBe('xhigh')
    const init = await sessionService.initAgent(SID)
    expect(init.modelMetadata.thinkingLevel).toBe('xhigh')
  })

  it('RC-3d 树上没写档位、非推理模型、默认思考等级配成 high → 仍是 off（initAgent 同）', async () => {
    tree({ provider: 'p1', model: 'm1' })
    catalog('p1', 'm1', { reasoning: false })
    settingsTable({ 'general.defaultThinkingLevel': 'high' })

    expect((await sessionService.resolveRunConfig(SID))?.thinkingLevel).toBe('off')
    expect((await sessionService.initAgent(SID)).modelMetadata.thinkingLevel).toBe('off')
  })

  it('RC-3e 默认思考等级配成 minimal（设置页画不出的值）→ 按没配过：DEFAULT_THINKING_LEVEL（initAgent 同）', async () => {
    tree({ provider: 'p1', model: 'm1' })
    catalog('p1', 'm1', { reasoning: true })
    settingsTable({ 'general.defaultThinkingLevel': 'minimal' })

    expect((await sessionService.resolveRunConfig(SID))?.thinkingLevel).toBe(DEFAULT_THINKING_LEVEL)
    expect((await sessionService.initAgent(SID)).modelMetadata.thinkingLevel).toBe(
      DEFAULT_THINKING_LEVEL
    )
  })

  it('RC-3f 树上模型、档位都没写：回落默认模型（推理模型），档位取默认思考等级 low', async () => {
    tree({})
    settingsTable({
      'general.defaultProvider': 'p-default',
      'general.defaultModel': 'm-default',
      'general.defaultThinkingLevel': 'low'
    })
    mocks.findEnabled.mockReturnValue([{ id: 'p-default' }])
    mocks.findEnabledModels.mockImplementation((p) =>
      p === 'p-default' ? [{ modelId: 'm-default' }] : []
    )
    catalog('p-default', 'm-default', { reasoning: true })

    expect(await sessionService.resolveRunConfig(SID)).toEqual({
      model: { provider: 'p-default', model: 'm-default', capabilities: { reasoning: true } },
      thinkingLevel: 'low'
    })
  })

  it.each([
    ['树上只有档位、没有默认模型', { thinkingLevel: 'high' }],
    ['树上只写了提供商、没有模型', { provider: 'p1', thinkingLevel: 'off' }]
  ])(
    'RC-4 没有可用模型（%s）→ model 为 null：档位写着也不凭空造出模型',
    async (_label, written) => {
      tree(written)
      expect((await sessionService.resolveRunConfig(SID))?.model).toBeNull()
    }
  )

  it('RC-5 会话不存在 → null，且不去读会话树', async () => {
    mocks.daoPick.mockReturnValue(undefined)
    mocks.daoPickSettings.mockReturnValue(undefined)
    tree({ provider: 'p1', model: 'm1', thinkingLevel: 'high' })

    expect(await sessionService.resolveRunConfig('ghost')).toBeNull()
    expect(mocks.readSessionRunConfig).not.toHaveBeenCalled()
  })
})

describe('RC-6 档案声明的模型 / 档位：会话没选过时的缺省，先于全局默认', () => {
  /** 设置里配好的全局默认模型 p-default/m-default（启用着） */
  function globalDefault(extra: Record<string, string> = {}): void {
    settingsTable({
      'general.defaultProvider': 'p-default',
      'general.defaultModel': 'm-default',
      ...extra
    })
    mocks.findEnabled.mockReturnValue([{ id: 'p-default' }])
    mocks.findEnabledModels.mockImplementation((p) =>
      p === 'p-default' ? [{ modelId: 'm-default' }] : []
    )
  }

  /** 档案表：按名给出声明了 model / thinkingLevel 的档案 */
  function profiles(table: Record<string, { model?: string; thinkingLevel?: string }>): void {
    mocks.getProfile.mockImplementation((name) =>
      table[name] ? { name, ...table[name] } : undefined
    )
  }

  /** 档案的 shuvix-model 解析得到的模型（resolveProfileModelSpec 的真实形状） */
  function resolvable(spec: string, provider: string, model: string): void {
    mocks.resolveProfileModelSpec.mockImplementation((s) =>
      s === spec ? { provider, model, capabilities: {} } : null
    )
  }

  it('RC-6a 会话没选过模型：用无项目会话基座 chat 声明的模型，不是全局默认；选择器拿到的也是它', async () => {
    globalDefault()
    profiles({ chat: { model: 'p-prof/m-prof' } })
    resolvable('p-prof/m-prof', 'p-prof', 'm-prof')
    catalog('p-prof', 'm-prof', { reasoning: true })

    expect((await sessionService.resolveRunConfig(SID))?.model).toEqual({
      provider: 'p-prof',
      model: 'm-prof',
      capabilities: { reasoning: true }
    })
    const init = await sessionService.initAgent(SID)
    expect([init.provider, init.model]).toEqual(['p-prof', 'm-prof'])
    expect(mocks.getProfile).toHaveBeenCalledWith('chat')
  })

  it('RC-6b 会话选过模型：会话的赢，档案的模型连解析都不解析', async () => {
    globalDefault()
    tree({ provider: 'p1', model: 'm1', thinkingLevel: 'low' })
    profiles({ chat: { model: 'p-prof/m-prof', thinkingLevel: 'high' } })
    resolvable('p-prof/m-prof', 'p-prof', 'm-prof')

    expect(await sessionService.resolveRunConfig(SID)).toEqual({
      model: { provider: 'p1', model: 'm1', capabilities: {} },
      thinkingLevel: 'low'
    })
    expect(mocks.resolveProfileModelSpec).not.toHaveBeenCalled()
  })

  it('RC-6c 档案的模型此刻不可用（停用 / 写错）→ 回落全局默认', async () => {
    globalDefault()
    profiles({ chat: { model: 'gone/model' } })

    expect((await sessionService.resolveRunConfig(SID))?.model).toEqual({
      provider: 'p-default',
      model: 'm-default',
      capabilities: {}
    })
  })

  it('RC-6d 档位：会话没设过 → 档案声明的（压过设置里的默认档）；会话设过 → 会话的', async () => {
    globalDefault({ 'general.defaultThinkingLevel': 'low' })
    catalog('p-default', 'm-default', { reasoning: true })
    profiles({ chat: { thinkingLevel: 'off' } })

    expect((await sessionService.resolveRunConfig(SID))?.thinkingLevel).toBe('off')
    expect((await sessionService.initAgent(SID)).modelMetadata.thinkingLevel).toBe('off')

    tree({ thinkingLevel: 'xhigh' })
    expect((await sessionService.resolveRunConfig(SID))?.thinkingLevel).toBe('xhigh')
  })

  it('RC-6e 会话选过模型、没设过档位：模型是会话的，档位仍取档案声明的', async () => {
    tree({ provider: 'p1', model: 'm1' })
    profiles({ chat: { model: 'p-prof/m-prof', thinkingLevel: 'medium' } })

    expect(await sessionService.resolveRunConfig(SID)).toEqual({
      model: { provider: 'p1', model: 'm1', capabilities: {} },
      thinkingLevel: 'medium'
    })
    expect(mocks.resolveProfileModelSpec).not.toHaveBeenCalled()
  })

  it('RC-6f 档案按形态取：项目会话读 work 的声明，不读 chat 的', async () => {
    globalDefault()
    mocks.daoPick.mockReturnValue({
      projectId: 'proj-1',
      parentId: null,
      settings: { enabledTools: [] }
    })
    profiles({
      chat: { model: 'p-chat/m-chat' },
      work: { model: 'p-work/m-work' }
    })
    mocks.resolveProfileModelSpec.mockImplementation((s) => {
      const [provider, model] = String(s).split('/')
      return { provider, model, capabilities: {} }
    })

    const cfg = await sessionService.resolveRunConfig(SID)
    expect([cfg?.model?.provider, cfg?.model?.model]).toEqual(['p-work', 'm-work'])
  })
})

describe('RC-7 newSessionDefaults：还没建的会话会用什么（欢迎页的选择器）', () => {
  function globalDefault(): void {
    settingsTable({
      'general.defaultProvider': 'p-default',
      'general.defaultModel': 'm-default',
      'general.defaultThinkingLevel': 'high'
    })
    mocks.findEnabled.mockReturnValue([{ id: 'p-default' }])
    mocks.findEnabledModels.mockImplementation((p) =>
      p === 'p-default' ? [{ modelId: 'm-default' }] : []
    )
  }

  it('RC-7a 无项目：chat 声明的模型与档位；与刚建、什么都没选过的无项目会话 initAgent 报的一样', async () => {
    globalDefault()
    mocks.getProfile.mockImplementation((name) =>
      name === 'chat' ? { name, model: 'p-prof/m-prof', thinkingLevel: 'low' } : undefined
    )
    mocks.resolveProfileModelSpec.mockImplementation((s) =>
      s === 'p-prof/m-prof' ? { provider: 'p-prof', model: 'm-prof', capabilities: {} } : null
    )
    catalog('p-prof', 'm-prof', { reasoning: true })

    const defaults = sessionService.newSessionDefaults({ projectId: null })
    expect(defaults).toEqual({
      provider: 'p-prof',
      model: 'm-prof',
      capabilities: { reasoning: true },
      modelMetadata: { thinkingLevel: 'low' }
    })
    const init = await sessionService.initAgent(SID)
    expect({
      provider: init.provider,
      model: init.model,
      capabilities: init.capabilities,
      modelMetadata: init.modelMetadata
    }).toEqual(defaults)
    // 还没建的会话没有会话行可读：不碰会话树
    mocks.readSessionRunConfig.mockClear()
    sessionService.newSessionDefaults({})
    expect(mocks.readSessionRunConfig).not.toHaveBeenCalled()
  })

  it('RC-7b 有项目：读 work 的声明，不读 chat 的', () => {
    globalDefault()
    mocks.getProfile.mockImplementation((name) =>
      name === 'chat' ? { name, model: 'p-chat/m-chat' } : { name }
    )
    mocks.resolveProfileModelSpec.mockImplementation((s) => {
      const [provider, model] = String(s).split('/')
      return { provider, model, capabilities: {} }
    })

    const defaults = sessionService.newSessionDefaults({ projectId: 'proj-1' })
    expect([defaults.provider, defaults.model]).toEqual(['p-default', 'm-default'])
    expect(mocks.getProfile).toHaveBeenCalledWith('work')
    expect(mocks.getProfile).not.toHaveBeenCalledWith('chat')
  })

  it('RC-7c 基座没声明：全局默认模型；档位按模型能力回落（推理 → 默认档 high，否则 off）', () => {
    globalDefault()
    catalog('p-default', 'm-default', { reasoning: true })
    expect(sessionService.newSessionDefaults({ projectId: null })).toEqual({
      provider: 'p-default',
      model: 'm-default',
      capabilities: { reasoning: true },
      modelMetadata: { thinkingLevel: 'high' }
    })

    catalog('p-default', 'm-default', {})
    expect(sessionService.newSessionDefaults({ projectId: null }).modelMetadata).toEqual({
      thinkingLevel: 'off'
    })
  })

  it('RC-7d 什么都没配：provider / model 为空串（欢迎页据此不让发）', () => {
    expect(sessionService.newSessionDefaults({ projectId: null })).toMatchObject({
      provider: '',
      model: ''
    })
  })
})

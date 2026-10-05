/**
 * sessionService —— 会话此刻实际在用的模型类运行配置（`resolveRunConfig`）与 hook 派发用的那份
 * （`resolveRunModelConfig`）。
 *
 * `resolveRunModelConfig` 是 hook run 的回落源（hookService → runner 的 `resolveRunModel`），
 * 返回会话的模型**连同思考档位**：hook 派出的 agent 与任何派发一样继承会话的档位，想不思考就在
 * 它的 agent md 里声明 `shuvix-thinking`。只给模型的话，manager 会补缺省 'off' —— 等于宿主替每个
 * hook agent 悄悄关掉了思考，档案里的声明（titler 的 off）也就无从说「生效与否」。
 *
 * 钉的是：
 *   - RC-1 有模型 → 模型三件（provider / model / capabilities）+ 会话档位；与子会话种子的来源
 *     （`resolveRunConfig`）同一口径；
 *   - RC-2 五档原样带出 —— off 也是一档（会话选了「不思考」），不是「没有」；
 *   - RC-3 解析后的值而非「树上显式写过的」：树上没写档位 → 回落默认档，与 `initAgent` 给前端的
 *     那一格相同（hook agent 继承的，就是用户在选择器里看到的）；树上没写模型 → 回落默认模型；
 *   - RC-4 没有可用模型 → null（调用方据此报「无可用模型」），哪怕树上写着档位；
 *   - RC-5 会话不存在 → null，且不去读会话树。
 *
 * mock 面沿用 sessionServiceProfileResolution.test.ts（import 图全换假件）。会话树只经
 * `readSessionRunConfig` 读；设置项与提供商目录是回落默认模型的来源。
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
  projectPick: vi.fn()
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
  appendModelChange: vi.fn(),
  appendThinkingLevelChange: vi.fn()
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
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../agentService', () => ({ agentService: { getProfile: vi.fn() } }))
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

describe('resolveRunModelConfig —— hook 派发的回落源：会话的模型连同思考档位', () => {
  it('RC-1 有模型：返回模型三件 + 会话的思考档位；与子会话种子的来源（resolveRunConfig）同一口径', async () => {
    tree({ provider: 'p1', model: 'm1', thinkingLevel: 'high' })
    catalog('p1', 'm1', { reasoning: true })

    const cfg = await sessionService.resolveRunModelConfig(SID)
    expect(cfg).toEqual({
      provider: 'p1',
      model: 'm1',
      capabilities: { reasoning: true },
      thinkingLevel: 'high'
    })

    // hook 派发与子会话种子读的是同一个答案：模型那三件 + 同一个档位
    const run = await sessionService.resolveRunConfig(SID)
    expect(cfg).toEqual({ ...run!.model, thinkingLevel: run!.thinkingLevel })
  })

  it.each([...SELECTABLE_THINKING_LEVELS])(
    'RC-2 树上的档位原样带出：%s（off 也是会话的一种选择，不能当「没有」丢掉）',
    async (level) => {
      tree({ provider: 'p1', model: 'm1', thinkingLevel: level })
      expect((await sessionService.resolveRunModelConfig(SID))?.thinkingLevel).toBe(level)
    }
  )

  it('RC-3a 树上没写档位：带的是回落后的默认档，与 initAgent 给前端的那一格相同', async () => {
    tree({ provider: 'p1', model: 'm1' })

    const cfg = await sessionService.resolveRunModelConfig(SID)
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

    expect(await sessionService.resolveRunModelConfig(SID)).toEqual({
      provider: 'p-default',
      model: 'm-default',
      capabilities: {},
      thinkingLevel: 'low'
    })
  })

  it.each([
    ['树上只有档位、没有默认模型', { thinkingLevel: 'high' }],
    ['树上只写了提供商、没有模型', { provider: 'p1', thinkingLevel: 'off' }]
  ])('RC-4 没有可用模型（%s）→ null：档位写着也不单独给出去', async (_label, written) => {
    tree(written)
    expect(await sessionService.resolveRunModelConfig(SID)).toBeNull()
  })

  it('RC-5 会话不存在 → null，且不去读会话树', async () => {
    mocks.daoPick.mockReturnValue(undefined)
    mocks.daoPickSettings.mockReturnValue(undefined)
    tree({ provider: 'p1', model: 'm1', thinkingLevel: 'high' })

    expect(await sessionService.resolveRunModelConfig('ghost')).toBeNull()
    expect(mocks.readSessionRunConfig).not.toHaveBeenCalled()
  })
})

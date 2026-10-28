/**
 * sessionService —— 重配（2026-10-26，用户裁决：锁住的 agent 换模型 / 扩展勾选当场生效，运行中也是）的三个
 * 入口：`updateEnabledTools`、`setModel`、`previewAgentChange`。
 *
 * 契约（根 CLAUDE.md「Session extensions」→「Live reconfigure」/「The cache rule」）：
 *   RD-1 `updateEnabledTools` 先写设置、广播，再按「会话开着 → 交给它；没开但锁镜像说锁着 → peek 打开（存储不在 =
 *        什么都不做）；都不是 → 不碰运行时」重配 —— 开着就重配（锁没锁都调，没锁时运行时自己答 applied:false），
 *        恰一次；会话不存在 → false；
 *   RD-2 写下之后**从不拒绝**：重配被取消 / 会话关了 → true；被拒（no_model / unsupported）或别的意外 → true +
 *        一条 warn，设置照样写着（下一次创建按它建）；
 *   RD-3 等重配落定才答；
 *   RD-4 `setModel`（SM-1..10）：锁住（开着，或镜像说锁着而 peek 打开的那条有锁）时先问「那个 agent 用得了它吗」
 *        （resolveLockModel 对模型注册表 + provider 行）—— 用不了 → false、什么都不写；没锁不问（F1）；写下之后重配
 *        被拒 → false 并把原来的模型写回（原来没写过就留着新值，F2）；被取消 / 关了算好；写设置失败原样上抛；
 *   RD-5 `previewAgentChange`：没锁（含会话不存在 / 没开且没镜像）→ `{locked:false, cache:'none'}`，不碰运行时；
 *        锁着 → 把想改成的样子套在会话配置上（勾选与写入口同样净化、滤掉 `mcp:chrome`、按可用性过滤；模型两项一起给
 *        才算），交给运行时的 `previewAgentChange` 一次，结果原样交回；什么都不写；SessionClosedError → none；
 *        别的错误原样上抛。
 *
 * mock 面照抄 sessionServiceEnabledTools.test.ts（import 图全换假件、会话运行时换成假宿主、sessionDao / projectDao
 * 是一张内存行表），外加模型注册表（`getModelRegistry`）与 provider 行的替身、记录 warn 的日志。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { AgentCreationError, SessionClosedError } from '@shuvix/agent-runtime'
import type { AgentChangePreview } from '@shuvix/chat-protocol/chatApi'
import { fakeHost, gate, lockRecord, resetFakeHost } from './support/fakeSessionHost'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoPickSettings: vi.fn<(id: string, keys: string[]) => unknown>(),
  daoUpdateSettings: vi.fn<(id: string, patch: Record<string, unknown>) => void>(),
  daoInsert: vi.fn<(session: { id: string; settings: Record<string, unknown> }) => void>(),
  daoFindById: vi.fn<(id: string) => unknown>(),
  projectPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  readSessionRunConfig: vi.fn<(id: string) => Promise<Record<string, unknown>>>(),
  recordSessionModel: vi.fn<(id: string, provider: string, modelId: string) => Promise<void>>(),
  findModelsByProvider: vi.fn<(provider: string) => unknown[]>(() => []),
  listProviders: vi.fn<() => unknown[]>(() => []),
  getModelRegistry: vi.fn<() => unknown>(),
  findByKey: vi.fn<(key: string) => string | undefined>(),
  filterAvailableTools: vi.fn<(tools: string[], projectPath?: string) => string[]>(),
  broadcastSessionConfigChanged: vi.fn<(sessionId: string) => void>(),
  daoTouchActive: vi.fn<(id: string) => void>(),
  warn: vi.fn<(message: string) => void>()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    updateSettings: mocks.daoUpdateSettings,
    insert: mocks.daoInsert,
    findById: mocks.daoFindById,
    deleteById: vi.fn(),
    findChildren: vi.fn(() => []),
    updateProjectId: vi.fn(),
    updateTitle: vi.fn(),
    touchActive: mocks.daoTouchActive
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
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findModelsByProvider: mocks.findModelsByProvider,
    findEnabled: vi.fn(() => []),
    findEnabledModels: vi.fn(() => [])
  }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
// 模型注册表与 provider 行：setModel 锁着时用它们判「那个 agent 用得了这个模型吗」
vi.mock('../models', () => ({
  getModelRegistry: mocks.getModelRegistry,
  providerCredentialPort: { listProviders: mocks.listProviders }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: mocks.findByKey } }))
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  isDurableSession: () => true,
  readSessionRunConfig: mocks.readSessionRunConfig,
  recordSessionModel: mocks.recordSessionModel
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results'
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: mocks.filterAvailableTools }))
vi.mock('../acl', () => ({ sessionAcl: { initialize: vi.fn(), deleteSession: vi.fn() } }))
vi.mock('../agentService', () => ({
  agentService: {
    getProfile: vi.fn((name: string) => ({
      name,
      tools: [],
      instructionFiles: [],
      projectAwareness: false
    }))
  }
}))
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../agentSession', async () =>
  (await import('./support/fakeSessionHost')).agentSessionModuleMock()
)
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
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
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
}))

let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

// ─── 内存行表（sessionDao / projectDao 的替身） ─────────────────────────────

interface MemSession {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  settings: Record<string, unknown>
  createdAt: number
  updatedAt: number
  lastActiveAt: number
}

const sessions = new Map<string, MemSession>()

function pickCols(row: object | undefined, cols: readonly string[]): unknown {
  if (!row) return undefined
  const source = row as Record<string, unknown>
  return Object.fromEntries(cols.map((c) => [c, structuredClone(source[c])]))
}

function seedSession(settings: Record<string, unknown> = { enabledTools: [] }): void {
  sessions.set(SID, {
    id: SID,
    title: SID,
    projectId: null,
    parentId: null,
    settings,
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  })
}

const settingsOf = (): Record<string, unknown> => sessions.get(SID)!.settings
const writesTo = (id: string): unknown[][] =>
  mocks.daoUpdateSettings.mock.calls.filter((c) => c[0] === id)
/** 某一笔 warn 里有没有这段字 */
const warned = (text: string): boolean =>
  mocks.warn.mock.calls.some(([message]) => String(message).includes(text))

// ─── 模型注册表（resolveLockModel 的两个入参） ──────────────────────────────

/** provider 行：一条内置行 prov（启用位可拨） */
const PROV = {
  id: 'prov',
  name: 'prov',
  displayName: '',
  isBuiltin: true,
  isEnabled: true,
  apiKey: '',
  baseUrl: '',
  apiProtocol: '',
  metadata: ''
}
/** 注册表里有的模型（`<provider>/<模型>`） */
const KNOWN = new Set(['prov/m-1', 'prov/m-2'])
const REGISTRY = {
  models: {
    getModel: (provider: string, id: string) =>
      KNOWN.has(`${provider}/${id}`) ? { provider, id } : undefined
  },
  modelRefOf: (rowId: string, modelId: string) =>
    rowId === PROV.id ? { provider: PROV.id, id: modelId } : undefined
}

const NONE: AgentChangePreview = { locked: false, cache: 'none', reasons: [], promptTokens: 0 }
const M1 = { provider: 'prov', modelId: 'm-1' }

let seq = 0
let SID = ''

beforeEach(() => {
  seq += 1
  SID = `rc-${seq}`
  sessions.clear()
  for (const m of Object.values(mocks)) m.mockReset()
  PROV.isEnabled = true

  mocks.daoPick.mockImplementation((id, cols) => pickCols(sessions.get(id), cols))
  mocks.daoPickSettings.mockImplementation((id, keys) => pickCols(sessions.get(id)?.settings, keys))
  mocks.daoUpdateSettings.mockImplementation((id, patch) => {
    const row = sessions.get(id)
    if (row) row.settings = { ...row.settings, ...structuredClone(patch) }
  })
  mocks.daoFindById.mockImplementation((id) => structuredClone(sessions.get(id)))
  mocks.projectPick.mockReturnValue(undefined)
  // 会话设置是模型的唯一事实源：读 / 写都落在内存行的 settings.model 上
  mocks.readSessionRunConfig.mockImplementation(async (id) => {
    const model = sessions.get(id)?.settings.model as { provider: string; modelId: string }
    return model ? { provider: model.provider, model: model.modelId } : {}
  })
  mocks.recordSessionModel.mockImplementation(async (id, provider, modelId) => {
    const row = sessions.get(id)
    if (row) row.settings = { ...row.settings, model: { provider, modelId } }
  })
  mocks.findModelsByProvider.mockReturnValue([])
  mocks.listProviders.mockImplementation(() => [{ ...PROV }])
  mocks.getModelRegistry.mockReturnValue(REGISTRY)
  mocks.findByKey.mockReturnValue(undefined)
  mocks.filterAvailableTools.mockImplementation((tools) => tools)
  resetFakeHost()
})

// ─── updateEnabledTools ─────────────────────────────────────────────────────

describe('RD-1 updateEnabledTools：写下之后把改动交给 agent', () => {
  it.each([
    ['开着、没锁', false],
    ['开着、锁着', true]
  ])('RD-1 %s → 写、广播，然后重配恰一次（在写与广播之后），答 true', async (_label, locked) => {
    seedSession()
    const session = fakeHost.put(SID, locked ? { lock: lockRecord() } : {})
    const reconfigure = vi.spyOn(session, 'reconfigureAgent')

    expect(
      await sessionService.updateEnabledTools(SID, ['mcp:a', 'bash', 'skill:x', 'mcp:b'])
    ).toBe(true)
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: ['mcp:a', 'mcp:b'] }]])
    expect(mocks.broadcastSessionConfigChanged.mock.calls).toEqual([[SID]])
    expect(session.callsOf('reconfigureAgent')).toHaveLength(1)
    expect(reconfigure.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.daoUpdateSettings.mock.invocationCallOrder[0]
    )
    expect(reconfigure.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.broadcastSessionConfigChanged.mock.invocationCallOrder[0]
    )
    expect(fakeHost.callsOf('peek')).toEqual([])
    expect(fakeHost.callsOf('open')).toEqual([])
  })

  it('RD-1 没开、锁镜像说锁着、存储在 → peek 打开它，再交给它重配', async () => {
    seedSession({ enabledTools: [], agentLocked: true })
    fakeHost.storages.add(SID)
    fakeHost.configure = (reopened) => {
      reopened.lock = lockRecord()
    }
    expect(await sessionService.updateEnabledTools(SID, ['mcp:a'])).toBe(true)
    expect(settingsOf().enabledTools).toEqual(['mcp:a'])
    expect(fakeHost.callsOf('peek')).toEqual([SID])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.get(SID)!.callsOf('reconfigureAgent')).toHaveLength(1)
  })

  it('RD-1 没开、锁镜像说锁着、存储不在 → peek 落空，什么都不重配，写入照样作数', async () => {
    seedSession({ enabledTools: [], agentLocked: true })
    expect(await sessionService.updateEnabledTools(SID, ['mcp:a'])).toBe(true)
    expect(settingsOf().enabledTools).toEqual(['mcp:a'])
    expect(fakeHost.callsOf('peek')).toEqual([SID])
    expect(fakeHost.get(SID)).toBeUndefined()
  })

  it('RD-1 没开、没有锁镜像 → 不 open / peek，不碰运行时', async () => {
    seedSession()
    expect(await sessionService.updateEnabledTools(SID, ['mcp:a'])).toBe(true)
    expect(settingsOf().enabledTools).toEqual(['mcp:a'])
    expect(fakeHost.calls).toEqual([])
  })

  it('RD-1 会话不存在 → false：零写入、零广播、不碰宿主', async () => {
    expect(await sessionService.updateEnabledTools('no-such-session', ['mcp:a'])).toBe(false)
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(mocks.broadcastSessionConfigChanged).not.toHaveBeenCalled()
    expect(fakeHost.calls).toEqual([])
  })
})

describe('RD-2 updateEnabledTools 写下之后从不拒绝（F6）', () => {
  it.each<[string, () => unknown, boolean]>([
    ['重配被取消', () => new AgentCreationError('cancelled', 'cancelled by destroy'), false],
    ['会话关了', () => new SessionClosedError('x'), false],
    ['模型被拒（no_model）', () => new AgentCreationError('no_model', 'model went away'), true],
    [
      '宿主不支持（unsupported）',
      () => new AgentCreationError('unsupported', 'host cannot reconfigure'),
      true
    ],
    ['别的意外', () => new Error('boom while connecting'), true]
  ])('RD-2 %s → true，设置照样写着（被拒与意外才记 warn）', async (_label, error, warns) => {
    seedSession({ enabledTools: ['mcp:old'] })
    const session = fakeHost.put(SID, { lock: lockRecord(), reconfigureError: error() })
    expect(await sessionService.updateEnabledTools(SID, ['mcp:new'])).toBe(true)
    expect(settingsOf().enabledTools).toEqual(['mcp:new'])
    expect(session.callsOf('reconfigureAgent')).toHaveLength(1)
    const message = (session.reconfigureError as Error).message
    expect(warned(message)).toBe(warns)
    if (!warns) expect(mocks.warn).not.toHaveBeenCalled()
  })
})

describe('RD-3 updateEnabledTools 等重配落定才答', () => {
  it('RD-3 重配挂着（连 MCP 中）时不答；放行之后答 true', async () => {
    seedSession()
    const held = gate()
    const session = fakeHost.put(SID, { lock: lockRecord(), reconfigureGate: held })
    let settled = false
    const pending = sessionService.updateEnabledTools(SID, ['mcp:new']).then((ok) => {
      settled = true
      return ok
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 写入早已落下（界面那份乐观状态就是设置），只是答复等重配
    expect(settingsOf().enabledTools).toEqual(['mcp:new'])
    expect(session.callsOf('reconfigureAgent')).toHaveLength(1)
    expect(settled).toBe(false)
    held.release()
    expect(await pending).toBe(true)
  })
})

// ─── setModel ───────────────────────────────────────────────────────────────

describe('RD-4 setModel', () => {
  it('SM-1 没开、没有锁镜像 → 写一次、不问注册表、不 peek，答 true', async () => {
    seedSession()
    expect(await sessionService.setModel(SID, 'prov', 'm-2')).toBe(true)
    expect(mocks.recordSessionModel.mock.calls).toEqual([[SID, 'prov', 'm-2']])
    expect(mocks.getModelRegistry).not.toHaveBeenCalled()
    expect(fakeHost.calls).toEqual([])
  })

  it('SM-2 开着、锁着、模型用得了 → 先写设置再重配，答 true', async () => {
    seedSession({ enabledTools: [], model: M1 })
    const session = fakeHost.put(SID, { lock: lockRecord() })
    const reconfigure = vi.spyOn(session, 'reconfigureAgent')
    expect(await sessionService.setModel(SID, 'prov', 'm-2')).toBe(true)
    expect(mocks.getModelRegistry).toHaveBeenCalled()
    expect(mocks.recordSessionModel.mock.calls).toEqual([[SID, 'prov', 'm-2']])
    expect(settingsOf().model).toEqual({ provider: 'prov', modelId: 'm-2' })
    expect(session.callsOf('reconfigureAgent')).toHaveLength(1)
    expect(reconfigure.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.recordSessionModel.mock.invocationCallOrder[0]
    )
  })

  it.each<[string, () => void, string]>([
    ['模型不在注册表里', () => {}, 'm-x'],
    [
      'provider 停用了',
      () => {
        PROV.isEnabled = false
      },
      'm-2'
    ],
    ['provider 行没了', () => mocks.listProviders.mockReturnValue([]), 'm-2']
  ])('SM-3 开着、锁着、%s → false：不写设置、不重配', async (_label, arrange, modelId) => {
    seedSession({ enabledTools: [], model: M1 })
    const session = fakeHost.put(SID, { lock: lockRecord() })
    arrange()
    expect(await sessionService.setModel(SID, 'prov', modelId)).toBe(false)
    expect(mocks.recordSessionModel).not.toHaveBeenCalled()
    expect(settingsOf().model).toEqual(M1)
    expect(session.callsOf('reconfigureAgent')).toEqual([])
  })

  it('SM-4 开着但没锁、模型用不了 → 不问注册表，照写、答 true（用不用得了由下一次创建去判，F1）', async () => {
    seedSession({ enabledTools: [], model: M1 })
    const session = fakeHost.put(SID)
    expect(await sessionService.setModel(SID, 'prov', 'm-x')).toBe(true)
    expect(mocks.getModelRegistry).not.toHaveBeenCalled()
    expect(settingsOf().model).toEqual({ provider: 'prov', modelId: 'm-x' })
    // 没锁时运行时自己答 applied:false —— 调一下无害
    expect(session.callsOf('reconfigureAgent')).toHaveLength(1)
  })

  it('SM-5 没开、锁镜像说锁着、存储在 → peek 打开（只一次），按它的锁问注册表，写、重配，答 true', async () => {
    seedSession({ enabledTools: [], model: M1, agentLocked: true })
    fakeHost.storages.add(SID)
    fakeHost.configure = (reopened) => {
      reopened.lock = lockRecord()
    }
    expect(await sessionService.setModel(SID, 'prov', 'm-2')).toBe(true)
    expect(fakeHost.callsOf('peek')).toEqual([SID])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(mocks.getModelRegistry).toHaveBeenCalled()
    expect(settingsOf().model).toEqual({ provider: 'prov', modelId: 'm-2' })
    expect(fakeHost.get(SID)!.callsOf('reconfigureAgent')).toHaveLength(1)
  })

  it('SM-5 没开、锁镜像说锁着、存储不在 → peek 落空：不问注册表，照写、答 true', async () => {
    seedSession({ enabledTools: [], model: M1, agentLocked: true })
    expect(await sessionService.setModel(SID, 'prov', 'm-x')).toBe(true)
    expect(mocks.getModelRegistry).not.toHaveBeenCalled()
    expect(settingsOf().model).toEqual({ provider: 'prov', modelId: 'm-x' })
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.get(SID)).toBeUndefined()
  })

  it.each<[string, () => unknown]>([
    ['重配被取消', () => new AgentCreationError('cancelled', 'destroyed meanwhile')],
    ['会话关了', () => new SessionClosedError('x')]
  ])('SM-6 %s → 算好：答 true，新模型留在设置里', async (_label, error) => {
    seedSession({ enabledTools: [], model: M1 })
    fakeHost.put(SID, { lock: lockRecord(), reconfigureError: error() })
    expect(await sessionService.setModel(SID, 'prov', 'm-2')).toBe(true)
    expect(settingsOf().model).toEqual({ provider: 'prov', modelId: 'm-2' })
    expect(mocks.recordSessionModel).toHaveBeenCalledTimes(1)
  })

  it.each<[string, AgentCreationError]>([
    ['no_model（检查之后 provider 恰好停用）', new AgentCreationError('no_model', 'disabled')],
    ['unsupported（宿主不支持重配）', new AgentCreationError('unsupported', 'no reconfigure')]
  ])('SM-7 写下之后重配被拒：%s → false，设置写回原来的模型（F2）', async (_label, error) => {
    seedSession({ enabledTools: [], model: M1 })
    fakeHost.put(SID, { lock: lockRecord(), reconfigureError: error })
    expect(await sessionService.setModel(SID, 'prov', 'm-2')).toBe(false)
    expect(mocks.recordSessionModel.mock.calls).toEqual([
      [SID, 'prov', 'm-2'],
      [SID, 'prov', 'm-1']
    ])
    expect(settingsOf().model).toEqual(M1)
    expect(warned(error.message)).toBe(true)
  })

  it('SM-7 原来没写过模型：被拒之后答 false，新值留着（没有可写回的）', async () => {
    seedSession()
    fakeHost.put(SID, {
      lock: lockRecord(),
      reconfigureError: new AgentCreationError('unsupported', 'no reconfigure')
    })
    expect(await sessionService.setModel(SID, 'prov', 'm-2')).toBe(false)
    expect(mocks.recordSessionModel.mock.calls).toEqual([[SID, 'prov', 'm-2']])
    expect(settingsOf().model).toEqual({ provider: 'prov', modelId: 'm-2' })
  })

  it('SM-8 写设置失败 → 原样上抛（不吞成 false），不重配', async () => {
    seedSession({ enabledTools: [], model: M1 })
    const session = fakeHost.put(SID, { lock: lockRecord() })
    mocks.recordSessionModel.mockRejectedValue(new Error('settings write failed'))
    await expect(sessionService.setModel(SID, 'prov', 'm-2')).rejects.toThrow(
      'settings write failed'
    )
    expect(session.callsOf('reconfigureAgent')).toEqual([])
  })

  it('SM-9 会话不存在 → false：不写、不问注册表、不碰宿主', async () => {
    expect(await sessionService.setModel('no-such-session', 'prov', 'm-2')).toBe(false)
    expect(mocks.recordSessionModel).not.toHaveBeenCalled()
    expect(mocks.getModelRegistry).not.toHaveBeenCalled()
    expect(fakeHost.calls).toEqual([])
  })

  it('SM-10 写设置与重配都落定才答', async () => {
    seedSession({ enabledTools: [], model: M1 })
    const held = gate()
    const session = fakeHost.put(SID, { lock: lockRecord(), reconfigureGate: held })
    let finishWrite!: () => void
    mocks.recordSessionModel.mockImplementationOnce(
      (id, provider, modelId) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            sessions.get(id)!.settings.model = { provider, modelId }
            resolve()
          }
        })
    )
    let settled = false
    const pending = sessionService.setModel(SID, 'prov', 'm-2').then((ok) => {
      settled = true
      return ok
    })
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    await tick()
    expect(settled).toBe(false)
    expect(session.callsOf('reconfigureAgent')).toEqual([])

    finishWrite()
    await tick()
    expect(session.callsOf('reconfigureAgent')).toHaveLength(1)
    expect(settled).toBe(false)

    held.release()
    expect(await pending).toBe(true)
  })
})

// ─── previewAgentChange ─────────────────────────────────────────────────────

describe('RD-5 previewAgentChange', () => {
  it('RD-5 会话不存在 / 没开且没镜像 / 开着没锁 → none 的形状；不问运行时、不 peek', async () => {
    expect(await sessionService.previewAgentChange('no-such-session', {})).toEqual(NONE)
    seedSession()
    expect(await sessionService.previewAgentChange(SID, { enabledTools: ['mcp:a'] })).toEqual(NONE)
    expect(fakeHost.calls).toEqual([])

    const session = fakeHost.put(SID)
    expect(
      await sessionService.previewAgentChange(SID, { provider: 'prov', model: 'm-2' })
    ).toEqual(NONE)
    expect(session.callsOf('previewAgentChange')).toEqual([])
    expect(fakeHost.callsOf('peek')).toEqual([])
  })

  it('RD-5 开着、锁着 → 想改成的样子套在会话配置上交给运行时一次（勾选净化（技能条目丢掉）、滤掉 mcp:chrome、按可用性过滤；模型 = 给的那一对），结果原样交回，什么都不写', async () => {
    seedSession({ enabledTools: ['mcp:old'], model: M1 })
    const verdict: AgentChangePreview = {
      locked: true,
      cache: 'lost',
      reasons: ['model', 'tools'],
      promptTokens: 1234
    }
    const session = fakeHost.put(SID, { lock: lockRecord(), preview: verdict })
    mocks.filterAvailableTools.mockImplementation((tools) => tools.filter((n) => n !== 'mcp:gone'))

    const result = await sessionService.previewAgentChange(SID, {
      enabledTools: [
        'mcp:x',
        'mcp:x',
        'bash',
        '-mcp:y',
        'skill:s',
        '-skill:t',
        'mcp:chrome',
        '-mcp:chrome',
        'MCP:z',
        'mcp:gone',
        'mcp:a'
      ],
      provider: 'prov',
      model: 'm-2'
    })
    expect(result).toBe(session.preview)
    const calls = session.callsOf('previewAgentChange')
    expect(calls).toHaveLength(1)
    const config = calls[0][1] as { toolOverlay: string[]; model: unknown }
    expect(config.toolOverlay).toEqual(['mcp:x', '-mcp:y', 'mcp:a'])
    expect(config.model).toEqual({ provider: 'prov', modelId: 'm-2' })
    // 只预判：设置、广播、模型写入、重配一概没有
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(mocks.broadcastSessionConfigChanged).not.toHaveBeenCalled()
    expect(mocks.recordSessionModel).not.toHaveBeenCalled()
    expect(session.callsOf('reconfigureAgent')).toEqual([])
    expect(settingsOf().enabledTools).toEqual(['mcp:old'])
  })

  it('RD-5 只给 provider（模型两项没给全）→ 模型照会话设置；enabledTools [] → 勾选就是空', async () => {
    seedSession({ enabledTools: ['mcp:old'], model: M1 })
    const session = fakeHost.put(SID, { lock: lockRecord() })
    await sessionService.previewAgentChange(SID, { enabledTools: [], provider: 'other' })
    const config = session.callsOf('previewAgentChange')[0][1] as {
      toolOverlay: string[]
      model: unknown
    }
    expect(config.model).toEqual(M1)
    expect(config.toolOverlay).toEqual([])
  })

  it('RD-5 什么都不改 → 交给运行时的就是 resolveAgentConfig(sid) 那一份', async () => {
    seedSession({ enabledTools: ['mcp:old', 'mcp:a'], model: M1 })
    const session = fakeHost.put(SID, { lock: lockRecord() })
    await sessionService.previewAgentChange(SID, {})
    expect(session.callsOf('previewAgentChange')[0][1]).toEqual(
      await sessionService.resolveAgentConfig(SID)
    )
  })

  it('RD-5 没开、锁镜像说锁着、存储在 → peek 打开它再问', async () => {
    seedSession({ enabledTools: [], model: M1, agentLocked: true })
    fakeHost.storages.add(SID)
    fakeHost.configure = (reopened) => {
      reopened.lock = lockRecord()
    }
    expect(await sessionService.previewAgentChange(SID, { enabledTools: ['mcp:a'] })).toEqual({
      locked: true,
      cache: 'kept',
      reasons: [],
      promptTokens: 0
    })
    expect(fakeHost.callsOf('peek')).toEqual([SID])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.get(SID)!.callsOf('previewAgentChange')).toHaveLength(1)
  })

  it('RD-5 问的途中会话关了（SessionClosedError）→ none；别的错误原样上抛', async () => {
    seedSession({ enabledTools: [], model: M1 })
    const session = fakeHost.put(SID, {
      lock: lockRecord(),
      previewError: new SessionClosedError('x')
    })
    expect(await sessionService.previewAgentChange(SID, {})).toEqual(NONE)

    session.previewError = new Error('catalog exploded')
    await expect(sessionService.previewAgentChange(SID, {})).rejects.toThrow('catalog exploded')
  })
})

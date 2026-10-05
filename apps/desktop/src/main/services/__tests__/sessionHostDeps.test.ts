/**
 * 桌面 SessionHost 的 seam（`buildSessionHostDeps`）与退出钩子。
 *
 *   D10-13 身份：模型 / 目录 / 事件 / 存储三件 / isEphemeral / today / 中断发送策略；单例懒建、只建一次
 *           （P2-06-31：ToolHost 拿到的是 `sessionOf` —— 同步 `get` 打开着的会话，从不打开）
 *   P2-07-51 内置 MCP 服务器认调用方的解析器：(会话, 对话) → host.get(会话)?.agentIdentity(对话)，
 *           同步 get、从不 open / peek；缺省问单例
 *   D10-14 resolveAgentConfig 的档案矩阵（形态推导）
 *   D10-15 toolOverlay（滤掉不可用与 mcp:chrome；原值不动；旧行补键一次）
 *   D10-16 model（会话设置 → 原样；没有 → 启用中的默认 provider / 模型；都没有 → 不给）
 *   D10-17 thinkingLevel（合法值原样，含 off；没有 / 写坏 → 按模型能力：reasoning → 缺省档，否则 off）
 *   D10-18 cwd（项目根 → 自带目录 → 临时工作区；与 getById 同一口径）
 *   D10-19 现读；会话不存在 → 拒绝、什么都不写
 *   D10-20 onLockChange → settings.agentLocked；内存会话写内存；删掉的会话不复活
 *   D10-21 onRunStateChange → settings.runState；值没变不写、不 bump updatedAt
 *   D10-22 审查 seam（真 reviewState）
 *   D10-23 autoResume 每次现读设置
 *   D10-24 isPinned = 会话还有活着的后台任务（PIN-04）
 *   P2-10-06 onDrivenSettled 接到子会话运行器的处理器（overrides 可整项替换）；beforeAbort 同时把中断父会话的
 *            级联交给运行器；import sessionHost 不加载运行器（按需动态加载，加载期无环）
 *   D10-62 退出钩子：第一次 before-quit 拦下、closeAll（封顶）、再 quit；之后放行
 *
 * sessions 表是真的（node:sqlite 内存库 + 迁移，sessionRecords 真件）；sessionService / sessionHost /
 * sessionStorage / taskRegistry 是真的；其余 DAO 与重的上游换成假件。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  localDate,
  toInProcessAgentType,
  type AgentProfile,
  type SessionHost
} from '@shuvix/agent-runtime'
// 进行中审查的登记口不在包的公共出口上：按路径取（与包入口是同一个模块实例）
import { trackReview } from '../../../../../../packages/agent-runtime/src/security/reviewState'
import { DEFAULT_THINKING_LEVEL } from '@shuvix/chat-protocol/types/thinking'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  projects: new Map<string, { path: string; settings: Record<string, unknown> }>(),
  createSessionHostCalls: 0,
  /** 子会话运行器模块被加载了几次（P2-10-06：import sessionHost 时应为 0） */
  runnerLoads: 0,
  /** providerDao.findModelsByProvider 交回的模型行（D10-17 按它给缺省档位；缺省空表） */
  models: [] as Array<{ modelId: string; capabilities: string }>
}))

const mocks = vi.hoisted(() => ({
  findByKey: vi.fn<(key: string) => string | undefined>(),
  findEnabled: vi.fn<() => Array<{ id: string }>>(),
  findEnabledModels: vi.fn<(providerId: string) => Array<{ modelId: string }>>(),
  getProfile: vi.fn<(name: string) => unknown>(),
  filterAvailableTools: vi.fn<(tools: string[], projectPath?: string) => string[]>(),
  settingsGet: vi.fn<(key: string) => string | undefined>(),
  registry: { models: { tag: 'models' }, modelRefOf: () => undefined, tag: 'registry' },
  port: { tag: 'port', listProviders: () => [] },
  sink: { tag: 'sink', broadcast: () => {}, hasUserInputCapability: () => true },
  toolHost: {
    tag: 'toolHost',
    buildBuiltinTools: () => [],
    resolveAgentTools: async () => ({ sandboxed: false }),
    rebuildAgentTools: () => ({})
  },
  createDesktopToolHost: vi.fn(),
  promptHost: { tag: 'promptHost' },
  promptVars: vi.fn(() => ({})),
  onDrivenSettled: vi.fn(async () => {}),
  cascadeParentAbort: vi.fn(async () => {})
}))

vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return {
    ...actual,
    createSessionHost: (...args: Parameters<typeof actual.createSessionHost>) => {
      holder.createSessionHostCalls++
      return actual.createSessionHost(...args)
    }
  }
})
vi.mock('../../dao/database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return holder.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (holder.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => holder.db } }
})
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findModelsByProvider: () => holder.models,
    findEnabled: mocks.findEnabled,
    findEnabledModels: mocks.findEnabledModels
  }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: mocks.findByKey } }))
vi.mock('../../dao/projectDao', () => ({
  projectDao: {
    pick: (id: string, cols: string[]) => {
      const row = holder.projects.get(id) as Record<string, unknown> | undefined
      return row ? Object.fromEntries(cols.map((c) => [c, structuredClone(row[c])])) : undefined
    }
  }
}))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => holder.sessionsDir,
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results'
}))
vi.mock('../models', () => ({
  getModelRegistry: () => mocks.registry,
  providerCredentialPort: mocks.port
}))
vi.mock('../agentRuntimeAdapters', () => ({ electronEventSink: mocks.sink }))
// 真 agentHost 的依赖图很重（electron、工具注册表、MCP……）：工具 / 提示词 seam 换成可辨认的假件
vi.mock('../../agents/agentHost', () => ({
  createDesktopToolHost: mocks.createDesktopToolHost,
  desktopPromptHost: mocks.promptHost,
  desktopPromptVars: mocks.promptVars,
  resolveProfileModelSpec: vi.fn()
}))
vi.mock('../settingsService', () => ({ settingsService: { get: mocks.settingsGet } }))
vi.mock('../subSessionRunner', () => {
  holder.runnerLoads++
  return {
    subSessionRunner: {
      onDrivenSettled: mocks.onDrivenSettled,
      cascadeParentAbort: mocks.cascadeParentAbort
    }
  }
})
vi.mock('../agentService', () => ({
  agentService: { getProfile: mocks.getProfile, isSessionProfile: () => true }
}))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: mocks.filterAvailableTools }))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../agentSession', async () =>
  (await import('./support/fakeSessionHost')).agentSessionModuleMock()
)
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../userInputBroker', () => ({ registerUserInputParticipant: vi.fn() }))
vi.mock('../artifacts/store', () => ({ deleteSessionArtifacts: vi.fn() }))
vi.mock('../sandbox', () => ({ cleanupSession: vi.fn() }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { migrations } from '../../dao/migrations'
import { resolveProfileModelSpec } from '../../agents/agentHost'
import type { Session } from '../../dao/types'
import { sessionRecords } from '../sessionRecords'
import * as storage from '../sessionStorage'
import { taskRegistry } from '../taskRegistry'
import {
  AUTO_RESUME_KEY,
  INTERRUPTED_SEND_POLICY,
  buildSessionHostDeps,
  createDesktopSessionHost,
  getSessionHost,
  installSessionHostQuitHook,
  resetSessionHostForTests,
  sessionAgentResolver,
  type QuitHookApp
} from '../sessionHost'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let sessionService: (typeof import('../sessionService'))['sessionService']
/** 刚 import 完 sessionHost 时 createSessionHost 被调了几次（应为 0：懒建） */
let callsAtImport = -1
/** 刚 import 完 sessionHost 时子会话运行器加载了几次（应为 0：按需动态加载） */
let runnerLoadsAtImport = -1

beforeAll(async () => {
  callsAtImport = holder.createSessionHostCalls
  runnerLoadsAtImport = holder.runnerLoads
  ;({ sessionService } = await import('../sessionService'))
})

const profile = (name: string): AgentProfile =>
  ({
    name,
    displayName: name,
    description: `${name} profile`,
    tools: ['read'],
    systemPrompt: `${name} prompt`,
    instructionFiles: [],
    projectAwareness: false
  }) as unknown as AgentProfile

const KNOWN_PROFILES = new Set(['work', 'chat', 'notebook', 'coedit', 'bot', 'tab', 'coding'])

function row(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: { enabledTools: [] },
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...patch
  }
}

/** 直接读表上的 settings 与 updatedAt（绕过 sessionRecords，证明「真写了库」） */
function tableRow(
  id: string
): { settings: Record<string, unknown>; updatedAt: number } | undefined {
  const raw = (holder.db as DatabaseSync)
    .prepare('SELECT settings, updatedAt FROM sessions WHERE id = ?')
    .get(id) as { settings: string; updatedAt: number } | undefined
  return raw ? { settings: JSON.parse(raw.settings), updatedAt: raw.updatedAt } : undefined
}

mocks.createDesktopToolHost.mockImplementation(() => mocks.toolHost)
const sessionOfForDeps = vi.fn(() => undefined)
const deps = buildSessionHostDeps({}, sessionOfForDeps)

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-host-deps-'))
  holder.projects.clear()
  sessionRecords.clearEphemeralForTests()
  for (const m of [
    mocks.findByKey,
    mocks.findEnabled,
    mocks.findEnabledModels,
    mocks.getProfile,
    mocks.filterAvailableTools,
    mocks.settingsGet
  ]) {
    m.mockReset()
  }
  mocks.findEnabled.mockReturnValue([])
  mocks.findEnabledModels.mockReturnValue([])
  mocks.getProfile.mockImplementation((name) =>
    KNOWN_PROFILES.has(name) ? profile(name) : undefined
  )
  mocks.filterAvailableTools.mockImplementation((tools) => tools)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(holder.sessionsDir, { recursive: true, force: true })
})

describe('D10-13 身份 seam 与单例', () => {
  it('D10-13 模型 / 目录 / 事件 / 存储 / isEphemeral 都接对了；today = localDate；中断发送策略缺省 abort-then-send', () => {
    expect(deps.models).toBe(mocks.registry.models)
    expect(deps.modelCatalog.registry).toBe(mocks.registry)
    expect(deps.modelCatalog.port).toBe(mocks.port)
    expect(deps.eventSink).toBe(mocks.sink)
    // 工具 / 提示词 seam 来自 agentHost；ToolHost 拿到的是 sessionOf（同步取打开着的会话），没有 lockOf
    expect(deps.toolHost).toBe(mocks.toolHost)
    expect(mocks.createDesktopToolHost).toHaveBeenCalledWith({ sessionOf: sessionOfForDeps })
    expect(mocks.createDesktopToolHost.mock.calls[0][0]).not.toHaveProperty('lockOf')
    expect(deps.promptHost).toBe(mocks.promptHost)
    expect(deps.promptVars).toBe(mocks.promptVars)
    expect(deps.openStorage).toBe(storage.openSessionStorage)
    expect(deps.storageExists).toBe(storage.sessionStorageExists)
    expect(deps.deleteStorage).toBe(storage.deleteSessionStorage)

    sessionRecords.insert(row('e1'), { ephemeral: true })
    sessionRecords.insert(row('p1'))
    expect(deps.isEphemeral?.('e1')).toBe(true)
    expect(deps.isEphemeral?.('p1')).toBe(false)

    vi.useFakeTimers({ toFake: ['Date'] })
    // 本地 23:30：日期是本地的那一天，不是 UTC 的
    vi.setSystemTime(new Date(2026, 9, 4, 23, 30, 0))
    expect(deps.today?.()).toBe(localDate())
    expect(deps.today?.()).toBe('2026-10-04')

    expect(INTERRUPTED_SEND_POLICY).toBe('abort-then-send')
    expect(deps.interruptedSendPolicy).toBe(INTERRUPTED_SEND_POLICY)
  })

  it('D10-13 / P2-06-31 getSessionHost：import 时不建；第一次取才建、只建一次，之后是同一个对象', async () => {
    expect(callsAtImport).toBe(0)
    resetSessionHostForTests()
    const before = holder.createSessionHostCalls
    const first: SessionHost = getSessionHost()
    const second = getSessionHost()
    expect(second).toBe(first)
    expect(holder.createSessionHostCalls - before).toBe(1)
    // 单例的 ToolHost 问的就是这个宿主打开着的会话：同步 get，从不打开会话
    const { sessionOf } = mocks.createDesktopToolHost.mock.calls.at(-1)![0] as {
      sessionOf: (sessionId: string) => unknown
    }
    const getSpy = vi.spyOn(first, 'get')
    const peekSpy = vi.spyOn(first, 'peek')
    const openSpy = vi.spyOn(first, 'open')
    expect(sessionOf('nobody')).toBeUndefined()
    expect(getSpy).toHaveBeenCalledWith('nobody')
    // 开着的会话：sessionOf(id) 就是 host.get(id) 交回的那一个
    const opened = { sessionId: 'open-1' } as unknown as ReturnType<SessionHost['get']>
    getSpy.mockReturnValueOnce(opened)
    expect(sessionOf('open-1')).toBe(opened)
    expect(getSpy).toHaveBeenLastCalledWith('open-1')
    expect(peekSpy).not.toHaveBeenCalled()
    expect(openSpy).not.toHaveBeenCalled()
    await first.closeAll()
    resetSessionHostForTests()
  })

  it('P2-06-31 createDesktopSessionHost(overrides)：ToolHost 的 sessionOf 问的是**这个**宿主，不是单例', async () => {
    const singleton = getSessionHost()
    const own = createDesktopSessionHost({})
    expect(own).not.toBe(singleton)
    const { sessionOf } = mocks.createDesktopToolHost.mock.calls.at(-1)![0] as {
      sessionOf: (sessionId: string) => unknown
    }
    const ownGet = vi.spyOn(own, 'get')
    const singletonGet = vi.spyOn(singleton, 'get')
    expect(sessionOf('x')).toBeUndefined()
    expect(ownGet).toHaveBeenCalledWith('x')
    expect(singletonGet).not.toHaveBeenCalled()
    await own.closeAll()
    await singleton.closeAll()
    resetSessionHostForTests()
  })
})

describe('P2-05 派生 agent 档案模型的 seam', () => {
  it('resolveProfileModel：resolveProfileModelSpec 的命中 → {provider, modelId}；不可用 → null', async () => {
    const spec = vi.mocked(resolveProfileModelSpec)
    spec.mockReturnValueOnce({ provider: 'prov-1', model: 'gpt-5', capabilities: {} })
    expect(await deps.resolveProfileModel?.('prov-1/gpt-5')).toEqual({
      provider: 'prov-1',
      modelId: 'gpt-5'
    })
    spec.mockReturnValueOnce(null)
    expect(await deps.resolveProfileModel?.('nope/missing')).toBeNull()
    expect(spec.mock.calls.map(([value]) => value)).toEqual(['prov-1/gpt-5', 'nope/missing'])
  })
})

describe('P2-07-51 内置 MCP 服务器的调用方解析器', () => {
  it('P2-07-51 (sid, c) => host.get(sid)?.agentIdentity(c)：没开的会话 → undefined；从不 open / peek', () => {
    const EXPLORE = { profileName: 'explore', kind: 'spawned' as const, callerId: 'sub-a1' }
    const agentIdentity = vi.fn((c: number) => (c === 2 ? EXPLORE : undefined))
    const host = {
      get: vi.fn((sid: string) => (sid === 'open-1' ? { agentIdentity } : undefined)),
      open: vi.fn(),
      peek: vi.fn()
    }
    const resolve = sessionAgentResolver(() => host as unknown as SessionHost)

    expect(resolve('nobody', 2)).toBeUndefined()
    expect(host.get).toHaveBeenLastCalledWith('nobody')
    expect(agentIdentity).not.toHaveBeenCalled()

    expect(resolve('open-1', 2)).toBe(EXPLORE)
    expect(agentIdentity).toHaveBeenLastCalledWith(2)
    expect(resolve('open-1', 9)).toBeUndefined()
    expect(host.open).not.toHaveBeenCalled()
    expect(host.peek).not.toHaveBeenCalled()
  })

  it('P2-07-51 缺省问单例宿主（每次现取）：同步 get，从不打开会话', async () => {
    resetSessionHostForTests()
    const resolve = sessionAgentResolver()
    const host = getSessionHost()
    const getSpy = vi.spyOn(host, 'get')
    const openSpy = vi.spyOn(host, 'open')
    const peekSpy = vi.spyOn(host, 'peek')

    expect(resolve('nobody', 1)).toBeUndefined()
    expect(getSpy).toHaveBeenCalledWith('nobody')

    const WORK = { profileName: 'work', kind: 'root' as const }
    getSpy.mockReturnValueOnce({ agentIdentity: () => WORK } as unknown as ReturnType<
      SessionHost['get']
    >)
    expect(resolve('open-1', 1)).toBe(WORK)
    expect(openSpy).not.toHaveBeenCalled()
    expect(peekSpy).not.toHaveBeenCalled()
    await host.closeAll()
    resetSessionHostForTests()
  })
})

describe('D10-14 resolveAgentConfig 的档案矩阵', () => {
  const cases: Array<[string, Partial<Session>, string]> = [
    ['有项目', { projectId: 'p1' }, 'work'],
    ['无项目', {}, 'chat'],
    ['笔记本', { settings: { notebookPath: 'a.md' } }, 'notebook'],
    ['笔记本 + coEdit', { settings: { notebookPath: 'a.md', coEdit: true } }, 'coedit'],
    ['bot', { settings: { bot: 'scout' } }, 'bot'],
    ['chromeTab', { settings: { chromeTab: { installId: 'i', runId: 'r', tabId: 1 } } }, 'tab'],
    ['钉成 coding 的子会话', { parentId: 'P', settings: { agentProfile: 'coding' } }, 'coding'],
    ['钉的档案已不存在', { parentId: 'P', settings: { agentProfile: 'gone' } }, 'chat']
  ]

  it.each(cases)('D10-14 %s → %s', async (_label, patch, expected) => {
    holder.projects.set('p1', { path: '/proj', settings: {} })
    sessionRecords.insert(row('s', patch))
    const config = await deps.resolveAgentConfig('s')
    expect(config.profile.name).toBe(expected)
    expect(config.profile).toEqual(toInProcessAgentType(profile(expected)))
  })

  it('D10-14 getProfile(name) 取不到 → work 兜底', async () => {
    sessionRecords.insert(row('s'))
    mocks.getProfile.mockImplementation((name) => (name === 'work' ? profile('work') : undefined))
    const config = await deps.resolveAgentConfig('s')
    expect(config.profile).toEqual(toInProcessAgentType(profile('work')))
  })
})

describe('D10-15 toolOverlay', () => {
  it('D10-15 = filterAvailableTools(勾选去掉 mcp:chrome, 项目路径)；库里的原值不动', async () => {
    holder.projects.set('p1', { path: '/proj', settings: {} })
    sessionRecords.insert(
      row('s', {
        projectId: 'p1',
        settings: { enabledTools: ['mcp:chrome', 'mcp:ssh', 'skill:x'] }
      })
    )
    mocks.filterAvailableTools.mockImplementation((tools) => tools.filter((t) => t !== 'skill:x'))
    const config = await deps.resolveAgentConfig('s')
    expect(mocks.filterAvailableTools).toHaveBeenCalledWith(['mcp:ssh', 'skill:x'], '/proj')
    expect(config.toolOverlay).toEqual(['mcp:ssh'])
    expect(tableRow('s')?.settings.enabledTools).toEqual(['mcp:chrome', 'mcp:ssh', 'skill:x'])
  })

  it('D10-15 缺键的旧行：补一次（按项目继承）并用补上的值', async () => {
    holder.projects.set('p1', { path: '/proj', settings: { enabledTools: ['skill:y'] } })
    sessionRecords.insert(row('s', { projectId: 'p1', settings: {} }))
    expect((await deps.resolveAgentConfig('s')).toolOverlay).toEqual(['skill:y'])
    expect(tableRow('s')?.settings.enabledTools).toEqual(['skill:y'])
    const updated = tableRow('s')!.updatedAt
    expect((await deps.resolveAgentConfig('s')).toolOverlay).toEqual(['skill:y'])
    expect(tableRow('s')!.updatedAt).toBe(updated)
  })
})

describe('D10-16 model', () => {
  it('D10-16 settings.model 在 → 原样 `{provider: 行 id, modelId}`（停用的 provider 也原样交给运行时去拒）', async () => {
    sessionRecords.insert(row('s', { settings: { model: { provider: 'row-1', modelId: 'm1' } } }))
    expect((await deps.resolveAgentConfig('s')).model).toEqual({ provider: 'row-1', modelId: 'm1' })
    // 默认值不参与
    expect(mocks.findByKey).not.toHaveBeenCalledWith('general.defaultProvider')
  })

  it('D10-16 没有 → 启用中的默认 provider + 默认模型', async () => {
    sessionRecords.insert(row('s'))
    mocks.findByKey.mockImplementation((key) =>
      key === 'general.defaultProvider'
        ? 'row-d'
        : key === 'general.defaultModel'
          ? 'md'
          : undefined
    )
    mocks.findEnabled.mockReturnValue([{ id: 'row-d' }])
    mocks.findEnabledModels.mockImplementation((id) => (id === 'row-d' ? [{ modelId: 'md' }] : []))
    expect((await deps.resolveAgentConfig('s')).model).toEqual({ provider: 'row-d', modelId: 'md' })
  })

  it.each([
    ['默认 provider 已停用', [], [{ modelId: 'md' }]],
    ['默认模型不在启用列表里', [{ id: 'row-d' }], []]
  ])('D10-16 %s → model 不给（运行时拒绝创建）', async (_label, enabled, models) => {
    sessionRecords.insert(row('s'))
    mocks.findByKey.mockImplementation((key) =>
      key === 'general.defaultProvider'
        ? 'row-d'
        : key === 'general.defaultModel'
          ? 'md'
          : undefined
    )
    mocks.findEnabled.mockReturnValue(enabled)
    mocks.findEnabledModels.mockReturnValue(models)
    const config = await deps.resolveAgentConfig('s')
    expect(config.model).toBeUndefined()
    expect('model' in config).toBe(false)
  })
})

describe('D10-17 thinkingLevel（PIN-03）', () => {
  afterEach(() => {
    holder.models = []
  })

  it.each([
    ['off', false, 'off'],
    ['high', false, 'high'],
    ['off', true, 'off'],
    [undefined, false, 'off'],
    ['ultra', false, 'off'],
    [undefined, true, DEFAULT_THINKING_LEVEL],
    ['ultra', true, DEFAULT_THINKING_LEVEL]
  ])('D10-17 设置 %s、模型 reasoning=%s → %s', async (stored, reasoning, expected) => {
    holder.models = [{ modelId: 'm1', capabilities: JSON.stringify({ reasoning }) }]
    sessionRecords.insert(
      row('s', {
        settings: {
          enabledTools: [],
          model: { provider: 'row-1', modelId: 'm1' },
          ...(stored ? { thinkingLevel: stored } : {})
        }
      })
    )
    expect((await deps.resolveAgentConfig('s')).thinkingLevel).toBe(expected)
  })
})

describe('D10-18 cwd', () => {
  it.each([
    ['项目根', { projectId: 'p1' }, '/proj'],
    ['自带目录', { settings: { workingDirectory: '/mine' } }, '/mine'],
    ['临时工作区', {}, '/nonexistent/shuvix-unit/tmp/s']
  ] as Array<[string, Partial<Session>, string]>)('D10-18 %s', async (_label, patch, expected) => {
    holder.projects.set('p1', { path: '/proj', settings: {} })
    sessionRecords.insert(row('s', patch))
    const config = await deps.resolveAgentConfig('s')
    expect(config.cwd).toBe(expected)
    expect(config.cwd).toBe(sessionService.getById('s')?.workingDirectory)
  })
})

describe('D10-19 现读与不存在的会话', () => {
  it('D10-19 两次之间改了设置：第二次读到新值', async () => {
    sessionRecords.insert(row('s', { settings: { enabledTools: [], thinkingLevel: 'low' } }))
    expect((await deps.resolveAgentConfig('s')).thinkingLevel).toBe('low')
    sessionRecords.updateSettings('s', { thinkingLevel: 'high' })
    expect((await deps.resolveAgentConfig('s')).thinkingLevel).toBe('high')
  })

  it('D10-19 会话不存在 → 拒绝（说清楚），什么都不写', async () => {
    await expect(deps.resolveAgentConfig('nope')).rejects.toThrow(/nope/)
    expect(tableRow('nope')).toBeUndefined()
  })
})

describe('D10-20 onLockChange → settings.agentLocked', () => {
  it('D10-20 true / false 落进设置，别的键不动', () => {
    sessionRecords.insert(row('s', { settings: { enabledTools: ['skill:a'], bot: 'x' } }))
    deps.onLockChange?.('s', true)
    expect(tableRow('s')?.settings).toEqual({
      enabledTools: ['skill:a'],
      bot: 'x',
      agentLocked: true
    })
    deps.onLockChange?.('s', false)
    expect(tableRow('s')?.settings.agentLocked).toBe(false)
    expect(tableRow('s')?.settings.enabledTools).toEqual(['skill:a'])
  })

  it('D10-20 内存会话：写在内存行上，表里没有它', () => {
    sessionRecords.insert(row('e'), { ephemeral: true })
    deps.onLockChange?.('e', true)
    expect(sessionRecords.pickSettings('e', ['agentLocked'])?.agentLocked).toBe(true)
    expect(tableRow('e')).toBeUndefined()
  })

  it('D10-20 已删的会话：不抛，也不复活一行', () => {
    sessionRecords.insert(row('d'))
    sessionRecords.deleteById('d')
    expect(() => deps.onLockChange?.('d', true)).not.toThrow()
    expect(tableRow('d')).toBeUndefined()
  })
})

describe('D10-21 onRunStateChange → settings.runState（PIN-06）', () => {
  it('D10-21 idle / busy / interrupted 落进设置；值没变不写、不 bump updatedAt；不认识的 id 不抛', () => {
    sessionRecords.insert(row('s'))
    for (const state of ['busy', 'interrupted', 'idle'] as const) {
      deps.onRunStateChange?.('s', state)
      expect(tableRow('s')?.settings.runState).toBe(state)
    }
    const stamp = tableRow('s')!.updatedAt
    ;(holder.db as DatabaseSync).prepare('UPDATE sessions SET updatedAt = 7 WHERE id = ?').run('s')
    deps.onRunStateChange?.('s', 'idle')
    expect(tableRow('s')!.updatedAt).toBe(7)
    expect(stamp).toBeGreaterThan(0)
    expect(() => deps.onRunStateChange?.('unknown', 'busy')).not.toThrow()
    expect(tableRow('unknown')).toBeUndefined()
  })

  it('D10-21 锁镜像同理：没变不写', () => {
    sessionRecords.insert(row('s', { settings: { enabledTools: [], agentLocked: true } }))
    ;(holder.db as DatabaseSync).prepare('UPDATE sessions SET updatedAt = 7 WHERE id = ?').run('s')
    deps.onLockChange?.('s', true)
    expect(tableRow('s')!.updatedAt).toBe(7)
  })
})

describe('D10-22 审查 seam（真 reviewState）', () => {
  it('D10-22 beforeAbort 只中止本会话进行中的审查；onInputsReopened 重新受理', () => {
    const a = new AbortController()
    const b = new AbortController()
    const untrackA = trackReview('rv-s1', a)
    const untrackB = trackReview('rv-s2', b)
    expect(untrackA).not.toBeNull()

    deps.beforeAbort?.('rv-s1')
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    // 被停止的会话：下一轮之前不再开始新的审查
    expect(trackReview('rv-s1', new AbortController())).toBeNull()

    deps.onInputsReopened?.('rv-s1')
    const again = trackReview('rv-s1', new AbortController())
    expect(again).not.toBeNull()
    again?.()
    untrackB?.()
    untrackA?.()
  })
})

describe('P2-10-06 子会话 seam', () => {
  it('P2-10-06 onDrivenSettled 把事件原样交给运行器的处理器，并等它落定（拒绝原样上抛）', async () => {
    expect(runnerLoadsAtImport).toBe(0)
    const event = { sessionId: 'c1', parentId: 'P', requestId: 'subsession:P:5' } as never
    await deps.onDrivenSettled?.(event)
    expect(mocks.onDrivenSettled).toHaveBeenCalledWith(event)
    mocks.onDrivenSettled.mockRejectedValueOnce(new Error('parent unreachable'))
    await expect(deps.onDrivenSettled?.(event)).rejects.toThrow('parent unreachable')
  })

  it('P2-10-06 overrides.onDrivenSettled 整项替换', () => {
    const own = vi.fn()
    expect(buildSessionHostDeps({ onDrivenSettled: own }, sessionOfForDeps).onDrivenSettled).toBe(
      own
    )
  })

  it('P2-10-06 beforeAbort 把中断父会话的级联交给运行器（不等它）', async () => {
    deps.beforeAbort?.('parent-x')
    await vi.waitFor(() => expect(mocks.cascadeParentAbort).toHaveBeenCalledWith('parent-x'))
  })
})

describe('D10-23 autoResume', () => {
  it('D10-23 每次现读 session.autoResume', () => {
    mocks.settingsGet.mockReturnValue(undefined)
    expect(deps.autoResume?.('s')).toBeUndefined()
    mocks.settingsGet.mockImplementation((key) => (key === AUTO_RESUME_KEY ? 'false' : undefined))
    expect(deps.autoResume?.('s')).toBe('false')
    expect(mocks.settingsGet).toHaveBeenCalledWith('session.autoResume')
  })
})

describe('D10-24 isPinned（PIN-04）', () => {
  it('D10-24 会话还有活着的后台任务 → 钉住；任务落定 → 放开；别的会话不受影响', () => {
    const taskId = taskRegistry.create({
      kind: 'bash',
      sessionId: 'pin-s1',
      title: 'sleep',
      subject: { kind: 'bash', command: 'sleep 9', cwd: '/', logPath: '/tmp/x.log' } as never,
      announceAfter: Infinity
    })
    expect(deps.isPinned?.('pin-s1')).toBe(true)
    expect(deps.isPinned?.('pin-s2')).toBe(false)
    taskRegistry.settle(taskId, { status: 'done' })
    expect(deps.isPinned?.('pin-s1')).toBe(false)
    taskRegistry.killBySession('pin-s1')
  })
})

describe('D10-62 退出钩子（PIN-11）', () => {
  /** 一个只认 before-quit 的假 app：emit() 走一遍监听器，返回这次有没有被 preventDefault */
  function fakeApp(): QuitHookApp & { emit(): boolean; quits: number } {
    const listeners: Array<(event: { preventDefault(): void }) => void> = []
    const app = {
      quits: 0,
      on: (_event: 'before-quit', listener: (event: { preventDefault(): void }) => void) => {
        listeners.push(listener)
        return app
      },
      quit: () => {
        app.quits++
      },
      emit: () => {
        let prevented = false
        for (const listener of listeners) listener({ preventDefault: () => (prevented = true) })
        return prevented
      }
    }
    return app
  }

  it('D10-62 第一次 before-quit：拦下、closeAll 恰一次、关完再 quit；之后的 before-quit 放行、不再 closeAll', async () => {
    const app = fakeApp()
    const closeAll = vi.fn(async () => {})
    const hook = installSessionHostQuitHook(app, {
      host: () => ({ closeAll }) as unknown as SessionHost
    })

    expect(app.emit()).toBe(true)
    expect(closeAll).toHaveBeenCalledTimes(1)
    expect(hook.ready).toBe(false)
    await vi.waitFor(() => expect(app.quits).toBe(1))
    expect(hook.ready).toBe(true)

    expect(app.emit()).toBe(false)
    expect(closeAll).toHaveBeenCalledTimes(1)
  })

  it('D10-62 closeAll 卡住超过上限：照样 quit', async () => {
    const app = fakeApp()
    const closeAll = vi.fn(() => new Promise<void>(() => {}))
    installSessionHostQuitHook(app, {
      capMs: 20,
      host: () => ({ closeAll }) as unknown as SessionHost
    })
    expect(app.emit()).toBe(true)
    await vi.waitFor(() => expect(app.quits).toBe(1))
    expect(app.emit()).toBe(false)
  })

  it('D10-62 关停期间又来一次 before-quit：照样拦着，不重复 closeAll', async () => {
    const app = fakeApp()
    let release!: () => void
    const closeAll = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    installSessionHostQuitHook(app, { host: () => ({ closeAll }) as unknown as SessionHost })
    expect(app.emit()).toBe(true)
    expect(app.emit()).toBe(true)
    expect(closeAll).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(app.quits).toBe(1))
  })

  it('D10-62 从没建过宿主：不拦', () => {
    const app = fakeApp()
    const hook = installSessionHostQuitHook(app, { host: () => undefined })
    expect(app.emit()).toBe(false)
    expect(hook.ready).toBe(true)
    expect(app.quits).toBe(0)
  })
})

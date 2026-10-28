/**
 * 重配（2026-10-26）的真宿主集成（RD-6）：真 SessionHost（单例经 `resetSessionHostForTests` 换上有 faux-1 / faux-2
 * 两个模型的 faux 套件与 `emptyToolHost` —— 它实现了重配：新服务器连不上、没有技能）+ 真 sessionService / 网关 +
 * 临时目录里的真 SQLite 会话存储。模型注册表（`getModelRegistry`）与 provider 行换成同一份 faux 目录：sessionService
 * 判「锁住的 agent 用不用得了这个模型」与运行时重配读的是同一张表。mock 面照 agentInfoEnsure.test.ts。
 *
 *   RD-6  锁住的会话 setModel(faux, faux-2)：答 true；initAgent 报锁里的 faux-2；下一次请求用 faux-2；其间没有
 *         agent_created / agent_closing（同一个 agent，没有重建）
 *   RD-6b 锁住的 agent 用不了的模型（目录里没有）→ false：设置与锁都还是 faux-1
 *   RD-6c 锁住的会话 updateEnabledTools → true；锁记下新的勾选（`lock.selection`），initAgent 报的就是它；没有重建
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DurableSession, ModelCatalog } from '@shuvix/agent-runtime'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  toolResults: '',
  /** 这个「进程」的模型目录（注册表 + provider 行）：sessionService 与运行时读同一份 */
  catalog: undefined as unknown
}))

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  getProfile: vi.fn<(name: string) => unknown>()
}))

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
    findModelsByProvider: () => [],
    findEnabled: () => [],
    findEnabledModels: () => []
  }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: () => undefined } }))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => holder.sessionsDir,
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => holder.toolResults,
  getSessionArtifactsDir: (sid: string) => `/nonexistent/shuvix-unit/artifacts/${sid}`,
  isSafeSessionId: () => true
}))
vi.mock('../models', () => ({
  getModelRegistry: () => (holder.catalog as ModelCatalog).registry,
  providerCredentialPort: {
    listProviders: () => (holder.catalog as ModelCatalog).port.listProviders()
  }
}))
vi.mock('../../agents/agentHost', () => ({
  createDesktopToolHost: () => ({
    buildBuiltinTools: () => [],
    resolveAgentTools: async () => ({ sandboxed: false }),
    rebuildAgentTools: () => ({})
  }),
  desktopPromptHost: {},
  desktopPromptVars: () => ({}),
  resolveProfileModelSpec: () => null
}))
vi.mock('../agentRuntimeAdapters', () => ({
  electronEventSink: {
    broadcast: (event: Record<string, unknown>) => mocks.broadcast(event),
    hasUserInputCapability: () => true
  }
}))
vi.mock('../settingsService', () => ({ settingsService: { get: () => undefined } }))
vi.mock('../sessionDayPromptService', () => ({ recordUserEntry: vi.fn() }))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: (tools: string[]) => tools }))
vi.mock('../mcpService', () => ({
  mcpService: { closeSession: async () => {}, getAllToolInfos: () => [] }
}))
vi.mock('../agentService', () => ({
  agentService: { getProfile: mocks.getProfile, isSessionProfile: () => true }
}))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: mocks.broadcast }
}))
vi.mock('../artifacts/store', () => ({ deleteSessionArtifacts: vi.fn() }))
vi.mock('../sandbox', () => ({ cleanupSession: vi.fn() }))
vi.mock('../hookService', () => ({
  hookTriggers: { fire: vi.fn() },
  hookService: { abortSessionRuns: vi.fn() }
}))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: async () => ({}),
  isDefaultTitle: () => false
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({ clearSession: vi.fn() }))
vi.mock('../../tools/allTools', () => ({}))
vi.mock('../toolRegistry', () => ({
  getBuiltinToolEntries: () => [],
  getPlatformBuiltinToolEntries: () => []
}))
vi.mock('../builtinMcp/dbConnections', () => ({
  dbManager: { runtimeStatus: () => undefined, getConnectionInfo: () => undefined }
}))
vi.mock('../builtinMcp/sshServer', () => ({
  sshRuntimeStatuses: () => ({}),
  sshDisconnectRuntime: () => undefined
}))
vi.mock('../skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { migrations } from '../../dao/migrations'
import type { Session } from '../../dao/types'
import { sessionRecords } from '../sessionRecords'
import { clearMemoryStoragesForTests } from '../sessionStorage'
import { getSessionHost, resetSessionHostForTests } from '../sessionHost'
import {
  answer,
  emptyToolHost,
  fauxCatalog,
  fauxKit,
  fauxPort,
  testDepsOverrides,
  withTimeout,
  type FauxKit
} from './support/realHost'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let sessionService: (typeof import('../sessionService'))['sessionService']
let chatGateway: (typeof import('../../frontend/core/DefaultChatGateway'))['chatGateway']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  ;({ chatGateway } = await import('../../frontend/core/DefaultChatGateway'))
})

const profile = (name: string): Record<string, unknown> => ({
  name,
  displayName: name,
  description: '',
  tools: [],
  systemPrompt: '',
  instructionFiles: [],
  projectAwareness: false
})

const TIMEOUT = 25000
const FAUX_1 = { provider: 'faux', modelId: 'faux-1' }

function insert(id: string, patch: Partial<Session> = {}): string {
  sessionRecords.insert({
    id,
    title: id,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: { enabledTools: [], model: FAUX_1 },
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...patch
  })
  return id
}

const settingsOf = (id: string): Record<string, unknown> =>
  (sessionRecords.findById(id)?.settings ?? {}) as Record<string, unknown>

const eventsOf = (type: string, sessionId = 's1'): Array<Record<string, unknown>> =>
  mocks.broadcast.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === type && event.sessionId === sessionId)

const openSession = (id: string): DurableSession => {
  const session = getSessionHost().get(id)
  if (session === undefined) throw new Error(`session ${id} is not open`)
  return session
}

let kit: FauxKit

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-reconfigure-'))
  holder.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-reconfigure-tr-'))
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
  mocks.broadcast.mockClear()
  mocks.getProfile.mockImplementation((name) => profile(name))
  kit = fauxKit({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
  const catalog = fauxCatalog(kit, fauxPort())
  holder.catalog = catalog
  resetSessionHostForTests(
    testDepsOverrides(kit, { toolHost: emptyToolHost, modelCatalog: catalog })
  )
})

afterEach(async () => {
  vi.restoreAllMocks()
  await withTimeout(getSessionHost().closeAll(), 15000, 'closeAll in afterEach').catch(
    () => undefined
  )
  resetSessionHostForTests()
  rmSync(holder.sessionsDir, { recursive: true, force: true })
  rmSync(holder.toolResults, { recursive: true, force: true })
})

/** 一轮 U1 / A1：会话锁在 faux-1 上 */
async function lockedOnFaux1(): Promise<void> {
  insert('s1')
  kit.queue(answer('A1'))
  expect(await chatGateway.prompt('s1', 'U1')).toEqual({})
  expect(openSession('s1').lock?.model).toEqual(FAUX_1)
  expect(eventsOf('agent_created')).toHaveLength(1)
  expect(kit.requests[0]!.modelId).toBe('faux-1')
}

describe('RD-6 重配接到真宿主上', () => {
  it(
    'RD-6 锁住的会话换到 faux-2：答 true，initAgent 报锁里的 faux-2，下一次请求用 faux-2；没有重建',
    async () => {
      await lockedOnFaux1()

      expect(await chatGateway.setModel('s1', 'faux', 'faux-2')).toBe(true)
      expect(settingsOf('s1').model).toEqual({ provider: 'faux', modelId: 'faux-2' })
      expect(openSession('s1').lock?.model).toEqual({ provider: 'faux', modelId: 'faux-2' })
      const init = await sessionService.initAgent('s1')
      expect(init.created).toBe(true)
      expect(init.provider).toBe('faux')
      expect(init.model).toBe('faux-2')

      kit.queue(answer('A2'))
      expect(await chatGateway.prompt('s1', 'U2')).toEqual({})
      expect(kit.requests[1]!.modelId).toBe('faux-2')
      // 同一个 agent：没有销毁、没有新建
      expect(eventsOf('agent_created')).toHaveLength(1)
      expect(eventsOf('agent_closing')).toEqual([])
    },
    TIMEOUT
  )

  it(
    'RD-6b 锁住的 agent 用不了的模型（目录里没有）→ false：设置与锁都还是 faux-1，下一次请求照旧',
    async () => {
      await lockedOnFaux1()

      expect(await chatGateway.setModel('s1', 'faux', 'faux-9')).toBe(false)
      expect(settingsOf('s1').model).toEqual(FAUX_1)
      expect(openSession('s1').lock?.model).toEqual(FAUX_1)
      expect((await sessionService.initAgent('s1')).model).toBe('faux-1')

      kit.queue(answer('A2'))
      expect(await chatGateway.prompt('s1', 'U2')).toEqual({})
      expect(kit.requests[1]!.modelId).toBe('faux-1')
    },
    TIMEOUT
  )

  it(
    'RD-6c 锁住的会话改勾选：答 true，锁记下新的勾选（旧的 skill: 条目不收），initAgent 报的就是它；技能货架不变；没有重建',
    async () => {
      await lockedOnFaux1()
      expect(openSession('s1').lock?.selection).toEqual([])
      const skillsBefore = openSession('s1').lock?.skills

      expect(await sessionService.updateEnabledTools('s1', ['mcp:browser', 'skill:x'])).toBe(true)
      expect(settingsOf('s1').enabledTools).toEqual(['mcp:browser'])
      expect(openSession('s1').lock?.selection).toEqual(['mcp:browser'])
      // 重配从不动技能：货架在创建时定下（2026-10-28）
      expect(openSession('s1').lock?.skills).toEqual(skillsBefore)
      const init = await sessionService.initAgent('s1')
      expect(init.created).toBe(true)
      expect(init.enabledTools).toEqual(['mcp:browser'])
      expect(eventsOf('agent_created')).toHaveLength(1)
      expect(eventsOf('agent_closing')).toEqual([])
    },
    TIMEOUT
  )
})

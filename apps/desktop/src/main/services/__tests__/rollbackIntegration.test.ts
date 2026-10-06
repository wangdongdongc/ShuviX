/**
 * P3-10b · 桌面回退映射到运行时 `rollbackTo`（S：真 SessionHost —— 单例经 `resetSessionHostForTests` 换上 faux
 * 模型 —— + 真 sessionService / 网关 / 门面 / messageService / sessionMirror / sessionDayPromptService（真 DAO）+
 * 临时目录里的真 SQLite 会话存储）。
 *
 *   09 U1 A1 U2 A2、锁着：gateway.rollbackMessage(U2) → true；列表 [U1, A1]（id 不变）；agent_closing 恰一对；
 *      锁镜像 false、init 的 created:false；U2 的日历行还在（PIN-18 对齐）；fileTime 清过一次；再 prompt 重新上锁、
 *      列表 [U1, A1, U3, A3]
 *   09b 被拒（目标是助手消息 / 不在当前对话里）：false，什么都不动 —— 锁、镜像、列表、广播都原样
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DurableSession } from '@shuvix/agent-runtime'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  toolResults: ''
}))

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  getProfile: vi.fn<(name: string) => unknown>(),
  clearFileTime: vi.fn<(sessionId: string) => void>()
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
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => holder.sessionsDir,
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => holder.toolResults,
  getSessionArtifactsDir: (sid: string) => `/nonexistent/shuvix-unit/artifacts/${sid}`,
  isSafeSessionId: () => true
}))
vi.mock('../models', () => ({
  getModelRegistry: () => {
    throw new Error('the model registry is not used in these tests')
  },
  providerCredentialPort: { listProviders: () => [] }
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
  buildTurnCompletedFacts: async () => null,
  isDefaultTitle: () => false
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({
  clearSession: (sessionId: string) => mocks.clearFileTime(sessionId),
  recordRead: vi.fn()
}))
vi.mock('../../tools/allTools', () => ({}))
vi.mock('../toolRegistry', () => ({
  getBuiltinToolEntries: () => [],
  getPlatformBuiltinToolEntries: () => [],
  registerBuiltinTool: vi.fn()
}))
vi.mock('../builtinMcp/dbConnections', () => ({
  dbManager: { runtimeStatus: () => undefined, getConnectionInfo: () => undefined }
}))
vi.mock('../builtinMcp/sshServer', () => ({
  sshRuntimeStatuses: () => ({}),
  sshDisconnectRuntime: () => undefined
}))
vi.mock('../skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string>) =>
    vars?.reason !== undefined ? `${key}:${vars.reason}` : key
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { migrations } from '../../dao/migrations'
import type { Session } from '../../dao/types'
import { sessionRecords } from '../sessionRecords'
import { clearMemoryStoragesForTests } from '../sessionStorage'
import { getSessionHost, resetSessionHostForTests } from '../sessionHost'
import { answer, fauxKit, testDepsOverrides, withTimeout, type FauxKit } from './support/realHost'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let sessionService: (typeof import('../sessionService'))['sessionService']
let messageService: (typeof import('../messageService'))['messageService']
let chatGateway: (typeof import('../../frontend/core/DefaultChatGateway'))['chatGateway']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  ;({ messageService } = await import('../messageService'))
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

function insert(id: string): string {
  sessionRecords.insert({
    id,
    title: id,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: { enabledTools: [], model: { provider: 'faux', modelId: 'faux-1' } },
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1
  } as Session)
  return id
}

const dayRowIds = (sessionId: string): string[] =>
  (
    (holder.db as DatabaseSync)
      .prepare('SELECT entryId FROM session_day_prompts WHERE sessionId = ?')
      .all(sessionId) as Array<{ entryId: string }>
  ).map((row) => row.entryId)

const closingEvents = (sessionId: string): unknown[] =>
  mocks.broadcast.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === 'agent_closing' && event.sessionId === sessionId)
    .map((event) => event.closing)

const mirrorLocked = (sessionId: string): boolean | undefined =>
  sessionRecords.pickSettings(sessionId, ['agentLocked'])?.agentLocked

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
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-p310b-'))
  holder.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-p310b-tr-'))
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
  mocks.broadcast.mockClear()
  mocks.clearFileTime.mockClear()
  mocks.getProfile.mockImplementation((name) => profile(name))
  kit = fauxKit()
  resetSessionHostForTests(testDepsOverrides(kit))
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

/** U1 A1 U2 A2，锁着 */
async function seedTwoTurns(sessionId: string): Promise<string[]> {
  insert(sessionId)
  kit.queue(answer('A1'))
  expect(await chatGateway.prompt(sessionId, 'U1')).toEqual({})
  kit.queue(answer('A2'))
  expect(await chatGateway.prompt(sessionId, 'U2')).toEqual({})
  const listed = await messageService.listBySession(sessionId)
  expect(listed.map((m) => `${m.role}:${m.content}`)).toEqual([
    'user:U1',
    'assistant:A1',
    'user:U2',
    'assistant:A2'
  ])
  expect(openSession(sessionId).lock).toBeDefined()
  expect(mirrorLocked(sessionId)).toBe(true)
  return listed.map((m) => m.id)
}

describe('P3-10b-09 real-host integration (S)', () => {
  it(
    'P3-10b-09 rollback to U2 on a locked session: list [U1, A1] with the same ids; one agent_closing pair; mirror unlocked and init created:false; U2 day row kept; next prompt relocks',
    async () => {
      const [u1, a1, u2] = await seedTwoTurns('s')
      expect(dayRowIds('s')).toContain(u2)
      mocks.broadcast.mockClear()

      expect(await chatGateway.rollbackMessage('s', u2!)).toBe(true)

      const listed = await messageService.listBySession('s')
      expect(listed.map((m) => m.id)).toEqual([u1, a1])
      expect(listed.map((m) => m.content)).toEqual(['U1', 'A1'])
      expect(closingEvents('s')).toEqual([true, false])
      expect(mirrorLocked('s')).toBe(false)
      expect(openSession('s').lock).toBeUndefined()
      expect((await chatGateway.startChat('s')).created).toBe(false)
      expect(sessionService.hasAgentRuntime('s')).toBe(false)
      // PIN-18 对齐：被回退藏起来的条目，日历行照留
      expect(dayRowIds('s')).toContain(u2)
      // 桌面侧随 agent 的状态（fileTime）清过恰一次
      expect(mocks.clearFileTime.mock.calls).toEqual([['s']])

      kit.queue(answer('A3'))
      expect(await chatGateway.prompt('s', 'again')).toEqual({})
      const after = await messageService.listBySession('s')
      expect(after.slice(0, 2).map((m) => m.id)).toEqual([u1, a1])
      expect(after.map((m) => `${m.role}:${m.content}`)).toEqual([
        'user:U1',
        'assistant:A1',
        'user:again',
        'assistant:A3'
      ])
      expect(openSession('s').lock).toBeDefined()
      expect(mirrorLocked('s')).toBe(true)
    },
    TIMEOUT
  )

  it(
    'P3-10b-09b refused targets (an assistant entry, an id not in the current conversation): false and nothing moves — lock, mirror, list, broadcasts, cleanup',
    async () => {
      const ids = await seedTwoTurns('s')
      const lock = openSession('s').lock
      mocks.broadcast.mockClear()

      expect(await chatGateway.rollbackMessage('s', ids[1]!)).toBe(false)
      expect(await chatGateway.rollbackMessage('s', '999999')).toBe(false)

      expect((await messageService.listBySession('s')).map((m) => m.id)).toEqual(ids)
      expect(openSession('s').lock).toEqual(lock)
      expect(mirrorLocked('s')).toBe(true)
      expect(closingEvents('s')).toEqual([])
      expect(mocks.clearFileTime).not.toHaveBeenCalled()
    },
    TIMEOUT
  )
})

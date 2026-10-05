/**
 * P2-14 · 转写摘要的 S 用例：真 SessionHost（单例换上 faux 模型与空 ToolHost）+ 真 sessionService / 网关 / 门面 /
 * messageService / sessionStorage + 临时目录里的真 SQLite —— 与 sessionHostIntegration 同一套接线，但**不**替身
 * sessionTriggerFacts 与 permissionReview。
 *
 *   P2-14-33 两轮真发送：`session.turn-completed` 的事实（第 1 轮 / 第 2 轮）与审查 payload 的 userMessages
 *            都来自 durable 存储；会话目录里只有 `<sid>.sqlite`（及 -wal / -shm）
 *   P2-14-36 什么都不创建：从未发过消息的 durable 行、活着 / 已删的内存会话、带 .jsonl 的旧格式行 ——
 *            两个消费者跑完之后磁盘上、内存里都没有多出存储；宿主只被 peek、从不 open
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  toolResults: ''
}))

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  getProfile: vi.fn<(name: string) => unknown>(),
  fire: vi.fn<(id: string, payload: Record<string, unknown>) => void>()
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
vi.mock('../sessionDayPromptService', () => ({
  recordPromptAdmitted: vi.fn(),
  recordFromUserMessageEvent: vi.fn()
}))
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
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: mocks.broadcast } }))
vi.mock('../artifacts/store', () => ({ deleteSessionArtifacts: vi.fn() }))
vi.mock('../sandbox', () => ({ cleanupSession: vi.fn(), unpinSession: vi.fn() }))
vi.mock('../hookService', () => ({
  hookTriggers: { fire: mocks.fire, decide: async () => null },
  hookService: { abortSessionRuns: vi.fn(), agentsBoundTo: () => new Set<string>() }
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
vi.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string>) =>
    key === 'agent.defaultTitle'
      ? 'New Chat'
      : vars?.reason !== undefined
        ? `${key}:${vars.reason}`
        : key
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { migrations } from '../../dao/migrations'
import type { Session } from '../../dao/types'
import { buildPermissionRequestPayload } from '../permissionReview'
import { sessionRecords } from '../sessionRecords'
import { clearMemoryStoragesForTests, sessionStorageExists } from '../sessionStorage'
import { getSessionHost, resetSessionHostForTests } from '../sessionHost'
import { buildTurnCompletedFacts } from '../sessionTriggerFacts'
import {
  answer,
  fauxKit,
  testDepsOverrides,
  waitFor,
  withTimeout,
  type FauxKit
} from './support/realHost'
import { legacyJsonl, makeEvent, user } from './support/transcriptTwins'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let chatGateway: (typeof import('../../frontend/core/DefaultChatGateway'))['chatGateway']

beforeAll(async () => {
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

function row(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: 'New Chat',
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: {
      enabledTools: [],
      model: { provider: 'faux', modelId: 'faux-1' },
      titleOrigin: 'auto'
    },
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...patch
  }
}

const turnCompleted = (): Record<string, unknown>[] =>
  mocks.fire.mock.calls
    .filter(([id]) => id === 'session.turn-completed')
    .map(([, payload]) => payload)

/** 两个消费者各跑一遍（审查 payload + 起标题事实） */
async function runBothConsumers(sessionId: string): Promise<{
  userMessages: string[]
  facts: Awaited<ReturnType<typeof buildTurnCompletedFacts>>
}> {
  const payload = await buildPermissionRequestPayload(makeEvent(sessionId))
  return { userMessages: payload.userMessages, facts: await buildTurnCompletedFacts(sessionId) }
}

let kit: FauxKit

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-digest-int-'))
  holder.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-digest-int-tr-'))
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
  mocks.broadcast.mockClear()
  mocks.fire.mockClear()
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

describe('P2-14-33 real SessionHost and SQLite: both consumers read the durable store', () => {
  it('two prompts → turn-completed facts per turn, the reviewer sees both prompts, only the sqlite files on disk', async () => {
    sessionRecords.insert(row('s1'))
    kit.queue(answer('r1'))
    expect(await chatGateway.prompt('s1', 'first')).toEqual({})
    await waitFor(() => turnCompleted().length === 1, 3000, 'turn 1 facts')
    kit.queue(answer('r2'))
    expect(await chatGateway.prompt('s1', 'second')).toEqual({})
    await waitFor(() => turnCompleted().length === 2, 3000, 'turn 2 facts')

    const [first, second] = turnCompleted()
    expect(first).toMatchObject({ sessionId: 's1', turnCount: 1, textMessageCount: 2 })
    expect(second).toMatchObject({
      sessionId: 's1',
      turnCount: 2,
      textMessageCount: 4,
      recentText: 'User: first\nAssistant: r1\nUser: second\nAssistant: r2',
      titleAutoGenerated: true
    })
    expect((await buildPermissionRequestPayload(makeEvent('s1'))).userMessages).toEqual([
      'first',
      'second'
    ])
    const files = readdirSync(holder.sessionsDir)
    expect(files).toContain('s1.sqlite')
    expect(
      files.every((name) => ['s1.sqlite', 's1.sqlite-wal', 's1.sqlite-shm'].includes(name))
    ).toBe(true)
  })
})

describe('P2-14-36 nothing is created', () => {
  function spyHost(): { peek: ReturnType<typeof vi.spyOn>; open: ReturnType<typeof vi.spyOn> } {
    const host = getSessionHost()
    return { peek: vi.spyOn(host, 'peek'), open: vi.spyOn(host, 'open') }
  }

  it('(a) a durable row never prompted: no file appears; the host is peeked, never opened', async () => {
    sessionRecords.insert(row('fresh'))
    const host = spyHost()
    expect(await runBothConsumers('fresh')).toEqual({
      userMessages: [],
      facts: expect.objectContaining({ turnCount: 0, textMessageCount: 0, recentText: '' })
    })
    expect(readdirSync(holder.sessionsDir)).toEqual([])
    expect(host.peek).toHaveBeenCalledWith('fresh')
    expect(host.open).not.toHaveBeenCalled()
    expect(getSessionHost().openSessionIds()).toEqual([])
  })

  it('(b) a live in-memory session never prompted: no MemoryStorage is made', async () => {
    sessionRecords.insert(row('mem'), { ephemeral: true })
    const host = spyHost()
    expect((await runBothConsumers('mem')).facts).toMatchObject({ turnCount: 0 })
    expect(sessionStorageExists('mem')).toBe(false)
    expect(readdirSync(holder.sessionsDir)).toEqual([])
    expect(host.open).not.toHaveBeenCalled()
  })

  it('(c) a retired in-memory session: nothing in memory, nothing on disk', async () => {
    sessionRecords.insert(row('gone'), { ephemeral: true })
    sessionRecords.deleteById('gone')
    const host = spyHost()
    expect(await runBothConsumers('gone')).toEqual({ userMessages: [], facts: null })
    expect(sessionStorageExists('gone')).toBe(false)
    expect(readdirSync(holder.sessionsDir)).toEqual([])
    expect(host.open).not.toHaveBeenCalled()
  })

  it('(d) a legacy row with a .jsonl: read through the frozen projection, no .sqlite appears', async () => {
    sessionRecords.insert(row('old', { storageKind: 'harness-v3-jsonl' }))
    writeFileSync(
      join(holder.sessionsDir, 'old.jsonl'),
      legacyJsonl('old', [user(1000, 'legacy hi')])
    )
    const host = spyHost()
    expect(await runBothConsumers('old')).toEqual({
      userMessages: ['legacy hi'],
      facts: expect.objectContaining({
        turnCount: 1,
        textMessageCount: 1,
        recentText: 'User: legacy hi'
      })
    })
    expect(readdirSync(holder.sessionsDir)).toEqual(['old.jsonl'])
    expect(host.peek).not.toHaveBeenCalled()
    expect(host.open).not.toHaveBeenCalled()
  })
})

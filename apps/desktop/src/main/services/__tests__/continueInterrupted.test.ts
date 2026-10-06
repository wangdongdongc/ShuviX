/**
 * 被中断的会话：`session.list` / `getById` 的界面口径与「继续」（P3-12 Runtime / desktop API 段）——真 SessionHost
 * （单例经 `resetSessionHostForTests` 换上 faux 模型）+ 真 sessionService / 网关 / 门面 + 临时目录里的真 SQLite 存储。
 * mock 骨架照抄 agentInfoEnsure.test.ts。
 *
 *   P3-12-01 session.list 的运行标记：镜像 busy / interrupted / idle / 缺键 × 本进程开着 / 没开着（Q-P3-20）；
 *            Chrome 标签页会话照旧不在列表里
 *   P3-12-02 列表只读：不 open / peek / 建存储；宿主还没建就不建；行里仍是 busy、updatedAt 不动
 *   P3-12-03 getById 与列表同一个口径（PIN-19）
 *   P3-12-04 网关 continue（PIN-16）：开着且被中断 → 门面 continue 恰一次；没开但存储在 → peek 再继续；
 *            没存储 / 旧格式 / 不认识 / 宿主已封存 → {}，不开不建、不出文件、不广播
 *   P3-12-05 门面埋点（真宿主那一半）：续上被中断的工作 → session.turn-completed 恰一次
 *   P3-12-06 空闲、没锁的会话上 continue：严格无操作 —— 镜像仍 agentLocked:false、init().created 为 false、
 *            没有 agent_created、调度器停着、零次 LLM
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backgroundContext as BG, type SessionHostDeps } from '@shuvix/agent-runtime'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  toolResults: ''
}))

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  getProfile: vi.fn<(name: string) => unknown>(),
  fire: vi.fn(),
  recordPromptAdmitted: vi.fn()
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
  recordPromptAdmitted: mocks.recordPromptAdmitted,
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
vi.mock('../artifacts/store', () => ({ deleteSessionArtifacts: vi.fn() }))
vi.mock('../sandbox', () => ({ cleanupSession: vi.fn() }))
vi.mock('../hookService', () => ({
  hookTriggers: { fire: mocks.fire },
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
import { getSessionHost, peekSessionHost, resetSessionHostForTests } from '../sessionHost'
import { AgentSession } from '../agentSession'
import {
  answer,
  fauxKit,
  stalled,
  testDepsOverrides,
  transcript,
  waitFor,
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
  systemPrompt: 'You are the desktop agent',
  instructionFiles: [],
  projectAwareness: false
})

const FAUX_SELECTION = { provider: 'faux', modelId: 'faux-1' }

function insert(id: string, patch: Partial<Session> = {}): string {
  sessionRecords.insert({
    id,
    title: id,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    ...patch,
    settings: { enabledTools: [], model: FAUX_SELECTION, ...patch.settings },
    createdAt: 1,
    updatedAt: patch.updatedAt ?? 1,
    lastActiveAt: 1
  })
  return id
}

const settingsOf = (id: string): Record<string, unknown> =>
  (sessionRecords.findById(id)?.settings ?? {}) as Record<string, unknown>

const runStateOfList = (id: string): unknown =>
  sessionService.list().find((s) => s.id === id)?.settings.runState

const eventsOf = (type: string, sessionId = 's1'): Array<Record<string, unknown>> =>
  mocks.broadcast.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === type && event.sessionId === sessionId)

const filesOf = (sessionId: string): string[] =>
  readdirSync(holder.sessionsDir).filter((name) => name.startsWith(`${sessionId}.`))

const fired = (trigger: string): unknown[] =>
  mocks.fire.mock.calls.filter(([name]) => name === trigger)

function overrides(kit: FauxKit): Partial<SessionHostDeps> {
  return testDepsOverrides(kit)
}

/** 换一个「进程」：关掉现在的宿主，按新的 faux 套件换一个新的单例（第一次用时才建） */
async function newProcess(): Promise<FauxKit> {
  await withTimeout(getSessionHost().closeAll(), 15000, 'closeAll').catch(() => undefined)
  const next = fauxKit()
  resetSessionHostForTests(overrides(next))
  return next
}

/** 在当前「进程」里起一轮卡住的运行，再换进程：留下一条被中断的会话（镜像仍是 busy） */
async function leaveInterrupted(id: string): Promise<FauxKit> {
  insert(id)
  const stall = stalled()
  kit.queue(stall.step)
  void chatGateway.prompt(id, 'first')
  await stall.reached
  return newProcess()
}

let kit: FauxKit

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-continue-'))
  holder.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-continue-tr-'))
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
  mocks.broadcast.mockClear()
  mocks.fire.mockClear()
  mocks.recordPromptAdmitted.mockClear()
  mocks.getProfile.mockImplementation((name) => profile(name))
  kit = fauxKit()
  resetSessionHostForTests(overrides(kit))
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

describe('P3-12-01..03 · the effective runState of session.list / getById', () => {
  it('P3-12-01 busy on a session that is not open → interrupted; open + busy → busy; interrupted / idle / absent pass through; chrome tabs stay out', async () => {
    insert('closed-busy', { settings: { runState: 'busy' } })
    insert('closed-int', { settings: { runState: 'interrupted' } })
    insert('closed-idle', { settings: { runState: 'idle' } })
    insert('closed-none')
    insert('tab', {
      settings: { runState: 'busy', chromeTab: { installId: 'i1', runId: 'r1', tabId: 5 } }
    })
    const host = getSessionHost()
    for (const id of ['open-busy', 'open-int', 'open-idle']) {
      insert(id)
      await host.open(id)
    }
    // 打开会对账镜像；之后按矩阵把镜像钉成要测的值（打开着的会话 = 本进程里的权威）
    sessionRecords.updateSettings('open-busy', { runState: 'busy' })
    sessionRecords.updateSettings('open-int', { runState: 'interrupted' })
    sessionRecords.updateSettings('open-idle', { runState: 'idle' })

    const rows = new Map(sessionService.list().map((s) => [s.id, s.settings]))
    expect(rows.get('closed-busy')?.runState).toBe('interrupted')
    expect(rows.get('open-busy')?.runState).toBe('busy')
    expect(rows.get('closed-int')?.runState).toBe('interrupted')
    expect(rows.get('open-int')?.runState).toBe('interrupted')
    expect(rows.get('closed-idle')?.runState).toBe('idle')
    expect(rows.get('open-idle')?.runState).toBe('idle')
    expect(rows.get('closed-none')).toBeDefined()
    expect(rows.get('closed-none')?.runState).toBeUndefined()
    expect(rows.has('tab')).toBe(false)
  })

  it('P3-12-02 the list is read-only: no host is instantiated when none exists; no open / peek / storage; the row still says busy, updatedAt untouched', async () => {
    insert('s1', { settings: { runState: 'busy' }, updatedAt: 7 })
    expect(peekSessionHost()).toBeUndefined()
    expect(runStateOfList('s1')).toBe('interrupted')
    expect(sessionService.getById('s1')?.settings.runState).toBe('interrupted')
    expect(peekSessionHost()).toBeUndefined()

    const host = getSessionHost()
    const open = vi.spyOn(host, 'open')
    const peek = vi.spyOn(host, 'peek')
    expect(runStateOfList('s1')).toBe('interrupted')
    expect(open).not.toHaveBeenCalled()
    expect(peek).not.toHaveBeenCalled()
    expect(filesOf('s1')).toEqual([])
    expect(settingsOf('s1').runState).toBe('busy')
    expect(sessionRecords.findById('s1')?.updatedAt).toBe(7)
  })

  it('P3-12-03 getById gives the same effective runState as the list for the same row (PIN-19)', async () => {
    insert('a', { settings: { runState: 'busy' } })
    insert('b')
    insert('c', { settings: { runState: 'idle' } })
    await getSessionHost().open('b')
    sessionRecords.updateSettings('b', { runState: 'busy' })
    for (const id of ['a', 'b', 'c']) {
      expect(sessionService.getById(id)?.settings.runState).toBe(runStateOfList(id))
    }
    expect(sessionService.getById('a')?.settings.runState).toBe('interrupted')
    expect(sessionService.getById('b')?.settings.runState).toBe('busy')
    expect(sessionService.getById('c')?.settings.runState).toBe('idle')
  })

  it('P3-12-01 a real interrupted session (left busy by the previous process) lists as interrupted before it is opened; the mirror still says busy', async () => {
    await leaveInterrupted('s1')
    expect(settingsOf('s1').runState).toBe('busy')
    expect(runStateOfList('s1')).toBe('interrupted')
    expect(peekSessionHost()).toBeUndefined()
  })
})

describe('P3-12-04 / 05 · gateway continue', () => {
  it('P3-12-04 closed but stored: peek, then continue — the interrupted run completes; P3-12-05 one turn-completed', async () => {
    const kit2 = await leaveInterrupted('s1')
    kit2.queue(answer('resumed answer'))
    const facadeContinue = vi.spyOn(AgentSession.prototype, 'continue')
    mocks.fire.mockClear()
    expect(getSessionHost().get('s1')).toBeUndefined()
    expect(await chatGateway.continue('s1')).toEqual({})
    expect(facadeContinue).toHaveBeenCalledTimes(1)
    expect(kit2.callCount).toBe(1)
    const session = getSessionHost().get('s1')!
    expect(session.isInterrupted()).toBe(false)
    expect(session.isBusy()).toBe(false)
    expect((await transcript(await session.currentConversation())).at(-1)).toBe(
      'pi.assistant:resumed answer'
    )
    await waitFor(() => fired('session.turn-completed').length === 1)
    expect(fired('session.turn-completed')).toHaveLength(1)
    await waitFor(() => settingsOf('s1').runState === 'idle')
    expect(runStateOfList('s1')).toBe('idle')
  })

  it('P3-12-04 open and interrupted: the facade continue is called once and its result is returned; no extra peek', async () => {
    const kit2 = await leaveInterrupted('s1')
    kit2.queue(answer('resumed answer'))
    const session = (await getSessionHost().peek('s1'))!
    expect(session.isInterrupted()).toBe(true)
    expect(runStateOfList('s1')).toBe('interrupted')
    const facadeContinue = vi.spyOn(AgentSession.prototype, 'continue')
    const peek = vi.spyOn(getSessionHost(), 'peek')
    expect(await chatGateway.continue('s1')).toEqual({})
    expect(facadeContinue).toHaveBeenCalledTimes(1)
    expect(peek).not.toHaveBeenCalled()
    expect(kit2.callCount).toBe(1)
  })

  it('P3-12-04 no storage, a legacy session, an unknown id and a sealed host: {}; nothing opened or created, no file, no broadcast', async () => {
    insert('fresh')
    insert('old', { storageKind: 'harness-v3-jsonl' })
    const file = join(holder.sessionsDir, 'old.jsonl')
    writeFileSync(file, '{"type":"session","version":3}\n')
    const bytes = readFileSync(file)
    const host = getSessionHost()
    const open = vi.spyOn(host, 'open')
    expect(await chatGateway.continue('fresh')).toEqual({})
    expect(await chatGateway.continue('old')).toEqual({})
    expect(await chatGateway.continue('ghost')).toEqual({})
    expect(open).not.toHaveBeenCalled()
    expect(host.get('fresh')).toBeUndefined()
    expect(filesOf('fresh')).toEqual([])
    expect(filesOf('ghost')).toEqual([])
    expect(readFileSync(file)).toEqual(bytes)

    insert('s2')
    await host.closeAll()
    expect(await chatGateway.continue('s2')).toEqual({})
    expect(filesOf('s2')).toEqual([])
    expect(mocks.broadcast).not.toHaveBeenCalled()
    expect(kit.callCount).toBe(0)
  })
})

describe('P3-12-06 · idle no-op on a real host', () => {
  it('P3-12-06 continue on an idle, unlocked session: the mirror stays unlocked, init().created is false, no agent_created, scheduling paused, no LLM call, no hook', async () => {
    insert('s1')
    const session = await getSessionHost().open('s1')
    expect(session.lock).toBeUndefined()
    mocks.broadcast.mockClear()
    expect(await chatGateway.continue('s1')).toEqual({})
    expect(session.lock).toBeUndefined()
    expect(settingsOf('s1').agentLocked).not.toBe(true)
    expect((await chatGateway.startChat('s1')).created).toBe(false)
    expect(eventsOf('agent_created')).toEqual([])
    expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    expect(kit.callCount).toBe(0)
    expect(fired('session.turn-completed')).toEqual([])
  })
})

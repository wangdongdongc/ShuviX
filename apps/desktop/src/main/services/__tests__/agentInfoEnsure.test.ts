/**
 * `agent.getInfo` 的 ensure 语义与接线（P3-06 C 段 18–28、D 段 29 / 30 的真宿主部分、回归 R2 / R3）：真 SessionHost
 * （单例经 `resetSessionHostForTests` 换上 faux 模型与计数的 ToolHost）+ 真 sessionService / 网关 / 门面 + 临时目录里
 * 的真 SQLite 会话存储。
 *
 *   18 新会话上 ensure：建存储、上锁、恰一个 agent_created、零次 LLM、调度器停着；之后不带 ensure 读到同一份
 *   19 新会话不带 ensure：null，不 open / peek、不建存储、不广播、镜像不动
 *   20 锁着再 ensure：不再创建（配置 / 工具 / 变量表都不再调）· 21 并发 ensure 合流成一次创建
 *   22 ensure 从不解锁 · 23 被中断且锁着：不续跑、不送达、不追加 · 24 被中断、重开时锁被清掉：按此刻的配置重建锁
 *   25 旧格式会话 · 26 不认识的会话 / 宿主已封存 · 27 没有可用模型（PIN-01）与意外的创建失败
 *   28 ensure 没有发送的副作用（hook 埋点、日历、日期通知、显示侧车、受理回调）；MCP 只在创建里连一次
 *   29 门面 getRuntimeInfo = 锁所在对话的 agentInfo · 30 不带 ensure、锁着但被 LRU 关掉 → peek（PIN-03）
 *   R2 ensure 之后「有运行时 ⇒ 锁住」· R3 读完之后会话仍可回收
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import {
  backgroundContext as BG,
  DisplayDoc,
  SessionStateDoc,
  type DurableSession,
  type SessionHostDeps,
  type ToolHost
} from '@shuvix/agent-runtime'

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
import { getSessionHost, resetSessionHostForTests } from '../sessionHost'
import {
  allEntries,
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

const PERSONA = 'You are the desktop agent'

const profile = (name: string): Record<string, unknown> => ({
  name,
  displayName: name,
  description: '',
  tools: ['probe'],
  systemPrompt: PERSONA,
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
    settings: { enabledTools: [], model: FAUX_SELECTION },
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

const filesOf = (sessionId: string): string[] =>
  readdirSync(holder.sessionsDir).filter((name) => name.startsWith(`${sessionId}.`))

/** ToolHost 与变量表的调用计数（每个「进程」共用；`fail*` 注入失败） */
const counters = {
  resolve: 0,
  rebuild: 0,
  builtin: 0,
  vars: 0,
  failResolve: undefined as Error | undefined,
  failRebuild: undefined as Error | undefined
}

const probe: ToolRegistration = defineTool({
  name: 'probe',
  description: 'probe: looks at things',
  parameters: Type.Object({ target: Type.String() }),
  execute: async () => ({ content: [{ type: 'text', text: 'probe done' }] })
})

const countingToolHost: ToolHost = {
  buildBuiltinTools: () => {
    counters.builtin++
    return []
  },
  resolveAgentTools: async () => {
    counters.resolve++
    if (counters.failResolve !== undefined) throw counters.failResolve
    return { sandboxed: false, tools: [probe] }
  },
  rebuildAgentTools: () => {
    counters.rebuild++
    if (counters.failRebuild !== undefined) throw counters.failRebuild
    return { tools: [probe] }
  }
}

function overrides(kit: FauxKit, extra: Partial<SessionHostDeps> = {}): Partial<SessionHostDeps> {
  return testDepsOverrides(kit, {
    toolHost: countingToolHost,
    promptVars: () => {
      counters.vars++
      return {}
    },
    ...extra
  })
}

/** 换一个「进程」：关掉现在的宿主，按新的 faux 套件建一个新的单例 */
async function newProcess(extra: Partial<SessionHostDeps> = {}): Promise<FauxKit> {
  await withTimeout(getSessionHost().closeAll(), 15000, 'closeAll').catch(() => undefined)
  const next = fauxKit()
  resetSessionHostForTests(overrides(next, extra))
  return next
}

const opened = (sessionId = 's1'): DurableSession => getSessionHost().get(sessionId)!
const evictable = (session: DurableSession): boolean =>
  (session as unknown as { evictable: boolean }).evictable

let kit: FauxKit

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-agent-info-'))
  holder.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-agent-info-tr-'))
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
  mocks.broadcast.mockClear()
  mocks.fire.mockClear()
  mocks.recordPromptAdmitted.mockClear()
  mocks.getProfile.mockImplementation((name) => profile(name))
  Object.assign(counters, {
    resolve: 0,
    rebuild: 0,
    builtin: 0,
    vars: 0,
    failResolve: undefined,
    failRebuild: undefined
  })
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

describe('P3-06 C · ensure', () => {
  it('P3-06-18 ensure on a fresh session: storage + lock + one agent_created, no LLM call, scheduling paused; a plain read equals it', async () => {
    insert('s1')
    expect(filesOf('s1')).toEqual([])
    const info = await chatGateway.getAgentInfo('s1', { ensure: true })
    expect(info).not.toBeNull()
    expect(info!.systemPrompt).toBe(PERSONA)
    expect(info!.tools.map((tool) => tool.name)).toEqual(['probe'])
    expect(info!.tools[0]!.parameters).toEqual(['target'])
    expect(info!.model.id).toBe('faux-1')
    expect(info!.messageCount).toBe(0)
    expect(info!.isStreaming).toBe(false)
    expect(existsSync(join(holder.sessionsDir, 's1.sqlite'))).toBe(true)
    expect(opened().lock).toBeDefined()
    expect(settingsOf('s1').agentLocked).toBe(true)
    expect(eventsOf('agent_created')).toEqual([{ type: 'agent_created', sessionId: 's1' }])
    expect(kit.callCount).toBe(0)
    expect((await opened().harness.inspect(BG)).scheduling).toBe('paused')
    expect(await chatGateway.getAgentInfo('s1')).toEqual(info)
  })

  it('P3-06-19 no ensure on a fresh session: null; no open / peek, no storage, no lock, no broadcast, mirror untouched', async () => {
    insert('s1')
    const host = getSessionHost()
    const open = vi.spyOn(host, 'open')
    const peek = vi.spyOn(host, 'peek')
    const settings = structuredClone(settingsOf('s1'))
    expect(await chatGateway.getAgentInfo('s1')).toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(peek).not.toHaveBeenCalled()
    expect(filesOf('s1')).toEqual([])
    expect(host.get('s1')).toBeUndefined()
    expect(mocks.broadcast).not.toHaveBeenCalled()
    expect(settingsOf('s1')).toEqual(settings)
  })

  it('P3-06-20 ensure on a locked session creates nothing again: no config / tools / vars call, same createdAt, no extra agent_created', async () => {
    insert('s1')
    const first = await chatGateway.getAgentInfo('s1', { ensure: true })
    const createdAt = opened().lock!.createdAt
    const config = vi.spyOn(sessionService, 'resolveAgentConfig')
    const before = { resolve: counters.resolve, vars: counters.vars }
    const second = await chatGateway.getAgentInfo('s1', { ensure: true })
    expect(config).not.toHaveBeenCalled()
    expect(counters.resolve).toBe(before.resolve)
    expect(counters.vars).toBe(before.vars)
    expect(opened().lock!.createdAt).toBe(createdAt)
    expect(eventsOf('agent_created')).toHaveLength(1)
    expect(second).toEqual(first)
  })

  it('P3-06-21 two concurrent ensures: one creation, equal results', async () => {
    insert('s1')
    const config = vi.spyOn(sessionService, 'resolveAgentConfig')
    const [a, b] = await Promise.all([
      chatGateway.getAgentInfo('s1', { ensure: true }),
      chatGateway.getAgentInfo('s1', { ensure: true })
    ])
    expect(config).toHaveBeenCalledTimes(1)
    expect(counters.resolve).toBe(1)
    expect(eventsOf('agent_created')).toHaveLength(1)
    expect(a).not.toBeNull()
    expect(b).toEqual(a)
  })

  it('P3-06-22 ensure never unlocks: the lock record is byte-identical, no agent_closing, history intact', async () => {
    insert('s1')
    kit.queue(answer('a1'))
    expect(await chatGateway.prompt('s1', 'hi')).toEqual({})
    const session = opened()
    const stored = JSON.stringify((await session.harness.snapshot(SessionStateDoc, BG))?.lock)
    const lines = await transcript(await session.currentConversation())
    const infos = [
      await chatGateway.getAgentInfo('s1', { ensure: true }),
      await chatGateway.getAgentInfo('s1'),
      await chatGateway.getAgentInfo('s1', { ensure: true })
    ]
    expect(JSON.stringify((await session.harness.snapshot(SessionStateDoc, BG))?.lock)).toBe(stored)
    expect(eventsOf('agent_closing')).toEqual([])
    for (const info of infos) expect(info!.messageCount).toBe(2)
    expect(await transcript(await session.currentConversation())).toEqual(lines)
    expect(lines).toEqual(['pi.user:hi', 'pi.assistant:a1'])
  })

  it('P3-06-23 interrupted and locked: the info comes back; nothing resumes, nothing is delivered or appended', async () => {
    insert('s1')
    const stall = stalled()
    kit.queue(stall.step)
    void chatGateway.prompt('s1', 'long job')
    await stall.reached
    const kit2 = await newProcess()
    const session = (await sessionService.ensureAgentSession('s1'))!.durable
    expect(session.isInterrupted()).toBe(true)
    const conversation = await session.currentConversation()
    const entries = (await allEntries(conversation)).length
    const deferred = structuredClone(
      (await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices
    )
    const info = await chatGateway.getAgentInfo('s1', { ensure: true })
    expect(info).not.toBeNull()
    expect(info!.isStreaming).toBe(false)
    expect(info!.messageCount).toBe(1)
    expect(session.isInterrupted()).toBe(true)
    expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    expect(kit2.callCount).toBe(0)
    expect((await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual(deferred)
    expect((await allEntries(conversation)).length).toBe(entries)
  })

  it('P3-06-24 interrupted, lock cleared at reopen (rebuild failed): ensure locks again from the current config; still interrupted and paused', async () => {
    insert('s1')
    const stall = stalled()
    kit.queue(stall.step)
    void chatGateway.prompt('s1', 'long job')
    await stall.reached
    counters.failRebuild = new Error('rebuild failed')
    const kit2 = await newProcess()
    const session = (await sessionService.ensureAgentSession('s1'))!.durable
    expect(session.lock).toBeUndefined()
    expect(session.isInterrupted()).toBe(true)
    mocks.broadcast.mockClear()
    const resolves = counters.resolve
    const info = await chatGateway.getAgentInfo('s1', { ensure: true })
    expect(info).not.toBeNull()
    expect(info!.systemPrompt).toBe(PERSONA)
    expect(session.lock).toBeDefined()
    expect(counters.resolve).toBe(resolves + 1)
    expect(eventsOf('agent_created')).toHaveLength(1)
    expect(session.isInterrupted()).toBe(true)
    expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    expect(kit2.callCount).toBe(0)
  })

  it('P3-06-25 a legacy session: null with and without ensure; never opened; the .jsonl and storageKind untouched; no mirror write, no broadcast', async () => {
    insert('old', { storageKind: 'harness-v3-jsonl' })
    const file = join(holder.sessionsDir, 'old.jsonl')
    writeFileSync(file, '{"type":"session","version":3}\n')
    const bytes = readFileSync(file)
    const settings = structuredClone(settingsOf('old'))
    const host = getSessionHost()
    const open = vi.spyOn(host, 'open')
    expect(await chatGateway.getAgentInfo('old', { ensure: true })).toBeNull()
    expect(await chatGateway.getAgentInfo('old')).toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(readFileSync(file)).toEqual(bytes)
    expect(sessionRecords.pick('old', ['storageKind'])?.storageKind).toBe('harness-v3-jsonl')
    expect(settingsOf('old')).toEqual(settings)
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('P3-06-26 an unknown session id, and a sealed host: null; no storage file is created', async () => {
    expect(await chatGateway.getAgentInfo('ghost', { ensure: true })).toBeNull()
    expect(await chatGateway.getAgentInfo('ghost')).toBeNull()
    expect(filesOf('ghost')).toEqual([])

    insert('s2')
    await getSessionHost().closeAll()
    expect(await chatGateway.getAgentInfo('s2', { ensure: true })).toBeNull()
    expect(filesOf('s2')).toEqual([])
    expect(eventsOf('agent_created', 's2')).toEqual([])
  })

  it('P3-06-27 no model available (PIN-01): null, no lock, no agent_created, no error event; an unexpected creation error rejects', async () => {
    insert('s1', { settings: { enabledTools: [] } })
    expect(await chatGateway.getAgentInfo('s1', { ensure: true })).toBeNull()
    expect(getSessionHost().get('s1')?.lock).toBeUndefined()
    expect(settingsOf('s1').agentLocked).not.toBe(true)
    expect(eventsOf('agent_created')).toEqual([])
    expect(eventsOf('error')).toEqual([])
    expect(kit.callCount).toBe(0)

    insert('s3')
    counters.failResolve = new Error('tool host exploded')
    await expect(chatGateway.getAgentInfo('s3', { ensure: true })).rejects.toThrow(
      'tool host exploded'
    )
    expect(getSessionHost().get('s3')?.lock).toBeUndefined()
    expect(eventsOf('agent_created', 's3')).toEqual([])
  })

  it('P3-06-28 ensure has none of the side effects of a send; the lazy MCP connect happens exactly once, inside createAgent', async () => {
    await newProcess({ today: () => '2026-10-05' })
    insert('s1')
    expect(await chatGateway.getAgentInfo('s1', { ensure: true })).not.toBeNull()
    expect(await chatGateway.getAgentInfo('s1', { ensure: true })).not.toBeNull()
    expect(counters.resolve).toBe(1)
    const triggers = mocks.fire.mock.calls.map(([trigger]) => trigger)
    expect(triggers).not.toContain('session.prompt-accepted')
    expect(triggers).not.toContain('session.turn-completed')
    expect(mocks.recordPromptAdmitted).not.toHaveBeenCalled()
    const session = opened()
    const conversation = await session.currentConversation()
    expect((await allEntries(conversation)).map((entry) => entry.kind)).not.toContain(
      'shuvix.notice'
    )
    const display = await session.harness.snapshot(DisplayDoc, conversation.id, BG)
    expect(Object.keys(display?.items ?? {})).toEqual([])
  })
})

describe('P3-06 D · facade and gateway against the real host', () => {
  it('P3-06-29 AgentSession.getRuntimeInfo: locked = agentInfo of the lock conversation; unlocked = null', async () => {
    insert('s1')
    const facade = (await sessionService.ensureAgentSession('s1'))!
    expect(await facade.getRuntimeInfo()).toBeNull()
    await facade.createAgent()
    const lock = facade.durable.lock!
    expect(await facade.getRuntimeInfo()).toEqual(
      await facade.durable.agentInfo(lock.conversationId)
    )
    expect(eventsOf('agent_created')).toHaveLength(1)
  })

  it('P3-06-30 no ensure on a locked session the LRU closed: peek, never open-create, never resume (PIN-03)', async () => {
    insert('s1')
    const first = await chatGateway.getAgentInfo('s1', { ensure: true })
    await getSessionHost().close('s1')
    expect(getSessionHost().get('s1')).toBeUndefined()
    const host = getSessionHost()
    const open = vi.spyOn(host, 'open')
    const peek = vi.spyOn(host, 'peek')
    const info = await chatGateway.getAgentInfo('s1')
    expect(info).toEqual(first)
    expect(peek).toHaveBeenCalledWith('s1')
    expect(open).not.toHaveBeenCalled()
    expect((await opened().harness.inspect(BG)).scheduling).toBe('paused')
    expect(kit.callCount).toBe(0)
  })
})

describe('P3-06 regressions', () => {
  it('P3-06-R2 after an ensure the session counts as locked: setModel false, updateEnabledTools refused, initAgent created', async () => {
    insert('s1')
    expect(sessionService.hasAgentRuntime('s1')).toBe(false)
    await chatGateway.getAgentInfo('s1', { ensure: true })
    expect(sessionService.hasAgentRuntime('s1')).toBe(true)
    expect(await chatGateway.setModel('s1', 'faux', 'faux-1')).toBe(false)
    expect(sessionService.updateEnabledTools('s1', ['mcp:other'])).toBe(false)
    expect((await sessionService.initAgent('s1')).created).toBe(true)
  })

  it('P3-06-R3 after getInfo / ensure returns, an idle session is still evictable (no leftover call, no pin)', async () => {
    insert('s1')
    await chatGateway.getAgentInfo('s1', { ensure: true })
    const session = opened()
    await waitFor(() => evictable(session), 1000, 'evictable after ensure')
    await chatGateway.getAgentInfo('s1')
    expect(evictable(session)).toBe(true)
    expect(session.pendingInputCount).toBe(0)
  })
})

/**
 * P2-14 · 转写摘要的 S 用例：真 SessionHost（单例换上 faux 模型与空 ToolHost）+ 真 sessionService / 网关 / 门面 /
 * messageService / sessionStorage + 临时目录里的真 SQLite —— 与 sessionHostIntegration 同一套接线，但**不**替身
 * sessionTriggerFacts 与 permissionReview。
 *
 *   P2-14-33 两轮真发送：`session.turn-completed` 的事实（第 1 轮 / 第 2 轮）与审查 payload 的 userMessages
 *            都来自 durable 存储；会话目录里只有 `<sid>.sqlite`（及 -wal / -shm）
 *   P2-14-36 什么都不创建：从未发过消息的 durable 行、活着 / 已删的内存会话、带 .jsonl 的旧格式行 ——
 *            两个消费者跑完之后磁盘上、内存里都没有多出存储；宿主只被 peek、从不 open
 *   RSRC-33  真发送路径端到端（§19.7）：被驱动的 prompt / steerDriven 是任务，界面的 prompt / steer 是人话
 *   RSRC-26  [guard] 「重新生成」/ 回退后原样重发一条父会话代发的消息：经真网关 → 门面 → durable → 转写摘要，
 *            它仍进 delegatedTasks（resendSources 沿用来源）；改过的文字才是人的话
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
  recordUserEntry: vi.fn()
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
vi.mock('../sandbox', () => ({ cleanupSession: vi.fn() }))
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
  held,
  testDepsOverrides,
  waitFor,
  withTimeout,
  type FauxKit
} from './support/realHost'
import { legacyJsonl, makeEvent, user } from './support/transcriptTwins'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let chatGateway: (typeof import('../../frontend/core/DefaultChatGateway'))['chatGateway']
let sessionService: (typeof import('../sessionService'))['sessionService']
let messageService: (typeof import('../messageService'))['messageService']

beforeAll(async () => {
  ;({ chatGateway } = await import('../../frontend/core/DefaultChatGateway'))
  ;({ sessionService } = await import('../sessionService'))
  ;({ messageService } = await import('../messageService'))
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

describe('RSRC · 真发送路径上的来源（§19.7）', () => {
  /** 父会话驱动子会话的那份发送参数（subSessionRunner 给的形状；§20 起标记恒为后台） */
  const drive = (
    n: number
  ): { requestId: string; driven: { parentId: string; background: boolean } } => ({
    requestId: `subsession:top:${n}`,
    driven: { parentId: 'top', background: true }
  })

  async function seedTopAndChild(): Promise<void> {
    sessionRecords.insert(row('top'))
    sessionRecords.insert(row('child', { parentId: 'top' }))
    kit.queue(answer('r-top'))
    expect(await chatGateway.prompt('top', 'top intent')).toEqual({})
  }

  /** 子会话里文本恰为 `text` 的那条用户消息的 id（界面消息 id = 条目 id） */
  async function userMessageId(text: string): Promise<string> {
    const found = (await messageService.listBySession('child')).filter(
      (m) => m.role === 'user' && m.content === text
    )
    expect(found, text).toHaveLength(1)
    return found[0]!.id
  }

  it('RSRC-33 被驱动的 prompt / steerDriven 是任务，界面的 prompt / steer 是人话（真网关 / 门面 / SQLite）', async () => {
    await seedTopAndChild()
    kit.queue(answer('r1'))
    expect(await chatGateway.prompt('child', 'P task', undefined, undefined, drive(1))).toEqual({})
    kit.queue(answer('r2'))
    expect(await chatGateway.prompt('child', 'H typed')).toEqual({})

    // 扣住第三轮：父会话的引导与人的引导都在它跑着的时候进来
    const run = held(answer('r3'))
    kit.queue(run.step, answer('r4'), answer('r5'))
    const sending = chatGateway.prompt('child', 'H second')
    await run.reached
    expect(
      await chatGateway.steerDriven('child', 'P steer', {
        requestId: 'subsession-steer:top:2',
        parentId: 'top'
      })
    ).toEqual({})
    chatGateway.steer('child', 'H steer')
    const agent = sessionService.getAgentSession('child')!
    await waitFor(async () => (await agent.sessionView()).queue.length === 2, 3000, 'two steers')
    run.release()
    expect(await withTimeout(sending, 10000, 'third round')).toEqual({})
    await waitFor(
      async () => (await agent.sessionView()).queue.length === 0 && !agent.isStreaming,
      5000,
      'steers placed'
    )

    const payload = await buildPermissionRequestPayload(makeEvent('child'))
    expect(payload.delegatedTasks).toStrictEqual(['P task', 'P steer'])
    expect(payload.userMessages).toStrictEqual(['top intent', 'H typed', 'H second', 'H steer'])
    // 子会话存储里恰有被驱动的那两条来源
    expect([...(await agent.inputSources()).values()]).toStrictEqual([
      { kind: 'parent-session', sessionId: 'top' },
      { kind: 'parent-session', sessionId: 'top' }
    ])
  }, 20000)

  it('RSRC-26 [guard] 回退掉父会话代发的那条、原样重发（「重新生成」）：它仍进 delegatedTasks；改过的文字才算人的话', async () => {
    await seedTopAndChild()
    kit.queue(answer('r1'), answer('r2'))
    expect(await chatGateway.prompt('child', 'P1 task', undefined, undefined, drive(1))).toEqual({})
    expect(
      await chatGateway.prompt('child', 'delete legacy/ entirely', undefined, undefined, drive(2))
    ).toEqual({})

    // 重新生成 = 回退到那条之前 + 经 IPC 同一个函数重发同一段文字（没有 drive）
    expect(
      await chatGateway.rollbackMessage('child', await userMessageId('delete legacy/ entirely'))
    ).toBe(true)
    kit.queue(answer('r3'))
    expect(await chatGateway.prompt('child', 'delete legacy/ entirely')).toEqual({})
    const resent = await buildPermissionRequestPayload(makeEvent('child'))
    expect(resent.delegatedTasks).toStrictEqual(['P1 task', 'delete legacy/ entirely'])
    expect(resent.userMessages).toStrictEqual(['top intent'])
    expect(JSON.stringify(resent.userMessages)).not.toContain('delete legacy/')

    // 再回退那条重发的、这次改了字再发：人的话
    expect(
      await chatGateway.rollbackMessage('child', await userMessageId('delete legacy/ entirely'))
    ).toBe(true)
    kit.queue(answer('r4'))
    expect(await chatGateway.prompt('child', 'delete legacy/ entirely, but keep README')).toEqual(
      {}
    )
    const edited = await buildPermissionRequestPayload(makeEvent('child'))
    expect(edited.delegatedTasks).toStrictEqual(['P1 task'])
    expect(edited.userMessages).toStrictEqual([
      'top intent',
      'delete legacy/ entirely, but keep README'
    ])
  }, 20000)
})

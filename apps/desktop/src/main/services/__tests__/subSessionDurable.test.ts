/**
 * P2-10 子会话接 durable 的 S / S+T 用例：真 SessionHost（单例经 `resetSessionHostForTests` 换上 faux 模型）+
 * 真 sessionService / 网关 / 门面 / 子会话运行器 + 临时目录里的真 SQLite 会话存储；真定时器。
 * 「崩溃」= `newProcess()`（closeAll → 清掉进程内记账 → 新的 faux 套件与单例宿主）。
 * S+T：父会话的 agent 经测试 ToolHost 拿到真的 `SessionTool`，父会话的 faux 脚本 `callTool('session', …)`。
 * 父子共用一个 faux 套件，所以应答按**请求的先后**排队。
 *
 *   P2-10-23 (S+T) 崩溃落在回执之后（§20：派活一律回执）→ 父会话「继续」不重跑这次调用、不把子会话带起来
 *                  （BG-36，已知的变化）；那次调用的结果仍是第一次的回执
 *   P2-10-25 (S+T) 之后用户在子会话里继续 → 父会话恰一条写入的通知（上个进程的驱动，不叫醒，option A）
 *   P2-10-26 (S+T) wait 版本：后台 prompt + wait、崩溃 → 父会话「继续」→ 子会话续上一次、wait 交回答复
 *   P2-10-29 (S)   真答复 / 模型错误是答复（带 isError），不是 NOT delivered
 *   P2-10-34 (S)   重启之后：list 报 interrupted，从不为此打开子会话；用户继续之后 idle
 *   P2-10-41 (S)   后台完成跨重启补报：父会话恰一条通知（只写入、不起一轮 —— 驱动不是本进程发起的，
 *                  option A）、带 subsession-done 的 requestId、标记清掉
 *   P2-10-42 (S)   送达之后、清标记之前崩溃：下次打开再报一次，父会话仍只有一条
 *   P2-10-46 (S+T) 中断的父会话被中止（及 abort-then-send）：子会话原样不动、不被 peek（BG-31，§20 不级联）
 *   P2-10-49 (S)   新消息发进被中断的子会话：abort-then-send
 *   P2-10-50 (S)   PIN-19：同一父会话的新消息顶掉它驱动的那一轮 → 不通知；用户自己顶掉 → 通知
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InterruptedSendPolicy, SessionHostDeps } from '@shuvix/agent-runtime'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  toolResults: ''
}))

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  getProfile: vi.fn<(name: string) => unknown>(),
  settingsGet: vi.fn<(key: string) => string | undefined>()
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
vi.mock('../settingsService', () => ({ settingsService: { get: mocks.settingsGet } }))
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
vi.mock('../../utils/toolUtils/fileTime', () => ({ clearSession: vi.fn() }))
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
import type { ToolContext } from '../toolContext'
import { sessionRecords } from '../sessionRecords'
import { clearMemoryStoragesForTests } from '../sessionStorage'
import { taskRegistry } from '../taskRegistry'
import {
  beforeSessionAbort,
  getSessionHost,
  onSubSessionDrivenSettled,
  resetSessionHostForTests
} from '../sessionHost'
import {
  answer,
  callTool,
  fauxKit,
  held,
  modelError,
  stalled,
  testDepsOverrides,
  toolsToolHost,
  transcript,
  waitFor,
  withTimeout,
  type FauxKit
} from './support/realHost'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let sessionService: (typeof import('../sessionService'))['sessionService']
let chatGateway: (typeof import('../../frontend/core/DefaultChatGateway'))['chatGateway']
let runner: (typeof import('../subSessionRunner'))['subSessionRunner']
let SessionTool: (typeof import('../../tools/session'))['SessionTool']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  ;({ chatGateway } = await import('../../frontend/core/DefaultChatGateway'))
  ;({ subSessionRunner: runner } = await import('../subSessionRunner'))
  // eslint-disable-next-line boundaries/dependencies -- S+T 用例有意让真的 session 工具驱动真的运行器（产品里是工具引用服务，这里只是从服务的用例里把它构造出来）
  ;({ SessionTool } = await import('../../tools/session'))
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

/** 每个会话收到的中止前 seam 调用（真 seam 照样执行：审查作废；§20 起不再级联到子会话） */
const aborts: string[] = []

interface ProcessOptions {
  /** 父会话的 agent 带上真的 SessionTool */
  sessionTool?: boolean
  policy?: InterruptedSendPolicy
  onDrivenSettled?: SessionHostDeps['onDrivenSettled']
}

function overrides(kit: FauxKit, options: ProcessOptions): Partial<SessionHostDeps> {
  return testDepsOverrides(kit, {
    beforeAbort: (sessionId) => {
      aborts.push(sessionId)
      beforeSessionAbort(sessionId)
    },
    ...(options.sessionTool
      ? {
          toolHost: toolsToolHost((sessionId) => [new SessionTool({ sessionId } as ToolContext)])
        }
      : {}),
    ...(options.policy ? { interruptedSendPolicy: options.policy } : {}),
    ...(options.onDrivenSettled ? { onDrivenSettled: options.onDrivenSettled } : {})
  })
}

/** 换一个「进程」：关掉现在的宿主，等上一个进程的发送收尾，清掉进程内记账，按新的 faux 套件建单例 */
async function newProcess(options: ProcessOptions = {}): Promise<FauxKit> {
  await withTimeout(getSessionHost().closeAll(), 15000, 'closeAll').catch(() => undefined)
  await withTimeout(runner.drainForTests(), 10000, 'drain runner').catch(() => undefined)
  taskRegistry.killAll()
  runner.resetForTests()
  aborts.length = 0
  const kit = fauxKit()
  resetSessionHostForTests(overrides(kit, options))
  return kit
}

/** 一个会话的转写（打开它；没开就 open） */
async function transcriptOf(sessionId: string): Promise<string[]> {
  const session = getSessionHost().get(sessionId) ?? (await getSessionHost().open(sessionId))
  return transcript(await session.currentConversation())
}

/** 父会话里的子会话通知（steer / 自动续跑的 pi.user，或写入的 shuvix.notice） */
const noticesIn = (entries: string[]): string[] =>
  entries.filter(
    (e) =>
      (e.startsWith('pi.user:') || e.startsWith('shuvix.notice:')) && e.includes('<sub-session')
  )

const userTexts = (entries: string[]): string[] => entries.filter((e) => e.startsWith('pi.user:'))

let kit: FauxKit

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-subsession-s-'))
  holder.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-subsession-s-tr-'))
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
  mocks.broadcast.mockClear()
  mocks.getProfile.mockImplementation((name) => profile(name))
  mocks.settingsGet.mockReset()
  taskRegistry.killAll()
  runner.resetForTests()
  aborts.length = 0
  kit = fauxKit()
  resetSessionHostForTests(overrides(kit, {}))
})

afterEach(async () => {
  await withTimeout(getSessionHost().closeAll(), 15000, 'closeAll in afterEach').catch(
    () => undefined
  )
  await withTimeout(runner.drainForTests(), 10000, 'drain runner').catch(() => undefined)
  resetSessionHostForTests()
  rmSync(holder.sessionsDir, { recursive: true, force: true })
  rmSync(holder.toolResults, { recursive: true, force: true })
})

/** 自动续跑关掉（父会话收到的通知只写成 shuvix.notice，不起轮） */
function autoResumeOff(): void {
  mocks.settingsGet.mockImplementation((key) =>
    key === 'session.autoResume' ? 'false' : undefined
  )
}

/**
 * 进程 1：父会话 P 的模型 prompt-sub-session 进 C（'do it'），C 的请求卡住；P 拿到回执、它的下一步模型请求也卡住
 * → 崩溃。崩溃点是确定的：P 的下一步请求只在那次调用的结果（回执）落进转写之后才发出（§20：派活一律回执 ——
 * 原来的「崩在前台等待里」只在崩溃恰好落进 50ms 确认窗时才成立，是运气）。交回进程 2 的 faux 套件
 * （进程 2 的父会话同样带 SessionTool）。
 */
async function crashAfterReceipt(options: ProcessOptions = {}): Promise<FauxKit> {
  insert('P')
  insert('C', { parentId: 'P' })
  resetSessionHostForTests(overrides(kit, { sessionTool: true }))
  // 父子共用一个 faux 套件：C 的那一轮与 P 的下一步谁先拿到哪个应答都一样 —— 两个都是卡住
  const first = stalled()
  const second = stalled()
  kit.queue(
    callTool('session', { action: 'prompt-sub-session', sub_session_id: 'C', message: 'do it' }),
    first.step,
    second.step
  )
  void chatGateway.prompt('P', 'start')
  await withTimeout(
    Promise.all([first.reached, second.reached]),
    10000,
    'C request and P next step'
  )
  await waitFor(() => settingsOf('C').runState === 'busy', 5000, 'C busy marker')
  return newProcess({ sessionTool: true, ...options })
}

/** P 转写里 session 工具的结果（带 `<sub-session id="C"` 的那几条，不含通知） */
const sessionToolResults = (entries: string[]): string[] =>
  entries.filter((e) => e.includes('<sub-session id="C"') && noticesIn([e]).length === 0)

// ─── S+T：继续的级联 ────────────────────────────────────────────────────────

describe('S+T continue cascade', () => {
  it('P2-10-23 / BG-36 崩溃落在回执之后：父会话「继续」只请求 P 自己 —— 不重跑那次调用、不把 C 带起来；结果仍是第一次的回执（不是「可能已部分执行」）；C 仍被中断、只有一条输入；P 没有通知', async () => {
    const kit2 = await crashAfterReceipt()
    kit2.queue(answer('P-final'))
    const parent = await sessionService.ensureAgentSession('P')
    expect(getSessionHost().get('P')!.isInterrupted()).toBe(true)
    expect(await withTimeout(parent!.continue(), 15000, 'P.continue')).toEqual({})
    // 只有 P 请求过模型；C 没被打开，镜像还是崩溃留下的 busy（没开着的会话按 interrupted 报）
    expect(kit2.callCount).toBe(1)
    expect(getSessionHost().get('C')).toBeUndefined()
    expect(settingsOf('C').runState).toBe('busy')
    const listed = runner.list('P')
    if ('error' in listed) throw new Error(listed.error)
    expect(listed.subSessions.map((s) => [s.id, s.status])).toEqual([['C', 'interrupted']])

    const p = await transcriptOf('P')
    const results = sessionToolResults(p)
    expect(results).toHaveLength(1)
    expect(results[0]).toContain('<sub-session id="C" status="running"/>')
    expect(results[0]).toContain('Started in the background')
    expect(results[0]).not.toMatch(/partially/i)
    expect(results[0]).not.toContain('<reply>')
    expect(p.at(-1)).toBe('pi.assistant:P-final')
    expect(noticesIn(p)).toEqual([])
    expect(userTexts(await transcriptOf('C'))).toEqual(['pi.user:do it'])
    expect(getSessionHost().get('C')!.isInterrupted()).toBe(true)
  }, 30000)

  it('P2-10-25 / BG-36 之后用户在 C 里继续：C 就地续上答完（只有一条输入、没被中止）；P 恰一条写入的通知（上个进程的驱动：不叫醒，option A）；两边镜像 idle、标记清掉', async () => {
    const kit2 = await crashAfterReceipt()
    kit2.queue(answer('P-final'))
    const parent = await sessionService.ensureAgentSession('P')
    expect(await withTimeout(parent!.continue(), 15000, 'P.continue')).toEqual({})
    await waitFor(() => settingsOf('P').runState === 'idle', 5000, 'P idle')
    expect(noticesIn(await transcriptOf('P'))).toEqual([])

    const deliver = vi.spyOn(sessionService, 'deliverSubSessionNotice')
    kit2.queue(answer('C-done'))
    const child = await sessionService.ensureAgentSession('C')
    expect(getSessionHost().get('C')!.isInterrupted()).toBe(true)
    expect(await withTimeout(child!.continue(), 15000, 'C.continue')).toEqual({})
    expect(await transcriptOf('C')).toEqual(['pi.user:do it', 'pi.assistant:C-done'])
    expect(aborts).not.toContain('C')
    await waitFor(async () => noticesIn(await transcriptOf('P')).length === 1, 10000, 'notice in P')
    expect(noticesIn(await transcriptOf('P'))[0]).toMatch(/^shuvix\.notice:<sub-session id="C"/)
    expect(deliver.mock.calls.map((call) => call[3])).toEqual([{ wake: false }])
    await waitFor(() => settingsOf('C').runState === 'idle', 5000, 'C idle')
    await waitFor(
      () => getSessionHost().get('C')?.drivenRun === undefined,
      5000,
      'C marker cleared'
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    // P 一轮都没被叫醒：P 的 P-final 与 C 的 C-done
    expect(kit2.callCount).toBe(2)
    expect(settingsOf('P').runState).toBe('idle')
    deliver.mockRestore()
  }, 30000)

  it('P2-10-26 / BG-35 wait 版本：prompt + wait、崩溃 → 父会话「继续」→ C 续上一次并答完，wait 交回答复；父会话没有通知', async () => {
    insert('P')
    insert('C', { parentId: 'P' })
    resetSessionHostForTests(overrides(kit, { sessionTool: true }))
    const stall = stalled()
    kit.queue(
      callTool(
        'session',
        { action: 'prompt-sub-session', sub_session_id: 'C', message: 'bg task' },
        'call-prompt'
      ),
      stall.step,
      callTool('session', { action: 'wait-for-sub-sessions' }, 'call-wait')
    )
    void chatGateway.prompt('P', 'start')
    await withTimeout(stall.reached, 10000, 'C request')
    await waitFor(() => kit.requests.length >= 3, 10000, 'P called wait')
    // wait 已经挂住（memo 写下了要等的那条）
    await new Promise((resolve) => setTimeout(resolve, 300))

    const kit2 = await newProcess({ sessionTool: true })
    kit2.queue(answer('C-done'), answer('P-final'))
    const parent = await sessionService.ensureAgentSession('P')
    expect(await withTimeout(parent!.continue(), 15000, 'P.continue')).toEqual({})

    expect(await transcriptOf('C')).toEqual(['pi.user:bg task', 'pi.assistant:C-done'])
    const p = await transcriptOf('P')
    expect(
      p.some((e) => e.includes('<sub-sessions status="settled">') && e.includes('C-done'))
    ).toBe(true)
    await waitFor(
      () => getSessionHost().get('C')?.drivenRun === undefined,
      5000,
      'C marker cleared'
    )
    expect(noticesIn(await transcriptOf('P'))).toEqual([])
  }, 30000)
})

// ─── S：答复与状态 ──────────────────────────────────────────────────────────

describe('S answers and status', () => {
  it('P2-10-29 prompt 只回执（§20）：真答复 a1 经 wait 收；模型错误 boom 的那一轮也是发出去了 —— 回执不带 error，wait / read 交回 {answer:boom, isError:true}', async () => {
    insert('P')
    insert('C', { parentId: 'P' })
    kit.queue(answer('a1'))
    expect(
      await runner.prompt({
        parentId: 'P',
        childId: 'C',
        message: 'q1',
        requestId: 'subsession:P:1'
      })
    ).toEqual({ kind: 'started', id: 'C' })
    await waitFor(() => taskRegistry.get('subsession:P:1')?.endedAt != null, 10000, 'turn 1 done')
    expect(await runner.wait({ parentId: 'P', childId: 'C', timeoutSeconds: 10 })).toMatchObject({
      kind: 'settled',
      results: [{ id: 'C', answer: 'a1' }]
    })

    kit.queue(modelError('boom'))
    const failed = await runner.prompt({
      parentId: 'P',
      childId: 'C',
      message: 'q2',
      requestId: 'subsession:P:2'
    })
    expect(failed).toEqual({ kind: 'started', id: 'C' })
    expect(failed).not.toHaveProperty('error')
    await waitFor(() => taskRegistry.get('subsession:P:2')?.endedAt != null, 10000, 'turn 2 done')
    expect(await runner.wait({ parentId: 'P', childId: 'C', timeoutSeconds: 10 })).toMatchObject({
      kind: 'settled',
      results: [{ id: 'C', answer: 'boom', isError: true }]
    })
    expect(await runner.read('P', 'C')).toMatchObject({ answer: 'boom', isError: true })
  }, 20000)

  it('P2-10-34 重启之后：list 报 interrupted、从不为此打开 C；用户继续 C 之后 idle', async () => {
    insert('P')
    insert('C', { parentId: 'P' })
    const stall = stalled()
    kit.queue(stall.step)
    void chatGateway.prompt('C', 'work')
    await withTimeout(stall.reached, 10000, 'C request')
    await waitFor(() => settingsOf('C').runState === 'busy', 5000, 'C busy marker')

    const kit2 = await newProcess()
    const listed = runner.list('P')
    if ('error' in listed) throw new Error(listed.error)
    expect(listed.subSessions.map((s) => [s.id, s.status])).toEqual([['C', 'interrupted']])
    expect(getSessionHost().get('C')).toBeUndefined()

    kit2.queue(answer('done'))
    const child = await sessionService.ensureAgentSession('C')
    expect(await withTimeout(child!.continue(), 15000, 'C.continue')).toEqual({})
    const after = runner.list('P')
    if ('error' in after) throw new Error(after.error)
    expect(after.subSessions.map((s) => s.status)).toEqual(['idle'])
  }, 30000)
})

// ─── S：完成通知跨重启 ──────────────────────────────────────────────────────

describe('S completion notices across restarts', () => {
  it('P2-10-41 后台跑一半崩溃：打开 P 不续上 C、P 什么都没收到；用户继续 C → P 恰一条通知（只写入、不起一轮，option A；subsession-done 的 requestId），标记清掉；再开一次什么都不多', async () => {
    insert('P')
    insert('C', { parentId: 'P' })
    kit.queue(answer('a0'))
    expect(await chatGateway.prompt('P', 'hi')).toEqual({})
    const stall = stalled()
    kit.queue(stall.step)
    expect(
      await runner.prompt({
        parentId: 'P',
        childId: 'C',
        message: 'bg',
        requestId: 'subsession:P:5'
      })
    ).toEqual({ kind: 'started', id: 'C' })
    await withTimeout(stall.reached, 10000, 'C request')

    const kit2 = await newProcess()
    await sessionService.ensureAgentSession('P')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(getSessionHost().get('C')).toBeUndefined()
    expect(noticesIn(await transcriptOf('P'))).toEqual([])

    const deliver = vi.spyOn(sessionService, 'deliverSubSessionNotice')
    kit2.queue(answer('done'))
    const child = await sessionService.ensureAgentSession('C')
    expect(await withTimeout(child!.continue(), 15000, 'C.continue')).toEqual({})
    await waitFor(async () => noticesIn(await transcriptOf('P')).length === 1, 10000, 'notice in P')
    const notice = noticesIn(await transcriptOf('P'))[0]!
    // 这次驱动是上个进程发起的：通知写进 P 的转写（P 的下一轮看得见），不起一轮
    expect(notice.startsWith('shuvix.notice:')).toBe(true)
    expect(notice).toContain('id="C"')
    expect(userTexts(await transcriptOf('P'))).toEqual(['pi.user:hi'])
    expect(deliver.mock.calls[0]![3]).toEqual({ wake: false })
    const noticeRequestId = deliver.mock.calls[0]![2]
    expect(noticeRequestId).toMatch(/^subsession-done:C:\d+$/)
    expect(await getSessionHost().get('P')!.requestState(noticeRequestId)).not.toBe('none')
    await waitFor(
      () => getSessionHost().get('C')?.drivenRun === undefined,
      5000,
      'C marker cleared'
    )
    await waitFor(() => settingsOf('P').runState === 'idle', 10000, 'P idle')
    deliver.mockRestore()
    expect(kit2.callCount).toBe(1)

    const p = await transcriptOf('P')
    const c = await transcriptOf('C')
    await newProcess()
    await sessionService.ensureAgentSession('C')
    await sessionService.ensureAgentSession('P')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await transcriptOf('P')).toEqual(p)
    expect(await transcriptOf('C')).toEqual(c)
  }, 40000)

  it('P2-10-42 送达之后、清标记之前崩溃：打开 C 再报一次，P 仍只有一条（按 requestId 去重），标记清掉', async () => {
    autoResumeOff()
    insert('P')
    insert('C', { parentId: 'P' })
    resetSessionHostForTests(
      overrides(kit, {
        onDrivenSettled: async (event) => {
          await onSubSessionDrivenSettled(event)
          throw new Error('crash before the marker is cleared')
        }
      })
    )
    kit.queue(answer('a0'))
    expect(await chatGateway.prompt('P', 'hi')).toEqual({})
    kit.queue(answer('done'))
    await runner.prompt({
      parentId: 'P',
      childId: 'C',
      message: 'bg',
      requestId: 'subsession:P:7'
    })
    await waitFor(
      async () => noticesIn(await transcriptOf('P')).length === 1,
      10000,
      'first delivery'
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(getSessionHost().get('C')!.drivenRun).toBeDefined()

    await newProcess()
    const deliver = vi.spyOn(sessionService, 'deliverSubSessionNotice')
    await sessionService.ensureAgentSession('C')
    await waitFor(() => deliver.mock.calls.length === 1, 5000, 'redelivery')
    await waitFor(
      () => getSessionHost().get('C')?.drivenRun === undefined,
      5000,
      'C marker cleared'
    )
    expect(noticesIn(await transcriptOf('P'))).toHaveLength(1)
    deliver.mockRestore()
  }, 30000)
})

// ─── S+T：中断父会话的中止级联 ──────────────────────────────────────────────

describe('S+T interrupted parent is stopped: no cascade (§20, BG-31)', () => {
  it('P2-10-46 / BG-31 chatGateway.abort(P)：只中止 P —— C 不被 peek / open / 中止，仍被中断；P 没有通知', async () => {
    await crashAfterReceipt()
    const host = getSessionHost()
    const open = vi.spyOn(host, 'open')
    const peek = vi.spyOn(host, 'peek')
    await sessionService.ensureAgentSession('P')
    expect(host.get('P')!.isInterrupted()).toBe(true)

    await chatGateway.abort('P')
    await waitFor(() => host.get('P')?.isInterrupted() === false, 5000, 'P aborted')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(aborts).toEqual(['P'])
    expect(peek.mock.calls.filter(([id]) => id === 'C')).toEqual([])
    expect(open.mock.calls.filter(([id]) => id === 'C')).toEqual([])
    expect(host.get('C')).toBeUndefined()
    expect(settingsOf('C').runState).toBe('busy')
    expect(noticesIn(await transcriptOf('P'))).toEqual([])
    // 打开来看：C 那一轮原样被中断着，只有一条输入
    expect(userTexts(await transcriptOf('C'))).toEqual(['pi.user:do it'])
    expect(host.get('C')!.isInterrupted()).toBe(true)
  }, 30000)

  it("P2-10-46 / BG-31 abort-then-send：chatGateway.prompt(P, 'new') 只中止 P 自己被中断的那一轮，'new' 照常跑；C 不被碰；之后用户继续 C → P 恰一条写入的通知（不叫醒）", async () => {
    const kit2 = await crashAfterReceipt()
    const host = getSessionHost()
    const open = vi.spyOn(host, 'open')
    const peek = vi.spyOn(host, 'peek')
    kit2.queue(answer('fresh'))
    expect(await withTimeout(chatGateway.prompt('P', 'new'), 15000, 'P new')).toEqual({})
    const p = await transcriptOf('P')
    expect(p.at(-2)).toBe('pi.user:new')
    expect(p.at(-1)).toBe('pi.assistant:fresh')
    expect(aborts).toEqual(['P'])
    expect(peek.mock.calls.filter(([id]) => id === 'C')).toEqual([])
    expect(open.mock.calls.filter(([id]) => id === 'C')).toEqual([])
    expect(host.get('C')).toBeUndefined()
    expect(noticesIn(p)).toEqual([])

    kit2.queue(answer('C-done'))
    const child = await sessionService.ensureAgentSession('C')
    expect(host.get('C')!.isInterrupted()).toBe(true)
    expect(await withTimeout(child!.continue(), 15000, 'C.continue')).toEqual({})
    await waitFor(async () => noticesIn(await transcriptOf('P')).length === 1, 10000, 'notice in P')
    expect(noticesIn(await transcriptOf('P'))[0]).toMatch(/^shuvix\.notice:<sub-session id="C"/)
    await waitFor(
      () => getSessionHost().get('C')?.drivenRun === undefined,
      5000,
      'C marker handled'
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    // P 的 fresh 与 C 的 C-done：P 没被叫醒
    expect(kit2.callCount).toBe(2)
  }, 30000)
})

// ─── S：新消息发进被中断的子会话 ────────────────────────────────────────────

describe('S fresh prompt into an interrupted child', () => {
  it('P2-10-49 用户的一轮卡住、崩溃 → 进程 2 的 prompt：回执 started；旧的那一轮 aborted（中止前 seam 恰一次），一次请求、最后一条用户消息是新的；跑完的完成通知是本进程记着的（叫醒）', async () => {
    insert('P')
    insert('C', { parentId: 'P' })
    const stall = stalled()
    kit.queue(stall.step)
    void chatGateway.prompt('C', 'old')
    await withTimeout(stall.reached, 10000, 'C request')
    await waitFor(() => settingsOf('C').runState === 'busy', 5000, 'C busy marker')

    const kit2 = await newProcess()
    const deliver = vi.spyOn(sessionService, 'deliverSubSessionNotice')
    kit2.queue(answer('fresh'))
    const outcome = await withTimeout(
      runner.prompt({
        parentId: 'P',
        childId: 'C',
        message: 'new task',
        requestId: 'subsession:P:3'
      }),
      15000,
      'prompt'
    )
    expect(outcome).toEqual({ kind: 'started', id: 'C' })
    await waitFor(() => settingsOf('C').runState === 'idle', 10000, 'C idle')
    await waitFor(() => deliver.mock.calls.length === 1, 5000, 'completion notice')
    expect(aborts.filter((id) => id === 'C')).toHaveLength(1)
    expect(kit2.requests).toHaveLength(1)
    const users = kit2.requests[0]!.messages.filter((m) => m.role === 'user')
    const last = users.at(-1)!
    expect(
      typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    ).toContain('new task')
    expect(userTexts(await transcriptOf('C'))).toEqual(['pi.user:old', 'pi.user:new task'])
    expect((await transcriptOf('C')).at(-1)).toBe('pi.assistant:fresh')
    // 进程 2 发起的驱动：落定时能叫醒父会话（P 在这里没有存储，送达落空 —— 只看决定）
    expect(deliver.mock.calls[0]![3]).toEqual({ wake: true })
    deliver.mockRestore()
  }, 30000)

  it('P2-10-50 PIN-19：P 自己驱动的那一轮被 P 的新消息顶掉 → 那次 aborted 不通知；标记换成新的那一轮；新的那一轮只回执，跑完恰一条完成通知（说的是它，不是「被用户停掉」）', async () => {
    autoResumeOff()
    insert('P')
    insert('C', { parentId: 'P' })
    kit.queue(answer('a0'))
    expect(await chatGateway.prompt('P', 'hi')).toEqual({})
    const stall = stalled()
    kit.queue(stall.step)
    await runner.prompt({
      parentId: 'P',
      childId: 'C',
      message: 'r1',
      requestId: 'subsession:P:1'
    })
    await withTimeout(stall.reached, 10000, 'C request')

    const kit2 = await newProcess()
    await sessionService.ensureAgentSession('P')
    kit2.queue(held2(kit2))
    const outcome = await withTimeout(
      runner.prompt({
        parentId: 'P',
        childId: 'C',
        message: 'r2',
        requestId: 'subsession:P:2'
      }),
      15000,
      'prompt r2'
    )
    expect(outcome).toEqual({ kind: 'started', id: 'C' })
    await waitFor(
      async () => (await transcriptOf('C')).at(-1) === 'pi.assistant:r2 answer',
      10000,
      'r2 answered'
    )
    expect(markerSeen).toBe('subsession:P:2')
    await waitFor(
      () => getSessionHost().get('C')?.drivenRun === undefined,
      5000,
      'C marker handled'
    )
    await waitFor(async () => noticesIn(await transcriptOf('P')).length === 1, 10000, 'notice in P')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const notices = noticesIn(await transcriptOf('P'))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('has finished')
    expect(notices[0]).not.toContain('stopped by the user')
  }, 30000)

  it('P2-10-50 PIN-19：用户自己在 C 里发消息顶掉 P 驱动的那一轮 → P 恰一条通知（说明是被用户停的）', async () => {
    autoResumeOff()
    insert('P')
    insert('C', { parentId: 'P' })
    kit.queue(answer('a0'))
    expect(await chatGateway.prompt('P', 'hi')).toEqual({})
    const stall = stalled()
    kit.queue(stall.step)
    await runner.prompt({
      parentId: 'P',
      childId: 'C',
      message: 'r1',
      requestId: 'subsession:P:1'
    })
    await withTimeout(stall.reached, 10000, 'C request')

    const kit2 = await newProcess()
    kit2.queue(answer('user answer'))
    expect(await withTimeout(chatGateway.prompt('C', 'my own'), 15000, 'user prompt')).toEqual({})
    await waitFor(async () => noticesIn(await transcriptOf('P')).length === 1, 10000, 'notice in P')
    expect(noticesIn(await transcriptOf('P'))[0]).toContain('stopped by the user')
  }, 30000)
})

/** P2-10-50 用：C 的应答步骤里记下那一刻的 driven 标记（证明标记已经换成了 R(2)） */
let markerSeen: string | undefined
function held2(kit2: FauxKit): Parameters<FauxKit['queue']>[0] {
  void kit2
  markerSeen = undefined
  return async () => {
    markerSeen = getSessionHost().get('C')?.drivenRun?.requestId
    return answer('r2 answer')
  }
}

// ─── SW：完成通知能不能叫醒父会话（option A） ──────────────────────────────────

describe('SW sub-session completion wakes the parent only for drives this process tracks', () => {
  /** P 在本进程里锁着、空闲；C 的后台驱动扣在 held 上，交回放行函数 */
  async function lockedParentWithHeldChild(): Promise<{ release: () => void }> {
    insert('P')
    insert('C', { parentId: 'P' })
    kit.queue(answer('a0'))
    expect(await chatGateway.prompt('P', 'hi')).toEqual({})
    expect(getSessionHost().get('P')!.lock).toBeDefined()
    const child = held(answer('child done'))
    kit.queue(child.step)
    expect(
      await runner.prompt({
        parentId: 'P',
        childId: 'C',
        message: 'bg',
        requestId: 'subsession:P:5'
      })
    ).toEqual({ kind: 'started', id: 'C' })
    await withTimeout(child.reached, 10000, 'C request')
    return { release: child.release }
  }

  it('SW-01 the runner no longer knows the drive (its in-memory tables emptied, as after a restart): the idle locked parent gets a written notice — no input submitted, no turn — that its next turn sees', async () => {
    const { release } = await lockedParentWithHeldChild()
    runner.resetForTests()
    const deliver = vi.spyOn(sessionService, 'deliverSubSessionNotice')
    const submit = vi.spyOn(getSessionHost().get('P')!, 'submitUser')
    release()
    await waitFor(async () => noticesIn(await transcriptOf('P')).length === 1, 10000, 'notice in P')
    await new Promise((resolve) => setTimeout(resolve, 700))

    expect(deliver.mock.calls[0]![3]).toEqual({ wake: false })
    expect(submit).not.toHaveBeenCalled()
    const parent = getSessionHost().get('P')!
    expect(parent.lock).toBeDefined()
    expect(parent.runState).toBe('idle')
    const p = await transcriptOf('P')
    expect(p.slice(0, 2)).toEqual(['pi.user:hi', 'pi.assistant:a0'])
    expect(p.slice(2)).toEqual([expect.stringMatching(/^shuvix\.notice:<sub-session id="C"/)])
    // P 一次都没被叫醒：只有 P 的 hi 与 C 的那一轮请求过模型
    expect(kit.callCount).toBe(2)

    // 父会话的下一轮看得见它
    kit.queue(answer('seen'))
    expect(await chatGateway.prompt('P', 'next')).toEqual({})
    const lastRequest = JSON.stringify(kit.requests.at(-1)!.messages)
    expect(lastRequest).toContain('sub-session id=\\"C\\"')
    deliver.mockRestore()
    submit.mockRestore()
  }, 30000)

  it('SW-02 an in-process background drive still wakes the idle locked parent: the notice starts one auto-resumed turn, as before', async () => {
    const { release } = await lockedParentWithHeldChild()
    const deliver = vi.spyOn(sessionService, 'deliverSubSessionNotice')
    kit.queue(answer('ack'))
    release()
    await waitFor(
      async () => (await transcriptOf('P')).at(-1) === 'pi.assistant:ack',
      10000,
      'P auto-resumed'
    )
    expect(deliver.mock.calls[0]![3]).toEqual({ wake: true })
    const notices = noticesIn(await transcriptOf('P'))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/^pi\.user:<sub-session id="C"/)
    expect(kit.callCount).toBe(3)
    deliver.mockRestore()
  }, 30000)

  it('SW-03 a drive whose turn may already finish inside the 50ms confirm window is still one this process tracks: the receipt says started, and its completion wakes the parent (§20; the old foreground-timeout drive is gone)', async () => {
    insert('P')
    insert('C', { parentId: 'P' })
    kit.queue(answer('a0'))
    expect(await chatGateway.prompt('P', 'hi')).toEqual({})
    const deliver = vi.spyOn(sessionService, 'deliverSubSessionNotice')
    // C answers at once (no hold), then P's auto-resumed turn
    kit.queue(answer('child done'), answer('ack'))
    expect(
      await withTimeout(
        runner.prompt({
          parentId: 'P',
          childId: 'C',
          message: 'fast',
          requestId: 'subsession:P:6'
        }),
        10000,
        'prompt'
      )
    ).toEqual({ kind: 'started', id: 'C' })
    await waitFor(
      async () => (await transcriptOf('P')).at(-1) === 'pi.assistant:ack',
      10000,
      'P auto-resumed'
    )
    expect(deliver.mock.calls.map((call) => call[3])).toEqual([{ wake: true }])
    expect(noticesIn(await transcriptOf('P'))).toEqual([
      expect.stringMatching(/^pi\.user:<sub-session id="C"/)
    ])
    deliver.mockRestore()
  }, 30000)
})

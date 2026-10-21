/**
 * P2-10 子会话接 durable 的单元面：真 sessionService / AgentSession 门面 / 网关 / 子会话运行器 / session 工具 /
 * taskRegistry + 真 sessions 表（node:sqlite 内存库），会话运行时是假宿主（support/fakeSessionHost）。
 * 「重跑」= 同一个 taskId、同一张 memo 表（`sharedMemo`）再调一次工具；「换进程」= `newProcess()`
 * （清掉枢纽与 runner 的进程内记账，换一个假宿主）。
 *
 *   A  P2-10-02..05  幂等键的贯通（选项、用户路径不带、call_0 不再撞、create 的 id）
 *      PIN-10(P2-12) 派生 agent 的 session 调用：子会话挂在根会话下，幂等键按根会话
 *   B  P2-10-07..21  session 工具每个动作的幂等（create / prompt / wait / stop / set-title / read / list）
 *   D  P2-10-24 / 27 进程重启之后的重跑（单元面）
 *   E  P2-10-30 / 31 答复（没有答复 / 被中断 / PIN-02 矩阵）
 *   F  P2-10-33      wait 与被中断的子会话
 *   G  P2-10-35..44  完成通知：送达、抑制、不重复（BG-24 的矩阵：§20 派活一律后台之后谁通知、谁不通知）
 *   H  P2-10-45      中止语义：父会话被停不级联（§20；中断父会话的级联 PIN-08 / P2-10-47 已删）
 *   I  P2-10-48      新消息发进被中断的子会话
 *   J  WP3-99..103   §19 父会话介入自己发起的那一轮：代答 / 插话 / 询问通知经真门面落到哪里
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from '@earendil-works/chord'
import type { DrivenSettledEvent } from '@shuvix/agent-runtime'
import { invokeTool } from '@shuvix/agent-runtime/tools/testing/invokeTool'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  toolResults: '',
  notifier: undefined as undefined | ((sessionId: string, text: string) => void)
}))

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  listChanged: vi.fn(),
  fire: vi.fn(),
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
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../sessionDayPromptService', () => ({
  recordUserEntry: vi.fn(),
  recordSessionCreated: vi.fn()
}))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: (tools: string[]) => tools }))
vi.mock('../mcpService', () => ({
  mcpService: { closeSession: async () => {}, getAllToolInfos: () => [] }
}))
vi.mock('../agentService', () => ({
  agentService: { getProfile: mocks.getProfile, isSessionProfile: () => true }
}))
vi.mock('../bgTaskService', () => ({
  killBySession: vi.fn(),
  setBgTaskNotifier: (fn: (sessionId: string, text: string) => void) => {
    holder.notifier = fn
  }
}))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: () => null }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: mocks.listChanged,
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: mocks.broadcast }
}))
vi.mock('../artifacts/store', () => ({ deleteSessionArtifacts: vi.fn() }))
// 会话权限表（services/acl）的派生行要「会话自己的目录」：这里一个都不派生（表是空的，不在这组用例里）
vi.mock('../sandbox', () => ({
  cleanupSession: vi.fn(),
  sessionOwnDirsView: () => null,
  settingDirForAcl: () => null
}))
vi.mock('../hookService', () => ({
  hookTriggers: { fire: mocks.fire },
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
import type { Session, SessionCreateParams } from '../../types'
import type { ToolContext } from '../toolContext'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { sessionRecords } from '../sessionRecords'
import { clearMemoryStoragesForTests } from '../sessionStorage'
import { setTaskNotifier, taskRegistry } from '../taskRegistry'
import {
  FakeDurableSession,
  fakeHost,
  gate,
  lockRecord,
  resetFakeHost
} from './support/fakeSessionHost'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let sessionService: (typeof import('../sessionService'))['sessionService']
let chatGateway: (typeof import('../../frontend/core/DefaultChatGateway'))['chatGateway']
let runner: (typeof import('../subSessionRunner'))['subSessionRunner']
let SessionTool: (typeof import('../../tools/session'))['SessionTool']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  ;({ chatGateway } = await import('../../frontend/core/DefaultChatGateway'))
  ;({ subSessionRunner: runner } = await import('../subSessionRunner'))
  // eslint-disable-next-line boundaries/dependencies -- 用例有意让真的 session 工具驱动真的运行器（产品里是工具引用服务，这里只是从服务的用例里把它构造出来）
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

function insert(id: string, patch: Partial<Session> = {}): string {
  sessionRecords.insert({
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
  })
  return id
}

/** 父会话 P（开着、锁着 —— 完成通知走门面的 notify）与它的几条子会话（没开着） */
function family(...children: string[]): FakeDurableSession {
  insert('P')
  for (const id of children) insert(id, { parentId: 'P' })
  return fakeHost.put('P', { lock: lockRecord() })
}

const R = (taskId: number | string, parentId = 'P'): string => `subsession:${parentId}:${taskId}`

/** 一张跨调用共享的 memo 表（同 durable：先到的候选值胜出）—— 重跑就是同一个 taskId 带着它再调一次 */
function sharedMemo(): {
  store: Map<string, JsonValue>
  log: string[]
  memo: (name: string, ...rest: unknown[]) => Promise<JsonValue | undefined>
} {
  const store = new Map<string, JsonValue>()
  const log: string[] = []
  return {
    store,
    log,
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length < 2) {
        log.push(`read:${name}`)
        return store.get(name)
      }
      log.push(`write:${name}`)
      if (!store.has(name)) store.set(name, structuredClone(rest[0]) as JsonValue)
      return store.get(name)
    }
  }
}

interface CallOptions {
  taskId?: number
  memo?: ReturnType<typeof sharedMemo>
  conversationId?: number
  signal?: AbortSignal
  sessionId?: string
}

/** 经 BaseTool 模板调一次 session 工具，交回文字与是否失败 */
async function call(
  args: Record<string, unknown>,
  options: CallOptions = {}
): Promise<{ text: string; isError: boolean; details: unknown }> {
  const tool = new SessionTool({ sessionId: options.sessionId ?? 'P' } as ToolContext)
  const memo = options.memo ?? sharedMemo()
  const { result } = await invokeTool(tool, args as never, {
    callId: 'call_0',
    taskId: options.taskId ?? 1,
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    api: { memo: memo.memo as never }
  })
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
  return { text, isError: result.isError === true, details: result.details }
}

/** 运行时报来的一次 driven 落定 */
function settledEvent(
  over: Partial<{
    childId: string
    requestId: string
    background: boolean
    reason: string
    result: DrivenSettledEvent['result']
  }> = {}
): DrivenSettledEvent {
  const childId = over.childId ?? 'c1'
  return {
    sessionId: childId,
    parentId: 'P',
    requestId: over.requestId ?? R(5),
    background: over.background ?? true,
    conversationId: 1 as DrivenSettledEvent['conversationId'],
    submissionId: 42 as DrivenSettledEvent['submissionId'],
    noticeRequestId: `subsession-done:${childId}:42`,
    result: over.result ?? {},
    record:
      over.reason === undefined ? { status: 'done' } : { status: 'unanswered', reason: over.reason }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 换一个「进程」：枢纽与 runner 的进程内记账清空，换一个新的假宿主 */
function newProcess(): void {
  taskRegistry.killAll()
  runner.resetForTests()
  resetFakeHost()
}

const submitsOf = (session: FakeDurableSession): Array<Record<string, unknown>> =>
  session.callsOf('submitUser').map((c) => c[2] as Record<string, unknown>)

const noticesTo = (session: FakeDurableSession): unknown[][] => [
  ...session.callsOf('notify'),
  ...session.callsOf('writeNotice')
]

/**
 * 本进程发起的驱动（option A：只有它们落定时能叫醒父会话）：子会话的发送扣在闸门上，`prompt` 交回
 * 启动回执、记着这次发送。交回子会话（用完放闸门）。
 */
async function startBackground(childId: string, taskId: number): Promise<FakeDurableSession> {
  const child = fakeHost.put(childId, { submitGate: gate() })
  const started = await runner.prompt({
    parentId: 'P',
    childId,
    message: 'go',
    requestId: R(taskId)
  })
  expect(started).toMatchObject({ kind: 'started' })
  return child
}

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-subsession-unit-'))
  holder.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-subsession-unit-tr-'))
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
  for (const m of Object.values(mocks)) m.mockClear()
  mocks.getProfile.mockImplementation((name) => profile(name))
  newProcess()
})

afterEach(() => {
  rmSync(holder.sessionsDir, { recursive: true, force: true })
  rmSync(holder.toolResults, { recursive: true, force: true })
})

// ─── A. 幂等键的贯通 ───────────────────────────────────────────────────────

describe('A. requestId plumbing', () => {
  it('P2-10-02 / BG-07 选项一路到底：枢纽任务 id = 幂等键；子会话收到 requestId + driven（恒为后台）+ onAdmitted；跑着时 driven', async () => {
    family('c1')
    const c1 = fakeHost.put('c1', { submitGate: gate() })
    const pending = runner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'go',
      requestId: R(5)
    })
    expect(await pending).toEqual({ kind: 'started', id: 'c1' })
    expect(taskRegistry.get(R(5))).toMatchObject({ kind: 'sub-session', sessionId: 'P' })
    const [options] = submitsOf(c1)
    expect(options!.requestId).toBe(R(5))
    expect(options!.driven).toEqual({ parentId: 'P', background: true })
    expect(typeof options!.onAdmitted).toBe('function')
    const listed = runner.list('P')
    if ('error' in listed) throw new Error(listed.error)
    expect(listed.subSessions.find((s) => s.id === 'c1')!.driven).toBe(true)

    c1.submitGate!.release()
    await vi.waitFor(() => {
      const after = runner.list('P')
      if ('error' in after) throw new Error(after.error)
      expect(after.subSessions.find((s) => s.id === 'c1')!.driven).toBe(false)
    })

    // §20：没有前台形态了 —— 第二次发送同样是后台标记、同样只回执
    const c1b = fakeHost.get('c1')!
    c1b.submitGate = undefined
    expect(
      await runner.prompt({ parentId: 'P', childId: 'c1', message: 'again', requestId: R(6) })
    ).toEqual({ kind: 'started', id: 'c1' })
    expect(submitsOf(c1b).at(-1)!.driven).toEqual({ parentId: 'P', background: true })
  })

  it('P2-10-03 用户自己的发送（IPC agent:prompt）不带 requestId，也不带 driven', async () => {
    insert('c1')
    await chatGateway.prompt('c1', 'hi')
    const [options] = submitsOf(fakeHost.get('c1')!)
    expect(options).not.toHaveProperty('requestId')
    expect(options).not.toHaveProperty('driven')
  })

  it('P2-10-04 provider 的 call_0 重复不再撞：两次发送各自一个键、各自一条任务，第二次走正常路径', async () => {
    family('c1')
    const c1 = fakeHost.put('c1')
    expect(
      (await call({ action: 'prompt-session', session_id: 'c1', message: 'a' }, { taskId: 7 }))
        .isError
    ).toBe(false)
    expect(
      (await call({ action: 'prompt-session', session_id: 'c1', message: 'b' }, { taskId: 8 }))
        .isError
    ).toBe(false)
    expect(submitsOf(c1).map((o) => o.requestId)).toEqual([R(7), R(8)])
    expect(taskRegistry.get(R(7))).toBeDefined()
    expect(taskRegistry.get(R(8))).toBeDefined()
    expect(c1.callsOf('requestState')).toContainEqual(['requestState', R(8)])
    // 正常路径 = 受理（受理回调触发了 prompt-accepted 埋点）
    expect(
      mocks.fire.mock.calls.filter(([name]) => name === 'session.prompt-accepted')
    ).toHaveLength(2)

    // 两个父会话、同一个 taskId、并发 → 两个不同的键，两条都跑
    insert('P1')
    insert('P2')
    insert('d1', { parentId: 'P1' })
    insert('d2', { parentId: 'P2' })
    const d1 = fakeHost.put('d1', { submitGate: gate() })
    const d2 = fakeHost.put('d2', { submitGate: gate() })
    const a = call(
      { action: 'prompt-session', session_id: 'd1', message: 'x' },
      { taskId: 5, sessionId: 'P1' }
    )
    const b = call(
      { action: 'prompt-session', session_id: 'd2', message: 'y' },
      { taskId: 5, sessionId: 'P2' }
    )
    await vi.waitFor(() => {
      expect(submitsOf(d1).map((o) => o.requestId)).toEqual([R(5, 'P1')])
      expect(submitsOf(d2).map((o) => o.requestId)).toEqual([R(5, 'P2')])
    })
    d1.submitGate!.release()
    d2.submitGate!.release()
    expect((await a).isError).toBe(false)
    expect((await b).isError).toBe(false)
  })

  it('P2-10-05 sessionService.create(params, {id})：幂等（同一行、广播一次、勾选只抄一次）；落在别处 → 抛错；IPC 参数没有 id', () => {
    insert('P', { settings: { enabledTools: ['skill:a'] } })
    const insertSpy = vi.spyOn(sessionRecords, 'insert')
    const first = sessionService.create({ parentId: 'P' }, { id: 'X' })
    const second = sessionService.create({ parentId: 'P' }, { id: 'X' })
    expect(first.id).toBe('X')
    expect(second.id).toBe('X')
    expect(sessionRecords.findChildren('P').map((s) => s.id)).toEqual(['X'])
    expect(mocks.listChanged).toHaveBeenCalledTimes(1)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(sessionRecords.findById('X')!.settings.enabledTools).toEqual(['skill:a'])
    insertSpy.mockRestore()

    insert('Q')
    expect(() => sessionService.create({ parentId: 'Q' }, { id: 'X' })).toThrow(/different parent/)
    expect(() => sessionService.create(undefined, { id: 'X' })).toThrow(/different parent/)
    // @ts-expect-error —— 由调用方定 id 只是主进程的选项，IPC 的建会话参数里没有它
    const ipc: SessionCreateParams = { id: 'Y' }
    void ipc
  })

  it('PIN-10(P2-12) 派生 agent（对话 ≠ 1）调 session 工具：子会话挂在根会话下，幂等键按根会话与这次调用的 taskId', async () => {
    insert('P')
    const memo = sharedMemo()
    const created = await call(
      { action: 'create-sub-session', title: 'From spawned' },
      { taskId: 11, conversationId: 3, memo }
    )
    expect(created.isError).toBe(false)
    const [child] = sessionRecords.findChildren('P')
    expect(child).toBeDefined()
    expect(child!.parentId).toBe('P')
    const c = fakeHost.put(child!.id)
    await call(
      { action: 'prompt-session', session_id: child!.id, message: 'go' },
      { taskId: 12, conversationId: 3 }
    )
    expect(submitsOf(c)[0]!.requestId).toBe(R(12))
  })
})

// ─── B. session 工具每个动作的幂等 ─────────────────────────────────────────

describe('B. session tool idempotency', () => {
  it('P2-10-07 create 第一次：先写 memo 再建会话，create 拿到 memo 里的 id，回执是那个 id', async () => {
    insert('P')
    const memo = sharedMemo()
    const order: string[] = []
    const realMemo = memo.memo
    memo.memo = async (name, ...rest) => {
      if (rest.length >= 2) order.push('memo')
      return realMemo(name, ...rest)
    }
    const createSpy = vi.spyOn(sessionService, 'create').mockImplementation(function (
      this: unknown,
      ...args
    ) {
      order.push('create')
      createSpy.mockRestore()
      return sessionService.create(...args)
    })
    const res = await call({ action: 'create-sub-session' }, { memo })
    const id = memo.store.get('session.create-sub-session.id') as string
    expect(typeof id).toBe('string')
    expect(order).toEqual(['memo', 'create'])
    expect(sessionRecords.findChildren('P').map((s) => s.id)).toEqual([id])
    expect(res.text).toContain(`<session id="${id}"`)
    expect(res.text).toContain('status="created"/>')
  })

  it('P2-10-08 create 重跑（行已经在、父会话已有 20 条）：同一个 id、仍是一行、没有上限错误、标题记 user、回执相同', async () => {
    insert('P')
    for (let i = 0; i < 19; i++) insert(`old${i}`, { parentId: 'P' })
    const memo = sharedMemo()
    const first = await call({ action: 'create-sub-session', title: 'Named' }, { memo, taskId: 3 })
    expect(first.isError).toBe(false)
    expect(sessionRecords.findChildren('P')).toHaveLength(20)
    const id = memo.store.get('session.create-sub-session.id') as string
    const settingsBefore = sessionRecords.findById(id)!.settings

    const again = await call({ action: 'create-sub-session', title: 'Named' }, { memo, taskId: 3 })
    expect(again.isError).toBe(false)
    expect(again.text).toBe(first.text)
    expect(sessionRecords.findChildren('P')).toHaveLength(20)
    expect(sessionRecords.findChildren('P').filter((s) => s.id === id)).toHaveLength(1)
    const row = sessionRecords.findById(id)!
    expect(row.title).toBe('Named')
    expect(row.settings.titleOrigin).toBe('user')
    expect(row.settings).toEqual(settingsBefore)
  })

  it('P2-10-09 / P2-10-27 create 重跑（memo 写了、行还没插）：用 memo 里的 id 建行，只有这一行', async () => {
    insert('P')
    const memo = sharedMemo()
    memo.store.set('session.create-sub-session.id', 'X-memo')
    const createSpy = vi.spyOn(sessionService, 'create')
    const res = await call({ action: 'create-sub-session' }, { memo })
    expect(res.isError).toBe(false)
    expect(createSpy).toHaveBeenCalledWith({ parentId: 'P' }, { id: 'X-memo' })
    expect(sessionRecords.findChildren('P').map((s) => s.id)).toEqual(['X-memo'])
    createSpy.mockRestore()
  })

  it('P2-10-10 / BG-33 prompt 重跑（被中断、键 pending）：跳过忙 / 等批准 / 上限，重新挂上一次（driven 恒为后台），不受理、不中止；回执 started、不带答复；落定时本进程记着 → 恰一次叫醒父会话', async () => {
    const parent = family('c1', 'b1', 'b2', 'b3', 'b4')
    // 本进程里已有 4 条在跑（并发上限顶满）—— 重新挂上不看它
    for (const id of ['b1', 'b2', 'b3', 'b4']) {
      fakeHost.put(id, { submitGate: gate() })
      await runner.prompt({ parentId: 'P', childId: id, message: 'x', requestId: R(`bg-${id}`) })
      fakeHost.get(id)!.busy = true
    }
    const c1 = fakeHost.put('c1', { interrupted: true, submitGate: gate(), answer: { text: 'A9' } })
    c1.requestStates.set(R(9), 'pending')
    mocks.fire.mockClear()
    const res = await call(
      { action: 'prompt-session', session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    expect(res.isError).toBe(false)
    expect(res.text).toContain('Started in the background')
    expect(res.details).toEqual({ type: 'session', background: true })
    expect(res.text).not.toContain('<reply>')
    expect(res.text).not.toContain('A9')
    expect(submitsOf(c1)).toHaveLength(1)
    const [options] = submitsOf(c1)
    expect(options!.requestId).toBe(R(9))
    expect(options!.driven).toEqual({ parentId: 'P', background: true })
    expect(mocks.fire.mock.calls.filter(([name]) => name === 'session.prompt-accepted')).toEqual([])
    expect(c1.callsOf('abort')).toEqual([])

    c1.submitGate!.release()
    await vi.waitFor(() => expect(taskRegistry.get(R(9))!.status).toBe('done'))
    await runner.onDrivenSettled(settledEvent({ requestId: R(9) }))
    expect(parent.callsOf('notify')).toHaveLength(1)
    expect(parent.callsOf('writeNotice')).toEqual([])
    for (const id of ['b1', 'b2', 'b3', 'b4']) fakeHost.get(id)!.submitGate!.release()
  })

  it('P2-10-11 / P2-10-14 / BG-34 prompt 重跑（在跑、键 pending）：不报「在跑」，不等闸门放开就回执 started；只挂上一次、没有第二条输入', async () => {
    family('c1')
    const c1 = fakeHost.put('c1', { busy: true, submitGate: gate(), answer: { text: 'later' } })
    c1.requestStates.set(R(9), 'pending')
    const res = await call(
      { action: 'prompt-session', session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    // 闸门还关着：回执不等这一轮
    expect(res.isError).toBe(false)
    expect(res.text).not.toMatch(/is running/)
    expect(res.text).toContain('Started in the background')
    expect(res.details).toEqual({ type: 'session', background: true })
    expect(res.text).not.toContain('later')
    expect(c1.callsOf('submitUser')).toHaveLength(1)
    c1.submitGate!.release()
  })

  it('P2-10-12 / BG-27 prompt 重跑（键 settled、子会话没开着）：不再发送、没有报错广播、没有埋点；回执说那一轮已经结束（status="idle"），不说在跑；打开时扫描报的那次落定被本进程接住 → 恰一次叫醒父会话', async () => {
    const parent = family('c1')
    fakeHost.storages.add('c1')
    fakeHost.configure = (session) => {
      if (session.sessionId !== 'c1') return
      session.answer = { text: 'A' }
      session.requestStates.set(R(9), 'settled')
      // 打开时的扫描：运行时在 peek 交回之前报出这次落定（runner 先记下发送、再问幂等键，正为接住它）
      void runner.onDrivenSettled(settledEvent({ requestId: R(9) }))
    }
    const res = await call(
      { action: 'prompt-session', session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    expect(res.isError).toBe(false)
    expect(res.text).toBe(
      '<session id="c1" status="idle"/>\n\nThat turn already finished before the app restarted — nothing was sent again. Read its answer with "read-session".'
    )
    expect(res.details).toBeUndefined()
    const c1 = fakeHost.get('c1')!
    expect(c1.callsOf('submitUser')).toEqual([])
    expect(mocks.broadcast.mock.calls.filter(([e]) => e.sessionId === 'c1')).toEqual([])
    expect(mocks.fire).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(parent.callsOf('notify')).toHaveLength(1))
    expect(parent.callsOf('writeNotice')).toEqual([])
    // 答复就在子会话里：read 收得到
    expect((await call({ action: 'read-session', session_id: 'c1' })).text).toContain(
      '<reply>\nA\n</reply>'
    )
  })

  it("P2-10-13 键 'none'：正常路径 —— 在跑的子会话照旧被拒", async () => {
    family('c1')
    fakeHost.put('c1', { busy: true })
    const res = await call(
      { action: 'prompt-session', session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/is running/)
  })

  // 原 P2-10-14（后台 prompt 重跑、键 pending）并进上面的 P2-10-11 / BG-34：§20 起没有前台 / 后台之分

  it('P2-10-15 wait 第一次：挂住的时候 memo 里已是要等的那几条；从不 resumeInterrupted', async () => {
    family('c1', 'c2')
    const c1 = fakeHost.put('c1', { busy: true })
    const c2 = fakeHost.put('c2', { busy: true })
    const memo = sharedMemo()
    const pending = call({ action: 'wait-for-sessions' }, { memo })
    await vi.waitFor(() =>
      expect(memo.store.get('session.wait-for-sub-sessions.targets')).toEqual(['c1', 'c2'])
    )
    c1.busy = false
    c2.busy = false
    expect((await pending).text).toContain('<sessions status="settled">')
    expect(c1.callsOf('resumeInterrupted')).toEqual([])
    expect(c2.callsOf('resumeInterrupted')).toEqual([])
  })

  it('P2-10-16 wait 重跑（目标开着）：被中断的续上一次、空闲的不碰；等到它不在跑；结果带各自的 lastAnswer；后来才跑的不加进来', async () => {
    family('c1', 'c2', 'c3')
    const c1 = fakeHost.put('c1', { interrupted: true, answer: { text: 'one' } })
    const c2 = fakeHost.put('c2', { answer: { text: 'two' } })
    fakeHost.put('c3', { busy: true })
    const memo = sharedMemo()
    memo.store.set('session.wait-for-sub-sessions.targets', ['c1', 'c2'])
    let resolved = false
    const pending = call({ action: 'wait-for-sessions' }, { memo }).then((r) => {
      resolved = true
      return r
    })
    await vi.waitFor(() => expect(c1.callsOf('resumeInterrupted')).toHaveLength(1))
    await sleep(300)
    expect(resolved).toBe(false)
    c1.busy = false
    const res = await pending
    expect(c2.callsOf('resumeInterrupted')).toEqual([])
    expect(res.text).toContain('<reply>\none\n</reply>')
    expect(res.text).toContain('<reply>\ntwo\n</reply>')
    expect(res.text).not.toContain('id="c3"')
  })

  it('P2-10-17 wait 重跑（目标没开着、镜像说被中断）：open 一次 → resumeInterrupted → 再等', async () => {
    family('c1')
    sessionRecords.updateSettings('c1', { runState: 'interrupted' })
    fakeHost.storages.add('c1')
    fakeHost.configure = (session) => {
      if (session.sessionId === 'c1') session.interrupted = true
    }
    const memo = sharedMemo()
    memo.store.set('session.wait-for-sub-sessions.targets', ['c1'])
    const pending = call({ action: 'wait-for-sessions' }, { memo })
    await vi.waitFor(() => expect(fakeHost.get('c1')?.callsOf('resumeInterrupted')).toHaveLength(1))
    expect(fakeHost.callsOf('open')).toEqual(['c1'])
    fakeHost.get('c1')!.busy = false
    expect((await pending).isError).toBe(false)
  })

  it('P2-10-18 wait 第一次、点名一条被中断的：立刻返回，不续上，状态 interrupted，外层 settled；重跑（memo []）结果相同', async () => {
    family('c1')
    const c1 = fakeHost.put('c1', { interrupted: true })
    const memo = sharedMemo()
    const first = await call({ action: 'wait-for-sessions', session_id: 'c1' }, { memo })
    expect(first.text).toContain('<sessions status="settled">')
    expect(first.text).toContain('status="interrupted"')
    expect(c1.callsOf('resumeInterrupted')).toEqual([])
    expect(memo.store.get('session.wait-for-sub-sessions.targets')).toEqual([])
    const again = await call({ action: 'wait-for-sessions', session_id: 'c1' }, { memo })
    expect(again.text).toBe(first.text)
    expect(c1.callsOf('resumeInterrupted')).toEqual([])
  })

  it('P2-10-19 stop 重跑：(a) 空闲且没开着 → {stopped:false}，不 open / peek；(b) 被中断（开着 → abort；没开着 → peek 再 abort）→ stopped，之后没有通知', async () => {
    const parent = family('c1', 'c2', 'c3')
    const a = await call({ action: 'stop-session', session_id: 'c1' })
    expect(a.text).toContain('was not running')
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.callsOf('peek')).toEqual([])

    const c2 = fakeHost.put('c2', {
      interrupted: true,
      drivenRun: { requestId: R(21), parentId: 'P', background: true, conversationId: 1 as never }
    })
    expect((await call({ action: 'stop-session', session_id: 'c2' })).text).toContain('Stopped')
    expect(c2.callsOf('abort')).toHaveLength(1)

    sessionRecords.updateSettings('c3', { runState: 'interrupted' })
    fakeHost.storages.add('c3')
    fakeHost.configure = (session) => {
      if (session.sessionId !== 'c3') return
      session.interrupted = true
      session.drivenRun = {
        requestId: R(22),
        parentId: 'P',
        background: true,
        conversationId: 1 as never
      }
    }
    expect((await call({ action: 'stop-session', session_id: 'c3' })).text).toContain('Stopped')
    expect(fakeHost.callsOf('peek')).toEqual(['c3'])
    expect(fakeHost.get('c3')!.callsOf('abort')).toHaveLength(1)

    await runner.onDrivenSettled(
      settledEvent({ childId: 'c2', requestId: R(21), reason: 'aborted' })
    )
    await runner.onDrivenSettled(
      settledEvent({ childId: 'c3', requestId: R(22), reason: 'aborted' })
    )
    expect(noticesTo(parent)).toEqual([])
  })

  it('P2-10-20 set-title 重跑：两次一样，不抛，origin auto，回执相同', async () => {
    insert('P')
    const updateSpy = vi.spyOn(sessionService, 'updateTitle')
    const first = await call({ action: 'set-title', title: 'Same' }, { taskId: 4 })
    const again = await call({ action: 'set-title', title: 'Same' }, { taskId: 4 })
    expect(first.isError).toBe(false)
    expect(again.text).toBe(first.text)
    expect(updateSpy).toHaveBeenCalledWith('P', 'Same', 'auto')
    expect(sessionRecords.findById('P')!.settings.titleOrigin).toBe('auto')
    updateSpy.mockRestore()
  })

  it('P2-10-21 read / list 是纯读：两次相同；read 没开着的 peek 不 open；没有存储的不建文件、No reply yet；list 不 open 也不 peek', async () => {
    family('c1', 'c2')
    fakeHost.storages.add('c1')
    fakeHost.configure = (session) => {
      if (session.sessionId === 'c1') session.answer = { text: 'R1' }
    }
    const first = await call({ action: 'read-session', session_id: 'c1' })
    const again = await call({ action: 'read-session', session_id: 'c1' })
    expect(again.text).toBe(first.text)
    expect(first.text).toContain('<reply>\nR1\n</reply>')
    expect(fakeHost.callsOf('peek')).toContain('c1')
    expect(fakeHost.callsOf('open')).toEqual([])

    const none = await call({ action: 'read-session', session_id: 'c2' })
    expect(none.text).toContain('<note>No reply yet.</note>')
    expect(readdirSync(holder.sessionsDir)).toEqual([])
    expect(fakeHost.callsOf('open')).toEqual([])

    const peeks = fakeHost.callsOf('peek').length
    await call({ action: 'list-sessions' })
    expect(fakeHost.callsOf('peek')).toHaveLength(peeks)
    expect(fakeHost.callsOf('open')).toEqual([])
  })
})

// ─── D. 重启之后的重跑 ──────────────────────────────────────────────────────

describe('D. continue cascade (unit)', () => {
  it('P2-10-24 / BG-33 模拟重启：进程 1 派活卡着；进程 2 里子会话被中断、键 pending → 同一 taskId 重跑重新挂上一次，回执 started（不带答复）、不受理；落定时进程 2 记着 → 恰一次叫醒父会话', async () => {
    family('c1')
    fakeHost.put('c1', { submitGate: gate() })
    const memo = sharedMemo()
    void call({ action: 'prompt-session', session_id: 'c1', message: 'task' }, { taskId: 9, memo })
    await vi.waitFor(() => expect(submitsOf(fakeHost.get('c1')!)).toHaveLength(1))

    newProcess()
    const parent = fakeHost.put('P', { lock: lockRecord() })
    const c1 = fakeHost.put('c1', { interrupted: true, answer: { text: 'C9' } })
    c1.requestStates.set(R(9), 'pending')
    mocks.fire.mockClear()
    const res = await call(
      { action: 'prompt-session', session_id: 'c1', message: 'task' },
      { taskId: 9, memo }
    )
    expect(res.isError).toBe(false)
    expect(res.text).toContain('Started in the background')
    expect(res.text).not.toContain('<reply>')
    expect(submitsOf(c1).map((o) => o.requestId)).toEqual([R(9)])
    expect(mocks.fire.mock.calls.filter(([name]) => name === 'session.prompt-accepted')).toEqual([])
    await runner.onDrivenSettled(settledEvent({ requestId: R(9) }))
    expect(parent.callsOf('notify')).toHaveLength(1)
  })

  it('P2-10-27 / BG-27 崩溃前子会话已经答完、父会话的工具还没收（子会话早已开着，扫描早报过）：重跑回执「已经结束」，子会话不再发请求；父会话只有早先写入的那一条通知', async () => {
    const parent = family('c1')
    const c1 = fakeHost.put('c1', { answer: { text: 'C-done' } })
    c1.requestStates.set(R(9), 'settled')
    // 子会话打开时扫描报过的那一次（本进程不认得的驱动：只写入）
    await runner.onDrivenSettled(settledEvent({ requestId: R(9) }))
    expect(parent.callsOf('writeNotice')).toHaveLength(1)
    const res = await call(
      { action: 'prompt-session', session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    expect(res.text).toContain('<session id="c1" status="idle"/>')
    expect(res.text).toContain('nothing was sent again')
    expect(res.text).not.toContain('Started in the background')
    expect(res.text).not.toContain('C-done')
    expect(c1.callsOf('submitUser')).toEqual([])
    expect(parent.callsOf('notify')).toEqual([])
    expect(parent.callsOf('writeNotice')).toHaveLength(1)
  })
})

// ─── E. 答复 ────────────────────────────────────────────────────────────────

describe('E. answers via lastAnswer', () => {
  it('P2-10-30 没有答复 → No reply yet；被中断在半路（上一轮答过 old）→ 不出现 old，围栏 interrupted；wait 的结果逐条取 lastAnswer', async () => {
    family('c1', 'c2', 'c3')
    fakeHost.put('c1')
    expect((await call({ action: 'read-session', session_id: 'c1' })).text).toContain(
      '<note>No reply yet.</note>'
    )
    // PIN-07：这一轮的提问之后没有回答 → lastAnswer 是 undefined，不是上一轮的 old
    fakeHost.put('c2', { interrupted: true, answer: undefined })
    const interrupted = await call({ action: 'read-session', session_id: 'c2' })
    expect(interrupted.text).toContain('status="interrupted"')
    expect(interrupted.text).not.toContain('old')
    expect(interrupted.text).not.toContain('<reply>')

    fakeHost.put('c3', { answer: { text: 'three' } })
    const waited = await call({ action: 'wait-for-sessions' })
    expect(waited.text).toContain('<reply>\nthree\n</reply>')
    expect(fakeHost.get('c3')!.callsOf('lastAnswer').length).toBeGreaterThan(0)
  })

  it.each([
    ['busy', false],
    ['no_model', false],
    ['closed', false],
    ['queued', false],
    ['model_error', true],
    ['faulted', true],
    ['orphaned', true]
  ] as const)(
    'P2-10-31 / BG-03 / BG-04 网关结果 %s → %s 时是发出去了（回执 started、那一轮以错误收场），否则 NOT delivered',
    async (code, delivered) => {
      const parent = family('c1')
      fakeHost.put('c1', { submitResults: [{ error: `${code} text`, code }] })
      const res = await runner.prompt({
        parentId: 'P',
        childId: 'c1',
        message: 'go',
        requestId: R(31)
      })
      expect(taskRegistry.get(R(31))!.status).toBe('error')
      expect(taskRegistry.runningCount('P')).toBe(0)
      const finished = settledEvent({ requestId: R(31), result: { error: `${code} text`, code } })
      if (delivered) {
        expect(res).toEqual({ kind: 'started', id: 'c1' })
        expect(res).not.toHaveProperty('error')
        // 那一轮没有留下助手条目：read 交回错误原文（§20 之前前台等待直接交回它）
        expect(await runner.read('P', 'c1')).toMatchObject({
          answer: `${code} text`,
          isError: true
        })
        // 记账在：完成通知照发一次、叫醒父会话，说清以错误收场
        await runner.onDrivenSettled(finished)
        expect(parent.callsOf('notify')).toHaveLength(1)
        expect(String(parent.callsOf('notify')[0]![1])).toContain(
          `The turn you started ended with an error: ${code} text`
        )
      } else {
        expect((res as { error: string }).error).toContain('NOT delivered')
        const listed = runner.list('P')
        if ('error' in listed) throw new Error(listed.error)
        expect(listed.subSessions.find((s) => s.id === 'c1')!.driven).toBe(false)
        // 记账已撤：之后同一键的落定报来也不叫醒（只写入）
        await runner.onDrivenSettled(finished)
        expect(parent.callsOf('notify')).toEqual([])
        expect(parent.callsOf('writeNotice')).toHaveLength(1)
      }
      // 原来这里还有「lastAnswer 读不到错误条目时退回结果原文」那半：§20 起 prompt 只回执，错误原文改由 read / wait 交回
    }
  )
})

// ─── F. wait 与被中断的子会话 ───────────────────────────────────────────────

describe('F. interrupted status in wait', () => {
  it('P2-10-33 省略 id 的 wait 不等被中断的；没有可等的时候结果里照样列出它们', async () => {
    family('c1', 'c2')
    fakeHost.put('c1', { interrupted: true })
    const c2 = fakeHost.put('c2', { busy: true })
    const memo = sharedMemo()
    const pending = call({ action: 'wait-for-sessions' }, { memo })
    await vi.waitFor(() =>
      expect(memo.store.get('session.wait-for-sub-sessions.targets')).toEqual(['c2'])
    )
    c2.busy = false
    const res = await pending
    expect(res.text).toContain('id="c2"')
    expect(res.text).not.toContain('id="c1"')

    const idle = await call({ action: 'wait-for-sessions' })
    expect(idle.text).toContain('id="c1"')
    expect(idle.text).toContain('status="interrupted"')
    expect(idle.text).toMatch(/<note>Interrupted when the app stopped/)
  })
})

// ─── G. 完成通知 ────────────────────────────────────────────────────────────

describe('G. completion notices', () => {
  it('P2-10-35 进程内后台跑完：父会话恰一次 notify(text, {kind, requestId})；文案点名、给收法、不带内容；没有不带 requestId 的通知', async () => {
    const parent = family('c1')
    fakeHost.put('c1', { answer: { text: 'SECRET ANSWER' } })
    await runner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'go',
      requestId: R(5)
    })
    await sleep(300)
    await runner.onDrivenSettled(settledEvent({ requestId: R(5) }))
    const notices = parent.callsOf('notify')
    expect(notices).toHaveLength(1)
    const [, text, options] = notices[0] as [string, string, unknown]
    expect(options).toEqual({ kind: 'sub-session', requestId: 'subsession-done:c1:42' })
    expect(text).toContain('id="c1"')
    expect(text).toContain('wait-for-sessions')
    expect(text).not.toContain('SECRET ANSWER')
    expect(parent.callsOf('writeNotice')).toEqual([])
  })

  // 原 P2-10-36（前台答完 → 不通知）、P2-10-37（前台超时降级 → 后来跑完一条通知）被 §20 取消：没有前台等待，
  // 由下面的 BG-24 矩阵替代（确认窗里就跑完、回执之后跑完都是恰一条）

  /** 等本进程这次驱动的任务落定（发送那一侧销账之后） */
  const settledTask = async (rid: string): Promise<void> => {
    await vi.waitFor(() => expect(taskRegistry.get(rid)?.endedAt).not.toBeNull())
  }

  /** 确认窗里等到任务建出来（微任务就够：假宿主的每一步都是立刻落定的 promise） */
  const untilTask = async (rid: string): Promise<void> => {
    for (let i = 0; i < 1000 && !taskRegistry.get(rid); i++) await Promise.resolve()
    expect(taskRegistry.get(rid)).toBeDefined()
  }

  /** c1 在这一轮里停下来问一道选择题（假宿主没有 index.ts 的接线，询问钩子由用例直接调） */
  const askOn = (c1: FakeDurableSession): void => {
    c1.busy = true
    c1.respondResult = true
    c1.pendingRequests.push({
      id: 'q1',
      kind: 'choice',
      toolName: 'ask',
      question: 'Keep?',
      options: [{ label: 'A', description: '' }],
      createdAt: 0
    })
    c1.onResponded = (requestId) => runner.onAskResolved('c1', requestId)
    runner.onAskRaised('c1', c1.pendingRequests[0]!)
  }

  /** 这一轮跑完：询问清空、不在跑、放闸门 */
  const finish = async (c1: FakeDurableSession, rid: string): Promise<void> => {
    c1.pendingRequests.length = 0
    c1.busy = false
    c1.submitGate?.release()
    await settledTask(rid)
  }

  type Scenario = (parent: FakeDurableSession) => Promise<void>
  const matrix: Array<[string, Scenario, number, string?]> = [
    [
      '回执之后没人管，跑完',
      async () => {
        const c1 = await startBackground('c1', 1)
        await finish(c1, R(1))
        await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
      },
      1
    ],
    [
      '确认窗里就跑完（BG-02）',
      async () => {
        fakeHost.put('c1')
        expect(
          await runner.prompt({ parentId: 'P', childId: 'c1', message: 'go', requestId: R(1) })
        ).toEqual({ kind: 'started', id: 'c1' })
        await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
      },
      1
    ],
    [
      'prompt 回 input 之后跑完',
      async () => {
        const c1 = fakeHost.put('c1', { submitGate: gate() })
        const pending = runner.prompt({
          parentId: 'P',
          childId: 'c1',
          message: 'go',
          requestId: R(1)
        })
        await untilTask(R(1))
        askOn(c1)
        expect(await pending).toMatchObject({ kind: 'input', id: 'c1' })
        await finish(c1, R(1))
        await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
      },
      1
    ],
    [
      'answer 回执之后跑完',
      async () => {
        const c1 = await startBackground('c1', 1)
        askOn(c1)
        expect(await runner.answer({ parentId: 'P', childId: 'c1', selections: ['A'] })).toEqual({
          kind: 'started',
          id: 'c1'
        })
        await finish(c1, R(1))
        await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
      },
      1
    ],
    [
      'wait 握着它时落定',
      async () => {
        const c1 = await startBackground('c1', 1)
        c1.busy = true
        const waiting = runner.wait({ parentId: 'P', childId: 'c1', timeoutSeconds: 5 })
        await sleep(20)
        await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
        await finish(c1, R(1))
        expect(await waiting).toMatchObject({ kind: 'settled' })
      },
      0
    ],
    [
      'wait 已经在同一轮里交回那次落定、事件后到（collectInBand）',
      async () => {
        const c1 = await startBackground('c1', 1)
        c1.busy = true
        const waiting = runner.wait({ parentId: 'P', childId: 'c1', timeoutSeconds: 5 })
        await sleep(20)
        c1.requestStates.set(R(1), 'settled')
        await finish(c1, R(1))
        expect(await waiting).toMatchObject({ kind: 'settled' })
        await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
      },
      0
    ],
    [
      'wait 超时放手之后才落定',
      async () => {
        const c1 = await startBackground('c1', 1)
        c1.busy = true
        expect(
          await runner.wait({ parentId: 'P', childId: 'c1', timeoutSeconds: 1 })
        ).toMatchObject({ kind: 'timeout' })
        await finish(c1, R(1))
        await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
      },
      1
    ],
    [
      'wait 被中止放手之后才落定',
      async () => {
        const c1 = await startBackground('c1', 1)
        c1.busy = true
        const ac = new AbortController()
        const waiting = runner.wait({
          parentId: 'P',
          childId: 'c1',
          timeoutSeconds: 5,
          signal: ac.signal
        })
        ac.abort()
        expect(await waiting).toMatchObject({ kind: 'aborted' })
        expect(c1.callsOf('abort')).toEqual([])
        await finish(c1, R(1))
        await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
      },
      1
    ],
    [
      'stop-sub-session 停的',
      async () => {
        const c1 = await startBackground('c1', 1)
        c1.busy = true
        await runner.stop('P', 'c1')
        await finish(c1, R(1))
        await runner.onDrivenSettled(settledEvent({ requestId: R(1), reason: 'aborted' }))
      },
      0
    ],
    [
      '同一父会话的新消息顶掉了它（PIN-19）',
      async () => {
        fakeHost.put('c1', {
          interrupted: true,
          drivenRun: {
            requestId: R(1),
            parentId: 'P',
            background: true,
            conversationId: 1 as never
          }
        })
        await call({ action: 'prompt-session', session_id: 'c1', message: 'new' }, { taskId: 2 })
        await runner.onDrivenSettled(settledEvent({ requestId: R(1), reason: 'aborted' }))
      },
      0
    ],
    [
      '用户从面板停',
      async () => {
        const c1 = await startBackground('c1', 1)
        expect(taskRegistry.stop(R(1), { by: 'user' })).toBe(true)
        await finish(c1, R(1))
        await runner.onDrivenSettled(settledEvent({ requestId: R(1), reason: 'aborted' }))
      },
      1,
      'stopped by the user'
    ],
    [
      '用户在子会话里自己停',
      async () => {
        const c1 = await startBackground('c1', 1)
        await finish(c1, R(1))
        await runner.onDrivenSettled(settledEvent({ requestId: R(1), reason: 'aborted' }))
      },
      1,
      'stopped by the user'
    ],
    [
      '父会话被中止（不级联，子会话自己跑完）',
      async () => {
        const c1 = fakeHost.put('c1', { submitGate: gate() })
        const ac = new AbortController()
        const receipt = call(
          { action: 'prompt-session', session_id: 'c1', message: 'go' },
          { taskId: 1, signal: ac.signal }
        )
        await vi.waitFor(() => expect(submitsOf(c1)).toHaveLength(1))
        ac.abort()
        expect((await receipt).text).toContain('Started in the background')
        expect(c1.callsOf('abort')).toEqual([])
        await finish(c1, R(1))
        await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
      },
      1
    ]
  ]

  it.each(matrix)(
    'BG-24 本进程发起、记着的驱动 —— %s：完成通知 %i 条（叫醒父会话，从不只写入）',
    async (_label, scenario, expected, wording) => {
      const parent = family('c1')
      await scenario(parent)
      const notices = parent.callsOf('notify')
      expect(notices).toHaveLength(expected)
      expect(parent.callsOf('writeNotice')).toEqual([])
      if (wording) expect(String(notices[0]![1])).toContain(wording)
    }
  )

  it('P2-10-38 wait 握着它 → 不通知；wait 已经交回那次落定之后才报来 → 同样不通知', async () => {
    const parent = family('c1', 'c2')
    // (a) 握着的时候报来
    const c1 = fakeHost.put('c1', { submitGate: gate() })
    await runner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'go',
      requestId: R(1)
    })
    c1.busy = true
    const waiting = runner.wait({ parentId: 'P', childId: 'c1', timeoutSeconds: 5 })
    await sleep(20)
    await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
    c1.busy = false
    c1.submitGate!.release()
    await waiting

    // (b) wait 先交回、报来在后（标记还在、那条已落定）
    const c2 = fakeHost.put('c2', { submitGate: gate() })
    await runner.prompt({
      parentId: 'P',
      childId: 'c2',
      message: 'go',
      requestId: R(2)
    })
    c2.busy = true
    const waiting2 = runner.wait({ parentId: 'P', childId: 'c2', timeoutSeconds: 5 })
    await sleep(20)
    c2.requestStates.set(R(2), 'settled')
    c2.busy = false
    c2.submitGate!.release()
    await waiting2
    await runner.onDrivenSettled(settledEvent({ childId: 'c2', requestId: R(2) }))
    expect(noticesTo(parent)).toEqual([])
  })

  it('P2-10-39 智能体自己停的 → 不通知（stop）；用户停的 → 恰一条（面板停止键、用户在子会话里自己停）', async () => {
    const parent = family('c1', 'c2', 'c3', 'c4')
    // stop-sub-session
    const c1 = fakeHost.put('c1', { submitGate: gate() })
    await runner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'go',
      requestId: R(1)
    })
    c1.busy = true
    await runner.stop('P', 'c1')
    c1.submitGate!.release()
    await runner.onDrivenSettled(settledEvent({ requestId: R(1), reason: 'aborted' }))
    // 原来这里还有「前台信号级联」一段（c2）：§20 起父会话被停不级联，那一段删了（反向见 BG-24 / BG-29）
    expect(noticesTo(parent)).toEqual([])

    // 用户从面板停
    const c3 = fakeHost.put('c3', { submitGate: gate() })
    await runner.prompt({
      parentId: 'P',
      childId: 'c3',
      message: 'go',
      requestId: R(3)
    })
    expect(taskRegistry.stop(R(3), { by: 'user' })).toBe(true)
    c3.submitGate!.release()
    await runner.onDrivenSettled(
      settledEvent({ childId: 'c3', requestId: R(3), reason: 'aborted' })
    )
    expect(parent.callsOf('notify')).toHaveLength(1)
    expect(String(parent.callsOf('notify')[0]![1])).toContain('stopped by the user')
    // 用户在子会话里自己停
    const c4 = fakeHost.put('c4', { submitGate: gate() })
    await runner.prompt({
      parentId: 'P',
      childId: 'c4',
      message: 'go',
      requestId: R(4)
    })
    c4.submitGate!.release()
    await runner.onDrivenSettled(
      settledEvent({ childId: 'c4', requestId: R(4), reason: 'aborted' })
    )
    expect(parent.callsOf('notify')).toHaveLength(2)
  })

  it('P2-10-40 送达父会话：本进程的驱动 + 开着锁着 → notify；本进程不认得的驱动 → 锁着也只 writeNotice（option A）；没开着 → peek（不 open），没锁 → writeNotice、不建 agent；行没了 → 什么都不调；peek / notify 抛 → 拒绝；被抑制 → 正常落定', async () => {
    const parent = family('c1', 'c3')
    const c1 = await startBackground('c1', 1)
    await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
    expect(parent.callsOf('notify')).toHaveLength(1)
    expect(parent.callsOf('writeNotice')).toEqual([])
    c1.submitGate!.release()

    // 本进程不认得的驱动（上个进程发起的）：父会话锁着也只写入
    await runner.onDrivenSettled(settledEvent({ requestId: R(7) }))
    expect(parent.callsOf('notify')).toHaveLength(1)
    expect(parent.callsOf('writeNotice')).toEqual([
      [
        'writeNotice',
        {
          text: expect.stringContaining('id="c1"'),
          kind: 'sub-session',
          requestId: 'subsession-done:c1:42'
        }
      ]
    ])

    // 没开着、存储在、没锁
    await fakeHost.close('P')
    fakeHost.calls.length = 0
    await runner.onDrivenSettled(settledEvent({ requestId: R(2) }))
    expect(fakeHost.callsOf('peek')).toEqual(['P'])
    expect(fakeHost.callsOf('open')).toEqual([])
    const reopened = fakeHost.get('P')!
    expect(reopened.callsOf('writeNotice')).toEqual([
      [
        'writeNotice',
        {
          text: expect.stringContaining('id="c1"'),
          kind: 'sub-session',
          requestId: 'subsession-done:c1:42'
        }
      ]
    ])
    expect(reopened.callsOf('createAgent')).toEqual([])

    // notify 抛 → 拒绝（运行时留着标记）
    reopened.lock = lockRecord()
    reopened.notify = async () => {
      throw new Error('parent write failed')
    }
    const c3 = await startBackground('c3', 3)
    await expect(
      runner.onDrivenSettled(settledEvent({ childId: 'c3', requestId: R(3) }))
    ).rejects.toThrow('parent write failed')
    c3.submitGate!.release()

    // peek 抛 → 拒绝
    await fakeHost.close('P')
    const peek = fakeHost.peek.bind(fakeHost)
    fakeHost.peek = async () => {
      throw new Error('storage unavailable')
    }
    await expect(runner.onDrivenSettled(settledEvent({ requestId: R(4) }))).rejects.toThrow(
      'storage unavailable'
    )
    fakeHost.peek = peek

    // 被抑制 → 正常落定
    runner['agentStopped'].add(R(5))
    await expect(runner.onDrivenSettled(settledEvent({ requestId: R(5) }))).resolves.toBeUndefined()

    // 父会话的行没了 → 什么都不调
    sessionRecords.deleteById('P')
    fakeHost.calls.length = 0
    await expect(runner.onDrivenSettled(settledEvent({ requestId: R(6) }))).resolves.toBeUndefined()
    expect(fakeHost.calls).toEqual([])
  })

  it('P2-10-43 进程 2 里重跑并重新挂上的那一次只回执（§20：不再就地握着结果）→ 落定时本进程记着，恰一次叫醒父会话；waiting-input 的通知文案不变', async () => {
    const parent = family('c1', 'c2')
    const c1 = fakeHost.put('c1', { interrupted: true, submitGate: gate(), answer: { text: 'A' } })
    c1.requestStates.set(R(9), 'pending')
    const receipt = await call(
      { action: 'prompt-session', session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    expect(receipt.text).toContain('Started in the background')
    expect(receipt.text).not.toContain('<reply>')
    expect(submitsOf(c1)).toHaveLength(1)
    c1.submitGate!.release()
    await vi.waitFor(() => expect(taskRegistry.get(R(9))!.status).toBe('done'))
    await runner.onDrivenSettled(settledEvent({ requestId: R(9) }))
    expect(parent.callsOf('notify')).toHaveLength(1)
    expect(parent.callsOf('writeNotice')).toEqual([])

    fakeHost.put('c2', { pendingInputCount: 1, pendingInputSummaries: ['bash: rm -rf build'] })
    await runner.onDrivenSettled(settledEvent({ childId: 'c2', requestId: R(10) }))
    // 本进程不认得的驱动：只写入（option A），文案照旧
    expect(parent.callsOf('notify')).toHaveLength(1)
    const text = String((parent.callsOf('writeNotice')[0]![1] as { text: string }).text)
    expect(text).toContain('ask the user for approval')
    expect(text).toContain('rm -rf build')
    expect(text).not.toContain('has finished')
  })

  it('P2-10-44 两条（本进程发起的）后台子会话同时跑完 → 两次 notify，各带自己的 requestId（不在桌面这边拼起来）', async () => {
    const parent = family('c1', 'c2')
    const children = [await startBackground('c1', 1), await startBackground('c2', 2)]
    await Promise.all([
      runner.onDrivenSettled(settledEvent({ childId: 'c1', requestId: R(1) })),
      runner.onDrivenSettled(settledEvent({ childId: 'c2', requestId: R(2) }))
    ])
    const notices = parent.callsOf('notify')
    expect(notices).toHaveLength(2)
    expect(notices.map((n) => (n[2] as { requestId: string }).requestId).sort()).toEqual([
      'subsession-done:c1:42',
      'subsession-done:c2:42'
    ])
    expect(
      notices.every((n) => !String(n[1]).includes('id="c1"') || !String(n[1]).includes('id="c2"'))
    ).toBe(true)
    for (const child of children) child.submitGate!.release()
  })

  it('PIN-14 抑制已删 / BG-26：上个进程留下的**前台**标记（background:false）落定 —— 不管驱动它的父会话工具任务还活不活着，都写入一条通知（不叫醒，option A）；从不去问任务存活', async () => {
    // §20 起重跑只回执、不再就地收下答复：压掉这条通知，答复就没了去处
    const parent = family('c1')
    parent.taskStates.set(9, { live: true, abortRequested: false })
    await runner.onDrivenSettled(settledEvent({ requestId: R(9), background: false }))
    parent.taskStates.set(10, { live: false, abortRequested: false })
    await runner.onDrivenSettled(settledEvent({ requestId: R(10), background: false }))
    expect(parent.callsOf('notify')).toEqual([])
    expect(parent.callsOf('writeNotice')).toHaveLength(2)
    expect(parent.callsOf('taskLiveness')).toEqual([])
  })
})

// ─── H. 中止语义 ────────────────────────────────────────────────────────────

describe('H. abort semantics', () => {
  it('P2-10-45 父会话被停从不级联：派出去之后 wait 被中止 → 子会话不中止；重跑 wait 续上之后父会话中止 → 子会话照跑，后来恰一条（写入的）通知', async () => {
    // 原来这里还有「前台 + 父会话信号 → 中止子会话」「重跑重新挂上的前台 + 信号 → 中止」两段：§20 一并取消（反向见 BG-29）
    const parent = family('c2', 'c4')
    const c2 = fakeHost.put('c2', { submitGate: gate() })
    await runner.prompt({ parentId: 'P', childId: 'c2', message: 'go', requestId: R(2) })
    c2.busy = true
    const ac3 = new AbortController()
    const waiting = runner.wait({
      parentId: 'P',
      childId: 'c2',
      timeoutSeconds: 5,
      signal: ac3.signal
    })
    ac3.abort()
    expect(await waiting).toMatchObject({ kind: 'aborted' })
    expect(c2.callsOf('abort')).toEqual([])
    c2.submitGate!.release()

    // 重跑 wait 续上之后父会话中止
    const c4 = fakeHost.put('c4', {
      interrupted: true,
      drivenRun: { requestId: R(40), parentId: 'P', background: true, conversationId: 1 as never }
    })
    const memo = sharedMemo()
    memo.store.set('session.wait-for-sub-sessions.targets', ['c4'])
    const ac5 = new AbortController()
    const rerunWait = call({ action: 'wait-for-sessions' }, { memo, signal: ac5.signal })
    await vi.waitFor(() => expect(c4.callsOf('resumeInterrupted')).toHaveLength(1))
    ac5.abort()
    await rerunWait.catch(() => undefined)
    expect(c4.callsOf('abort')).toEqual([])
    expect(c4.busy).toBe(true)
    c4.busy = false
    const before = noticesTo(parent).length
    const notifiesBefore = parent.callsOf('notify').length
    await runner.onDrivenSettled(settledEvent({ childId: 'c4', requestId: R(40) }))
    expect(noticesTo(parent).length - before).toBe(1)
    // 那次驱动是上个进程发起的：只写入、不叫醒（option A）
    expect(parent.callsOf('notify').length).toBe(notifiesBefore)
  })

  it('BG-29 派出去之后父会话的工具信号中止（确认窗里 / 回执之后各一次）：子会话不中止、任务不被停也没落定；放行后各恰一次叫醒父会话', async () => {
    const parent = family('c1', 'c2')
    // (a) 确认窗里就中止
    const c1 = fakeHost.put('c1', { submitGate: gate() })
    const ac1 = new AbortController()
    const inWindow = call(
      { action: 'prompt-session', session_id: 'c1', message: 'go' },
      { taskId: 1, signal: ac1.signal }
    )
    await vi.waitFor(() => expect(submitsOf(c1)).toHaveLength(1), { interval: 1 })
    ac1.abort()
    expect((await inWindow).text).toContain('Started in the background')
    // (b) 回执之后才中止
    const c2 = fakeHost.put('c2', { submitGate: gate() })
    const ac2 = new AbortController()
    expect(
      (
        await call(
          { action: 'prompt-session', session_id: 'c2', message: 'go' },
          { taskId: 2, signal: ac2.signal }
        )
      ).text
    ).toContain('Started in the background')
    ac2.abort()
    await sleep(100)
    for (const [child, rid] of [
      [c1, R(1)],
      [c2, R(2)]
    ] as const) {
      expect(child.callsOf('abort')).toEqual([])
      expect(taskRegistry.get(rid)).toMatchObject({ status: 'running', endedAt: null })
    }
    c1.submitGate!.release()
    c2.submitGate!.release()
    await vi.waitFor(() => expect(taskRegistry.runningCount('P')).toBe(0))
    await runner.onDrivenSettled(settledEvent({ childId: 'c1', requestId: R(1) }))
    await runner.onDrivenSettled(settledEvent({ childId: 'c2', requestId: R(2) }))
    expect(parent.callsOf('notify')).toHaveLength(2)
    expect(parent.callsOf('writeNotice')).toEqual([])
  })

  // 原 P2-10-47（中断的父会话被中止 → 级联它前台驱动着、被中断的子会话，cascadeParentAbort）被 §20 删除：
  // 父会话被停不级联（反向见 sessionHostDeps 的 BG-30、subSessionDurable 的 BG-31）
})

// ─── I. 新消息发进被中断的子会话 ────────────────────────────────────────────

describe('I. fresh prompt into an interrupted child', () => {
  it('P2-10-48 开着的被中断子会话、没开着但镜像说被中断的 → 都不拒；带新键发送，没开着的由网关打开', async () => {
    family('c1', 'c2')
    const c1 = fakeHost.put('c1', { interrupted: true })
    const a = await call(
      { action: 'prompt-session', session_id: 'c1', message: 'new' },
      { taskId: 21 }
    )
    expect(a.isError).toBe(false)
    expect(submitsOf(c1).map((o) => o.requestId)).toEqual([R(21)])

    sessionRecords.updateSettings('c2', { runState: 'interrupted' })
    fakeHost.storages.add('c2')
    fakeHost.configure = (session) => {
      if (session.sessionId === 'c2') session.interrupted = true
    }
    const b = await call(
      { action: 'prompt-session', session_id: 'c2', message: 'new' },
      { taskId: 22 }
    )
    expect(b.isError).toBe(false)
    expect(fakeHost.callsOf('open')).toContain('c2')
    expect(submitsOf(fakeHost.get('c2')!).map((o) => o.requestId)).toEqual([R(22)])
  })

  it('PIN-19（单元面）：被顶掉的正是本父会话驱动的那一轮 → 它的 aborted 落定不通知', async () => {
    const parent = family('c1')
    fakeHost.put('c1', {
      interrupted: true,
      drivenRun: { requestId: R(1), parentId: 'P', background: true, conversationId: 1 as never }
    })
    await call({ action: 'prompt-session', session_id: 'c1', message: 'new' }, { taskId: 2 })
    await runner.onDrivenSettled(settledEvent({ requestId: R(1), reason: 'aborted' }))
    expect(noticesTo(parent)).toEqual([])
  })
})

// ─── J. §19 父会话介入（经真门面） ───────────────────────────────────────────

describe('J. §19 parent intervention through the real facade', () => {
  const question = (id: string, text: string): InputRequest => ({
    id,
    kind: 'choice',
    toolName: 'ask',
    question: text,
    options: [
      { label: 'A', description: 'keep a shim' },
      { label: 'B', description: '' }
    ],
    createdAt: 0
  })

  beforeEach(() => {
    // U2：这里 bgTaskService 是假件，枢纽的通知器没人设 —— 接到真 sessionService 注入的那一个
    setTaskNotifier((sessionId, text) => holder.notifier?.(sessionId, text))
  })

  afterEach(() => {
    setTaskNotifier(() => {})
  })

  /**
   * 父会话 P 经真 SessionTool 后台 prompt c1（发送扣在闸门上）；c1 随即停在 q1 上。U3：假宿主的
   * subscribeInputs 是空的、也没有 index.ts，询问钩子由用例直接调（应答受理的那一条经 onResponded）。
   */
  async function askingChild(): Promise<{
    parent: FakeDurableSession
    c1: FakeDurableSession
  }> {
    const parent = family('c1')
    const c1 = fakeHost.put('c1', { submitGate: gate(), respondResult: true })
    const started = await call(
      {
        action: 'prompt-session',
        session_id: 'c1',
        message: 'go'
      },
      { taskId: 1 }
    )
    expect(started.isError).toBe(false)
    c1.busy = true
    raiseOn(c1, question('q1', 'Keep the old API?'))
    return { parent, c1 }
  }

  function raiseOn(session: FakeDurableSession, request: InputRequest): void {
    session.pendingRequests.push(request)
    session.onResponded = (requestId) => runner.onAskResolved(session.sessionId, requestId)
    runner.onAskRaised(session.sessionId, request)
  }

  it('WP3-99 代答经真门面只落到这条子会话的 durable：三参调用，附带信息里是 parent:<P> 与答题方；载荷里没有 answeredBy；别的会话一次都没被应答', async () => {
    const { parent, c1 } = await askingChild()
    const res = await call({ action: 'answer-session', selections: ['A'] }, { taskId: 2 })
    expect(res.isError).toBe(false)
    expect(res.text).toContain('Answered; it carries on in the background.')
    expect(c1.respondArgs).toEqual([
      {
        arity: 3,
        meta: {
          clientId: 'parent:P',
          answeredBy: { kind: 'parent-session', sessionId: 'P', title: 'P' }
        }
      }
    ])
    const [, requestId, response] = c1.callsOf('respondToInput')[0]!
    expect(requestId).toBe('q1')
    expect(response).toEqual({ kind: 'choice', selections: ['A'] })
    expect(response).not.toHaveProperty('answeredBy')
    expect(parent.callsOf('respondToInput')).toEqual([])
    for (const id of fakeHost.openSessionIds().filter((s) => s !== 'c1')) {
      expect(fakeHost.get(id)!.callsOf('respondToInput')).toEqual([])
    }
    c1.submitGate!.release()
  })

  it('WP3-100 / WP3-101 插话经网关的 steerDriven 落到子会话：幂等键 subsession-steer:<P>:<任务> 与来源（父会话）原样到 steer；重跑时子会话认得键 → 不再发', async () => {
    family('c1')
    const c1 = fakeHost.put('c1', { submitGate: gate() })
    expect(
      (
        await call(
          {
            action: 'prompt-session',
            session_id: 'c1',
            message: 'go'
          },
          { taskId: 1 }
        )
      ).isError
    ).toBe(false)
    c1.busy = true
    const memo = sharedMemo()
    const first = await call({ action: 'steer-session', message: 'm' }, { taskId: 9, memo })
    expect(first.isError).toBe(false)
    expect(first.text).toContain('Steer delivered')
    expect(c1.callsOf('steer')).toEqual([['steer', 'm']])
    expect(c1.steerOptions[0]).toMatchObject({
      requestId: 'subsession-steer:P:9',
      source: { kind: 'parent-session', sessionId: 'P' }
    })

    // WP3-101：重跑（同一 taskId、同一张 memo 表），子会话已经认得这个键
    c1.requestStates.set('subsession-steer:P:9', 'settled')
    const rerun = await call({ action: 'steer-session', message: 'm' }, { taskId: 9, memo })
    expect(rerun.isError).toBe(false)
    expect(rerun.text).toContain('already delivered earlier')
    expect(c1.callsOf('steer')).toHaveLength(1)
    c1.submitGate!.release()
  })

  it('WP3-102 后台这一轮停下来问、没人在等：通知经枢纽落到父会话门面的 notify（后台通知那条路：两参，不是完成通知的形状）；父会话没锁 → 只写一条 background 通知条目', async () => {
    const { parent, c1 } = await askingChild()
    await sleep(350)
    const notices = parent.callsOf('notify')
    expect(notices).toHaveLength(1)
    // ['notify', text] —— 没有 {kind:'sub-session', requestId:'subsession-done:…'}（那是完成通知的形状）
    expect(notices[0]).toHaveLength(2)
    const text = String(notices[0]![1])
    expect(text).toContain('<question ask_id="q1">')
    expect(text).toContain('answer-session')
    expect(parent.callsOf('writeNotice')).toEqual([])

    // 父会话没锁：落成一条通知条目，不起一轮
    parent.lock = undefined
    raiseOn(c1, question('q2', 'Which dir?'))
    await sleep(350)
    expect(parent.callsOf('notify')).toHaveLength(1)
    expect(parent.callsOf('writeNotice')).toEqual([
      [
        'writeNotice',
        { text: expect.stringContaining('<question ask_id="q2">'), kind: 'background' }
      ]
    ])
    c1.submitGate!.release()
  })

  it('WP3-103 换进程之后重跑同一次代答（子会话的 ask 重跑、同一 id 再挂）：工具失败，新进程里子会话 durable 一次都没被应答', async () => {
    const { c1 } = await askingChild()
    const memo = sharedMemo()
    const args = { action: 'answer-session', selections: ['A'] }
    // 第一个进程里答过一次（q1 被受理）
    expect((await call(args, { taskId: 2, memo })).isError).toBe(false)
    expect(c1.callsOf('respondToInput')).toHaveLength(1)
    c1.submitGate!.release()

    newProcess()
    const reopened = fakeHost.put('c1', { respondResult: true, busy: true })
    raiseOn(reopened, question('q1', 'Keep the old API?'))
    const rerun = await call(args, { taskId: 2, memo })
    expect(rerun.isError).toBe(true)
    expect(rerun.text).toContain('the app restarted since')
    expect(rerun.text).toContain('Nothing was sent.')
    expect(reopened.callsOf('respondToInput')).toEqual([])
  })
})

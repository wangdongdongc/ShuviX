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
 *   G  P2-10-35..44  完成通知：送达、抑制、不重复
 *   H  P2-10-45 / 47 中止语义（Q-P2-03）与中断父会话的级联（PIN-08，存活情况由假会话的脚本给）
 *   I  P2-10-48      新消息发进被中断的子会话
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
  recordUserEntry: vi.fn()
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
vi.mock('../sandbox', () => ({ cleanupSession: vi.fn() }))
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
import { sessionRecords } from '../sessionRecords'
import { clearMemoryStoragesForTests } from '../sessionStorage'
import { taskRegistry } from '../taskRegistry'
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
  over: Partial<{ childId: string; requestId: string; background: boolean; reason: string }> = {}
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
    result: {},
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
  it('P2-10-02 选项一路到底：枢纽任务 id = 幂等键；子会话收到 requestId + driven + onAdmitted；跑着时 driven', async () => {
    family('c1')
    const c1 = fakeHost.put('c1', { submitGate: gate() })
    const pending = runner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'go',
      background: true,
      timeoutSeconds: 5,
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

    // 前台：driven.background === false
    const c1b = fakeHost.get('c1')!
    c1b.submitGate = undefined
    await runner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'again',
      background: false,
      timeoutSeconds: 5,
      requestId: R(6)
    })
    expect(submitsOf(c1b).at(-1)!.driven).toEqual({ parentId: 'P', background: false })
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
      (
        await call(
          { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'a' },
          { taskId: 7 }
        )
      ).isError
    ).toBe(false)
    expect(
      (
        await call(
          { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'b' },
          { taskId: 8 }
        )
      ).isError
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
      { action: 'prompt-sub-session', sub_session_id: 'd1', message: 'x' },
      { taskId: 5, sessionId: 'P1' }
    )
    const b = call(
      { action: 'prompt-sub-session', sub_session_id: 'd2', message: 'y' },
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
      { action: 'prompt-sub-session', sub_session_id: child!.id, message: 'go' },
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
    expect(res.text).toContain(`<sub-session id="${id}"`)
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

  it('P2-10-10 prompt 重跑（被中断、键 pending）：跳过忙 / 等批准 / 上限，重新挂上（带 driven），不受理、不中止，答复取 lastAnswer', async () => {
    family('c1', 'b1', 'b2', 'b3', 'b4')
    // 本进程里已有 4 条在跑（并发上限顶满）—— 重新挂上不看它
    for (const id of ['b1', 'b2', 'b3', 'b4']) {
      fakeHost.put(id, { submitGate: gate() })
      await runner.prompt({
        parentId: 'P',
        childId: id,
        message: 'x',
        background: true,
        timeoutSeconds: 5,
        requestId: R(`bg-${id}`)
      })
      fakeHost.get(id)!.busy = true
    }
    const c1 = fakeHost.put('c1', { interrupted: true, answer: { text: 'A9' } })
    c1.requestStates.set(R(9), 'pending')
    mocks.fire.mockClear()
    const res = await call(
      { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    expect(res.isError).toBe(false)
    expect(res.text).toContain('<reply>\nA9\n</reply>')
    const [options] = submitsOf(c1)
    expect(options!.requestId).toBe(R(9))
    expect(options!.driven).toEqual({ parentId: 'P', background: false })
    expect(mocks.fire.mock.calls.filter(([name]) => name === 'session.prompt-accepted')).toEqual([])
    expect(c1.callsOf('abort')).toEqual([])
    for (const id of ['b1', 'b2', 'b3', 'b4']) fakeHost.get(id)!.submitGate!.release()
  })

  it('P2-10-11 prompt 重跑（在跑、键 pending）：不报「在跑」，闸门放开之后 answered', async () => {
    family('c1')
    const c1 = fakeHost.put('c1', { busy: true, submitGate: gate(), answer: { text: 'later' } })
    c1.requestStates.set(R(9), 'pending')
    const pending = call(
      { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    await vi.waitFor(() => expect(submitsOf(c1)).toHaveLength(1))
    c1.submitGate!.release()
    const res = await pending
    expect(res.isError).toBe(false)
    expect(res.text).toContain('<reply>\nlater\n</reply>')
  })

  it('P2-10-12 prompt 重跑（键 settled）：不再发送，直接 answered；子会话没有报错广播、没有埋点', async () => {
    family('c1')
    const c1 = fakeHost.put('c1', { answer: { text: 'A' } })
    c1.requestStates.set(R(9), 'settled')
    const res = await call(
      { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    expect(res.text).toContain('<reply>\nA\n</reply>')
    expect(c1.callsOf('submitUser')).toEqual([])
    expect(mocks.broadcast.mock.calls.filter(([e]) => e.sessionId === 'c1')).toEqual([])
    expect(mocks.fire).not.toHaveBeenCalled()
  })

  it("P2-10-13 键 'none'：正常路径 —— 在跑的子会话照旧被拒", async () => {
    family('c1')
    fakeHost.put('c1', { busy: true })
    const res = await call(
      { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/is running/)
  })

  it('P2-10-14 后台 prompt 重跑（键 pending）：确认窗口之后回执 started，只挂上一次、没有第二条输入', async () => {
    family('c1')
    const c1 = fakeHost.put('c1', { submitGate: gate() })
    c1.requestStates.set(R(9), 'pending')
    const res = await call(
      {
        action: 'prompt-sub-session',
        sub_session_id: 'c1',
        message: 'task',
        run_in_background: true
      },
      { taskId: 9 }
    )
    expect(res.text).toContain('Started in the background')
    expect(res.details).toEqual({ type: 'session', background: true })
    expect(c1.callsOf('submitUser')).toHaveLength(1)
    c1.submitGate!.release()
  })

  it('P2-10-15 wait 第一次：挂住的时候 memo 里已是要等的那几条；从不 resumeInterrupted', async () => {
    family('c1', 'c2')
    const c1 = fakeHost.put('c1', { busy: true })
    const c2 = fakeHost.put('c2', { busy: true })
    const memo = sharedMemo()
    const pending = call({ action: 'wait-for-sub-sessions' }, { memo })
    await vi.waitFor(() =>
      expect(memo.store.get('session.wait-for-sub-sessions.targets')).toEqual(['c1', 'c2'])
    )
    c1.busy = false
    c2.busy = false
    expect((await pending).text).toContain('<sub-sessions status="settled">')
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
    const pending = call({ action: 'wait-for-sub-sessions' }, { memo }).then((r) => {
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
    const pending = call({ action: 'wait-for-sub-sessions' }, { memo })
    await vi.waitFor(() => expect(fakeHost.get('c1')?.callsOf('resumeInterrupted')).toHaveLength(1))
    expect(fakeHost.callsOf('open')).toEqual(['c1'])
    fakeHost.get('c1')!.busy = false
    expect((await pending).isError).toBe(false)
  })

  it('P2-10-18 wait 第一次、点名一条被中断的：立刻返回，不续上，状态 interrupted，外层 settled；重跑（memo []）结果相同', async () => {
    family('c1')
    const c1 = fakeHost.put('c1', { interrupted: true })
    const memo = sharedMemo()
    const first = await call({ action: 'wait-for-sub-sessions', sub_session_id: 'c1' }, { memo })
    expect(first.text).toContain('<sub-sessions status="settled">')
    expect(first.text).toContain('status="interrupted"')
    expect(c1.callsOf('resumeInterrupted')).toEqual([])
    expect(memo.store.get('session.wait-for-sub-sessions.targets')).toEqual([])
    const again = await call({ action: 'wait-for-sub-sessions', sub_session_id: 'c1' }, { memo })
    expect(again.text).toBe(first.text)
    expect(c1.callsOf('resumeInterrupted')).toEqual([])
  })

  it('P2-10-19 stop 重跑：(a) 空闲且没开着 → {stopped:false}，不 open / peek；(b) 被中断（开着 → abort；没开着 → peek 再 abort）→ stopped，之后没有通知', async () => {
    const parent = family('c1', 'c2', 'c3')
    const a = await call({ action: 'stop-sub-session', sub_session_id: 'c1' })
    expect(a.text).toContain('was not running')
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.callsOf('peek')).toEqual([])

    const c2 = fakeHost.put('c2', {
      interrupted: true,
      drivenRun: { requestId: R(21), parentId: 'P', background: true, conversationId: 1 as never }
    })
    expect((await call({ action: 'stop-sub-session', sub_session_id: 'c2' })).text).toContain(
      'Stopped'
    )
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
    expect((await call({ action: 'stop-sub-session', sub_session_id: 'c3' })).text).toContain(
      'Stopped'
    )
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
    const first = await call({ action: 'read-sub-session', sub_session_id: 'c1' })
    const again = await call({ action: 'read-sub-session', sub_session_id: 'c1' })
    expect(again.text).toBe(first.text)
    expect(first.text).toContain('<reply>\nR1\n</reply>')
    expect(fakeHost.callsOf('peek')).toContain('c1')
    expect(fakeHost.callsOf('open')).toEqual([])

    const none = await call({ action: 'read-sub-session', sub_session_id: 'c2' })
    expect(none.text).toContain('<note>No reply yet.</note>')
    expect(readdirSync(holder.sessionsDir)).toEqual([])
    expect(fakeHost.callsOf('open')).toEqual([])

    const peeks = fakeHost.callsOf('peek').length
    await call({ action: 'list-sub-sessions' })
    expect(fakeHost.callsOf('peek')).toHaveLength(peeks)
    expect(fakeHost.callsOf('open')).toEqual([])
  })
})

// ─── D. 重启之后的重跑 ──────────────────────────────────────────────────────

describe('D. continue cascade (unit)', () => {
  it('P2-10-24 模拟重启：进程 1 前台 prompt 卡着；进程 2 里子会话被中断、键 pending → 同一 taskId 重跑重新挂上，回执带 lastAnswer', async () => {
    family('c1')
    fakeHost.put('c1', { submitGate: gate() })
    const memo = sharedMemo()
    void call(
      { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'task' },
      { taskId: 9, memo }
    )
    await vi.waitFor(() => expect(submitsOf(fakeHost.get('c1')!)).toHaveLength(1))

    newProcess()
    fakeHost.put('P', { lock: lockRecord() })
    const c1 = fakeHost.put('c1', { interrupted: true, answer: { text: 'C9' } })
    c1.requestStates.set(R(9), 'pending')
    mocks.fire.mockClear()
    const res = await call(
      { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'task' },
      { taskId: 9, memo }
    )
    expect(res.text).toContain('<reply>\nC9\n</reply>')
    expect(submitsOf(c1).map((o) => o.requestId)).toEqual([R(9)])
    expect(mocks.fire.mock.calls.filter(([name]) => name === 'session.prompt-accepted')).toEqual([])
  })

  it('P2-10-27 崩溃前子会话已经答完、父会话的工具还没收：重跑立刻 answered，子会话不再发请求', async () => {
    family('c1')
    const c1 = fakeHost.put('c1', { answer: { text: 'C-done' } })
    c1.requestStates.set(R(9), 'settled')
    const res = await call(
      { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    expect(res.text).toContain('<reply>\nC-done\n</reply>')
    expect(c1.callsOf('submitUser')).toEqual([])
  })
})

// ─── E. 答复 ────────────────────────────────────────────────────────────────

describe('E. answers via lastAnswer', () => {
  it('P2-10-30 没有答复 → No reply yet；被中断在半路（上一轮答过 old）→ 不出现 old，围栏 interrupted；wait 的结果逐条取 lastAnswer', async () => {
    family('c1', 'c2', 'c3')
    fakeHost.put('c1')
    expect((await call({ action: 'read-sub-session', sub_session_id: 'c1' })).text).toContain(
      '<note>No reply yet.</note>'
    )
    // PIN-07：这一轮的提问之后没有回答 → lastAnswer 是 undefined，不是上一轮的 old
    fakeHost.put('c2', { interrupted: true, answer: undefined })
    const interrupted = await call({ action: 'read-sub-session', sub_session_id: 'c2' })
    expect(interrupted.text).toContain('status="interrupted"')
    expect(interrupted.text).not.toContain('old')
    expect(interrupted.text).not.toContain('<reply>')

    fakeHost.put('c3', { answer: { text: 'three' } })
    const waited = await call({ action: 'wait-for-sub-sessions' })
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
    'P2-10-31 网关结果 %s → %s 时算答复（带 isError），否则 NOT delivered',
    async (code, answered) => {
      family('c1')
      const c1 = fakeHost.put('c1', { submitResults: [{ error: `${code} text`, code }] })
      const res = await runner.prompt({
        parentId: 'P',
        childId: 'c1',
        message: 'go',
        background: false,
        timeoutSeconds: 5,
        requestId: R(31)
      })
      if (answered) {
        // lastAnswer 读不到错误条目时退回结果里的错误原文
        expect(res).toMatchObject({ kind: 'answered', answer: `${code} text`, isError: true })
        c1.answer = { text: `${code} from transcript`, isError: true }
        const again = await runner.prompt({
          parentId: 'P',
          childId: 'c1',
          message: 'go',
          background: false,
          timeoutSeconds: 5,
          requestId: R(32)
        })
        expect(again).toMatchObject({ answer: `${code} from transcript`, isError: true })
      } else {
        expect((res as { error: string }).error).toContain('NOT delivered')
      }
      expect(taskRegistry.get(R(31))!.status).toBe('error')
      expect(taskRegistry.runningCount('P')).toBe(0)
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
    const pending = call({ action: 'wait-for-sub-sessions' }, { memo })
    await vi.waitFor(() =>
      expect(memo.store.get('session.wait-for-sub-sessions.targets')).toEqual(['c2'])
    )
    c2.busy = false
    const res = await pending
    expect(res.text).toContain('id="c2"')
    expect(res.text).not.toContain('id="c1"')

    const idle = await call({ action: 'wait-for-sub-sessions' })
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
      background: true,
      timeoutSeconds: 5,
      requestId: R(5)
    })
    await sleep(300)
    await runner.onDrivenSettled(settledEvent({ requestId: R(5) }))
    const notices = parent.callsOf('notify')
    expect(notices).toHaveLength(1)
    const [, text, options] = notices[0] as [string, string, unknown]
    expect(options).toEqual({ kind: 'sub-session', requestId: 'subsession-done:c1:42' })
    expect(text).toContain('id="c1"')
    expect(text).toContain('wait-for-sub-sessions')
    expect(text).not.toContain('SECRET ANSWER')
    expect(parent.callsOf('writeNotice')).toEqual([])
  })

  it('P2-10-36 前台答完 → 不通知，两种先后都一样', async () => {
    const parent = family('c1')
    const c1 = fakeHost.put('c1', { submitGate: gate(), answer: { text: 'A' } })
    const pending = runner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'go',
      background: false,
      timeoutSeconds: 5,
      requestId: R(1)
    })
    await vi.waitFor(() => expect(submitsOf(c1)).toHaveLength(1))
    // (a) 落定先报来、前台还在等
    await runner.onDrivenSettled(settledEvent({ requestId: R(1), background: false }))
    c1.submitGate!.release()
    expect(await pending).toMatchObject({ kind: 'answered', answer: 'A' })
    // (b) 前台先交回了，落定后报来
    c1.submitGate = undefined
    expect(
      await runner.prompt({
        parentId: 'P',
        childId: 'c1',
        message: 'go',
        background: false,
        timeoutSeconds: 5,
        requestId: R(2)
      })
    ).toMatchObject({ kind: 'answered' })
    await runner.onDrivenSettled(settledEvent({ requestId: R(2), background: false }))
    expect(noticesTo(parent)).toEqual([])
  })

  it('P2-10-37 前台超时降级成后台 → 后来跑完恰一条通知', async () => {
    const parent = family('c1')
    const c1 = fakeHost.put('c1', { submitGate: gate() })
    expect(
      await runner.prompt({
        parentId: 'P',
        childId: 'c1',
        message: 'go',
        background: false,
        timeoutSeconds: 1,
        requestId: R(3)
      })
    ).toEqual({ kind: 'timeout', id: 'c1' })
    c1.submitGate!.release()
    await runner.onDrivenSettled(settledEvent({ requestId: R(3), background: false }))
    expect(parent.callsOf('notify')).toHaveLength(1)
  })

  it('P2-10-38 wait 握着它 → 不通知；wait 已经交回那次落定之后才报来 → 同样不通知', async () => {
    const parent = family('c1', 'c2')
    // (a) 握着的时候报来
    const c1 = fakeHost.put('c1', { submitGate: gate() })
    await runner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'go',
      background: true,
      timeoutSeconds: 5,
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
      background: true,
      timeoutSeconds: 5,
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

  it('P2-10-39 智能体自己停的 → 不通知（stop、前台信号级联）；用户停的 → 恰一条（面板停止键、用户在子会话里自己停）', async () => {
    const parent = family('c1', 'c2', 'c3', 'c4')
    // stop-sub-session
    const c1 = fakeHost.put('c1', { submitGate: gate() })
    await runner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'go',
      background: true,
      timeoutSeconds: 5,
      requestId: R(1)
    })
    c1.busy = true
    await runner.stop('P', 'c1')
    c1.submitGate!.release()
    await runner.onDrivenSettled(settledEvent({ requestId: R(1), reason: 'aborted' }))
    // 前台信号级联
    const c2 = fakeHost.put('c2', { submitGate: gate() })
    const ac = new AbortController()
    const fg = runner.prompt({
      parentId: 'P',
      childId: 'c2',
      message: 'go',
      background: false,
      timeoutSeconds: 5,
      signal: ac.signal,
      requestId: R(2)
    })
    await vi.waitFor(() => expect(submitsOf(c2)).toHaveLength(1))
    ac.abort()
    await vi.waitFor(() => expect(c2.callsOf('abort')).toHaveLength(1))
    await runner.onDrivenSettled(
      settledEvent({ childId: 'c2', requestId: R(2), background: false, reason: 'aborted' })
    )
    c2.submitGate!.release()
    await fg
    expect(noticesTo(parent)).toEqual([])

    // 用户从面板停
    const c3 = fakeHost.put('c3', { submitGate: gate() })
    await runner.prompt({
      parentId: 'P',
      childId: 'c3',
      message: 'go',
      background: true,
      timeoutSeconds: 5,
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
      background: true,
      timeoutSeconds: 5,
      requestId: R(4)
    })
    c4.submitGate!.release()
    await runner.onDrivenSettled(
      settledEvent({ childId: 'c4', requestId: R(4), reason: 'aborted' })
    )
    expect(parent.callsOf('notify')).toHaveLength(2)
  })

  it('P2-10-40 送达父会话：开着锁着 → notify；没开着 → peek（不 open），没锁 → writeNotice、不建 agent；行没了 → 什么都不调；peek / notify 抛 → 拒绝；被抑制 → 正常落定', async () => {
    const parent = family('c1')
    await runner.onDrivenSettled(settledEvent({ requestId: R(1) }))
    expect(parent.callsOf('notify')).toHaveLength(1)

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
    await expect(runner.onDrivenSettled(settledEvent({ requestId: R(3) }))).rejects.toThrow(
      'parent write failed'
    )

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

  it('P2-10-43 进程 2 里重跑并重新挂上的前台握着结果 → 不通知；waiting-input 的通知文案不变', async () => {
    const parent = family('c1', 'c2')
    const c1 = fakeHost.put('c1', { interrupted: true, submitGate: gate(), answer: { text: 'A' } })
    c1.requestStates.set(R(9), 'pending')
    const pending = call(
      { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'task' },
      { taskId: 9 }
    )
    await vi.waitFor(() => expect(submitsOf(c1)).toHaveLength(1))
    await runner.onDrivenSettled(settledEvent({ requestId: R(9), background: false }))
    c1.submitGate!.release()
    expect((await pending).text).toContain('<reply>\nA\n</reply>')
    expect(noticesTo(parent)).toEqual([])

    fakeHost.put('c2', { pendingInputCount: 1, pendingInputSummaries: ['bash: rm -rf build'] })
    await runner.onDrivenSettled(settledEvent({ childId: 'c2', requestId: R(10) }))
    const text = String(parent.callsOf('notify')[0]![1])
    expect(text).toContain('ask the user for approval')
    expect(text).toContain('rm -rf build')
    expect(text).not.toContain('has finished')
  })

  it('P2-10-44 两条后台子会话同时跑完 → 两次 notify，各带自己的 requestId（不在桌面这边拼起来）', async () => {
    const parent = family('c1', 'c2')
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
  })

  it('PIN-14 的裁定：本进程不认得的前台落定 —— 驱动它的父会话工具任务还活着 → 不通知；已终结 → 通知', async () => {
    const parent = family('c1')
    parent.taskStates.set(9, { live: true, abortRequested: false })
    await runner.onDrivenSettled(settledEvent({ requestId: R(9), background: false }))
    expect(noticesTo(parent)).toEqual([])
    parent.taskStates.set(10, { live: false, abortRequested: false })
    await runner.onDrivenSettled(settledEvent({ requestId: R(10), background: false }))
    expect(parent.callsOf('notify')).toHaveLength(1)
  })
})

// ─── H. 中止语义 ────────────────────────────────────────────────────────────

describe('H. abort semantics', () => {
  it('P2-10-45 前台 + 父会话信号 → 中止子会话；后台、wait + 父会话中止 → 不中止；重跑重新挂上的前台 + 信号 → 中止；重跑 wait 续上之后父会话中止 → 子会话照跑，后来恰一条通知', async () => {
    const parent = family('c1', 'c2', 'c3', 'c4')
    const c1 = fakeHost.put('c1', { submitGate: gate() })
    const ac1 = new AbortController()
    const fg = runner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'go',
      background: false,
      timeoutSeconds: 5,
      signal: ac1.signal,
      requestId: R(1)
    })
    await vi.waitFor(() => expect(submitsOf(c1)).toHaveLength(1))
    ac1.abort()
    await vi.waitFor(() => expect(c1.callsOf('abort')).toHaveLength(1))
    c1.submitGate!.release()
    await fg

    const c2 = fakeHost.put('c2', { submitGate: gate() })
    const ac2 = new AbortController()
    await runner.prompt({
      parentId: 'P',
      childId: 'c2',
      message: 'go',
      background: true,
      timeoutSeconds: 5,
      signal: ac2.signal,
      requestId: R(2)
    })
    ac2.abort()
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

    // 重跑重新挂上的前台 + 信号
    const c3 = fakeHost.put('c3', { interrupted: true, submitGate: gate() })
    c3.requestStates.set(R(3), 'pending')
    const ac4 = new AbortController()
    const rerun = call(
      { action: 'prompt-sub-session', sub_session_id: 'c3', message: 'task' },
      { taskId: 3, signal: ac4.signal }
    )
    await vi.waitFor(() => expect(submitsOf(c3)).toHaveLength(1))
    ac4.abort()
    await vi.waitFor(() => expect(c3.callsOf('abort')).toHaveLength(1))
    c3.submitGate!.release()
    await rerun.catch(() => undefined)

    // 重跑 wait 续上之后父会话中止
    const c4 = fakeHost.put('c4', {
      interrupted: true,
      drivenRun: { requestId: R(40), parentId: 'P', background: true, conversationId: 1 as never }
    })
    const memo = sharedMemo()
    memo.store.set('session.wait-for-sub-sessions.targets', ['c4'])
    const ac5 = new AbortController()
    const rerunWait = call({ action: 'wait-for-sub-sessions' }, { memo, signal: ac5.signal })
    await vi.waitFor(() => expect(c4.callsOf('resumeInterrupted')).toHaveLength(1))
    ac5.abort()
    await rerunWait.catch(() => undefined)
    expect(c4.callsOf('abort')).toEqual([])
    expect(c4.busy).toBe(true)
    c4.busy = false
    const before = parent.callsOf('notify').length
    await runner.onDrivenSettled(settledEvent({ childId: 'c4', requestId: R(40) }))
    expect(parent.callsOf('notify').length - before).toBe(1)
  })

  it('P2-10-47 中断的父会话被中止：只级联前台驱动、工具任务还活着的那条；后台 / wait 目标 / 早先超时降级的前台一概不碰；不通知', async () => {
    const parent = family('fg', 'bg', 'waited', 'degraded')
    parent.interrupted = true
    parent.taskStates.set(7, { live: true, abortRequested: false })
    parent.taskStates.set(3, { live: false, abortRequested: false })
    const marker = (requestId: string, background: boolean): FakeDurableSession['drivenRun'] => ({
      requestId,
      parentId: 'P',
      background,
      conversationId: 1 as never
    })
    const fg = fakeHost.put('fg', { interrupted: true, drivenRun: marker(R(7), false) })
    const bg = fakeHost.put('bg', { interrupted: true, drivenRun: marker(R(5), true) })
    // wait 的目标：之前是后台发的（标记是后台的），或者干脆是用户自己的那一轮（没有标记）
    const waited = fakeHost.put('waited', { interrupted: true })
    const degraded = fakeHost.put('degraded', { interrupted: true, drivenRun: marker(R(3), false) })

    await runner.cascadeParentAbort('P')
    expect(fg.callsOf('abort')).toHaveLength(1)
    expect(bg.callsOf('abort')).toEqual([])
    expect(waited.callsOf('abort')).toEqual([])
    expect(degraded.callsOf('abort')).toEqual([])
    expect(bg.interrupted).toBe(true)
    // 级联中止的那一轮落定时不通知
    await runner.onDrivenSettled(
      settledEvent({ childId: 'fg', requestId: R(7), background: false, reason: 'aborted' })
    )
    expect(noticesTo(parent)).toEqual([])
    // 幂等：再来一遍什么都不多做
    await runner.cascadeParentAbort('P')
    expect(fg.callsOf('abort')).toHaveLength(1)
  })
})

// ─── I. 新消息发进被中断的子会话 ────────────────────────────────────────────

describe('I. fresh prompt into an interrupted child', () => {
  it('P2-10-48 开着的被中断子会话、没开着但镜像说被中断的 → 都不拒；带新键发送，没开着的由网关打开', async () => {
    family('c1', 'c2')
    const c1 = fakeHost.put('c1', { interrupted: true })
    const a = await call(
      { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'new' },
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
      { action: 'prompt-sub-session', sub_session_id: 'c2', message: 'new' },
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
    await call(
      { action: 'prompt-sub-session', sub_session_id: 'c1', message: 'new' },
      { taskId: 2 }
    )
    await runner.onDrivenSettled(settledEvent({ requestId: R(1), reason: 'aborted' }))
    expect(noticesTo(parent)).toEqual([])
  })
})

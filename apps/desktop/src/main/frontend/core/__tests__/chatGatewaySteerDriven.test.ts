/**
 * DefaultChatGateway.steerDriven —— 父会话往自己驱动着的子会话里插话（docs/sub-session-design.md §19.6）：
 * 与界面的 `steer` 同一道门，但交回受理结果、带上幂等键与来源；只交给打开着的会话；主进程内专用。
 *
 *   WP2-63 会话没开着 → `{error, code:'closed'}`，不为它打开 / peek 会话、不广播
 *   WP2-64 受理 → `admitSteer` 恰一次（requestId + 父会话来源，没有 title），交回 `{}`（不漏 submissionId）
 *   WP2-65 被拒 → 原样交回 `{error, code}`；不向界面广播（被拒只交给父会话 —— 现状，见下）
 *   WP2-66 admitSteer 抛错 / 抛字符串 → `{error}`（没有 code），从不 reject
 *   XS-59  驱动方不是 target 的父会话（别的会话 / 顶层会话 / 行不在）→ 来源 `{kind:'session', sessionId: <driver>}`；
 *          父会话驱动照旧 parent-session（[guard]）
 *   WP2-67 IPC 的 steer 照旧：`session.steer(text)`，不经 admitSteer；被拒广播 error
 *   WP2-78 前端拿不到写来源 / 答题方的口子（读源码）：IPC 与 Chrome 通道从不传 drive、从不调 steerDriven /
 *          admitSteer，respondToInput 的附带信息只由 `{clientId: …}` 字面量构成
 *
 * mock 骨架照抄 chatGatewayPrompt.test.ts。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureAgentSession: vi.fn(),
  getAgentSession: vi.fn(),
  peekAgentSession: vi.fn(),
  frontendBroadcast: vi.fn()
}))

vi.mock('../../../tools/allTools', () => ({}))
vi.mock('../../../services/toolRegistry', () => ({
  getBuiltinToolEntries: () => [],
  getPlatformBuiltinToolEntries: () => []
}))
// 会话权限表（services/acl）不在这组用例里：空表（真的那份落 SQLite，这里不起库）
vi.mock('../../../services/acl', () => ({
  sessionAcl: { pathView: () => ({ read: [], write: [] }), sandboxEntries: () => [] }
}))
vi.mock('../../../services/sessionService', () => ({
  sessionService: {
    ensureAgentSession: mocks.ensureAgentSession,
    getAgentSession: mocks.getAgentSession,
    peekAgentSession: mocks.peekAgentSession,
    resolveAgentProfileName: vi.fn()
  }
}))
vi.mock('../../../services/messageService', () => ({ messageService: {} }))
vi.mock('../../../services/sessionStorage', () => ({
  storageRefusalOf: () => undefined,
  recordSessionModel: vi.fn(),
  recordSessionThinkingLevel: vi.fn()
}))
vi.mock('../../../services/userInputBroker', () => ({ respondToUserInput: vi.fn() }))
vi.mock('../../../services/builtinMcp/dbConnections', () => ({
  dbManager: { getConnectionInfo: vi.fn() }
}))
vi.mock('../../../services/mcpService', () => ({ mcpService: { getAllToolInfos: () => [] } }))
vi.mock('../../../services/skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../../../dao/sessionDao', () => ({
  // c1 是 P1 的子会话：插话的来源记成 parent-session（驱动它的不是父会话时记 session，见 sessionRecords.drivingSourceOf）
  sessionDao: {
    findById: vi.fn(),
    touchActive: vi.fn(),
    // t1 是顶层会话（XS-59）；别的 id 没有行
    pick: vi.fn((id: string) =>
      id === 'c1' ? { parentId: 'P1' } : id === 't1' ? { parentId: null } : undefined
    )
  }
}))
vi.mock('../../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../../../services/agentService', () => ({ agentService: { getProfile: vi.fn() } }))
vi.mock('../ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: mocks.frontendBroadcast }
}))
vi.mock('../../../services/sessionDayPromptService', () => ({ recordUserEntry: vi.fn() }))

let chatGateway: (typeof import('../DefaultChatGateway'))['chatGateway']

beforeAll(async () => {
  ;({ chatGateway } = await import('../DefaultChatGateway'))
})

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
})

const DRIVE = { requestId: 'subsession-steer:P1:9', parentId: 'P1' }

/** 一条打开着的会话的替身：只有 steer / admitSteer 两样 */
function openSession(admitSteer: () => Promise<unknown>): {
  admitSteer: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
} {
  const session = { admitSteer: vi.fn(admitSteer), steer: vi.fn(async () => {}) }
  mocks.getAgentSession.mockReturnValue(session)
  return session
}

const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

describe('DefaultChatGateway.steerDriven（WP2）', () => {
  it('WP2-63 会话没开着 → {error, code: closed}；不 ensure / peek，不广播', async () => {
    mocks.getAgentSession.mockReturnValue(undefined)
    const result = await chatGateway.steerDriven('c1', 'm', DRIVE)
    expect(result.code).toBe('closed')
    expect(result.error).toBeTruthy()
    expect(mocks.getAgentSession).toHaveBeenCalledWith('c1')
    expect(mocks.ensureAgentSession).not.toHaveBeenCalled()
    expect(mocks.peekAgentSession).not.toHaveBeenCalled()
    expect(mocks.frontendBroadcast).not.toHaveBeenCalled()
  })

  it('WP2-64 受理 → admitSteer 恰一次（幂等键 + 父会话来源，没有 title），交回恰 {}', async () => {
    const session = openSession(async () => ({ submissionId: 3 }))
    expect(await chatGateway.steerDriven('c1', 'm', DRIVE)).toStrictEqual({})
    expect(session.admitSteer.mock.calls).toStrictEqual([
      [
        'm',
        {
          requestId: 'subsession-steer:P1:9',
          source: { kind: 'parent-session', sessionId: 'P1' }
        }
      ]
    ])
    expect(session.steer).not.toHaveBeenCalled()
  })

  it('WP2-65 被拒 → 原样交回 {error, code}；现状不向界面广播（被拒只交给父会话，与 IPC 的 steer 不同）', async () => {
    openSession(async () => ({ error: 'busy text', code: 'busy' }))
    expect(await chatGateway.steerDriven('c1', 'm', DRIVE)).toStrictEqual({
      error: 'busy text',
      code: 'busy'
    })
    await flush()
    expect(mocks.frontendBroadcast).not.toHaveBeenCalled()
  })

  it.each([
    ['an Error', new Error('x'), 'x'],
    ['a string', 'y', 'y']
  ] as const)(
    'WP2-66 admitSteer throws %s → {error}, no code, never rejects',
    async (_label, thrown, text) => {
      openSession(async () => {
        throw thrown
      })
      await expect(chatGateway.steerDriven('c1', 'm', DRIVE)).resolves.toStrictEqual({
        error: text
      })
    }
  )

  // XS-59 驱动方不是 target 的父会话（经会话权限表被授权的别的会话，2026-10-20）→ 来源记成 {kind:'session'}；
  // 判据是 sessionRecords.drivingSourceOf（target 的直接 parentId），没有 title
  it.each([
    ['c1（P1 的子会话）被别的会话 X 插话', 'c1', 'X'],
    ['顶层会话 t1 被 P1 插话', 't1', 'P1'],
    ['行已不在的会话被 P1 插话', 'ghost', 'P1']
  ] as const)(
    'XS-59 %s → admitSteer 的来源是 {kind: session, sessionId: <driver>}',
    async (_label, target, driver) => {
      const session = openSession(async () => ({ submissionId: 4 }))
      const drive = { requestId: `session-steer:${driver}:1`, parentId: driver }
      expect(await chatGateway.steerDriven(target, 'm', drive)).toStrictEqual({})
      expect(session.admitSteer.mock.calls).toStrictEqual([
        ['m', { requestId: drive.requestId, source: { kind: 'session', sessionId: driver } }]
      ])
      expect(mocks.getAgentSession).toHaveBeenCalledWith(target)
    }
  )

  it('XS-59 [guard] 同一条 c1 由它的父会话 P1 插话 → 仍是 parent-session（WP2-64 的对照面）', async () => {
    const session = openSession(async () => ({ submissionId: 5 }))
    expect(await chatGateway.steerDriven('c1', 'm', DRIVE)).toStrictEqual({})
    expect(session.admitSteer.mock.calls[0]?.[1]).toStrictEqual({
      requestId: DRIVE.requestId,
      source: { kind: 'parent-session', sessionId: 'P1' }
    })
  })

  it('WP2-67 IPC 的 steer 照旧走 session.steer(text)，不经 admitSteer；被拒广播 error', async () => {
    const session = openSession(async () => ({}))
    session.steer.mockRejectedValueOnce(new Error('The conversation is closed'))
    chatGateway.steer('c1', 'm')
    await flush()
    expect(session.steer.mock.calls).toStrictEqual([['m']])
    expect(session.admitSteer).not.toHaveBeenCalled()
    expect(mocks.frontendBroadcast).toHaveBeenCalledWith({
      type: 'error',
      sessionId: 'c1',
      error: 'The conversation is closed'
    })
  })
})

describe('WP2-78 前端拿不到写来源 / 答题方的口子（读源码）', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  /** `…/src/main/frontend/core/__tests__` 往上三层 = `src/main` */
  const MAIN = resolve(HERE, '../../..')
  const FILES = ['ipc/agentHandlers.ts', 'frontend/chrome/channel.ts']

  function parse(file: string): ts.SourceFile {
    const source = readFileSync(resolve(MAIN, file), 'utf8')
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  }

  function callsIn(node: ts.Node): ts.CallExpression[] {
    const found: ts.CallExpression[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) found.push(n)
      ts.forEachChild(n, visit)
    }
    visit(node)
    return found
  }

  function calleeName(call: ts.CallExpression): string | undefined {
    const callee = call.expression
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text
    if (ts.isIdentifier(callee)) return callee.text
    return undefined
  }

  function receiverText(call: ts.CallExpression, file: ts.SourceFile): string {
    const callee = call.expression
    return ts.isPropertyAccessExpression(callee) ? callee.expression.getText(file) : ''
  }

  it.each(FILES)(
    '%s：chatGateway.prompt 从不传第 5 个参数（drive），也从不调 steerDriven / admitSteer',
    (file) => {
      const sourceFile = parse(file)
      const calls = callsIn(sourceFile)
      const prompts = calls.filter(
        (call) => calleeName(call) === 'prompt' && receiverText(call, sourceFile) === 'chatGateway'
      )
      expect(prompts.length).toBeGreaterThan(0)
      for (const call of prompts) expect(call.arguments.length).toBeLessThanOrEqual(4)
      for (const call of calls) {
        expect(['steerDriven', 'admitSteer']).not.toContain(calleeName(call))
      }
      // 连名字都不出现（不只是调用 —— 也不许当成回调递出去）
      expect(sourceFile.getText()).not.toMatch(/steerDriven|admitSteer/)
    }
  )

  it.each(FILES)(
    '%s：respondToInput 的附带信息只由 {clientId: …} 字面量构成，不展开渲染端参数',
    (file) => {
      const sourceFile = parse(file)
      const responds = callsIn(sourceFile).filter((call) => calleeName(call) === 'respondToInput')
      expect(responds.length).toBeGreaterThan(0)
      for (const call of responds) {
        const meta = call.arguments.at(-1)!
        expect(ts.isObjectLiteralExpression(meta), meta.getText(sourceFile)).toBe(true)
        const properties = (meta as ts.ObjectLiteralExpression).properties
        expect(properties.map((p) => (p.name ? p.name.getText(sourceFile) : p.kind))).toEqual([
          'clientId'
        ])
        expect(ts.isPropertyAssignment(properties[0]!)).toBe(true)
      }
      expect(sourceFile.getText()).not.toMatch(/answeredBy/)
    }
  )
})

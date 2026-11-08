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
 *   GW-1   发送方（sessionSender.ts）：驱动方的标题进说明和 token.name，不进来源；target 的 parentId 等于驱动方 →
 *          "your parent session"，否则 "another session"；读不到标题 → 没有标题、不抛
 *   WP2-67 IPC 的 steer 照旧：`session.steer(text, 来源)`，不经 admitSteer（不在任何操作上下文里 → 来源 undefined）；
 *          被拒广播 error
 *   WP2-80 steer / followUp 的来源按这次操作的上下文盖章（2026-10-21）：网络客户端 → remote、Chrome → chrome、
 *          不在上下文里 → undefined；steerDriven 在网络客户端的上下文里照样记驱动它的会话（不被连接的章顶替）
 *   WP2-78 前端拿不到写来源 / 答题方的口子（读源码）：IPC 与 Chrome 通道从不传 drive（第 5 个参数没有、或是字面量
 *          `undefined`；第 6 个只能是载荷的 secrets，§14）、从不调 steerDriven / admitSteer，respondToInput 的附带信息
 *          只由 `{clientId: …}` 字面量构成
 *   WP2-78b 同上，输入来源那一面：`chatGateway.steer` / `followUp` 是 (sessionId, text) 加载荷的 secrets；每个 `continueTask({…})` 的
 *          来源是 `origin: inputOriginOfClient(ctx)`（不展开渲染端参数）；源码里没有 params / p 的 origin / source
 *
 * mock 骨架照抄 chatGatewayPrompt.test.ts；operationContext 用真的（WP2-80）。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { withSessionSender } from '@shuvix/chat-protocol/sessionSender'
import { withUserWords } from '@shuvix/chat-protocol/userWords'
import type { ClientContext } from '../../../ipc/registry'
import {
  createChromeContext,
  createClientContext,
  operationContext
} from '../../../utils/operationContext'

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
      id === 'c1'
        ? { parentId: 'P1' }
        : id === 't1'
          ? { parentId: null }
          : // GW-1：TP 有标题，c9 是它的子会话
            id === 'c9'
            ? { parentId: 'TP' }
            : id === 'TP'
              ? { parentId: null, title: '重构 "parser"' }
              : undefined
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
const PARENT_SOURCE = { kind: 'parent-session', sessionId: 'P1' } as const

/** admitSteer 该收到的参数：模型文本与侧车都带发送方（sessionSender.ts），来源原样 */
function steerCall(
  requestId: string,
  source: { kind: 'parent-session' | 'session'; sessionId: string }
): [string, Record<string, unknown>] {
  const sent = withSessionSender('m', undefined, source)
  return [sent.text, { requestId, source, display: sent.display }]
}

/** 一条打开着的会话的替身：只有 steer / admitSteer / followUp 三样 */
function openSession(admitSteer: () => Promise<unknown>): {
  admitSteer: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  followUp: ReturnType<typeof vi.fn>
} {
  const session = {
    admitSteer: vi.fn(admitSteer),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {})
  }
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
      steerCall('subsession-steer:P1:9', PARENT_SOURCE)
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
        steerCall(drive.requestId, { kind: 'session', sessionId: driver })
      ])
      expect(mocks.getAgentSession).toHaveBeenCalledWith(target)
    }
  )

  it('XS-59 [guard] 同一条 c1 由它的父会话 P1 插话 → 仍是 parent-session（WP2-64 的对照面）', async () => {
    const session = openSession(async () => ({ submissionId: 5 }))
    expect(await chatGateway.steerDriven('c1', 'm', DRIVE)).toStrictEqual({})
    expect(session.admitSteer.mock.calls[0]).toStrictEqual(
      steerCall(DRIVE.requestId, PARENT_SOURCE)
    )
  })

  it('WP2-67 IPC 的 steer 照旧走 session.steer(text, 来源)，不经 admitSteer；被拒广播 error', async () => {
    const session = openSession(async () => ({}))
    session.steer.mockRejectedValueOnce(new Error('The conversation is closed'))
    chatGateway.steer('c1', 'm')
    await flush()
    // 不在任何操作上下文里 → 没有来源
    expect(session.steer.mock.calls).toStrictEqual([['m', undefined, undefined]])
    expect(session.admitSteer).not.toHaveBeenCalled()
    expect(mocks.frontendBroadcast).toHaveBeenCalledWith({
      type: 'error',
      sessionId: 'c1',
      error: 'The conversation is closed'
    })
  })
})

describe('UW-G2 steerDriven 带用户原话', () => {
  it('原文 + 引用块 + 发送方说明；侧车两枚 Token；来源照旧', async () => {
    const session = openSession(async () => ({ submissionId: 1 }))
    const quote = {
      sessionId: 'P1',
      scope: 'since-last' as const,
      words: [{ kind: 'message' as const, ts: 5, text: '补充：列名叫 stockValue' }],
      omitted: 0
    }
    expect(await chatGateway.steerDriven('c1', 'm', { ...DRIVE, userWords: quote })).toStrictEqual(
      {}
    )
    const quoted = withUserWords('m', undefined, quote)
    const sent = withSessionSender(quoted.text, quoted.display, PARENT_SOURCE, { userWords: true })
    expect(session.admitSteer.mock.calls[0]).toStrictEqual([
      sent.text,
      { requestId: DRIVE.requestId, source: PARENT_SOURCE, display: sent.display }
    ])
    expect(Object.keys((sent.display as { tokens: object }).tokens).sort()).toEqual([
      'sender',
      'userwords'
    ])
  })
})

describe('GW-1 steerDriven 的发送方', () => {
  const steerTo = async (
    target: string,
    driver: string
  ): Promise<{ text: string; options: Record<string, never> }> => {
    const session = openSession(async () => ({ submissionId: 1 }))
    const drive = { requestId: `session-steer:${driver}:1`, parentId: driver }
    expect(await chatGateway.steerDriven(target, 'm', drive)).toStrictEqual({})
    expect(session.admitSteer).toHaveBeenCalledTimes(1)
    const [text, options] = session.admitSteer.mock.calls[0]!
    return { text, options } as { text: string; options: Record<string, never> }
  }
  const tokenOf = (options: Record<string, never>): Record<string, unknown> =>
    (options as unknown as { display: { tokens: { sender: Record<string, unknown> } } }).display
      .tokens.sender

  it('标题进说明与 token.name（说明里的双引号换成单引号），不进来源', async () => {
    const { text, options } = await steerTo('c9', 'TP')
    expect(text.startsWith(`m\n\n[Sent by your parent session (id TP — "重构 'parser'"). `)).toBe(
      true
    )
    expect(tokenOf(options).name).toBe('重构 "parser"')
    expect(tokenOf(options).id).toBe('TP')
    expect(options.source).toStrictEqual({ kind: 'parent-session', sessionId: 'TP' })
  })

  it('target 的 parentId 不是驱动方 → another session', async () => {
    const { text, options } = await steerTo('t1', 'TP')
    expect(text.startsWith(`m\n\n[Sent by another session (id TP — "重构 'parser'"). `)).toBe(true)
    expect(options.source).toStrictEqual({ kind: 'session', sessionId: 'TP' })
  })

  it('target 的 parentId 等于驱动方 → your parent session，驱动方没有标题也一样', async () => {
    const { text } = await steerTo('c1', 'P1')
    expect(text.startsWith('m\n\n[Sent by your parent session (id P1). ')).toBe(true)
  })

  it('读不到驱动方的行（pick 为 undefined）→ 没有标题、token.name 退回 id、不抛', async () => {
    const { text, options } = await steerTo('t1', 'gone')
    expect(text.startsWith('m\n\n[Sent by another session (id gone). ')).toBe(true)
    expect(text).not.toContain(' — "')
    expect(tokenOf(options).name).toBe('gone')
    expect(options.source).toStrictEqual({ kind: 'session', sessionId: 'gone' })
  })
})

describe('WP2-80 steer / followUp 的来源按操作上下文盖章', () => {
  const netCtx: ClientContext = {
    client: { kind: 'network', id: 'ws:4', remoteAddress: '192.168.1.20', userAgent: 'UA' },
    transport: 'network'
  }
  const REMOTE = {
    kind: 'remote',
    clientId: 'ws:4',
    address: '192.168.1.20',
    userAgent: 'UA'
  } as const

  it('WP2-80 网络客户端的上下文里 steer → session.steer(text, remote)，不经 admitSteer', async () => {
    const session = openSession(async () => ({}))
    operationContext.run(createClientContext(netCtx, 'c1'), () => chatGateway.steer('c1', 'm'))
    await flush()
    expect(session.steer.mock.calls).toStrictEqual([['m', REMOTE, undefined]])
    expect(session.admitSteer).not.toHaveBeenCalled()
    expect(session.followUp).not.toHaveBeenCalled()
  })

  it('WP2-80 Chrome 的上下文里 followUp → session.followUp(text, chrome)；不在上下文里 → 来源 undefined', async () => {
    const session = openSession(async () => ({}))
    operationContext.run(createChromeContext('inst-1', 'c1'), () => chatGateway.followUp('c1', 'f'))
    await flush()
    expect(session.followUp.mock.calls).toStrictEqual([
      ['f', { kind: 'chrome', installId: 'inst-1' }, undefined]
    ])
    session.followUp.mockClear()
    chatGateway.followUp('c1', 'f')
    await flush()
    expect(session.followUp.mock.calls).toStrictEqual([['f', undefined, undefined]])
    expect(session.steer).not.toHaveBeenCalled()
  })

  it('WP2-80 steerDriven 在网络客户端的上下文里 → admitSteer 的来源仍是驱动它的父会话（不是连接的章）', async () => {
    const session = openSession(async () => ({ submissionId: 6 }))
    const result = await operationContext.run(createClientContext(netCtx, 'c1'), () =>
      chatGateway.steerDriven('c1', 'm', DRIVE)
    )
    expect(result).toStrictEqual({})
    expect(session.admitSteer.mock.calls).toStrictEqual([steerCall(DRIVE.requestId, PARENT_SOURCE)])
    expect(session.steer).not.toHaveBeenCalled()
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
      for (const call of prompts) {
        const text = call.getText(sourceFile)
        expect(call.arguments.length, text).toBeLessThanOrEqual(6)
        // 第 5 个（drive）：没有，或是字面量 undefined；第 6 个只能是载荷的 secrets（输入框要藏的值）
        if (call.arguments.length >= 5)
          expect(call.arguments[4]!.getText(sourceFile), text).toBe('undefined')
        if (call.arguments.length === 6) {
          expect(call.arguments[5]!.getText(sourceFile), text).toMatch(/^(params|p)\.secrets$/)
        }
      }
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

  it.each(FILES)(
    'WP2-78b %s：chatGateway.steer / followUp 是 (sessionId, text, 载荷的 secrets)（来源不经参数递进去）',
    (file) => {
      const sourceFile = parse(file)
      const queued = callsIn(sourceFile).filter(
        (call) =>
          ['steer', 'followUp'].includes(calleeName(call) ?? '') &&
          receiverText(call, sourceFile) === 'chatGateway'
      )
      expect(queued.map((call) => calleeName(call)).sort()).toEqual(['followUp', 'steer'])
      for (const call of queued) {
        expect(call.arguments.length, call.getText(sourceFile)).toBe(3)
        expect(call.arguments[2]!.getText(sourceFile)).toMatch(/^(params|p)\.secrets$/)
      }
    }
  )

  it('WP2-78b 每个 continueTask({…}) 的来源恰是 origin: inputOriginOfClient(ctx)，字面量里不展开别的东西', () => {
    let seen = 0
    for (const file of FILES) {
      const sourceFile = parse(file)
      for (const call of callsIn(sourceFile).filter((c) => calleeName(c) === 'continueTask')) {
        seen++
        expect(call.arguments).toHaveLength(1)
        const arg = call.arguments[0]!
        expect(ts.isObjectLiteralExpression(arg), arg.getText(sourceFile)).toBe(true)
        const properties = (arg as ts.ObjectLiteralExpression).properties
        for (const property of properties) expect(ts.isPropertyAssignment(property)).toBe(true)
        const origin = properties.find((p) => p.name?.getText(sourceFile) === 'origin')
        expect(origin, `${file}: continueTask without origin`).toBeDefined()
        expect((origin as ts.PropertyAssignment).initializer.getText(sourceFile)).toBe(
          'inputOriginOfClient(ctx)'
        )
      }
    }
    // 不是空跑：agentHandlers 里那一处（agent:subAgentPrompt）确实读到了
    expect(seen).toBeGreaterThan(0)
  })

  it.each(FILES)('WP2-78b %s：源码里没有渲染端参数的 origin / source', (file) => {
    const text = parse(file).getText()
    for (const forbidden of ['params.origin', 'params.source', 'p.origin', 'p.source']) {
      expect(text).not.toContain(forbidden)
    }
  })
})

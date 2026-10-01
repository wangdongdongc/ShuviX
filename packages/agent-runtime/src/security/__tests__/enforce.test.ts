/**
 * executeDecision（PEP 共享内脏）—— 三态处置、询问四分支响应、
 * 「允许并记住」与决策日志。错误文案逐字对齐 enforce.ts 内四个文案函数。
 * 末尾一组是询问点的自动审查（onPermissionRequest 接缝，EN-RV 系列）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeDecision } from '../enforce'
import { clearSessionDecisions, getSessionDecisions } from '../decisionLog'
import {
  abortSessionReviews,
  clearReviewState,
  humanFeedbackOf,
  reopenSessionReviews,
  reviewSuspended
} from '../reviewState'
import type {
  AskInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type {
  PermissionDecision,
  PermissionVerdict
} from '@shuvix/chat-protocol/types/permissionReview'
import type {
  EnforceOpts,
  EnforceOutcome,
  PermissionRequestEvent,
  PermissionReviewAnswer,
  SecurityDecision,
  SecurityDecisionRecord,
  SecurityHostProvider,
  SecurityObject,
  SecurityRequest
} from '../types'

const SID = 'enforce-test-session'

const PATH_OBJECT: SecurityObject = { type: 'path', path: '/ws/file.txt' }
const COMMAND_OBJECT: SecurityObject = { type: 'command', channel: 'bash', command: 'ls -la' }
const GITOP_OBJECT: SecurityObject = {
  type: 'gitTool',
  gitAction: 'init',
  command: 'git init',
  force: false,
  delete: false
}

const databaseObject = (sql: string): SecurityObject => ({
  type: 'database',
  sql,
  credential: 'prod-mysql',
  dbType: 'mysql',
  readonly: false
})

function makeRequest(overrides: Partial<SecurityRequest> = {}): SecurityRequest {
  return {
    subject: { kind: 'agent', sessionId: SID, agentKind: 'root' },
    action: 'read',
    object: PATH_OBJECT,
    environment: { host: 'desktop' },
    ...overrides
  }
}

function makeProvider(overrides: Partial<SecurityHostProvider> = {}): SecurityHostProvider {
  return {
    host: 'desktop',
    pathSep: '/',
    getVars: () => ({}),
    getSessionGrants: () => ({ allowList: [] }),
    ...overrides
  }
}

/** requestUserInput 固定应答的 provider（含 mock 引用与 persistGrant spy） */
function askProvider(
  response: InputResponse,
  overrides: Partial<SecurityHostProvider> = {}
): {
  provider: SecurityHostProvider
  requestUserInput: ReturnType<typeof vi.fn>
  persistGrant: ReturnType<typeof vi.fn>
} {
  const requestUserInput = vi.fn(async (_req: InputRequest): Promise<InputResponse> => response)
  const persistGrant = vi.fn()
  return {
    provider: makeProvider({ requestUserInput, persistGrant, ...overrides }),
    requestUserInput,
    persistGrant
  }
}

function makeOpts(overrides: Partial<EnforceOpts> = {}): EnforceOpts {
  return { toolCallId: 'tc-1', toolName: 'read', ...overrides }
}

const ALLOW: SecurityDecision = { effect: 'allow', matched: ['r1'], winning: 'r1' }
const denyDecision = (reason?: string, prompt?: SecurityDecision['prompt']): SecurityDecision => ({
  effect: 'deny',
  matched: ['d1'],
  winning: 'd1',
  reason,
  prompt
})
const askDecision = (
  ask?: SecurityDecision['ask'],
  prompt?: SecurityDecision['prompt']
): SecurityDecision => ({
  effect: 'ask',
  matched: ['a1'],
  winning: 'a1',
  ask,
  prompt
})

/** 命中规则的人读提示语（evaluate 的 collectPrompt 产物形态） */
const PROMPT: NonNullable<SecurityDecision['prompt']> = {
  text: 'Writing replaces what is on disk. Check the target path and the diff before allowing.',
  rules: ['ask-on-write#0'],
  policies: ['Ask Before Writing a File']
}
const PATH_ASK = askDecision({ command: 'Read(/ws/file.txt)', rememberEntry: 'Read(/ws/file.txt)' })

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected the promise to reject')
}

afterEach(() => clearSessionDecisions(SID))

describe('executeDecision — allow / deny', () => {
  it('EN-1 allow → allowed；不弹询问；日志一条且无 userResponse/totalMs', async () => {
    const { provider, requestUserInput } = askProvider({ kind: 'ask', allowed: true })
    const outcome = await executeDecision({
      provider,
      request: makeRequest(),
      decision: ALLOW,
      opts: makeOpts(),
      evaluateMs: 2
    })
    expect(outcome).toEqual({ status: 'allowed' })
    expect(requestUserInput).not.toHaveBeenCalled()

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      effect: 'allow',
      matched: ['r1'],
      winning: 'r1',
      evaluateMs: 2
    })
    expect(logs[0].userResponse).toBeUndefined()
    expect(logs[0].totalMs).toBeUndefined()
  })

  it('EN-2 deny → throw decision.reason；无 reason 时 Access denied: <display>（displayPath 优先）；记日志', async () => {
    const run = (decision: SecurityDecision, opts: EnforceOpts): Promise<unknown> =>
      executeDecision({
        provider: makeProvider(),
        request: makeRequest(),
        decision,
        opts,
        evaluateMs: 0
      })

    expect(
      await rejectionMessage(run(denyDecision("Denied by security policy rule 'd1'"), makeOpts()))
    ).toBe("Denied by security policy rule 'd1'")
    expect(
      await rejectionMessage(run(denyDecision(), makeOpts({ displayPath: 'rel/file.txt' })))
    ).toBe('Access denied: rel/file.txt')
    expect(await rejectionMessage(run(denyDecision(), makeOpts()))).toBe(
      'Access denied: /ws/file.txt'
    )

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(3)
    expect(logs[0].effect).toBe('deny')
    expect(logs[0].userResponse).toBeUndefined()
  })

  it('EN-P1 deny + prompt → throw `<reason>\\n\\n<prompt.text>`；无 reason 时归因文案照样拼接', async () => {
    const run = (decision: SecurityDecision, opts: EnforceOpts): Promise<unknown> =>
      executeDecision({
        provider: makeProvider(),
        request: makeRequest(),
        decision,
        opts,
        evaluateMs: 0
      })

    // deny 不弹卡片，抛出的工具错误是这段文案唯一的露出面（agent 与用户看到同一段）
    expect(
      await rejectionMessage(
        run(denyDecision("Denied by security policy rule 'd1'", PROMPT), makeOpts())
      )
    ).toBe(`Denied by security policy rule 'd1'\n\n${PROMPT.text}`)

    expect(
      await rejectionMessage(
        run(denyDecision(undefined, PROMPT), makeOpts({ displayPath: 'rel/file.txt' }))
      )
    ).toBe(`Access denied: rel/file.txt\n\n${PROMPT.text}`)
  })

  it('EN-P2 deny 无 prompt → 文案与从前逐字一致（无尾随空行/分隔符）', async () => {
    const message = await rejectionMessage(
      executeDecision({
        provider: makeProvider(),
        request: makeRequest(),
        decision: denyDecision("Denied by security policy rule 'd1'"),
        opts: makeOpts(),
        evaluateMs: 0
      })
    )
    expect(message).toBe("Denied by security policy rule 'd1'")
    expect(message).not.toContain('\n')
  })
})

describe('executeDecision — ask 无询问通道', () => {
  it('EN-3 缺省 fail-closed：path/command/gitTool 各自文案；记日志', async () => {
    const run = (request: SecurityRequest, decision: SecurityDecision): Promise<unknown> =>
      executeDecision({
        provider: makeProvider(),
        request,
        decision,
        opts: makeOpts(),
        evaluateMs: 0
      })

    expect(await rejectionMessage(run(makeRequest(), PATH_ASK))).toBe(
      'Access denied: path outside workspace and no way to ask: /ws/file.txt'
    )
    expect(
      await rejectionMessage(
        run(
          makeRequest({ action: 'execute', object: COMMAND_OBJECT }),
          askDecision({ command: 'ls -la' })
        )
      )
    ).toBe('Access denied: this needs your confirmation but there is no way to ask: ls -la')
    expect(
      await rejectionMessage(
        run(
          makeRequest({ action: 'execute', object: GITOP_OBJECT }),
          askDecision({ command: 'git init' })
        )
      )
    ).toBe('Access denied: this needs your confirmation but there is no way to ask: git init')

    expect(getSessionDecisions(SID)).toHaveLength(3)
    expect(getSessionDecisions(SID)[0].effect).toBe('ask')
  })

  it('EN-4 missingChannel:allow → 放行并记日志（迁移过渡语义）', async () => {
    const outcome = await executeDecision({
      provider: makeProvider(),
      request: makeRequest(),
      decision: PATH_ASK,
      opts: makeOpts({ missingChannel: 'allow' }),
      evaluateMs: 0
    })
    expect(outcome).toEqual({ status: 'allowed' })
    expect(getSessionDecisions(SID)).toHaveLength(1)
  })

  it('EN-P6 无询问通道：fail-closed 文案不含 prompt；missingChannel:allow 放行且 prompt 不出现在任何出口', async () => {
    const withPrompt = askDecision(
      { command: 'Read(/ws/file.txt)', rememberEntry: 'Read(/ws/file.txt)' },
      PROMPT
    )

    // 提示语是给用户在卡片上就地判断用的；没有卡片可弹时它无处可去，文案保持原样
    expect(
      await rejectionMessage(
        executeDecision({
          provider: makeProvider(),
          request: makeRequest(),
          decision: withPrompt,
          opts: makeOpts(),
          evaluateMs: 0
        })
      )
    ).toBe('Access denied: path outside workspace and no way to ask: /ws/file.txt')

    const outcome = await executeDecision({
      provider: makeProvider(),
      request: makeRequest(),
      decision: withPrompt,
      opts: makeOpts({ missingChannel: 'allow' }),
      evaluateMs: 0
    })
    expect(outcome).toEqual({ status: 'allowed' })
    // 放行分支没有任何文本出口 —— 决策日志里也不该出现提示语
    expect(JSON.stringify(getSessionDecisions(SID))).not.toContain(PROMPT.text)
  })
})

describe('executeDecision — 询问响应四分支', () => {
  it('EN-5 cancel → throw abortError（缺省 Aborted）；日志 cancel 且 totalMs 有值', async () => {
    const { provider } = askProvider({ kind: 'cancel', reason: 'aborted' })
    const run = (opts: EnforceOpts): Promise<unknown> =>
      executeDecision({ provider, request: makeRequest(), decision: PATH_ASK, opts, evaluateMs: 0 })

    expect(await rejectionMessage(run(makeOpts()))).toBe('Aborted')
    expect(await rejectionMessage(run(makeOpts({ abortError: 'TOOL_ABORTED' })))).toBe(
      'TOOL_ABORTED'
    )

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(2)
    expect(logs[0].userResponse).toBe('cancel')
    expect(typeof logs[0].totalMs).toBe('number')
  })

  it('EN-6 other：缺省 throw（declined + 反馈文本）；onOther:return → feedback 结果；日志 feedback', async () => {
    const { provider } = askProvider({ kind: 'other', text: 'use another file' })

    expect(
      await rejectionMessage(
        executeDecision({
          provider,
          request: makeRequest(),
          decision: PATH_ASK,
          opts: makeOpts(),
          evaluateMs: 0
        })
      )
    ).toBe('User declined access to /ws/file.txt and provided feedback instead: use another file')

    const outcome = await executeDecision({
      provider,
      request: makeRequest({ action: 'execute', object: COMMAND_OBJECT }),
      decision: askDecision({ command: 'ls -la' }),
      opts: makeOpts({ onOther: 'return' }),
      evaluateMs: 0
    })
    expect(outcome).toEqual({ status: 'feedback', text: 'use another file' })

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(2)
    expect(logs[0].userResponse).toBe('feedback')
    expect(logs[1].userResponse).toBe('feedback')
  })

  it('EN-6 other 非 path 客体文案：User declined <命令> ...', async () => {
    const { provider } = askProvider({ kind: 'other', text: 'no' })
    expect(
      await rejectionMessage(
        executeDecision({
          provider,
          request: makeRequest({ action: 'execute', object: COMMAND_OBJECT }),
          decision: askDecision({ command: 'ls -la' }),
          opts: makeOpts(),
          evaluateMs: 0
        })
      )
    ).toBe('User declined ls -la and provided feedback instead: no')
  })

  it('EN-7 denied：response.reason 优先；否则按客体默认文案逐字；choice 响应同走 denied；日志 denied', async () => {
    const run = (
      response: InputResponse,
      request: SecurityRequest,
      decision: SecurityDecision
    ): Promise<string> =>
      rejectionMessage(
        executeDecision({
          provider: askProvider(response).provider,
          request,
          decision,
          opts: makeOpts(),
          evaluateMs: 0
        })
      )

    expect(
      await run({ kind: 'ask', allowed: false, reason: 'custom reason' }, makeRequest(), PATH_ASK)
    ).toBe('custom reason')
    expect(await run({ kind: 'ask', allowed: false }, makeRequest(), PATH_ASK)).toBe(
      'User denied access to /ws/file.txt'
    )
    expect(
      await run(
        { kind: 'ask', allowed: false },
        makeRequest({ action: 'execute', object: COMMAND_OBJECT }),
        askDecision({ command: 'ls -la' })
      )
    ).toBe('User denied execution of this command')
    expect(
      await run(
        { kind: 'ask', allowed: false },
        makeRequest({ action: 'execute', object: GITOP_OBJECT }),
        askDecision({ command: 'git init' })
      )
    ).toBe('User denied git init')
    // 非 ask kind（choice）同走 denied 分支
    expect(await run({ kind: 'choice', selections: ['x'] }, makeRequest(), PATH_ASK)).toBe(
      'User denied access to /ws/file.txt'
    )

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(5)
    for (const log of logs) expect(log.userResponse).toBe('denied')
  })

  it('EN-P5 三种否定分支的回话文案都不含 prompt（询问文本只到卡片为止，不进 agent 上下文）', async () => {
    const decision = askDecision(
      { command: 'Read(/ws/file.txt)', rememberEntry: 'Read(/ws/file.txt)' },
      PROMPT
    )
    const run = (response: InputResponse, opts = makeOpts()): Promise<EnforceOutcome> =>
      executeDecision({
        provider: askProvider(response).provider,
        request: makeRequest(),
        decision,
        opts,
        evaluateMs: 0
      })

    // denied：默认文案与 response.reason 优先两支
    expect(await rejectionMessage(run({ kind: 'ask', allowed: false }))).toBe(
      'User denied access to /ws/file.txt'
    )
    expect(
      await rejectionMessage(run({ kind: 'ask', allowed: false, reason: 'custom reason' }))
    ).toBe('custom reason')

    // other（throw 文案）
    expect(await rejectionMessage(run({ kind: 'other', text: 'use another file' }))).toBe(
      'User declined access to /ws/file.txt and provided feedback instead: use another file'
    )

    // cancel（abortError）
    expect(await rejectionMessage(run({ kind: 'cancel', reason: 'aborted' }))).toBe('Aborted')

    // onOther:'return' 的 feedback 文本只有用户输入
    expect(
      await run({ kind: 'other', text: 'use another file' }, makeOpts({ onOther: 'return' }))
    ).toEqual({ status: 'feedback', text: 'use another file' })
  })
})

describe('executeDecision — 允许与「记住」', () => {
  it('EN-8 allowed+remember → persistGrant 按 action 定 mode；日志 allowed_remember', async () => {
    const writeCase = askProvider({
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: true }
    })
    await executeDecision({
      provider: writeCase.provider,
      request: makeRequest({ action: 'write' }),
      decision: askDecision({
        command: 'Write(/ws/file.txt)',
        rememberEntry: 'Write(/ws/file.txt)'
      }),
      opts: makeOpts(),
      evaluateMs: 0
    })
    expect(writeCase.persistGrant).toHaveBeenCalledWith('write', '/ws/file.txt')

    const readCase = askProvider({
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: true }
    })
    await executeDecision({
      provider: readCase.provider,
      request: makeRequest({ action: 'read' }),
      decision: PATH_ASK,
      opts: makeOpts(),
      evaluateMs: 0
    })
    expect(readCase.persistGrant).toHaveBeenCalledWith('read', '/ws/file.txt')

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(2)
    expect(logs[0].userResponse).toBe('allowed_remember')
    expect(logs[1].userResponse).toBe('allowed_remember')
  })

  it('EN-9 command 客体带 rememberPath:true → 不调 persistGrant（无 rememberEntry 材料）；日志 allowed', async () => {
    const { provider, persistGrant } = askProvider({
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: true }
    })
    const outcome = await executeDecision({
      provider,
      request: makeRequest({ action: 'execute', object: COMMAND_OBJECT }),
      decision: askDecision({ command: 'ls -la' }), // command 恒无 rememberEntry
      opts: makeOpts(),
      evaluateMs: 0
    })
    expect(outcome).toEqual({ status: 'allowed' })
    expect(persistGrant).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)[0].userResponse).toBe('allowed')
  })

  it('EN-10 allowed 无 remember → 不调 persistGrant；日志 allowed', async () => {
    const { provider, persistGrant } = askProvider({ kind: 'ask', allowed: true })
    await executeDecision({
      provider,
      request: makeRequest(),
      decision: PATH_ASK,
      opts: makeOpts(),
      evaluateMs: 0
    })
    expect(persistGrant).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)[0].userResponse).toBe('allowed')
  })

  it('EN-14 省略 persistGrant 时 remember 分支不炸', async () => {
    const requestUserInput = vi.fn(
      async (): Promise<InputResponse> => ({
        kind: 'ask',
        allowed: true,
        extra: { rememberPath: true }
      })
    )
    const outcome = await executeDecision({
      provider: makeProvider({ requestUserInput }),
      request: makeRequest(),
      decision: PATH_ASK,
      opts: makeOpts(),
      evaluateMs: 0
    })
    expect(outcome).toEqual({ status: 'allowed' })
    expect(getSessionDecisions(SID)[0].userResponse).toBe('allowed_remember')
  })
})

describe('executeDecision — InputRequest 构造与目录探测', () => {
  it('EN-11 id=toolCallId、kind=ask、command=decision.ask.command、description/preview 透传', async () => {
    const { provider, requestUserInput } = askProvider({ kind: 'ask', allowed: true })
    const preview = { kind: 'diff' as const, path: 'file.txt', diff: '+new line' }
    await executeDecision({
      provider,
      request: makeRequest({ action: 'write' }),
      decision: askDecision({
        command: 'Write(/ws/file.txt)',
        rememberEntry: 'Write(/ws/file.txt)'
      }),
      opts: makeOpts({ toolCallId: 'tc-42', toolName: 'write', description: 'the desc', preview }),
      evaluateMs: 0
    })
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tc-42',
        kind: 'ask',
        toolName: 'write',
        command: 'Write(/ws/file.txt)',
        description: 'the desc',
        preview
      })
    )
  })

  it('EN-P3 ask + prompt → policyPrompt={text, policies}（**不含 rules**）；其余字段不变', async () => {
    const { provider, requestUserInput } = askProvider({ kind: 'ask', allowed: true })
    const preview = { kind: 'diff' as const, path: 'file.txt', diff: '+new line' }
    await executeDecision({
      provider,
      request: makeRequest({ action: 'write' }),
      decision: askDecision(
        { command: 'Write(/ws/file.txt)', rememberEntry: 'Write(/ws/file.txt)' },
        PROMPT
      ),
      opts: makeOpts({ toolCallId: 'tc-42', toolName: 'write', description: 'the desc', preview }),
      evaluateMs: 0
    })

    const request = requestUserInput.mock.calls[0][0] as InputRequest & {
      policyPrompt?: Record<string, unknown>
    }
    // 卡片要的是「说了什么 + 谁在说」；规则 id 是决策归因，属于日志面
    expect(request.policyPrompt).toEqual({ text: PROMPT.text, policies: PROMPT.policies })
    expect(request.policyPrompt).not.toHaveProperty('rules')
    expect(request).toMatchObject({
      id: 'tc-42',
      kind: 'ask',
      toolName: 'write',
      command: 'Write(/ws/file.txt)',
      description: 'the desc',
      preview
    })
  })

  it('EN-P4 ask 无 prompt → InputRequest 无 policyPrompt', async () => {
    const { provider, requestUserInput } = askProvider({ kind: 'ask', allowed: true })
    await executeDecision({
      provider,
      request: makeRequest(),
      decision: PATH_ASK,
      opts: makeOpts(),
      evaluateMs: 0
    })
    const request = requestUserInput.mock.calls[0][0] as InputRequest & { policyPrompt?: unknown }
    expect(request.policyPrompt).toBeUndefined()
  })

  it('EN-P7 决策日志形状不变：带 prompt 的 deny/ask 记录里没有 prompt 字段', async () => {
    const withPrompt = askDecision(
      { command: 'Read(/ws/file.txt)', rememberEntry: 'Read(/ws/file.txt)' },
      PROMPT
    )
    await executeDecision({
      provider: askProvider({ kind: 'ask', allowed: true }).provider,
      request: makeRequest(),
      decision: withPrompt,
      opts: makeOpts(),
      evaluateMs: 0
    })
    await rejectionMessage(
      executeDecision({
        provider: makeProvider(),
        request: makeRequest(),
        decision: denyDecision(undefined, PROMPT),
        opts: makeOpts(),
        evaluateMs: 0
      })
    )

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(2)
    for (const log of logs) {
      expect(log).not.toHaveProperty('prompt')
      expect(JSON.stringify(log)).not.toContain(PROMPT.text)
    }
  })

  it('EN-12 pathIsDirectory：path×read 探测（含 Promise 形态）；path×write 不探测；省略 → false', async () => {
    const askedWith = async (
      isDirectory: SecurityHostProvider['isDirectory'],
      action: string
    ): Promise<InputRequest> => {
      const { provider, requestUserInput } = askProvider(
        { kind: 'ask', allowed: true },
        { isDirectory }
      )
      await executeDecision({
        provider,
        request: makeRequest({ action }),
        decision: PATH_ASK,
        opts: makeOpts(),
        evaluateMs: 0
      })
      return requestUserInput.mock.calls[0][0] as InputRequest
    }

    const syncDir = vi.fn(() => true)
    const syncReq = await askedWith(syncDir, 'read')
    expect(syncDir).toHaveBeenCalledWith('/ws/file.txt')
    expect((syncReq as Extract<InputRequest, { kind: 'ask' }>).pathIsDirectory).toBe(true)

    const asyncReq = await askedWith(() => Promise.resolve(true), 'read')
    expect((asyncReq as Extract<InputRequest, { kind: 'ask' }>).pathIsDirectory).toBe(true)

    const writeDir = vi.fn(() => true)
    const writeReq = await askedWith(writeDir, 'write')
    expect(writeDir).not.toHaveBeenCalled()
    expect((writeReq as Extract<InputRequest, { kind: 'ask' }>).pathIsDirectory).toBe(false)

    const omittedReq = await askedWith(undefined, 'read')
    expect((omittedReq as Extract<InputRequest, { kind: 'ask' }>).pathIsDirectory).toBe(false)
  })

  it('EN-13 日志：命令截断 200 字符 / 路径不截断；subject 含 profileName+agentKind', async () => {
    const longCommand = 'x'.repeat(300)
    const longPath = `/ws/${'d'.repeat(250)}/file.txt`
    const subject = {
      kind: 'agent' as const,
      sessionId: SID,
      profileName: 'widget',
      agentKind: 'spawned' as const,
      depth: 1
    }

    await executeDecision({
      provider: makeProvider(),
      request: makeRequest({
        subject,
        action: 'execute',
        object: { type: 'command', channel: 'bash', command: longCommand }
      }),
      decision: ALLOW,
      opts: makeOpts(),
      evaluateMs: 0
    })
    await executeDecision({
      provider: makeProvider(),
      request: makeRequest({ subject, object: { type: 'path', path: longPath } }),
      decision: ALLOW,
      opts: makeOpts(),
      evaluateMs: 0
    })

    const logs = getSessionDecisions(SID)
    // 新→旧：logs[0] 是路径，logs[1] 是命令
    expect(logs[0].objectSummary).toBe(longPath)
    expect(logs[1].objectSummary).toBe('x'.repeat(200))
    expect(logs[0].subject).toEqual({ kind: 'agent', profileName: 'widget', agentKind: 'spawned' })
  })

  it('EN-13b database 日志：objectKind=database；长 SQL 截断 200 字符，短 SQL 原样', async () => {
    const longSql = `SELECT ${'s'.repeat(300)}`
    const shortSql = 'SELECT 1'

    for (const sql of [longSql, shortSql]) {
      await executeDecision({
        provider: makeProvider(),
        request: makeRequest({ action: 'execute', object: databaseObject(sql) }),
        decision: ALLOW,
        opts: makeOpts({ toolName: 'database' }),
        evaluateMs: 0
      })
    }

    const logs = getSessionDecisions(SID)
    // 新→旧：logs[0] 是短 SQL，logs[1] 是长 SQL
    expect(logs.map((l) => l.objectKind)).toEqual(['database', 'database'])
    expect(logs[0].objectSummary).toBe(shortSql)
    expect(logs[1].objectSummary).toBe(longSql.slice(0, 200))
    expect(logs[1].objectSummary).toHaveLength(200)
  })
})

describe('executeDecision — database 客体文案', () => {
  // 日志截断 200 字符，但给用户/AI 的文案取 SQL 原文（用超长 SQL 对照）
  const LONG_SQL = `DELETE FROM users WHERE note = '${'x'.repeat(300)}'`

  it('EN-15 拒绝 → User denied <sql 原文>；无询问通道 fail-closed → needs confirmation ... <sql 原文>', async () => {
    const denied = await rejectionMessage(
      executeDecision({
        provider: askProvider({ kind: 'ask', allowed: false }).provider,
        request: makeRequest({ action: 'execute', object: databaseObject(LONG_SQL) }),
        decision: askDecision({ command: LONG_SQL }),
        opts: makeOpts({ toolName: 'database' }),
        evaluateMs: 0
      })
    )
    expect(denied).toBe(`User denied ${LONG_SQL}`)

    const noChannel = await rejectionMessage(
      executeDecision({
        provider: makeProvider(),
        request: makeRequest({ action: 'execute', object: databaseObject(LONG_SQL) }),
        decision: askDecision({ command: LONG_SQL }),
        opts: makeOpts({ toolName: 'database' }),
        evaluateMs: 0
      })
    )
    expect(noChannel).toBe(
      `Access denied: this needs your confirmation but there is no way to ask: ${LONG_SQL}`
    )
  })
})

describe('executeDecision — url 客体文案', () => {
  // 日志摘要截断 200 字符，但给用户 / AI 的文案与询问卡片取地址原文（用超长地址对照）
  const LONG_URL = `https://a.example/search?q=${'x'.repeat(300)}`
  const urlObject = (url: string): SecurityObject => ({
    type: 'url',
    url,
    scheme: 'https',
    host: 'a.example',
    origin: 'https://a.example'
  })
  const urlRequest = (url = LONG_URL): SecurityRequest =>
    makeRequest({ action: 'navigate', object: urlObject(url) })
  const OPEN = { toolName: 'mcp__browser__open_tab' }

  it('EN-16 日志：objectKind=url；长地址摘要截断 200 字符，短地址原样', async () => {
    for (const url of [LONG_URL, 'https://a.example/']) {
      await executeDecision({
        provider: makeProvider(),
        request: urlRequest(url),
        decision: ALLOW,
        opts: makeOpts(OPEN),
        evaluateMs: 0
      })
    }
    const logs = getSessionDecisions(SID)
    // 新→旧：logs[0] 是短地址，logs[1] 是长地址
    expect(logs.map((l) => [l.action, l.objectKind])).toEqual([
      ['navigate', 'url'],
      ['navigate', 'url']
    ])
    expect(logs[0].objectSummary).toBe('https://a.example/')
    expect(logs[1].objectSummary).toBe(LONG_URL.slice(0, 200))
    expect(logs[1].objectSummary).toHaveLength(200)
  })

  it('EN-17 拒绝 → User denied opening <地址原文>；无询问通道 → needs confirmation … <地址原文>；无 reason 的 deny → Access denied: <地址原文>', async () => {
    const denied = await rejectionMessage(
      executeDecision({
        provider: askProvider({ kind: 'ask', allowed: false }).provider,
        request: urlRequest(),
        decision: askDecision({ command: LONG_URL }),
        opts: makeOpts(OPEN),
        evaluateMs: 0
      })
    )
    expect(denied).toBe(`User denied opening ${LONG_URL}`)

    const noChannel = await rejectionMessage(
      executeDecision({
        provider: makeProvider(),
        request: urlRequest(),
        decision: askDecision({ command: LONG_URL }),
        opts: makeOpts(OPEN),
        evaluateMs: 0
      })
    )
    expect(noChannel).toBe(
      `Access denied: this needs your confirmation but there is no way to ask: ${LONG_URL}`
    )

    const policyDeny = await rejectionMessage(
      executeDecision({
        provider: makeProvider(),
        request: urlRequest(),
        decision: denyDecision(),
        opts: makeOpts(OPEN),
        evaluateMs: 0
      })
    )
    expect(policyDeny).toBe(`Access denied: ${LONG_URL}`)

    const feedback = await rejectionMessage(
      executeDecision({
        provider: askProvider({ kind: 'other', text: 'skip it' }).provider,
        request: urlRequest(),
        decision: askDecision({ command: LONG_URL }),
        opts: makeOpts({ ...OPEN, onOther: 'throw' }),
        evaluateMs: 0
      })
    )
    expect(feedback).toBe(`User declined ${LONG_URL} and provided feedback instead: skip it`)
  })

  it('EN-18 询问卡片：决策没带材料时 command 回落到地址原文（不截断）', async () => {
    const { provider, requestUserInput } = askProvider({ kind: 'ask', allowed: true })
    await executeDecision({
      provider,
      request: urlRequest(),
      decision: askDecision(),
      opts: makeOpts({ ...OPEN, description: 'Open it' }),
      evaluateMs: 0
    })
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(requestUserInput.mock.calls[0][0]).toMatchObject({
      kind: 'ask',
      toolName: 'mcp__browser__open_tab',
      command: LONG_URL,
      description: 'Open it',
      pathIsDirectory: false
    })
  })
})

/**
 * 请求的写法落到了别处 —— 门面经 provider.realPath 解析过（见 context.ts）：客体上 path 是真实去处、
 * requestedPath 是交来的写法。执行层据此把两条都交代清楚：卡片（requestedPath 那一栏）、拒绝类文案的
 * 补注、决策日志；两条相同时一个字都不多。
 */
describe('executeDecision — 请求的写法落到了别处（requestedPath）', () => {
  const REAL = '/home/u/.ssh/id_rsa'
  const REQUESTED = '/ws/key'
  const NOTE = ` (${REQUESTED} resolves to ${REAL})`
  type AskRequest = Extract<InputRequest, { kind: 'ask' }>

  const redirected = (action = 'read'): SecurityRequest =>
    makeRequest({ action, object: { type: 'path', path: REAL, requestedPath: REQUESTED } })
  const unchanged = (action = 'read'): SecurityRequest =>
    makeRequest({
      action,
      object: { type: 'path', path: '/ws/file.txt', requestedPath: '/ws/file.txt' }
    })
  const REDIRECTED_ASK = askDecision({
    command: `Read(${REAL})`,
    rememberEntry: `Read(${REAL})`,
    requestedPath: REQUESTED
  })

  it('EN-R1 询问卡片的 requestedPath 取自决策材料：材料里有 → 原样透传；没有 → 缺席', async () => {
    const { provider, requestUserInput } = askProvider({ kind: 'ask', allowed: true })
    await executeDecision({
      provider,
      request: redirected(),
      decision: REDIRECTED_ASK,
      opts: makeOpts(),
      evaluateMs: 0
    })
    expect(requestUserInput.mock.calls[0][0]).toMatchObject({
      kind: 'ask',
      command: `Read(${REAL})`,
      requestedPath: REQUESTED
    })

    await executeDecision({
      provider,
      request: unchanged(),
      decision: PATH_ASK,
      opts: makeOpts(),
      evaluateMs: 0
    })
    const plain = requestUserInput.mock.calls[1][0] as AskRequest
    expect(plain.command).toBe('Read(/ws/file.txt)')
    expect(plain.requestedPath).toBeUndefined()
  })

  it('EN-R2 策略拒绝：归因之后、提示语之前补一句「(<写法> resolves to <真实去处>)」；没有 reason 的兜底文案同样', async () => {
    const run = (decision: SecurityDecision, opts = makeOpts()): Promise<string> =>
      rejectionMessage(
        executeDecision({
          provider: makeProvider(),
          request: redirected('write'),
          decision,
          opts,
          evaluateMs: 0
        })
      )

    expect(await run(denyDecision("Denied by security policy rule 'd1'", PROMPT))).toBe(
      `Denied by security policy rule 'd1'${NOTE}\n\n${PROMPT.text}`
    )
    expect(await run(denyDecision("Denied by security policy rule 'd1'"))).toBe(
      `Denied by security policy rule 'd1'${NOTE}`
    )
    expect(await run(denyDecision(), makeOpts({ displayPath: 'key' }))).toBe(
      `Access denied: key${NOTE}`
    )
  })

  it('EN-R3 没有询问通道的 fail-closed 文案同样补上这一句（展示名之后）', async () => {
    expect(
      await rejectionMessage(
        executeDecision({
          provider: makeProvider(),
          request: redirected(),
          decision: REDIRECTED_ASK,
          opts: makeOpts(),
          evaluateMs: 0
        })
      )
    ).toBe(`Access denied: path outside workspace and no way to ask: ${REQUESTED}${NOTE}`)
  })

  it('EN-R4 没给 displayPath 时展示名是请求时的写法（agent 认得出是哪一次调用），给了则 displayPath 优先；客体上没有 requestedPath 时回落到 path', async () => {
    const run = (
      response: InputResponse,
      request = redirected(),
      opts = makeOpts()
    ): Promise<string> =>
      rejectionMessage(
        executeDecision({
          provider: askProvider(response).provider,
          request,
          decision: REDIRECTED_ASK,
          opts,
          evaluateMs: 0
        })
      )

    expect(await run({ kind: 'ask', allowed: false })).toBe(`User denied access to ${REQUESTED}`)
    expect(await run({ kind: 'other', text: 'no' })).toBe(
      `User declined access to ${REQUESTED} and provided feedback instead: no`
    )
    expect(
      await run({ kind: 'ask', allowed: false }, redirected(), makeOpts({ displayPath: 'key' }))
    ).toBe('User denied access to key')
    // 未经门面的旧形态客体（没有 requestedPath）：照旧用 path
    expect(
      await run(
        { kind: 'ask', allowed: false },
        makeRequest({ object: { type: 'path', path: REAL } })
      )
    ).toBe(`User denied access to ${REAL}`)
  })

  it('EN-R5 决策日志：objectSummary 恒是真实去处；requestedPath 只在与它不同时记（落进 logger 的那一行同样）', async () => {
    const info = vi.fn()
    const provider = makeProvider({ logger: { info, warn: vi.fn(), error: vi.fn() } })
    const run = (request: SecurityRequest): Promise<EnforceOutcome> =>
      executeDecision({ provider, request, decision: ALLOW, opts: makeOpts(), evaluateMs: 0 })

    await run(redirected())
    await run(unchanged())
    await run(makeRequest())
    // 非路径客体带着同名属性（开放属性文档挡不住）：不算改道
    await run(
      makeRequest({ action: 'execute', object: { ...COMMAND_OBJECT, requestedPath: '/elsewhere' } })
    )

    // 新→旧
    expect(getSessionDecisions(SID).map((l) => [l.objectSummary, l.requestedPath])).toEqual([
      ['ls -la', undefined],
      ['/ws/file.txt', undefined],
      ['/ws/file.txt', undefined],
      [REAL, REQUESTED]
    ])
    const lines = info.mock.calls.map((c) => String(c[0]))
    expect(lines.filter((l) => l.includes('"requestedPath"'))).toEqual([
      expect.stringContaining(`"requestedPath":"${REQUESTED}"`)
    ])
  })

  it('EN-R6 写法与真实去处相同：拒绝与 fail-closed 文案与从前逐字一致（不多一个括号）；非路径客体上的同名属性不补注', async () => {
    const run = (request: SecurityRequest, decision: SecurityDecision): Promise<string> =>
      rejectionMessage(
        executeDecision({
          provider: makeProvider(),
          request,
          decision,
          opts: makeOpts(),
          evaluateMs: 0
        })
      )

    expect(
      await run(unchanged('write'), denyDecision("Denied by security policy rule 'd1'", PROMPT))
    ).toBe(`Denied by security policy rule 'd1'\n\n${PROMPT.text}`)
    expect(await run(unchanged(), PATH_ASK)).toBe(
      'Access denied: path outside workspace and no way to ask: /ws/file.txt'
    )
    expect(
      await run(
        makeRequest({
          action: 'execute',
          object: { ...COMMAND_OBJECT, requestedPath: '/elsewhere' }
        }),
        denyDecision("Denied by security policy rule 'd1'")
      )
    ).toBe("Denied by security policy rule 'd1'")
  })
})

/**
 * 询问点的自动审查（SecurityHostProvider.onPermissionRequest）—— 只有 ask 档的询问先交给审查：
 * allow 放行不弹卡；deny 以审查理由拒绝；ask / 答不出照旧弹卡（答 ask 时卡片带审查意见）。
 * 连续 3 / 累计 20 次审查拒绝后本会话直接问人；人回答一次清连续计数（cancel 不算回答）。
 * 审查与工具调用的 signal、会话的停止（abortSessionReviews）赛跑，中止一律按 abortError 收尾。
 *
 * 旧用例的 askDecision() 不带 tier，天然不进审查；这一组的决策都显式写 tier。
 * reviewState 是进程级的 Map：每条用例用自己的会话 id，afterEach 统一清掉。
 */
describe('executeDecision — 询问点的审查', () => {
  const REVIEW_DENY_TAIL =
    '\n\nFind a safer way that stays within what the user asked. Do not rephrase, split or ' +
    'obfuscate the operation to get past the review. If the user needs to decide, ask them.'

  const usedSids = new Set<string>()
  let sidSeq = 0
  const newSid = (): string => {
    const sid = `enforce-review-${++sidSeq}`
    usedSids.add(sid)
    return sid
  }
  afterEach(() => {
    for (const sid of usedSids) {
      clearReviewState(sid)
      clearSessionDecisions(sid)
    }
    usedSids.clear()
    vi.useRealTimers()
  })

  type Reviewer = NonNullable<SecurityHostProvider['onPermissionRequest']>
  type ReviewerMock = ReturnType<typeof vi.fn<Reviewer>>

  const verdict = (
    decision: PermissionDecision,
    fields: Partial<PermissionVerdict> = {}
  ): PermissionVerdict => ({ decision, risk: 'low', summary: 's', reason: 'r', ...fields })
  const answerOf = (value: unknown, source = 'auto-review'): PermissionReviewAnswer => ({
    verdict: value as PermissionVerdict,
    source
  })
  /** 固定回答的审查接缝 */
  const reviewer = (answer: PermissionReviewAnswer | null): ReviewerMock =>
    vi.fn<Reviewer>(async () => answer)
  /** 按次序回答的审查接缝（用完之后一律 allow） */
  const scriptedReviewer = (decisions: PermissionDecision[]): ReviewerMock => {
    const queue = [...decisions]
    return vi.fn<Reviewer>(async () => answerOf(verdict(queue.shift() ?? 'allow')))
  }
  /** 挂起的审查接缝：答复由用例手动给出（每次调用各一个） */
  const pendingReviewer = (): {
    review: ReviewerMock
    answer: (value: PermissionReviewAnswer | null, call?: number) => void
    signal: (call?: number) => AbortSignal
  } => {
    const resolvers: Array<(value: PermissionReviewAnswer | null) => void> = []
    const review = vi.fn<Reviewer>(
      () =>
        new Promise<PermissionReviewAnswer | null>((resolve) => {
          resolvers.push(resolve)
        })
    )
    return {
      review,
      answer: (value, call = 0) => resolvers[call](value),
      signal: (call = 0) => review.mock.calls[call][1] as AbortSignal
    }
  }

  /** ask 档的决策（执行层据 tier 决定能不能先交给审查） */
  const reviewAsk = (
    ask?: SecurityDecision['ask'],
    prompt?: SecurityDecision['prompt']
  ): SecurityDecision => ({ ...askDecision(ask, prompt), tier: 'ask' })
  const RV_PATH_ASK = reviewAsk({
    command: 'Read(/ws/file.txt)',
    rememberEntry: 'Read(/ws/file.txt)'
  })
  const RV_WRITE_ASK = reviewAsk(
    { command: 'Write(/ws/file.txt)', rememberEntry: 'Write(/ws/file.txt)' },
    PROMPT
  )

  const requestIn = (sid: string, overrides: Partial<SecurityRequest> = {}): SecurityRequest =>
    makeRequest({ subject: { kind: 'agent', sessionId: sid, agentKind: 'root' }, ...overrides })

  /** 审查接缝 + 固定应答的询问通道 + 可观察的 logger */
  function reviewProvider(
    review: Reviewer | undefined,
    response: InputResponse = { kind: 'ask', allowed: true },
    overrides: Partial<SecurityHostProvider> = {}
  ): {
    provider: SecurityHostProvider
    requestUserInput: ReturnType<typeof vi.fn<(req: InputRequest) => Promise<InputResponse>>>
    persistGrant: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
  } {
    const requestUserInput = vi.fn(async (_req: InputRequest): Promise<InputResponse> => response)
    const persistGrant = vi.fn()
    const info = vi.fn()
    const warn = vi.fn()
    return {
      provider: makeProvider({
        requestUserInput,
        persistGrant,
        logger: { info, warn, error: vi.fn() },
        ...(review ? { onPermissionRequest: review } : {}),
        ...overrides
      }),
      requestUserInput,
      persistGrant,
      info,
      warn
    }
  }

  const run = (
    provider: SecurityHostProvider,
    sid: string,
    decision: SecurityDecision = RV_PATH_ASK,
    opts: Partial<EnforceOpts> = {},
    request: SecurityRequest = requestIn(sid)
  ): Promise<EnforceOutcome> =>
    executeDecision({ provider, request, decision, opts: makeOpts(opts), evaluateMs: 0 })

  /** 唯一一张卡片 */
  const onlyCard = (requestUserInput: ReturnType<typeof vi.fn>): AskInputRequest => {
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    return requestUserInput.mock.calls[0][0] as AskInputRequest
  }

  /** 让已排队的微任务跑完（接缝在执行层的下一个微任务里才被调用） */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  /** 审查连拒三次，让本会话进入「直接问人」 */
  async function suspendByDenials(provider: SecurityHostProvider, sid: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      expect(await rejectionMessage(run(provider, sid))).toMatch(/^Blocked by the reviewer: /)
    }
    expect(reviewSuspended(sid)).toBe(true)
  }

  it('EN-RV1 审查 allow：不弹卡、不记住、直接放行；日志恰 1 条（effect ask、winning a1、无 userResponse），带 review 与 totalMs', async () => {
    const sid = newSid()
    const review = reviewer(
      answerOf(verdict('allow', { risk: 'low', summary: 's', reason: 'r' }), 'auto-review')
    )
    // 人要是被问到会勾「记住」—— 审查放行时这条路根本不该走到
    const { provider, requestUserInput, persistGrant } = reviewProvider(review, {
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: true }
    })
    expect(RV_PATH_ASK.ask?.rememberEntry).toBe('Read(/ws/file.txt)')

    await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
    expect(review).toHaveBeenCalledTimes(1)
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(persistGrant).not.toHaveBeenCalled()

    const logs = getSessionDecisions(sid)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ effect: 'ask', winning: 'a1', matched: ['a1'] })
    expect(logs[0].userResponse).toBeUndefined()
    expect(logs[0].review).toEqual({
      decision: 'allow',
      risk: 'low',
      source: 'auto-review',
      ms: expect.any(Number)
    })
    expect(logs[0].review!.ms).toBeGreaterThanOrEqual(0)
    expect(typeof logs[0].totalMs).toBe('number')
  })

  it('EN-RV2 审查 deny：以审查理由加固定的一句抛出（逐字）；决策带提示语也不拼进去；不弹卡；日志 review deny、无 userResponse', async () => {
    const sid = newSid()
    const reason = 'The user asked for a summary; overwriting this file was never requested.'
    const review = reviewer(answerOf(verdict('deny', { risk: 'high', reason })))
    const { provider, requestUserInput } = reviewProvider(review)

    const message = await rejectionMessage(
      run(provider, sid, RV_WRITE_ASK, { toolName: 'write' }, requestIn(sid, { action: 'write' }))
    )
    expect(message).toBe(
      `Blocked by the reviewer: ${reason}\n\n` +
        'Find a safer way that stays within what the user asked. Do not rephrase, split or obfuscate ' +
        'the operation to get past the review. If the user needs to decide, ask them.'
    )
    expect(message).not.toContain(PROMPT.text)
    expect(requestUserInput).not.toHaveBeenCalled()

    const logs = getSessionDecisions(sid)
    expect(logs).toHaveLength(1)
    expect(logs[0].review).toEqual({
      decision: 'deny',
      risk: 'high',
      source: 'auto-review',
      ms: expect.any(Number)
    })
    expect(logs[0].userResponse).toBeUndefined()
    expect(logs[0].effect).toBe('ask')
  })

  it('EN-RV3 审查 ask：弹卡恰 1 次，卡片 review = {risk, summary, reason}（没有 decision）；其余字段与没有接缝时逐字段相同；人允许 → allowed，日志 review ask + userResponse allowed', async () => {
    const preview = { kind: 'diff' as const, path: 'file.txt', diff: '+new line', isNewFile: false }
    const opts: Partial<EnforceOpts> = {
      toolCallId: 'tc-rv3',
      toolName: 'write',
      description: 'the desc',
      preview,
      background: true,
      unsandboxed: true
    }

    // 对照：没有接缝时的那张卡
    const plainSid = newSid()
    const plain = reviewProvider(undefined)
    await run(
      plain.provider,
      plainSid,
      RV_WRITE_ASK,
      opts,
      requestIn(plainSid, { action: 'write' })
    )
    const plainCard = onlyCard(plain.requestUserInput)

    const sid = newSid()
    const review = reviewer(
      answerOf(
        verdict('ask', {
          risk: 'medium',
          summary: 'Overwrites file.txt in the project.',
          reason: 'The user never mentioned this file.'
        })
      )
    )
    const reviewed = reviewProvider(review)
    await expect(
      run(reviewed.provider, sid, RV_WRITE_ASK, opts, requestIn(sid, { action: 'write' }))
    ).resolves.toEqual({ status: 'allowed' })
    const card = onlyCard(reviewed.requestUserInput)
    expect(card.review).toEqual({
      risk: 'medium',
      summary: 'Overwrites file.txt in the project.',
      reason: 'The user never mentioned this file.'
    })
    expect(card.review).not.toHaveProperty('decision')

    const { review: _review, createdAt: _createdAt, ...rest } = card
    const { review: _plainReview, createdAt: _plainCreatedAt, ...plainRest } = plainCard
    expect(rest).toStrictEqual(plainRest)
    // 对照组确实是一张「满的」卡：审查没有挤掉任何一栏
    expect(plainRest).toMatchObject({
      id: 'tc-rv3',
      kind: 'ask',
      toolName: 'write',
      command: 'Write(/ws/file.txt)',
      description: 'the desc',
      policyPrompt: { text: PROMPT.text, policies: PROMPT.policies },
      preview,
      background: true,
      unsandboxed: true,
      pathIsDirectory: false
    })

    const logs = getSessionDecisions(sid)
    expect(logs).toHaveLength(1)
    expect(logs[0].review).toEqual({
      decision: 'ask',
      risk: 'medium',
      source: 'auto-review',
      ms: expect.any(Number)
    })
    expect(logs[0].userResponse).toBe('allowed')
  })

  it('EN-RV4 接缝回 null：照旧弹卡，卡片没有 review；日志没有 review', async () => {
    const sid = newSid()
    const review = reviewer(null)
    const { provider, requestUserInput } = reviewProvider(review)

    await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
    expect(review).toHaveBeenCalledTimes(1)
    expect(onlyCard(requestUserInput).review).toBeUndefined()
    const logs = getSessionDecisions(sid)
    expect(logs).toHaveLength(1)
    expect(logs[0].review).toBeUndefined()
    expect(logs[0].userResponse).toBe('allowed')
  })

  it.each<[string, unknown]>([
    ['verdict 是 undefined', answerOf(undefined)],
    ['verdict 是 null', answerOf(null)],
    ["verdict 是字符串 'allow'", answerOf('allow')],
    ["verdict 只有 {decision:'allow'}", answerOf({ decision: 'allow' })],
    ['verdict 缺 reason', answerOf({ decision: 'allow', risk: 'low', summary: 's' })],
    ["decision 'ALLOW'", answerOf({ decision: 'ALLOW', risk: 'low', summary: 's', reason: 'r' })],
    [
      "decision 'approve'",
      answerOf({ decision: 'approve', risk: 'low', summary: 's', reason: 'r' })
    ],
    ["risk 'none'", answerOf({ decision: 'allow', risk: 'none', summary: 's', reason: 'r' })],
    ['summary 是数字', answerOf({ decision: 'allow', risk: 'low', summary: 42, reason: 'r' })],
    ['整个 answer 是 {}', {}],
    ['整个 answer 是 undefined', undefined]
  ])(
    'EN-RV5 不合格的判决绝不放行（%s）：照旧弹卡、卡片与日志都没有 review',
    async (_label, malformed) => {
      const sid = newSid()
      const review = vi.fn<Reviewer>(async () => malformed as PermissionReviewAnswer | null)
      const { provider, requestUserInput } = reviewProvider(review)

      await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
      expect(review).toHaveBeenCalledTimes(1)
      expect(onlyCard(requestUserInput).review).toBeUndefined()
      const [log] = getSessionDecisions(sid)
      expect(log.review).toBeUndefined()
      expect(log.userResponse).toBe('allowed')
    }
  )

  it('EN-RV5 连着 3 次不合格的 deny 不计入拒绝：第 4 次照常先问审查（人一直取消，连续计数没人清）', async () => {
    const sid = newSid()
    const review = reviewer(answerOf({ decision: 'deny', risk: 'none', summary: 's', reason: 'r' }))
    const { provider, requestUserInput } = reviewProvider(review, {
      kind: 'cancel',
      reason: 'aborted'
    })

    for (let i = 0; i < 3; i++) expect(await rejectionMessage(run(provider, sid))).toBe('Aborted')
    expect(reviewSuspended(sid)).toBe(false)
    expect(await rejectionMessage(run(provider, sid))).toBe('Aborted')
    expect(review).toHaveBeenCalledTimes(4)
    expect(requestUserInput).toHaveBeenCalledTimes(4)
  })

  it.each<[string, Reviewer]>([
    [
      '同步 throw',
      () => {
        throw new Error('reviewer exploded')
      }
    ],
    ['reject', async () => Promise.reject(new Error('reviewer exploded'))]
  ])(
    'EN-RV6 接缝%s → 照旧弹卡、没有 review；logger.warn 恰 1 行，含 permission review failed 与原错误文本',
    async (_label, impl) => {
      const sid = newSid()
      const review = vi.fn<Reviewer>(impl)
      const { provider, requestUserInput, warn } = reviewProvider(review)

      await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
      expect(review).toHaveBeenCalledTimes(1)
      expect(onlyCard(requestUserInput).review).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0][0])
      expect(line).toContain('permission review failed')
      expect(line).toContain('reviewer exploded')
      expect(getSessionDecisions(sid)[0].review).toBeUndefined()
    }
  )

  it('EN-RV6 没有 logger 时接缝抛错也不炸：照旧弹卡', async () => {
    const sid = newSid()
    const review = vi.fn<Reviewer>(async () => {
      throw new Error('reviewer exploded')
    })
    const { provider, requestUserInput } = reviewProvider(review, undefined, {
      logger: undefined
    })

    await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
    expect(onlyCard(requestUserInput).review).toBeUndefined()
  })

  it.each<[string, SecurityDecision, 'card' | 'allowed' | 'denied']>([
    ['force-ask', { ...askDecision({ command: 'Read(/ws/file.txt)' }), tier: 'force-ask' }, 'card'],
    [
      '缺省（手工构造、没有档位的 ask 决策）',
      askDecision({ command: 'Read(/ws/file.txt)' }),
      'card'
    ],
    ['deny', { ...denyDecision("Denied by security policy rule 'd1'"), tier: 'deny' }, 'denied'],
    ['force-allow', { ...ALLOW, tier: 'force-allow' }, 'allowed'],
    ['static-allow', { ...ALLOW, tier: 'static-allow' }, 'allowed'],
    [
      'default',
      { effect: 'allow', tier: 'default', matched: [], winning: 'default:path' },
      'allowed'
    ]
  ])('EN-RV7 只审 ask 档：tier %s → 接缝 0 次', async (_tier, decision, expected) => {
    const sid = newSid()
    const review = reviewer(answerOf(verdict('allow')))
    const { provider, requestUserInput } = reviewProvider(review)

    if (expected === 'denied') {
      expect(await rejectionMessage(run(provider, sid, decision))).toBe(
        "Denied by security policy rule 'd1'"
      )
      expect(requestUserInput).not.toHaveBeenCalled()
    } else if (expected === 'allowed') {
      await expect(run(provider, sid, decision)).resolves.toEqual({ status: 'allowed' })
      expect(requestUserInput).not.toHaveBeenCalled()
    } else {
      await expect(run(provider, sid, decision)).resolves.toEqual({ status: 'allowed' })
      expect(onlyCard(requestUserInput).review).toBeUndefined()
    }
    expect(review).not.toHaveBeenCalled()
    expect(getSessionDecisions(sid)[0].review).toBeUndefined()
  })

  it('EN-RV8 provider 不带 onPermissionRequest：ask 档与没有档位的旧决策逐字段一致 —— 结果、卡片、「记住」、日志', async () => {
    const preview = { kind: 'diff' as const, path: 'file.txt', diff: '+x' }
    const materials = { command: 'Write(/ws/file.txt)', rememberEntry: 'Write(/ws/file.txt)' }
    const observe = async (
      decision: SecurityDecision
    ): Promise<{
      outcome: EnforceOutcome
      card: Record<string, unknown>
      persisted: unknown[][]
      log: Record<string, unknown>
    }> => {
      const sid = newSid()
      const requestUserInput = vi.fn(
        async (_req: InputRequest): Promise<InputResponse> => ({
          kind: 'ask',
          allowed: true,
          extra: { rememberPath: true }
        })
      )
      const persistGrant = vi.fn()
      const provider = makeProvider({ requestUserInput, persistGrant })
      expect('onPermissionRequest' in provider).toBe(false)
      const outcome = await executeDecision({
        provider,
        request: requestIn(sid, { action: 'write' }),
        decision,
        opts: makeOpts({ toolName: 'write', preview, description: 'd' }),
        evaluateMs: 0
      })
      const { createdAt: _createdAt, ...card } = onlyCard(requestUserInput)
      const {
        ts: _ts,
        totalMs: _totalMs,
        sessionId: _sessionId,
        ...log
      } = getSessionDecisions(sid)[0]
      return { outcome, card, persisted: persistGrant.mock.calls, log }
    }

    const legacy = await observe(askDecision(materials, PROMPT))
    const tiered = await observe({ ...askDecision(materials, PROMPT), tier: 'ask' })
    expect(tiered).toStrictEqual(legacy)
    expect(tiered.outcome).toEqual({ status: 'allowed' })
    expect(tiered.card.review).toBeUndefined()
    expect(tiered.log.review).toBeUndefined()
    expect(tiered.log.userResponse).toBe('allowed_remember')
    expect(tiered.persisted).toEqual([['write', '/ws/file.txt']])
  })

  it('EN-RV9 连续 3 次审查 deny 之后第 4 次跳过审查（接缝总调用仍 3），直接弹卡、没有 review', async () => {
    const sid = newSid()
    const review = reviewer(answerOf(verdict('deny')))
    const { provider, requestUserInput } = reviewProvider(review)

    await suspendByDenials(provider, sid)
    expect(review).toHaveBeenCalledTimes(3)
    expect(requestUserInput).not.toHaveBeenCalled()

    await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
    expect(review).toHaveBeenCalledTimes(3)
    expect(onlyCard(requestUserInput).review).toBeUndefined()
    const [latest] = getSessionDecisions(sid)
    expect(latest.review).toBeUndefined()
    expect(latest.userResponse).toBe('allowed')
  })

  it.each<[string, InputResponse, Partial<EnforceOpts>, 'allowed' | 'denied' | 'feedback']>([
    ['allowed', { kind: 'ask', allowed: true }, {}, 'allowed'],
    ['denied', { kind: 'ask', allowed: false }, {}, 'denied'],
    [
      'other（onOther:return）',
      { kind: 'other', text: 'use the docs' },
      { onOther: 'return' },
      'feedback'
    ]
  ])(
    'EN-RV10 暂停之后人对第 4 张卡答 %s → 第 5 次重新先问审查',
    async (_label, response, extraOpts, expected) => {
      const sid = newSid()
      const review = scriptedReviewer(['deny', 'deny', 'deny', 'allow'])
      const { provider, requestUserInput } = reviewProvider(review, response)
      await suspendByDenials(provider, sid)

      const fourth = run(provider, sid, RV_PATH_ASK, extraOpts)
      if (expected === 'denied') {
        expect(await rejectionMessage(fourth)).toBe('User denied access to /ws/file.txt')
      } else if (expected === 'feedback') {
        await expect(fourth).resolves.toEqual({ status: 'feedback', text: 'use the docs' })
      } else {
        await expect(fourth).resolves.toEqual({ status: 'allowed' })
      }
      expect(review).toHaveBeenCalledTimes(3)
      expect(requestUserInput).toHaveBeenCalledTimes(1)
      expect(reviewSuspended(sid)).toBe(false)

      await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
      expect(review).toHaveBeenCalledTimes(4)
      expect(requestUserInput).toHaveBeenCalledTimes(1)
    }
  )

  it('EN-RV11 人 cancel 不清零：暂停之后第 4 张卡被取消 → 抛 abortError；第 5 次仍跳过审查', async () => {
    const sid = newSid()
    const review = reviewer(answerOf(verdict('deny')))
    const { provider, requestUserInput } = reviewProvider(review, {
      kind: 'cancel',
      reason: 'aborted'
    })
    await suspendByDenials(provider, sid)

    expect(
      await rejectionMessage(run(provider, sid, RV_PATH_ASK, { abortError: 'TOOL_ABORTED' }))
    ).toBe('TOOL_ABORTED')
    expect(reviewSuspended(sid)).toBe(true)
    expect(await rejectionMessage(run(provider, sid))).toBe('Aborted')
    expect(review).toHaveBeenCalledTimes(3)
    expect(requestUserInput).toHaveBeenCalledTimes(2)
  })

  it('EN-RV12 审查放行也清零：deny, deny, allow, deny, deny → 第 6 次仍经审查', async () => {
    const sid = newSid()
    const review = scriptedReviewer(['deny', 'deny', 'allow', 'deny', 'deny', 'allow'])
    const { provider, requestUserInput } = reviewProvider(review)

    for (const step of ['deny', 'deny', 'allow', 'deny', 'deny'] as const) {
      if (step === 'deny') {
        expect(await rejectionMessage(run(provider, sid))).toMatch(/^Blocked by the reviewer: /)
      } else {
        await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
      }
    }
    expect(reviewSuspended(sid)).toBe(false)
    await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
    expect(review).toHaveBeenCalledTimes(6)
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('EN-RV13 以 (deny, deny, allow) 交错攒满 20 次 deny（连续从未到 3）→ 之后跳过审查；人回答之后仍跳过（累计不清零）', async () => {
    const sid = newSid()
    const plan: PermissionDecision[] = []
    for (let i = 0; i < 9; i++) plan.push('deny', 'deny', 'allow')
    plan.push('deny', 'deny')
    const review = scriptedReviewer(plan)
    const { provider, requestUserInput } = reviewProvider(review)

    let denials = 0
    for (const step of plan) {
      if (step === 'deny') {
        expect(await rejectionMessage(run(provider, sid))).toMatch(/^Blocked by the reviewer: /)
        denials += 1
        expect({ denials, suspended: reviewSuspended(sid) }).toEqual({
          denials,
          suspended: denials >= 20
        })
      } else {
        await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
      }
    }
    expect(denials).toBe(20)
    expect(review).toHaveBeenCalledTimes(29)
    expect(requestUserInput).not.toHaveBeenCalled()

    // 第 21 次：跳过审查，直接问人（人允许）
    await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
    expect(review).toHaveBeenCalledTimes(29)
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    // 人回答过了，累计照旧：第 22 次仍跳过
    await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
    expect(review).toHaveBeenCalledTimes(29)
    expect(requestUserInput).toHaveBeenCalledTimes(2)
  })

  it('EN-RV14 按 subject.sessionId 分桶：A 暂停不影响 B；clearReviewState(A) 之后 A 恢复', async () => {
    const a = newSid()
    const b = newSid()
    const review = scriptedReviewer(['deny', 'deny', 'deny'])
    const { provider, requestUserInput } = reviewProvider(review)
    await suspendByDenials(provider, a)

    // B 照常经审查（脚本用完之后回 allow）
    await expect(run(provider, b)).resolves.toEqual({ status: 'allowed' })
    expect(review).toHaveBeenCalledTimes(4)
    expect((review.mock.calls[3][0] as PermissionRequestEvent).request.subject.sessionId).toBe(b)

    // A 直接问人
    await expect(run(provider, a)).resolves.toEqual({ status: 'allowed' })
    expect(review).toHaveBeenCalledTimes(4)
    expect(requestUserInput).toHaveBeenCalledTimes(1)

    // 人的回答清了 A 的连续计数；再让 A 连拒三次暂停，然后整份清掉 —— A 恢复，B 不受牵连
    await suspendByDenials(reviewProvider(reviewer(answerOf(verdict('deny')))).provider, a)
    clearReviewState(a)
    expect(reviewSuspended(a)).toBe(false)
    const after = reviewer(answerOf(verdict('allow')))
    await expect(run(reviewProvider(after).provider, a)).resolves.toEqual({ status: 'allowed' })
    expect(after).toHaveBeenCalledTimes(1)
  })

  it.each<[string | undefined, string]>([
    ['TOOL_ABORTED', 'TOOL_ABORTED'],
    [undefined, 'Aborted']
  ])(
    'EN-RV15 调用前 signal 已中止（abortError=%s）：接缝与卡片都不碰，抛 abortError；日志 cancel、有 totalMs、没有 review',
    async (abortError, expected) => {
      const sid = newSid()
      const review = reviewer(answerOf(verdict('allow')))
      const { provider, requestUserInput } = reviewProvider(review)
      const ac = new AbortController()
      ac.abort()

      expect(
        await rejectionMessage(run(provider, sid, RV_PATH_ASK, { signal: ac.signal, abortError }))
      ).toBe(expected)
      expect(review).not.toHaveBeenCalled()
      expect(requestUserInput).not.toHaveBeenCalled()
      const logs = getSessionDecisions(sid)
      expect(logs).toHaveLength(1)
      expect(logs[0].userResponse).toBe('cancel')
      expect(typeof logs[0].totalMs).toBe('number')
      expect(logs[0].review).toBeUndefined()
    }
  )

  it('EN-RV16 审查进行中被中止、接缝随后才答 allow：抛 abortError、不放行、不弹卡', async () => {
    const sid = newSid()
    const pending = pendingReviewer()
    const { provider, requestUserInput } = reviewProvider(pending.review)
    const ac = new AbortController()

    const result = run(provider, sid, RV_PATH_ASK, {
      signal: ac.signal,
      abortError: 'TOOL_ABORTED'
    })
    await flush()
    expect(pending.review).toHaveBeenCalledTimes(1)
    ac.abort()
    pending.answer(answerOf(verdict('allow')))

    expect(await rejectionMessage(result)).toBe('TOOL_ABORTED')
    expect(requestUserInput).not.toHaveBeenCalled()
    const logs = getSessionDecisions(sid)
    expect(logs).toHaveLength(1)
    expect(logs[0].userResponse).toBe('cancel')
    expect(logs[0].review).toBeUndefined()
  })

  it('EN-RV16 同样的流程接缝随后答 deny：不计入拒绝 —— 三次之后仍不暂停，第 4 次照常经审查', async () => {
    const sid = newSid()
    const pending = pendingReviewer()
    const { provider, requestUserInput } = reviewProvider(pending.review)

    for (let call = 0; call < 3; call++) {
      const ac = new AbortController()
      const result = run(provider, sid, RV_PATH_ASK, { signal: ac.signal })
      await flush()
      ac.abort()
      pending.answer(answerOf(verdict('deny')), call)
      expect(await rejectionMessage(result)).toBe('Aborted')
    }
    expect(reviewSuspended(sid)).toBe(false)

    const fourth = run(provider, sid)
    await flush()
    expect(pending.review).toHaveBeenCalledTimes(4)
    pending.answer(answerOf(verdict('allow')), 3)
    await expect(fourth).resolves.toEqual({ status: 'allowed' })
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('EN-RV17 接缝收到的第二个参数恒是一个 AbortSignal（不是 opts.signal 本身）：opts.signal 落下它随之 aborted', async () => {
    const sid = newSid()
    const pending = pendingReviewer()
    const { provider } = reviewProvider(pending.review)
    const ac = new AbortController()

    const result = run(provider, sid, RV_PATH_ASK, { signal: ac.signal })
    await flush()
    const seamSignal = pending.signal()
    expect(seamSignal).toBeInstanceOf(AbortSignal)
    expect(seamSignal).not.toBe(ac.signal)
    expect(seamSignal.aborted).toBe(false)

    ac.abort()
    expect(seamSignal.aborted).toBe(true)
    expect(await rejectionMessage(result)).toBe('Aborted')
  })

  it('EN-RV17 没给 opts.signal 时接缝照样收到一个 AbortSignal，审查期间与之后都不 aborted', async () => {
    const sid = newSid()
    const seen: boolean[] = []
    const review = vi.fn<Reviewer>(async (_event, signal) => {
      seen.push(signal instanceof AbortSignal, signal?.aborted === false)
      return answerOf(verdict('allow'))
    })
    const { provider } = reviewProvider(review)

    await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
    expect(seen).toEqual([true, true])
    const signal = review.mock.calls[0][1]
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(false)
  })

  it('EN-RV18 交给接缝的事件恰为 {request, decision, toolCallId, command, preview, background, unsandboxed}：request / decision 是同一对象，command 取决策材料；description 不进事件', async () => {
    const sid = newSid()
    const review = reviewer(null)
    const { provider } = reviewProvider(review)
    const request = requestIn(sid, { action: 'write' })
    const preview = { kind: 'diff' as const, path: 'file.txt', diff: '+x', isNewFile: true }

    await executeDecision({
      provider,
      request,
      decision: RV_WRITE_ASK,
      opts: makeOpts({
        toolCallId: 'tc-ev',
        toolName: 'write',
        description: 'AGENT-RATIONALE',
        preview,
        background: true,
        unsandboxed: true
      }),
      evaluateMs: 0
    })

    expect(review).toHaveBeenCalledTimes(1)
    const event = review.mock.calls[0][0]
    expect(Object.keys(event).sort()).toEqual([
      'background',
      'command',
      'decision',
      'preview',
      'request',
      'toolCallId',
      'unsandboxed'
    ])
    expect(event.request).toBe(request)
    expect(event.decision).toBe(RV_WRITE_ASK)
    expect(event.decision.tier).toBe('ask')
    expect(event).toEqual({
      request,
      decision: RV_WRITE_ASK,
      toolCallId: 'tc-ev',
      command: 'Write(/ws/file.txt)',
      preview,
      background: true,
      unsandboxed: true
    })
    // 模型写的理由（description 参数）只上卡片，不进审查员的输入
    expect(JSON.stringify(event)).not.toContain('AGENT-RATIONALE')
  })

  it('EN-RV18 决策没带询问材料时 command 回落展示名：命令原文 / displayPath / 路径', async () => {
    const commandOf = async (
      request: SecurityRequest,
      opts: Partial<EnforceOpts> = {}
    ): Promise<string> => {
      const review = reviewer(null)
      await run(
        reviewProvider(review).provider,
        request.subject.sessionId,
        reviewAsk(),
        opts,
        request
      )
      return review.mock.calls[0][0].command
    }

    const sid = newSid()
    expect(await commandOf(requestIn(sid, { action: 'execute', object: COMMAND_OBJECT }))).toBe(
      'ls -la'
    )
    expect(await commandOf(requestIn(sid), { displayPath: 'rel/file.txt' })).toBe('rel/file.txt')
    expect(await commandOf(requestIn(sid))).toBe('/ws/file.txt')
  })

  it('EN-RV19 无询问通道：审查 allow 放行、deny 抛审查文案（missingChannel:allow 也一样）；ask / null 之后才按 missingChannel', async () => {
    const noChannel = (answer: PermissionReviewAnswer | null): SecurityHostProvider =>
      makeProvider({ onPermissionRequest: reviewer(answer) })
    const FAIL_CLOSED = 'Access denied: path outside workspace and no way to ask: /ws/file.txt'

    // allow：缺省 missingChannel（deny）也放行 —— 没有人可问，审查就是答案
    const allowSid = newSid()
    await expect(run(noChannel(answerOf(verdict('allow'))), allowSid)).resolves.toEqual({
      status: 'allowed'
    })
    expect(getSessionDecisions(allowSid)[0].review?.decision).toBe('allow')

    // deny：即使调用方声明 missingChannel:allow
    const denySid = newSid()
    expect(
      await rejectionMessage(
        run(noChannel(answerOf(verdict('deny', { reason: 'nope' }))), denySid, RV_PATH_ASK, {
          missingChannel: 'allow'
        })
      )
    ).toBe(`Blocked by the reviewer: nope${REVIEW_DENY_TAIL}`)

    // ask：按 missingChannel，日志带着审查意见
    const askDenySid = newSid()
    expect(await rejectionMessage(run(noChannel(answerOf(verdict('ask'))), askDenySid))).toBe(
      FAIL_CLOSED
    )
    expect(getSessionDecisions(askDenySid)[0].review?.decision).toBe('ask')
    const askAllowSid = newSid()
    await expect(
      run(noChannel(answerOf(verdict('ask'))), askAllowSid, RV_PATH_ASK, {
        missingChannel: 'allow'
      })
    ).resolves.toEqual({ status: 'allowed' })
    expect(getSessionDecisions(askAllowSid)[0].review?.decision).toBe('ask')

    // null：同 ask，日志没有审查意见
    const nullDenySid = newSid()
    expect(await rejectionMessage(run(noChannel(null), nullDenySid))).toBe(FAIL_CLOSED)
    expect(getSessionDecisions(nullDenySid)[0].review).toBeUndefined()
    const nullAllowSid = newSid()
    await expect(
      run(noChannel(null), nullAllowSid, RV_PATH_ASK, { missingChannel: 'allow' })
    ).resolves.toEqual({ status: 'allowed' })
    expect(getSessionDecisions(nullAllowSid)[0].review).toBeUndefined()
  })

  it.each<[string, InputResponse, NonNullable<SecurityDecisionRecord['userResponse']>]>([
    ['allowed', { kind: 'ask', allowed: true }, 'allowed'],
    [
      'allowed_remember',
      { kind: 'ask', allowed: true, extra: { rememberPath: true } },
      'allowed_remember'
    ],
    ['denied', { kind: 'ask', allowed: false }, 'denied'],
    ['feedback', { kind: 'other', text: 'no' }, 'feedback'],
    ['cancel', { kind: 'cancel', reason: 'aborted' }, 'cancel']
  ])(
    'EN-RV20 审查 ask 之后人答 %s：日志照记人的回答，review 是同一份',
    async (_label, response, userResponse) => {
      const sid = newSid()
      const review = reviewer(answerOf(verdict('ask', { risk: 'high' })))
      const { provider, persistGrant } = reviewProvider(review, response)

      await run(provider, sid).catch(() => undefined)
      const logs = getSessionDecisions(sid)
      expect(logs).toHaveLength(1)
      expect(logs[0].userResponse).toBe(userResponse)
      expect(logs[0].review).toEqual({
        decision: 'ask',
        risk: 'high',
        source: 'auto-review',
        ms: expect.any(Number)
      })
      // 「记住」照旧：审查只是先看了一眼，人的授权还是人的
      expect(persistGrant.mock.calls).toEqual(
        userResponse === 'allowed_remember' ? [['read', '/ws/file.txt']] : []
      )
    }
  )

  it('EN-RV21 security_decision 那一行 JSON 里的 review 只有 {decision, risk, source, ms}：summary / reason 与判决上多余的键都不进日志', async () => {
    const sid = newSid()
    const review = reviewer(
      answerOf({
        ...verdict('ask', { risk: 'medium', summary: 'SUMMARY-TEXT', reason: 'REASON-TEXT' }),
        extra: 'EXTRA-TEXT'
      })
    )
    const { provider, info } = reviewProvider(review)
    await run(provider, sid)

    const lines = info.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('security_decision '))
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0].slice('security_decision '.length)) as SecurityDecisionRecord
    expect(Object.keys(record.review!).sort()).toEqual(['decision', 'ms', 'risk', 'source'])
    expect(record.review).toMatchObject({ decision: 'ask', risk: 'medium', source: 'auto-review' })
    for (const text of ['SUMMARY-TEXT', 'REASON-TEXT', 'EXTRA-TEXT']) {
      expect(lines[0]).not.toContain(text)
    }
  })

  it('EN-RV22 接缝耗时 250ms：review.ms 在 250 与 totalMs 之间', async () => {
    vi.useFakeTimers()
    const sid = newSid()
    const review = vi.fn<Reviewer>(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(answerOf(verdict('allow'))), 250)
        })
    )
    const { provider } = reviewProvider(review)

    const result = run(provider, sid)
    await vi.advanceTimersByTimeAsync(250)
    await expect(result).resolves.toEqual({ status: 'allowed' })
    const [log] = getSessionDecisions(sid)
    expect(log.review!.ms).toBeGreaterThanOrEqual(250)
    expect(log.review!.ms).toBeLessThanOrEqual(log.totalMs!)
  })

  it('EN-RV23 判决带多余的键照样被接受；卡片上的 review 只拷 risk / summary / reason', async () => {
    const extras = { extra: 'x', decisionNote: 'y', risk2: 'z' }

    const askSid = newSid()
    const asked = reviewProvider(
      reviewer(
        answerOf({ ...verdict('ask', { risk: 'critical', summary: 'S', reason: 'R' }), ...extras })
      )
    )
    await expect(run(asked.provider, askSid)).resolves.toEqual({ status: 'allowed' })
    const card = onlyCard(asked.requestUserInput)
    expect(Object.keys(card.review!).sort()).toEqual(['reason', 'risk', 'summary'])
    expect(card.review).toEqual({ risk: 'critical', summary: 'S', reason: 'R' })

    // allow 同样被接受：直接放行、不弹卡
    const allowSid = newSid()
    const allowed = reviewProvider(reviewer(answerOf({ ...verdict('allow'), ...extras })))
    await expect(run(allowed.provider, allowSid)).resolves.toEqual({ status: 'allowed' })
    expect(allowed.requestUserInput).not.toHaveBeenCalled()
  })

  it('EN-RV24 审查挂起时会话被停止（abortSessionReviews）：当场抛 abortError、日志 cancel、不弹卡；接缝收到的 signal 被中止', async () => {
    const sid = newSid()
    const pending = pendingReviewer()
    const { provider, requestUserInput } = reviewProvider(pending.review)

    // 没给 opts.signal：会话停止这一条路自己就要能收尾
    const result = run(provider, sid, RV_PATH_ASK, { abortError: 'TOOL_ABORTED' })
    await flush()
    const seamSignal = pending.signal()
    expect(seamSignal.aborted).toBe(false)

    abortSessionReviews(sid)
    expect(seamSignal.aborted).toBe(true)
    expect(await rejectionMessage(result)).toBe('TOOL_ABORTED')
    // 接缝事后才答：不起作用
    pending.answer(answerOf(verdict('allow')))
    await flush()

    expect(requestUserInput).not.toHaveBeenCalled()
    const logs = getSessionDecisions(sid)
    expect(logs).toHaveLength(1)
    expect(logs[0].userResponse).toBe('cancel')
    expect(typeof logs[0].totalMs).toBe('number')
    expect(logs[0].review).toBeUndefined()
  })

  it('EN-RV25 abortSessionReviews 之后新的 ask 档询问：接缝 0 次、抛 abortError（日志 cancel）；reopenSessionReviews 之后恢复；别的会话不受影响', async () => {
    const sid = newSid()
    const other = newSid()
    const review = reviewer(answerOf(verdict('allow')))
    const { provider, requestUserInput } = reviewProvider(review)

    abortSessionReviews(sid)
    expect(
      await rejectionMessage(run(provider, sid, RV_PATH_ASK, { abortError: 'TOOL_ABORTED' }))
    ).toBe('TOOL_ABORTED')
    expect(review).not.toHaveBeenCalled()
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(sid)[0]).toMatchObject({ userResponse: 'cancel' })

    await expect(run(provider, other)).resolves.toEqual({ status: 'allowed' })
    expect(review).toHaveBeenCalledTimes(1)

    reopenSessionReviews(sid)
    await expect(run(provider, sid)).resolves.toEqual({ status: 'allowed' })
    expect(review).toHaveBeenCalledTimes(2)
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('EN-RV26 接缝永不落定、也不理 signal：opts.signal 落下之后百毫秒量级内照样 reject abortError', async () => {
    const sid = newSid()
    const review = vi.fn<Reviewer>(() => new Promise<PermissionReviewAnswer | null>(() => {}))
    const { provider, requestUserInput } = reviewProvider(review)
    const ac = new AbortController()

    const result = run(provider, sid, RV_PATH_ASK, { signal: ac.signal })
    await flush()
    expect(review).toHaveBeenCalledTimes(1)

    const t0 = Date.now()
    ac.abort()
    const settled = await Promise.race([
      result.then(
        () => 'resolved',
        (err: Error) => err.message
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 300))
    ])
    expect(settled).toBe('Aborted')
    expect(Date.now() - t0).toBeLessThan(300)
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it.each<[string, () => { review: Reviewer; decision: SecurityDecision }]>([
    [
      '有审查意见的卡（审查答 ask）',
      () => ({ review: reviewer(answerOf(verdict('ask'))), decision: RV_WRITE_ASK })
    ],
    ['没有审查的卡（接缝回 null）', () => ({ review: reviewer(null), decision: RV_WRITE_ASK })],
    [
      'force-ask 的卡',
      () => ({
        review: reviewer(answerOf(verdict('allow'))),
        decision: {
          ...askDecision({ command: 'Write(/ws/file.txt)' }, PROMPT),
          tier: 'force-ask'
        }
      })
    ]
  ])(
    'EN-RV27 人对%s答「其它」→ humanFeedbackOf 多一条 {ts, target: 卡片主文本, text}',
    async (_label, setup) => {
      const sid = newSid()
      const { review, decision } = setup()
      const { provider, requestUserInput } = reviewProvider(review, {
        kind: 'other',
        text: 'write to notes.md instead'
      })
      expect(humanFeedbackOf(sid)).toEqual([])

      expect(
        await rejectionMessage(
          run(provider, sid, decision, { toolName: 'write' }, requestIn(sid, { action: 'write' }))
        )
      ).toBe(
        'User declined access to /ws/file.txt and provided feedback instead: write to notes.md instead'
      )
      const card = onlyCard(requestUserInput)
      expect(humanFeedbackOf(sid)).toEqual([
        { ts: expect.any(Number), target: card.command, text: 'write to notes.md instead' }
      ])
      expect(card.command).toBe('Write(/ws/file.txt)')
    }
  )

  it('EN-RV27 onOther:return 的命令卡同样记下（目标是命令原文）；allowed / denied / cancel 不记', async () => {
    const commandSid = newSid()
    const { provider } = reviewProvider(reviewer(null), { kind: 'other', text: 'run it in /tmp' })
    await expect(
      run(
        provider,
        commandSid,
        reviewAsk({ command: 'rm -rf build' }),
        { toolName: 'bash', onOther: 'return' },
        requestIn(commandSid, {
          action: 'execute',
          object: { ...COMMAND_OBJECT, command: 'rm -rf build' }
        })
      )
    ).resolves.toEqual({ status: 'feedback', text: 'run it in /tmp' })
    expect(humanFeedbackOf(commandSid)).toEqual([
      { ts: expect.any(Number), target: 'rm -rf build', text: 'run it in /tmp' }
    ])

    const answers: InputResponse[] = [
      { kind: 'ask', allowed: true },
      { kind: 'ask', allowed: false, reason: 'not now' },
      { kind: 'cancel', reason: 'aborted' }
    ]
    for (const response of answers) {
      const sid = newSid()
      await run(reviewProvider(reviewer(null), response).provider, sid).catch(() => undefined)
      expect({ response: response.kind, notes: humanFeedbackOf(sid) }).toEqual({
        response: response.kind,
        notes: []
      })
    }
  })
})

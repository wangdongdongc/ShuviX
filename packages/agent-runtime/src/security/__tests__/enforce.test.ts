/**
 * executeDecision（PEP 共享内脏）—— 三态处置、询问四分支响应、
 * 「允许并记住」与决策日志。错误文案逐字对齐 enforce.ts 内四个文案函数。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeDecision } from '../enforce'
import { clearSessionDecisions, getSessionDecisions } from '../decisionLog'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type {
  EnforceOpts,
  EnforceOutcome,
  SecurityDecision,
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
    getSessionGrants: () => ({ autoAllow: false, allowList: [] }),
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

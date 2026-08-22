/**
 * createSecurityContext（PEP 门面）全链 —— evaluateReadOnly 的 consent 缺省、
 * enforce 的 action/displayPath 转发、禁缓存红线（grants 变化即生效）、
 * L1 全工具门的 allow 即非事件。
 */
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import { createSecurityContext } from '../context'
import { clearSessionDecisions, getSessionDecisions } from '../decisionLog'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type {
  MatchContext,
  ParsedPolicyFile,
  PolicyRuleSpec,
  SecurityHostProvider,
  SecurityObject
} from '../types'
import type { ShellFacts } from '../shell'

/**
 * 手工构造命令客体时的结构属性缺省值 —— 等同「宿主没有注入解析器」。
 * 生产路径只有 enforceCommand 构造命令客体并挂上惰性 getter；这里的用例走
 * ctx.evaluate 传字面量，必须自己补齐，否则引用结构属性的规则求值报错，
 * deny 会 fail-safe 成命中（见 types.ts SecurityObject 的对偶约定）。
 *
 * 补齐之后是什么行为、不补齐是什么后果，分别见本文件末尾的
 * 「enforceCommand 的结构属性接线」一组与 blockCatastrophicCommands.test.ts 的 BC-80。
 */
const NO_SHELL_FACTS = { parsed: false, commands: [], writes: [] }

const SID = 'context-test-session'

const SUBJECT = { kind: 'agent' as const, sessionId: SID, agentKind: 'root' as const }
const ENVIRONMENT = { host: 'desktop' as const, workspaceDir: '/ws' }

const COMMAND_INPUT = { channel: 'bash' as const, command: 'ls -la' }
const GIT_INPUT = { gitAction: 'init', command: 'git init', force: false, delete: false }
const DATABASE_INPUT = {
  sql: 'SELECT * FROM users',
  credential: 'prod-mysql',
  dbType: 'mysql',
  readonly: false
}

function makeProvider(
  grants: { autoAllow: boolean; allowList: string[] },
  overrides: Partial<SecurityHostProvider> = {}
): SecurityHostProvider {
  return {
    host: 'desktop',
    pathSep: '/',
    getVars: () => ({
      workspace: '/ws',
      toolResultsBase: '/tool-results',
      skillsDirs: ['/skills'],
      home: '/home/u',
      systemDirs: []
    }),
    getSessionGrants: () => grants,
    ...overrides
  }
}

afterEach(() => clearSessionDecisions(SID))

describe('createSecurityContext', () => {
  it('CT-1 evaluateReadOnly 缺省排除 consent；{includeConsent:true} 翻转；返回 boolean', () => {
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider({ autoAllow: true, allowList: [] })
    )
    // 凭据目录读取有内置 ask 门（protect-credentials）：consent 缺省不纳入 → 不放行
    const credential: SecurityObject = { type: 'path', path: '/home/u/.ssh/id_rsa' }
    expect(ctx.evaluateReadOnly('read', credential)).toBe(false)
    expect(ctx.evaluateReadOnly('read', credential, { includeConsent: true })).toBe(true)
    expect(typeof ctx.evaluateReadOnly('read', credential)).toBe('boolean')

    // 工作区内读取自由（ask-on-read 的取反放过）；工作区外被内置读取门拦下
    expect(ctx.evaluateReadOnly('read', { type: 'path', path: '/ws/f.txt' })).toBe(true)
    expect(ctx.evaluateReadOnly('read', { type: 'path', path: '/outside/f.txt' })).toBe(false)
  })

  it('CT-2 enforcePath 以 mode 为 action、displayPath 进入展示；enforceCommand/enforceGitOp action=execute', async () => {
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider({ autoAllow: true, allowList: [] })
    )

    await ctx.enforcePath('read', '/ws/a.txt', { toolCallId: 'tc-1', toolName: 'read' })
    await ctx.enforcePath('write', '/ws/a.txt', { toolCallId: 'tc-2', toolName: 'write' })
    await expect(
      ctx.enforceCommand(COMMAND_INPUT, { toolCallId: 'tc-3', toolName: 'bash' })
    ).resolves.toEqual({ status: 'allowed' })
    await ctx.enforceGitOp(GIT_INPUT, { toolCallId: 'tc-4', toolName: 'git' })

    // 日志新→旧：gitTool / command / write / read
    const logs = getSessionDecisions(SID)
    expect(logs.map((l) => [l.action, l.objectKind])).toEqual([
      ['execute', 'gitTool'],
      ['execute', 'command'],
      ['write', 'path'],
      ['read', 'path']
    ])

    // displayPath：无询问通道 fail-closed 的文案使用展示路径
    const strict = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider({ autoAllow: false, allowList: [] })
    )
    await expect(
      strict.enforcePath('write', '/outside/b.txt', {
        toolCallId: 'tc-5',
        toolName: 'write',
        displayPath: 'rel/b.txt'
      })
    ).rejects.toThrow('Access denied: path outside workspace and no way to ask: rel/b.txt')
  })

  it('CT-3 禁缓存：同一实例下 grants 变化即生效', () => {
    const grants = { autoAllow: false, allowList: [] as string[] }
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, makeProvider(grants))

    // ask-on-command：ask → 开免询问后同一实例立即 allow
    const commandObject: SecurityObject = {
      type: 'command',
      channel: 'bash',
      command: 'ls -la',
      ...NO_SHELL_FACTS
    }
    expect(ctx.evaluate('execute', commandObject).effect).toBe('ask')
    grants.autoAllow = true
    const allowed = ctx.evaluate('execute', commandObject)
    expect(allowed.effect).toBe('allow')
    expect(allowed.winning).toBe('session-auto-allow#0')
    grants.autoAllow = false
    expect(
      ctx.evaluate('execute', {
        type: 'gitTool',
        gitAction: 'init',
        command: 'git init',
        force: false,
        delete: false
      }).effect
    ).toBe('ask')

    // allowList 落库（「允许并记住」）立即可见 —— 用带内置 ask 门的凭据路径验证
    const credential: SecurityObject = { type: 'path', path: '/home/u/.ssh/config' }
    expect(ctx.evaluate('read', credential).effect).toBe('ask')
    grants.allowList.push('Read(/home/u/.ssh/config)')
    expect(ctx.evaluate('read', credential).effect).toBe('allow')
  })

  it('CT-W1 端到端旗舰：match 取反工作区的 ask 门 —— 工作区内 allow、区外 ask（vars 流入 match 上下文）', () => {
    // 用户策略同名覆盖内置 ask-on-read（收紧为只看 workspace）——覆盖+match 一并验证
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { autoAllow: false, allowList: [] },
        {
          getUserPolicies: () => [
            {
              name: 'ask-on-read',
              displayName: 'ask-on-read',
              description: '',
              rules: [
                {
                  effect: 'ask' as const,
                  match:
                    "action == 'read' && object.type == 'path' && !inDir(object.path, vars.workspace)"
                }
              ],
              body: ''
            }
          ]
        }
      )
    )

    const inside = ctx.evaluate('read', { type: 'path', path: '/ws/f.txt' })
    expect(inside.effect).toBe('allow')
    expect(inside.winning).toBe('default:path')

    const outside = ctx.evaluate('read', { type: 'path', path: '/outside/f.txt' })
    expect(outside.effect).toBe('ask')
    expect(outside.winning).toBe('ask-on-read#0')
    expect(outside.matched.filter((id) => id.startsWith('ask-on-read'))).toEqual(['ask-on-read#0'])
  })

  it('CT-W2 provider.logger.warn 收到 fail-safe 告警（含 <policy>#<index> 规则 id）', () => {
    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() }
    const provider = makeProvider(
      { autoAllow: false, allowList: [] },
      {
        logger,
        getUserPolicies: () => [
          {
            name: 'wp',
            displayName: 'wp',
            description: '',
            rules: [{ effect: 'ask' as const, match: 'vars.nope == "x"' }],
            body: ''
          }
        ]
      }
    )
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    const decision = ctx.evaluate('read', { type: 'path', path: '/ws/f.txt' })
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('wp#0')
    expect(warn).toHaveBeenCalled()
    const failSafeWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('match evaluation failed'))
    expect(failSafeWarnings).toHaveLength(1)
    expect(failSafeWarnings[0]).toContain("'wp#0'")
    expect(failSafeWarnings[0]).toContain('treating as matched (fail-safe)')
  })
})

const userPolicy = (name: string, rules: PolicyRuleSpec[]): ParsedPolicyFile => ({
  name,
  displayName: name,
  description: '',
  rules,
  body: ''
})

/** 弹了就算失败的询问通道（非事件断言用） */
const rejectingChannel = (): Mock<(req: InputRequest) => Promise<InputResponse>> =>
  vi.fn(async (_req: InputRequest): Promise<InputResponse> => {
    throw new Error('unexpected ask prompt')
  })

/** 用户策略 + 固定询问应答的 provider（enforceInvocation 系列用） */
function invocationProvider(
  rules: PolicyRuleSpec[],
  response: InputResponse = { kind: 'ask', allowed: true }
): { provider: SecurityHostProvider; requestUserInput: ReturnType<typeof vi.fn> } {
  const requestUserInput = vi.fn(async (_req: InputRequest): Promise<InputResponse> => response)
  return {
    provider: makeProvider(
      { autoAllow: false, allowList: [] },
      { requestUserInput, getUserPolicies: () => [userPolicy('tool-gate', rules)] }
    ),
    requestUserInput
  }
}

describe('createSecurityContext — enforceInvocation（L1 全工具门）', () => {
  const INVOCATION_OPTS = { toolCallId: 'tc-inv', toolName: 'ssh', operation: 'connect' }
  const ASK_INVOCATION: PolicyRuleSpec = { effect: 'ask', match: "object.type == 'invocation'" }

  it('CT-T1 默认放行零痕迹：完整内置装配、无用户规则 → allowed；无日志；不弹窗', async () => {
    const requestUserInput = rejectingChannel()
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider({ autoAllow: false, allowList: [] }, { requestUserInput })
    )
    await expect(ctx.enforceInvocation({ ...INVOCATION_OPTS })).resolves.toEqual({
      status: 'allowed'
    })
    expect(getSessionDecisions(SID)).toEqual([])
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('CT-T1b allow 即非事件：autoAllow=true（consent 恒命中）→ 仍 allowed 且无日志、无弹窗', async () => {
    const requestUserInput = rejectingChannel()
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider({ autoAllow: true, allowList: [] }, { requestUserInput })
    )
    await expect(ctx.enforceInvocation({ ...INVOCATION_OPTS })).resolves.toEqual({
      status: 'allowed'
    })
    expect(getSessionDecisions(SID)).toEqual([])
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('CT-T2 用户 ask × invocation → 允许：询问 command="ssh: connect"；日志恰 1 条且 tool 字段正确', async () => {
    const { provider, requestUserInput } = invocationProvider([ASK_INVOCATION])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    await expect(ctx.enforceInvocation({ ...INVOCATION_OPTS })).resolves.toEqual({
      status: 'allowed'
    })
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tc-inv',
        kind: 'ask',
        toolName: 'ssh',
        command: 'ssh: connect'
      })
    )

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      effect: 'ask',
      objectKind: 'invocation',
      objectSummary: 'ssh: connect',
      tool: { name: 'ssh', operation: 'connect' },
      userResponse: 'allowed'
    })
  })

  it('CT-T3 用户 ask × invocation × tool.name==ssh：ssh 弹窗、read 直接 allowed 无日志', async () => {
    const { provider, requestUserInput } = invocationProvider([
      { effect: 'ask', match: "object.type == 'invocation' && tool.name == 'ssh'" }
    ])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    await expect(ctx.enforceInvocation({ toolCallId: 'tc-a', toolName: 'ssh' })).resolves.toEqual({
      status: 'allowed'
    })
    expect(requestUserInput).toHaveBeenCalledTimes(1)

    await expect(ctx.enforceInvocation({ toolCallId: 'tc-b', toolName: 'read' })).resolves.toEqual({
      status: 'allowed'
    })
    expect(requestUserInput).toHaveBeenCalledTimes(1) // read 不弹窗
    expect(getSessionDecisions(SID)).toHaveLength(1) // 只有 ssh 那次 ask 记录
  })

  it('CT-T4 deny × invocation → rejects Denied by security policy rule；日志 effect deny', async () => {
    const { provider, requestUserInput } = invocationProvider([
      { effect: 'deny', match: "object.type == 'invocation'" }
    ])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    await expect(ctx.enforceInvocation({ ...INVOCATION_OPTS })).rejects.toThrow(
      /Denied by security policy rule/
    )
    expect(requestUserInput).not.toHaveBeenCalled()

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(1)
    expect(logs[0].effect).toBe('deny')
    expect(logs[0].userResponse).toBeUndefined()
  })

  it('CT-T5 ask → 拒绝（allowed:false 无 reason）→ throw "User denied ssh: connect"；日志 denied', async () => {
    const { provider } = invocationProvider([ASK_INVOCATION], {
      kind: 'ask',
      allowed: false
    })
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    await expect(ctx.enforceInvocation({ ...INVOCATION_OPTS })).rejects.toThrow(
      'User denied ssh: connect'
    )
    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(1)
    expect(logs[0].userResponse).toBe('denied')
  })

  it('CT-T6 ask + onOther:return → other 反馈 → feedback 结果；日志 feedback', async () => {
    const { provider } = invocationProvider([ASK_INVOCATION], {
      kind: 'other',
      text: 'use the browser tool instead'
    })
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    await expect(ctx.enforceInvocation({ ...INVOCATION_OPTS, onOther: 'return' })).resolves.toEqual(
      { status: 'feedback', text: 'use the browser tool instead' }
    )

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(1)
    expect(logs[0].userResponse).toBe('feedback')
  })

  it('CT-T7 enforcePath 也带 tool 维度：deny × path × tool.name==write 只拦 write 工具', async () => {
    // 用户同名覆盖内置 ask-on-write（避免 ask 门弹窗干扰），换成按工具过滤的 deny
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { autoAllow: false, allowList: [] },
        {
          getUserPolicies: () => [
            userPolicy('ask-on-write', [
              {
                effect: 'deny',
                match: "action == 'write' && object.type == 'path' && tool.name == 'write'"
              }
            ])
          ]
        }
      )
    )

    await expect(
      ctx.enforcePath('write', '/ws/f.txt', { toolCallId: 'tc-w', toolName: 'write' })
    ).rejects.toThrow(/Denied by security policy rule/)
    await expect(
      ctx.enforcePath('write', '/ws/f.txt', { toolCallId: 'tc-r', toolName: 'read' })
    ).resolves.toBeUndefined()

    // 日志新→旧：allow（read 工具经由）/ deny（write 工具经由），tool 字段正确
    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({ effect: 'allow', tool: { name: 'read' } })
    expect(logs[1]).toMatchObject({ effect: 'deny', tool: { name: 'write' } })
  })
})

describe('createSecurityContext — enforceDatabase（数据库查询守卫）', () => {
  const DB_OPTS = { toolCallId: 'tc-db', toolName: 'database', abortError: 'TOOL_ABORTED' }

  /** 固定询问应答的 provider（内置 ask-on-database 对可写连接 ask） */
  function databaseProvider(response: InputResponse): {
    provider: SecurityHostProvider
    requestUserInput: ReturnType<typeof vi.fn>
  } {
    const requestUserInput = vi.fn(async (_req: InputRequest): Promise<InputResponse> => response)
    return {
      provider: makeProvider({ autoAllow: false, allowList: [] }, { requestUserInput }),
      requestUserInput
    }
  }

  it('CT-4 action/objectKind = execute/database；tool 维度取自 opts.toolName（tool.name 规则可命中）', async () => {
    // autoAllow 抵消内置 ask-on-database 的 ask，只留用户规则的按工具 deny（deny 压过 consent）
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { autoAllow: true, allowList: [] },
        {
          getUserPolicies: () => [
            userPolicy('db-tool-gate', [
              { effect: 'deny', match: "object.type == 'database' && tool.name == 'database'" }
            ])
          ]
        }
      )
    )

    await expect(
      ctx.enforceDatabase(DATABASE_INPUT, { ...DB_OPTS, toolCallId: 'tc-db1' })
    ).rejects.toThrow("Denied by security policy rule 'db-tool-gate#0'")
    // 同一客体换工具名：tool 维度不再命中 → consent 放行
    await expect(
      ctx.enforceDatabase(DATABASE_INPUT, { ...DB_OPTS, toolCallId: 'tc-db2', toolName: 'bash' })
    ).resolves.toEqual({ status: 'allowed' })

    // 日志新→旧
    const logs = getSessionDecisions(SID)
    expect(logs.map((l) => [l.action, l.objectKind])).toEqual([
      ['execute', 'database'],
      ['execute', 'database']
    ])
    expect(logs[0].tool).toEqual({ name: 'bash' })
    expect(logs[1].tool).toEqual({ name: 'database' })
  })

  it('CT-5 响应分支：允许 → allowed；拒绝/取消 → throw；other+onOther:return → feedback；用户 deny → 不弹窗直接 throw', async () => {
    const allowed = databaseProvider({ kind: 'ask', allowed: true })
    const ctxAllowed = createSecurityContext(SUBJECT, ENVIRONMENT, allowed.provider)
    await expect(ctxAllowed.enforceDatabase(DATABASE_INPUT, { ...DB_OPTS })).resolves.toEqual({
      status: 'allowed'
    })
    expect(allowed.requestUserInput).toHaveBeenCalledTimes(1)
    expect(getSessionDecisions(SID)[0]).toMatchObject({
      effect: 'ask',
      objectKind: 'database',
      userResponse: 'allowed'
    })
    clearSessionDecisions(SID)

    const denied = databaseProvider({ kind: 'ask', allowed: false })
    await expect(
      createSecurityContext(SUBJECT, ENVIRONMENT, denied.provider).enforceDatabase(DATABASE_INPUT, {
        ...DB_OPTS
      })
    ).rejects.toThrow(`User denied ${DATABASE_INPUT.sql}`)

    const cancelled = databaseProvider({ kind: 'cancel', reason: 'aborted' })
    await expect(
      createSecurityContext(SUBJECT, ENVIRONMENT, cancelled.provider).enforceDatabase(
        DATABASE_INPUT,
        { ...DB_OPTS }
      )
    ).rejects.toThrow('TOOL_ABORTED')

    const other = databaseProvider({ kind: 'other', text: '换个只读连接' })
    await expect(
      createSecurityContext(SUBJECT, ENVIRONMENT, other.provider).enforceDatabase(DATABASE_INPUT, {
        ...DB_OPTS,
        onOther: 'return'
      })
    ).resolves.toEqual({ status: 'feedback', text: '换个只读连接' })

    // 用户 deny 策略：连询问都不弹
    const requestUserInput = rejectingChannel()
    const denyCtx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { autoAllow: false, allowList: [] },
        {
          requestUserInput,
          getUserPolicies: () => [
            userPolicy('db-block', [{ effect: 'deny', match: "object.type == 'database'" }])
          ]
        }
      )
    )
    await expect(denyCtx.enforceDatabase(DATABASE_INPUT, { ...DB_OPTS })).rejects.toThrow(
      /Denied by security policy rule/
    )
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('CT-6 只读连接的 allow 是事件（与 L1 非事件相反）：放行且落一条 allow 日志、不弹窗；autoAllow 归因 consent', async () => {
    const requestUserInput = rejectingChannel()
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider({ autoAllow: false, allowList: [] }, { requestUserInput })
    )

    await expect(
      ctx.enforceDatabase({ ...DATABASE_INPUT, readonly: true }, { ...DB_OPTS })
    ).resolves.toEqual({ status: 'allowed' })
    expect(requestUserInput).not.toHaveBeenCalled()

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      effect: 'allow',
      objectKind: 'database',
      winning: 'default:database'
    })
    expect(logs[0].userResponse).toBeUndefined()
    clearSessionDecisions(SID)

    // 可写连接 + 免询问：同样放行，但归因 consent
    const autoCtx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider({ autoAllow: true, allowList: [] }, { requestUserInput: rejectingChannel() })
    )
    await expect(autoCtx.enforceDatabase(DATABASE_INPUT, { ...DB_OPTS })).resolves.toEqual({
      status: 'allowed'
    })
    expect(getSessionDecisions(SID)[0]).toMatchObject({
      effect: 'allow',
      winning: 'session-auto-allow#0'
    })
  })
})

describe('createSecurityContext — PEP 属性齐全性与 lets 禁缓存', () => {
  it('CT-N1 属性齐全性对偶：读齐各 type 全部文档属性的 match 经三个 enforce 各命中一次，logger.warn 零调用', async () => {
    const warn = vi.fn()
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { autoAllow: false, allowList: [] },
        {
          logger: { info: vi.fn(), warn, error: vi.fn() },
          getUserPolicies: () => [
            userPolicy('attr-probe', [
              {
                effect: 'deny',
                match:
                  "object.type == 'gitTool' && object.gitAction == 'init' && object.command != '' && !object.force && !object.delete"
              },
              {
                effect: 'deny',
                match: "object.type == 'path' && object.path != '' && object.displayPath != ''"
              },
              {
                effect: 'deny',
                match:
                  "object.type == 'command' && object.command != '' && object.channel == 'bash'"
              }
            ])
          ]
        }
      )
    )

    await expect(
      ctx.enforceGitOp(GIT_INPUT, { toolCallId: 'n1', toolName: 'git' })
    ).rejects.toThrow("Denied by security policy rule 'attr-probe#0'")
    // enforcePath 未传 displayPath：客体属性回退 resolvedPath（displayPath 恒在）
    await expect(
      ctx.enforcePath('write', '/ws/f.txt', { toolCallId: 'n2', toolName: 'write' })
    ).rejects.toThrow("Denied by security policy rule 'attr-probe#1'")
    await expect(
      ctx.enforceCommand(COMMAND_INPUT, { toolCallId: 'n3', toolName: 'bash' })
    ).rejects.toThrow("Denied by security policy rule 'attr-probe#2'")

    // PEP 属性文档齐全：strict fail-safe 只该在跨 type 误引时触发，此处零告警
    expect(warn).not.toHaveBeenCalled()
  })

  it('CT-N1b database 属性齐全性对偶：读齐 sql/credential/dbType/readonly 的 match 命中，logger.warn 零调用', async () => {
    const warn = vi.fn()
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { autoAllow: false, allowList: [] },
        {
          logger: { info: vi.fn(), warn, error: vi.fn() },
          getUserPolicies: () => [
            userPolicy('db-attr-probe', [
              {
                effect: 'deny',
                match:
                  "object.type == 'database' && object.sql != '' && object.credential != '' && object.dbType == 'mysql' && !object.readonly"
              }
            ])
          ]
        }
      )
    )

    await expect(
      ctx.enforceDatabase(DATABASE_INPUT, { toolCallId: 'n4', toolName: 'database' })
    ).rejects.toThrow("Denied by security policy rule 'db-attr-probe#0'")
    expect(warn).not.toHaveBeenCalled()
  })

  it('CT-N2 lets 禁缓存：provider vars 中途变化，同一 context 实例下一次 evaluate 立即按新值判定', () => {
    const vars: Record<string, string | string[]> = {
      workspace: '/ws',
      toolResultsBase: '/tool-results',
      skillsDirs: ['/skills'],
      home: '/home/u',
      systemDirs: [],
      blocked: '/ws/a'
    }
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { autoAllow: false, allowList: [] },
        {
          getVars: () => ({ ...vars }),
          getUserPolicies: () => [
            {
              name: 'blocklist',
              displayName: 'blocklist',
              description: '',
              lets: { dirs: '[vars.blocked]' },
              rules: [
                {
                  effect: 'deny' as const,
                  match: "object.type == 'path' && inDir(object.path, dirs)"
                }
              ],
              body: ''
            }
          ]
        }
      )
    )

    // blocked 目录取在工作区内 —— 读取无内置门干扰，deny/allow 对比干净
    const read = (path: string): { effect: string; winning: string } => {
      const decision = ctx.evaluate('read', { type: 'path', path })
      return { effect: decision.effect, winning: decision.winning }
    }

    expect(read('/ws/a/x')).toEqual({ effect: 'deny', winning: 'blocklist#0' })
    expect(read('/ws/b/x')).toEqual({ effect: 'allow', winning: 'default:path' })

    vars.blocked = '/ws/b'
    expect(read('/ws/a/x')).toEqual({ effect: 'allow', winning: 'default:path' })
    expect(read('/ws/b/x')).toEqual({ effect: 'deny', winning: 'blocklist#0' })
  })
})

describe('createSecurityContext — 结构化条件 × 策略级 scope（端到端）', () => {
  /** 带 scope 的用户策略 */
  const scopedPolicy = (
    name: string,
    scope: ParsedPolicyFile['scope'],
    rules: PolicyRuleSpec[]
  ): ParsedPolicyFile => ({ ...userPolicy(name, rules), scope })

  it('CT-C1 scope + tool.name 条件写成的 L1 门与 match 写法等价：ssh 弹窗、read 直接放行且零日志', async () => {
    const requestUserInput = vi.fn(
      async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
    )
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { autoAllow: false, allowList: [] },
        {
          requestUserInput,
          getUserPolicies: () => [
            scopedPolicy(
              'tool-gate',
              { 'subject.kind': ['agent'], 'object.type': ['invocation'], 'env.host': ['desktop'] },
              [{ effect: 'ask', conditions: { 'tool.name': ['ssh'] } }]
            )
          ]
        }
      )
    )

    await expect(
      ctx.enforceInvocation({ toolCallId: 'tc-c1a', toolName: 'ssh', operation: 'connect' })
    ).resolves.toEqual({ status: 'allowed' })
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ask', toolName: 'ssh', command: 'ssh: connect' })
    )

    // 条件不含 read 工具 → L1 非事件（不弹窗、不记日志）
    await expect(
      ctx.enforceInvocation({ toolCallId: 'tc-c1b', toolName: 'read' })
    ).resolves.toEqual({ status: 'allowed' })
    expect(requestUserInput).toHaveBeenCalledTimes(1)

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      objectKind: 'invocation',
      tool: { name: 'ssh', operation: 'connect' },
      winning: 'tool-gate#0'
    })
  })

  it("CT-C2 scope 的 subject.kind 隔离主体：agent 被 deny，user 主体同请求 default allow；改 '*' 后两者同待遇", () => {
    const policy = (kind: string): ParsedPolicyFile =>
      scopedPolicy('block-writes', { 'subject.kind': [kind], 'object.type': ['path'] }, [
        { effect: 'deny', conditions: { action: ['write'] } }
      ])

    const contexts = (
      kind: string
    ): {
      agent: ReturnType<typeof createSecurityContext>
      user: ReturnType<typeof createSecurityContext>
    } => {
      const provider = makeProvider(
        { autoAllow: false, allowList: [] },
        { getUserPolicies: () => [policy(kind)] }
      )
      return {
        agent: createSecurityContext(SUBJECT, ENVIRONMENT, provider),
        user: createSecurityContext({ kind: 'user', sessionId: SID }, ENVIRONMENT, provider)
      }
    }

    const target: SecurityObject = { type: 'path', path: '/ws/f.txt' }

    const agentOnly = contexts('agent')
    expect(agentOnly.agent.evaluate('write', target)).toMatchObject({
      effect: 'deny',
      winning: 'block-writes#0'
    })
    // user 主体：该策略不命中，内置写入门也只对 agent 生效 → 默认放行
    expect(agentOnly.user.evaluate('write', target)).toMatchObject({
      effect: 'allow',
      winning: 'default:path'
    })
    // 条件的 action 维度同样生效：读取不被这条 deny 命中
    expect(agentOnly.agent.evaluate('read', target).effect).toBe('allow')

    const anySubject = contexts('*')
    expect(anySubject.agent.evaluate('write', target).effect).toBe('deny')
    expect(anySubject.user.evaluate('write', target)).toMatchObject({
      effect: 'deny',
      winning: 'block-writes#0'
    })
  })
})

/**
 * 用户策略写 `effect: consent` —— 与内置会话授权同一层：压得过询问门、输给 deny。
 * 用户来源没有额外限制（consent 不是内置专属），这几条端到端钉住那条结算偏序。
 */
describe('createSecurityContext — 用户策略的 consent（端到端）', () => {
  const scopedPolicy = (
    name: string,
    scope: ParsedPolicyFile['scope'],
    rules: PolicyRuleSpec[]
  ): ParsedPolicyFile => ({ ...userPolicy(name, rules), scope })

  /** 路径类客体的用户策略（scope 放身份标签，与内置同一书写约定） */
  const pathPolicy = (name: string, rules: PolicyRuleSpec[]): ParsedPolicyFile =>
    scopedPolicy(name, { 'subject.kind': ['agent'], 'object.type': ['path'] }, rules)

  const contextWith = (
    policies: ParsedPolicyFile[],
    grants = { autoAllow: false, allowList: [] as string[] }
  ): ReturnType<typeof createSecurityContext> =>
    createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(grants, { getUserPolicies: () => policies })
    )

  it('CU-1 旗舰：用户 consent 局部放宽读取门 —— /data 读放行归因用户规则，区外读与 /data 写照旧 ask', () => {
    const ctx = contextWith([
      pathPolicy('trust-data', [
        {
          effect: 'consent',
          conditions: { action: ['read'] },
          match: "inDir(object.path, '/data')"
        }
      ])
    ])

    // /data 读：consent 压过内置 ask-on-read → allow，归因到用户规则
    const granted = ctx.evaluate('read', { type: 'path', path: '/data/x.txt' })
    expect(granted.effect).toBe('allow')
    expect(granted.winning).toBe('trust-data#0')
    // 门没被拆掉，只是被压过 —— ask-on-read 仍在 matched 里（决策日志据此回链）
    expect(granted.matched).toContain('ask-on-read#0')

    // 放宽是局部的：策略没提的路径仍归内置读取门管
    const elsewhere = ctx.evaluate('read', { type: 'path', path: '/elsewhere/f.txt' })
    expect(elsewhere.effect).toBe('ask')
    expect(elsewhere.winning).toBe('ask-on-read#0')

    // 放宽是按 action 的：同一目录的写入不受这条 read consent 影响
    const write = ctx.evaluate('write', { type: 'path', path: '/data/x.txt' })
    expect(write.effect).toBe('ask')
    expect(write.winning).toBe('ask-on-write#0')
  })

  it('CU-2 用户 consent 压不过内置 deny：~/.ssh 写入仍 deny，归因 protect-credentials#0', () => {
    const ctx = contextWith([
      pathPolicy('trust-ssh', [
        {
          effect: 'consent',
          conditions: { action: ['write'] },
          match: "inDir(object.path, vars.home + '/.ssh')"
        }
      ])
    ])

    const decision = ctx.evaluate('write', { type: 'path', path: '/home/u/.ssh/id_rsa' })
    expect(decision.effect).toBe('deny')
    expect(decision.winning).toBe('protect-credentials#0')
    // consent 规则确实命中了（是被 deny 压过，而不是没匹配上）
    expect(decision.matched).toContain('trust-ssh#0')
  })

  it('CU-3 同文件 ask 在前、consent 在后 → 仍 allow：优先序由 tier 决定，不是书写顺序', () => {
    const ctx = contextWith([
      pathPolicy('order-probe', [
        { effect: 'ask', conditions: { action: ['read'] }, match: "inDir(object.path, '/data')" },
        {
          effect: 'consent',
          conditions: { action: ['read'] },
          match: "inDir(object.path, '/data')"
        }
      ])
    ])

    const decision = ctx.evaluate('read', { type: 'path', path: '/data/x.txt' })
    expect(decision.effect).toBe('allow')
    expect(decision.winning).toBe('order-probe#1')
    // matched 按 tier 序：consent 在前、ask 在后（与书写顺序相反）
    expect(decision.matched.indexOf('order-probe#1')).toBeLessThan(
      decision.matched.indexOf('order-probe#0')
    )
  })

  it('CU-4 evaluateReadOnly 缺省丢弃所有 consent（用户策略也不例外）；{includeConsent:true} 翻转', () => {
    const ctx = contextWith([
      pathPolicy('trust-data', [
        {
          effect: 'consent',
          conditions: { action: ['read'] },
          match: "inDir(object.path, '/data')"
        }
      ])
    ])
    const target: SecurityObject = { type: 'path', path: '/data/x.txt' }

    // 按 tier 过滤而非按来源：用户 md 里写死的 consent 同样被丢弃（EvaluateOpts 的显式契约）
    expect(ctx.evaluateReadOnly('read', target)).toBe(false)
    expect(ctx.evaluateReadOnly('read', target, { includeConsent: true })).toBe(true)
    // 对照：主动评估（evaluate）缺省纳入 consent
    expect(ctx.evaluate('read', target).effect).toBe('allow')
  })

  it('CU-5 照 session-auto-allow 正文的收窄示例同名覆盖：免询问只覆盖读与执行，写仍 ask', () => {
    // 与内置 session-auto-allow 正文「To adjust」示例逐字同构
    const ctx = contextWith(
      [
        scopedPolicy('session-auto-allow', { 'subject.kind': ['agent'] }, [
          {
            effect: 'consent',
            conditions: { action: ['read', 'execute'] },
            match: 'vars.autoAllow'
          }
        ])
      ],
      { autoAllow: true, allowList: [] }
    )

    // 命令（execute）：照常被免询问放行
    const command = ctx.evaluate('execute', {
      type: 'command',
      ...NO_SHELL_FACTS,
      channel: 'bash',
      command: 'ls -la'
    })
    expect(command.effect).toBe('allow')
    expect(command.winning).toBe('session-auto-allow#0')

    // 区外读取：同样放行
    expect(ctx.evaluate('read', { type: 'path', path: '/outside/f.txt' })).toMatchObject({
      effect: 'allow',
      winning: 'session-auto-allow#0'
    })

    // 写入：收窄后不再被免询问覆盖 → 内置写入门重新生效
    expect(ctx.evaluate('write', { type: 'path', path: '/outside/f.txt' })).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-write#0'
    })
  })

  it('CU-6 同名覆盖 session-path-grants 为 rules: [] → 已授权路径重新 ask；免询问开关不受影响', () => {
    const grants = { autoAllow: false, allowList: ['Write(/data)'] }
    const emptyOverride = [userPolicy('session-path-grants', [])]

    // 对照：内置在位时授权生效
    expect(
      contextWith([], grants).evaluate('write', { type: 'path', path: '/data/x.txt' })
    ).toMatchObject({ effect: 'allow', winning: 'session-path-grants#1' })

    // 覆盖成空规则：条目还在会话里，但没有策略读它了 → 回到询问
    const stripped = contextWith(emptyOverride, grants)
    expect(stripped.evaluate('write', { type: 'path', path: '/data/x.txt' })).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-write#0'
    })

    // 另一份会话授权策略是独立的：免询问照常放行
    const autoAllow = contextWith(emptyOverride, { autoAllow: true, allowList: [] })
    expect(autoAllow.evaluate('write', { type: 'path', path: '/data/x.txt' })).toMatchObject({
      effect: 'allow',
      winning: 'session-auto-allow#0'
    })
  })
})

describe('createSecurityContext — 授权快照一次性（回归守护）', () => {
  it('CV-3 一次 evaluate 里 getSessionGrants / getVars 各恰好 1 次，决策取第一次快照', () => {
    // 每次调用翻转的 stub：若装配与求值各自 buildPolicyVars，两处会看到不同的授权视图
    let call = 0
    const getSessionGrants = vi.fn(() => ({ autoAllow: call++ === 0, allowList: [] as string[] }))
    const getVars = vi.fn(() => ({
      workspace: '/ws',
      toolResultsBase: '/tool-results',
      skillsDirs: ['/skills'],
      home: '/home/u',
      systemDirs: [] as string[]
    }))

    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, {
      host: 'desktop',
      pathSep: '/',
      getVars,
      getSessionGrants
    })

    // 第一次快照 autoAllow=true → 命令被免询问放行
    const first = ctx.evaluate('execute', {
      type: 'command',
      channel: 'bash',
      command: 'ls -la',
      ...NO_SHELL_FACTS
    })
    expect(first).toMatchObject({ effect: 'allow', winning: 'session-auto-allow#0' })
    // 丢掉 assembleRules 的第二参（各自 buildPolicyVars）时，这两个计数会变成 2
    expect(getSessionGrants).toHaveBeenCalledTimes(1)
    expect(getVars).toHaveBeenCalledTimes(1)

    // 第二次评估重新取快照（禁缓存），此时 autoAllow 已翻回 false → 询问门回来
    const second = ctx.evaluate('execute', {
      type: 'command',
      channel: 'bash',
      command: 'ls -la',
      ...NO_SHELL_FACTS
    })
    expect(second.effect).toBe('ask')
    expect(getSessionGrants).toHaveBeenCalledTimes(2)
    expect(getVars).toHaveBeenCalledTimes(2)
  })
})

describe('createSecurityContext — fail-safe 无 logger', () => {
  it('CT-W3 provider 无 logger → fail-safe 不 crash、决策相同', () => {
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { autoAllow: false, allowList: [] },
        {
          getUserPolicies: () => [
            {
              name: 'wp',
              displayName: 'wp',
              description: '',
              rules: [{ effect: 'ask' as const, match: 'vars.nope == "x"' }],
              body: ''
            }
          ]
        }
      )
    )
    const decision = ctx.evaluate('read', { type: 'path', path: '/ws/f.txt' })
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('wp#0')
  })
})

/**
 * 命令客体的结构属性（惰性 + 记忆化 + 非枚举）—— 只能走 enforceCommand 观察。
 *
 * 这三条性质各自防的是一件具体的事：惰性防「没人引用也把每条命令都解析一遍」，
 * 记忆化防「一条规则里多次引用 object.commands 就重复解析」，非枚举防「决策日志
 * 一序列化就把整棵树拖进日志、顺带触发解析」。它们只在门面构造客体时挂上，
 * 传字面量的 ctx.evaluate 用例（见文件头 NO_SHELL_FACTS）观察不到。
 */
describe('createSecurityContext — enforceCommand 的结构属性接线', () => {
  const SHELL_SID = 'context-shell-session'
  const SHELL_SUBJECT = { kind: 'agent' as const, sessionId: SHELL_SID, agentKind: 'root' as const }
  const SPAN = { start: 0, end: 0 }

  afterEach(() => clearSessionDecisions(SHELL_SID))

  /** `rm -rf /` 的解析事实（手工字面量 —— 这组测的是接线，不是解析） */
  const rmRootFacts = (): ShellFacts => ({
    source: 'rm -rf /',
    parsed: true,
    reason: 'ok',
    errorSpans: [],
    wordOnly: true,
    wordOnlyCommands: [['rm', '-rf', '/']],
    literalCommands: [
      { name: 'rm', base: 'rm', argv: ['rm', '-rf', '/'], complete: true, span: SPAN, depth: 0 }
    ],
    dynamics: [],
    redirects: [],
    depthExceeded: false
  })

  /** 解析器就绪但什么都没抽到 —— 与「宿主没注入解析器」同形态 */
  const unparsedFacts = (source: string): ShellFacts => ({
    source,
    parsed: false,
    reason: 'not-initialized',
    errorSpans: [],
    wordOnly: false,
    wordOnlyCommands: [],
    literalCommands: [],
    dynamics: [],
    redirects: [],
    depthExceeded: false
  })

  /** 允许一切的询问通道（ask 决策要走完 enforce 才看得到 status） */
  const allowingChannel = (): Mock<(req: InputRequest) => Promise<InputResponse>> =>
    vi.fn(async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: true }))

  function shellProvider(
    parser: Partial<SecurityHostProvider['shellParser']> & { analyze: Mock },
    overrides: Partial<SecurityHostProvider> = {}
  ): SecurityHostProvider {
    return makeProvider(
      { autoAllow: false, allowList: [] },
      {
        shellParser: {
          ensureReady: parser.ensureReady ?? (async () => {}),
          analyze: parser.analyze as unknown as (command: string) => ShellFacts
        },
        requestUserInput: allowingChannel(),
        ...overrides
      }
    )
  }

  it('CT-S1 一次 enforce 只解析一次：三条 deny 规则多次引用 object.commands 也只跑一遍', async () => {
    const analyze = vi.fn(() => rmRootFacts())
    const ensureReady = vi.fn(async () => {})
    const ctx = createSecurityContext(
      SHELL_SUBJECT,
      ENVIRONMENT,
      shellProvider({ analyze, ensureReady })
    )
    await expect(
      ctx.enforceCommand(
        { channel: 'bash', command: 'rm -rf /' },
        { toolCallId: 's1', toolName: 'bash' }
      )
    ).rejects.toThrow('block-catastrophic-commands#0')
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(ensureReady).toHaveBeenCalledTimes(1)
  })

  it('CT-S2 记忆化只在单次调用内：两次 enforce 各解析一次（客体不跨调用复用）', async () => {
    const analyze = vi.fn(() => unparsedFacts('ls -la'))
    const ctx = createSecurityContext(SHELL_SUBJECT, ENVIRONMENT, shellProvider({ analyze }))
    const opts = { toolCallId: 's2', toolName: 'bash' }
    await ctx.enforceCommand({ channel: 'bash', command: 'ls -la' }, opts)
    await ctx.enforceCommand({ channel: 'bash', command: 'ls -la' }, opts)
    expect(analyze).toHaveBeenCalledTimes(2)
  })

  it('CT-S3 无策略引用结构属性时一次都不解析（惰性）', async () => {
    // 用户同名覆盖把 block-catastrophic-commands 换成只看原文的版本 —— 于是全部内置
    // 策略都不碰 object.commands。此时解析器不该被叫醒：命令工具是高频路径，
    // 「用不上也每条都解析一遍」的成本会一直挂在那里。
    const analyze = vi.fn(() => rmRootFacts())
    const ctx = createSecurityContext(
      SHELL_SUBJECT,
      ENVIRONMENT,
      shellProvider(
        { analyze },
        {
          getUserPolicies: () => [
            userPolicy('block-catastrophic-commands', [
              {
                effect: 'deny' as const,
                conditions: { 'subject.kind': ['agent'], 'object.type': ['command'] },
                match: "object.command == 'nope'"
              }
            ])
          ]
        }
      )
    )
    const outcome = await ctx.enforceCommand(
      { channel: 'bash', command: 'rm -rf /' },
      { toolCallId: 's3', toolName: 'bash' }
    )
    expect(outcome).toEqual({ status: 'allowed' })
    expect(analyze).not.toHaveBeenCalled()
    const logged = getSessionDecisions(SHELL_SID)[0]
    expect([logged.effect, logged.winning]).toEqual(['ask', 'ask-on-command#0'])
  })

  it('CT-S4 结构化条件短路同样不触发解析（user 主体够不着 agent 限定的规则）', async () => {
    // 条件是原生谓词且排在 CEL 之前 —— 条件不命中的请求既不跑 CEL 也不碰 lets，
    // 自然也不会读到惰性属性。
    const analyze = vi.fn(() => rmRootFacts())
    const ctx = createSecurityContext(
      { kind: 'user', sessionId: SHELL_SID },
      ENVIRONMENT,
      shellProvider({ analyze })
    )
    await expect(
      ctx.enforceCommand(
        { channel: 'bash', command: 'rm -rf /' },
        { toolCallId: 's4', toolName: 'bash' }
      )
    ).resolves.toEqual({ status: 'allowed' })
    expect(analyze).not.toHaveBeenCalled()
  })

  it('CT-S5 结构属性非枚举、不进序列化，且序列化不触发解析', async () => {
    // 普通命令即可 —— 这条测的是客体形态，不是判决
    const analyze = vi.fn(
      (): ShellFacts => ({
        ...unparsedFacts('ls -la'),
        parsed: true,
        reason: 'ok',
        literalCommands: [
          { name: 'ls', base: 'ls', argv: ['ls', '-la'], complete: true, span: SPAN, depth: 0 }
        ]
      })
    )
    let captured: MatchContext['object'] | undefined
    const ctx = createSecurityContext(
      SHELL_SUBJECT,
      ENVIRONMENT,
      shellProvider(
        { analyze },
        {
          derivedRules: () => [
            {
              id: 'derived:capture',
              effect: 'allow' as const,
              tier: 'static-allow' as const,
              source: { kind: 'derived' as const },
              matches: (matchCtx) => {
                captured = matchCtx.object
                return false
              }
            }
          ]
        }
      )
    )
    await ctx.enforceCommand(
      { channel: 'bash', command: 'ls -la' },
      { toolCallId: 's5', toolName: 'bash' }
    )

    expect(captured).toBeDefined()
    expect(Object.keys(captured!)).toEqual(['type', 'command', 'channel'])
    const serialized = JSON.stringify(captured)
    for (const key of ['parsed', 'commands', 'writes']) {
      expect(serialized).not.toContain(key)
    }
    const beforeManualRead = analyze.mock.calls.length
    // 直接读才触发（本次决策里 block-catastrophic-commands 已读过，故已是 1）
    expect(Array.isArray(captured!.commands)).toBe(true)
    expect(analyze.mock.calls.length).toBe(beforeManualRead)
  })

  it('CT-S6 决策日志不含结构属性；objectSummary 仍是命令原文', async () => {
    const info = vi.fn()
    const analyze = vi.fn(() => unparsedFacts('ls -la'))
    const ctx = createSecurityContext(
      SHELL_SUBJECT,
      ENVIRONMENT,
      shellProvider({ analyze }, { logger: { info, warn: vi.fn(), error: vi.fn() } })
    )
    await ctx.enforceCommand(
      { channel: 'bash', command: 'ls -la' },
      { toolCallId: 's6', toolName: 'bash' }
    )
    const lines = info.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('security_decision'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('"commands"')
    expect(lines[0]).not.toContain('"writes"')
    expect(lines[0]).toContain('"objectSummary":"ls -la"')
  })

  it('CT-S7 analyze 抛错 → 按未解析处理：只告警，命令落回询问', async () => {
    const warn = vi.fn()
    const analyze = vi.fn(() => {
      throw new Error('boom')
    })
    const ctx = createSecurityContext(
      SHELL_SUBJECT,
      ENVIRONMENT,
      shellProvider({ analyze }, { logger: { info: vi.fn(), warn, error: vi.fn() } })
    )
    await expect(
      ctx.enforceCommand(
        { channel: 'bash', command: 'rm -rf /' },
        { toolCallId: 's7', toolName: 'bash' }
      )
    ).resolves.toEqual({ status: 'allowed' })
    const messages = warn.mock.calls.map((c) => String(c[0]))
    expect(messages.filter((m) => m.includes('shell 解析抛错'))).toHaveLength(1)
    expect(getSessionDecisions(SHELL_SID)[0].effect).toBe('ask')
  })

  it('CT-S8 ensureReady 拒绝 → 只告警不阻断（解析器确实未就绪时命令按未解析处理）', async () => {
    // ⚠️ 必须自带返回 parsed:false 的 analyze —— 解析器是进程级单例，别处已初始化时
    // ensureReady 抛错后 analyze 照样成功、策略照常命中。用真解析器写这条测的就不是
    // 这件事了。types.ts 的措辞也据此收敛为「若解析器未就绪则呈现为未解析」。
    const warn = vi.fn()
    const analyze = vi.fn(() => unparsedFacts('rm -rf /'))
    const ctx = createSecurityContext(
      SHELL_SUBJECT,
      ENVIRONMENT,
      shellProvider(
        {
          analyze,
          ensureReady: async () => {
            throw new Error('wasm gone')
          }
        },
        { logger: { info: vi.fn(), warn, error: vi.fn() } }
      )
    )
    await expect(
      ctx.enforceCommand(
        { channel: 'bash', command: 'rm -rf /' },
        { toolCallId: 's8', toolName: 'bash' }
      )
    ).resolves.toEqual({ status: 'allowed' })
    const messages = warn.mock.calls.map((c) => String(c[0]))
    expect(messages.filter((m) => m.includes('shell 解析器初始化失败'))).toHaveLength(1)
    expect(getSessionDecisions(SHELL_SID)[0].effect).toBe('ask')
  })

  it('CT-S9 ensureReady 先于首次 analyze（CEL 求值同步，解析必须在求值前就绪）', async () => {
    const order: string[] = []
    const ensureReady = vi.fn(async () => {
      order.push('ensureReady')
    })
    const analyze = vi.fn(() => {
      order.push('analyze')
      return rmRootFacts()
    })
    const ctx = createSecurityContext(
      SHELL_SUBJECT,
      ENVIRONMENT,
      shellProvider({ analyze, ensureReady })
    )
    await expect(
      ctx.enforceCommand(
        { channel: 'bash', command: 'rm -rf /' },
        { toolCallId: 's9', toolName: 'bash' }
      )
    ).rejects.toThrow()
    expect(order[0]).toBe('ensureReady')
    expect(order).toContain('analyze')
  })

  it('CT-S10 宿主省略 shellParser：不抛、零告警、命令落回询问', async () => {
    const warn = vi.fn()
    const ctx = createSecurityContext(
      SHELL_SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { autoAllow: false, allowList: [] },
        { requestUserInput: allowingChannel(), logger: { info: vi.fn(), warn, error: vi.fn() } }
      )
    )
    await expect(
      ctx.enforceCommand(
        { channel: 'bash', command: 'rm -rf /' },
        { toolCallId: 's10', toolName: 'bash' }
      )
    ).resolves.toEqual({ status: 'allowed' })
    expect(warn).not.toHaveBeenCalled()
    const logged = getSessionDecisions(SHELL_SID)[0]
    expect([logged.effect, logged.winning]).toEqual(['ask', 'ask-on-command#0'])
  })
})

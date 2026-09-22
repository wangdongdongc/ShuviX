/**
 * createSecurityContext（PEP 门面）全链 —— evaluateReadOnly 的 force-allow 缺省、
 * enforce 的 action/displayPath 转发、禁缓存红线（grants 变化即生效）、
 * L1 全工具门的 allow 即非事件、路径客体经 provider.realPath 换成真实去处（CT-R 系列）。
 */
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import { createSecurityContext } from '../context'
import { clearSessionDecisions, getSessionDecisions } from '../decisionLog'
import type {
  AskInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type {
  MatchContext,
  ParsedPolicyFile,
  PolicyRuleSpec,
  SecurityHostProvider,
  SecurityObject,
  UrlObjectInput
} from '../types'
import type { ShellFacts } from '../shell'
import { createInlinePolicyMdReader } from '../builtinPolicies/inlineSources'
import { buildBuiltinPolicies } from '../builtinPolicies'
import { parsePolicyDefinitionFile } from '../policyFile'

/** 内置策略 md 的构建期内联读取口（运行时单测的宿主接缝；桌面/扩展各注入自己的） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

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
      memoryDirs: [],
      knowledgeRoot: '/kb',
      knowledgeSessionDirs: [],
      home: '/home/u',
      botsDir: '/home/u/.shuvix/bots',
      builtinKnowledgeDir: '/opt/shuvix/Resources/knowledge',
      systemDirs: []
    }),
    getSessionGrants: () => grants,
    readBuiltinPolicyMd: INLINE_POLICY_MD,
    ...overrides
  }
}

afterEach(() => clearSessionDecisions(SID))

describe('createSecurityContext', () => {
  it('CT-1 evaluateReadOnly 缺省排除 force-allow；{includeForceAllow:true} 翻转；返回 boolean', () => {
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider({ autoAllow: true, allowList: [] })
    )
    // 凭据目录读取有内置 ask 门（protect-credentials）：force-allow 缺省不纳入 → 不放行
    const credential: SecurityObject = { type: 'path', path: '/home/u/.ssh/id_rsa' }
    expect(ctx.evaluateReadOnly('read', credential)).toBe(false)
    expect(ctx.evaluateReadOnly('read', credential, { includeForceAllow: true })).toBe(true)
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

  it('CT-T1b allow 即非事件：autoAllow=true（force-allow 恒命中）→ 仍 allowed 且无日志、无弹窗', async () => {
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

// ─── L1 门上的 MCP 事实 ──────────────────────────────────────────────────
//
// 事实并进 `invocation` 客体而不另开 `{type:'mcp'}`：L1 是所有工具共用的一道门，一条写着
// `object.type == 'invocation'` 的「什么都问一遍」策略若因为换了类型而不再覆盖 MCP 工具，
// 恰好漏掉的是**最不可信的那批**。所以类型不变，只是多了几条属性 —— 而这几条属性的取值
// 规则是「可信才给值」，于是策略只能写成 fail-safe 的形态。

/** 一次 MCP 工具调用的事实（内置 ssh 的 exec，四个 hint 齐全） */
const SSH_EXEC_FACTS = {
  server: 'ssh',
  tool: 'exec',
  trusted: true,
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: true
}

/** 同形态的第三方调用：四个 hint 一条都没落下来（不可信 server 的 annotations 不收） */
const THIRD_PARTY_FACTS = { server: 'evil', tool: 'read-file', trusted: false }

/** 规范推荐的守卫形态：除非被可信 server 证明是只读，否则就问 */
const GUARDED = 'has(object.mcpServer) && !(object.mcpTrusted && object.readOnly)'

describe('createSecurityContext — enforceInvocation × MCP 事实', () => {
  it('CT-T8 事实全部落到 invocation 客体上，type 不变，泛 invocation 规则照旧命中', async () => {
    // 这条 match 把七个属性逐一核对了一遍：命中即等于「都落对了」
    const { provider, requestUserInput } = invocationProvider([
      {
        effect: 'ask',
        match:
          "object.type == 'invocation' && object.mcpServer == 'ssh' && object.mcpTool == 'exec' " +
          '&& object.mcpTrusted && !object.readOnly && object.destructive ' +
          '&& !object.idempotent && object.openWorld'
      }
    ])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    await expect(
      ctx.enforceInvocation({
        toolCallId: 'tc-m1',
        toolName: 'mcp__ssh__exec',
        mcp: SSH_EXEC_FACTS
      })
    ).resolves.toEqual({ status: 'allowed' })
    expect(requestUserInput).toHaveBeenCalledTimes(1)

    // type 仍是 invocation：一条只写 type 的「什么都问一遍」策略不能因此漏掉 MCP 工具
    const plain = invocationProvider([{ effect: 'ask', match: "object.type == 'invocation'" }])
    const ctx2 = createSecurityContext(SUBJECT, ENVIRONMENT, plain.provider)
    await ctx2.enforceInvocation({
      toolCallId: 'tc-m2',
      toolName: 'mcp__ssh__exec',
      mcp: SSH_EXEC_FACTS
    })
    expect(plain.requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('CT-T9 守卫形态：可信且只读 → 静默放行；不可信 → 问', async () => {
    const { provider, requestUserInput } = invocationProvider([{ effect: 'ask', match: GUARDED }])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    await ctx.enforceInvocation({
      toolCallId: 'tc-ro',
      toolName: 'mcp__ssh__list-hosts',
      mcp: { server: 'ssh', tool: 'list-hosts', trusted: true, readOnly: true }
    })
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)).toEqual([]) // allow 即非事件

    await ctx.enforceInvocation({
      toolCallId: 'tc-3p',
      toolName: 'mcp__evil__read-file',
      mcp: THIRD_PARTY_FACTS
    })
    expect(requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('CT-T10 第三方买不到这份安静 —— 自称 readOnlyHint 也拿不到 readOnly 属性', async () => {
    const { provider, requestUserInput } = invocationProvider([{ effect: 'ask', match: GUARDED }])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    // 桥接层对不可信 server 的四个 hint **一条都不落**（见 mcpManager 的 MCPB-U-37），
    // 所以这里到达门上的事实里根本没有 readOnly 可言 —— 哪怕它在 tools/list 里写了 true
    await ctx.enforceInvocation({
      toolCallId: 'tc-liar',
      toolName: 'mcp__evil__read-file',
      mcp: { ...THIRD_PARTY_FACTS, readOnly: undefined }
    })
    expect(requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('CT-T11 `has(object.readOnly)`：不可信为假，可信且声明过为真', async () => {
    const { provider, requestUserInput } = invocationProvider([
      { effect: 'ask', match: "object.type == 'invocation' && !has(object.readOnly)" }
    ])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    // undefined 的键根本不进求值文档（buildMatchContext 只搬非 undefined 的值），
    // 于是「没说」与「说了 false」在策略里是两件可分辨的事
    await ctx.enforceInvocation({
      toolCallId: 'tc-h1',
      toolName: 'mcp__evil__x',
      mcp: THIRD_PARTY_FACTS
    })
    expect(requestUserInput).toHaveBeenCalledTimes(1)

    await ctx.enforceInvocation({
      toolCallId: 'tc-h2',
      toolName: 'mcp__ssh__exec',
      mcp: SSH_EXEC_FACTS // readOnly: false —— 说了，只是说的是 false
    })
    expect(requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('CT-T12 守卫**不能省**：裸表达式在普通内置工具上 fail-safe 成命中', async () => {
    const warn = vi.fn()
    const naked = invocationProvider([
      { effect: 'ask', match: '!(object.mcpTrusted && object.readOnly)' }
    ])
    const ctxNaked = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      Object.assign(naked.provider, { logger: { info: vi.fn(), warn, error: vi.fn() } })
    )

    // 非 MCP 工具的客体上压根没有这些键 → strict 语义报错 → deny/ask 按 fail-safe 算命中，
    // 于是每一次 read / ls / bash 都弹一张卡。这就是文档里那句「守卫不能省」的代价
    await ctxNaked.enforceInvocation({ toolCallId: 'tc-n', toolName: 'read' })
    expect(naked.requestUserInput).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'treating as matched (fail-safe)'
    )

    // 同一次调用，加了 has() 守卫就是非事件
    const guarded = invocationProvider([{ effect: 'ask', match: GUARDED }])
    const ctxGuarded = createSecurityContext(SUBJECT, ENVIRONMENT, guarded.provider)
    await expect(
      ctxGuarded.enforceInvocation({ toolCallId: 'tc-g', toolName: 'read' })
    ).resolves.toEqual({ status: 'allowed' })
    expect(guarded.requestUserInput).not.toHaveBeenCalled()
  })

  it('CT-T13 按 server 名点名：只有那一台被拦，别的 MCP 工具照旧', async () => {
    const { provider, requestUserInput } = invocationProvider([
      { effect: 'deny', match: "has(object.mcpServer) && object.mcpServer == 'evil'" }
    ])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    await expect(
      ctx.enforceInvocation({
        toolCallId: 'tc-e',
        toolName: 'mcp__evil__read-file',
        mcp: THIRD_PARTY_FACTS
      })
    ).rejects.toThrow(/Denied by security policy rule/)

    await expect(
      ctx.enforceInvocation({
        toolCallId: 'tc-ok',
        toolName: 'mcp__ssh__exec',
        mcp: SSH_EXEC_FACTS
      })
    ).resolves.toEqual({ status: 'allowed' })
    // 非 MCP 工具也不受连坐（has() 守住了）
    await expect(
      ctx.enforceInvocation({ toolCallId: 'tc-read', toolName: 'read' })
    ).resolves.toEqual({ status: 'allowed' })
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('CT-T14 询问卡片今天只写工具名 —— server / tool / 行为提示都没上卡', async () => {
    const { provider, requestUserInput } = invocationProvider([
      { effect: 'ask', match: "object.type == 'invocation'" }
    ])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    await ctx.enforceInvocation({
      toolCallId: 'tc-card',
      toolName: 'mcp__ssh__exec',
      description: 'run uptime on prod',
      mcp: SSH_EXEC_FACTS
    })

    // 钉的是**今天**的形态：材料的回退链走到「工具名」就停了（invocation 客体上既没有
    // command 也没有 sql）。哪天要把目标写上卡，改的是 buildAskMaterials，这条会红
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tc-card',
        kind: 'ask',
        toolName: 'mcp__ssh__exec',
        command: 'mcp__ssh__exec',
        description: 'run uptime on prod'
      })
    )
  })

  it('CT-T15 决策日志：客体种类仍是 invocation，摘要是工具名，事实不入库', async () => {
    const { provider } = invocationProvider([
      { effect: 'ask', match: "object.type == 'invocation'" }
    ])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    await ctx.enforceInvocation({
      toolCallId: 'tc-log',
      toolName: 'mcp__ssh__exec',
      operation: 'exec',
      mcp: SSH_EXEC_FACTS
    })

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      effect: 'ask',
      objectKind: 'invocation',
      objectSummary: 'mcp__ssh__exec: exec',
      toolName: 'mcp__ssh__exec',
      tool: { name: 'mcp__ssh__exec', operation: 'exec' },
      userResponse: 'allowed',
      // J10：主体今天恒报 root agent（档案维度还没接线）
      subject: { kind: 'agent', agentKind: 'root' }
    })
    // 日志里没有 MCP 事实这一栏 —— 要按 server 回查，今天只能靠 toolName 的前缀
    expect(JSON.stringify(logs[0])).not.toContain('mcpTrusted')
  })
})

// ─── ssh 命令客体上的 host ───────────────────────────────────────────────
//
// 有它策略才写得出「生产要问、测试放行」，用户也才能在卡片上看出这条 `rm -rf` 要跑在哪台
// 机器上 —— 否则卡片上只有命令，目标只能靠模型自己写的 description，而那段文字在提示注入
// 的场景里正是攻击者控制的。bash 刻意不写这个键，于是 `has(object.host)` 就是「远端还是本地」。

describe('createSecurityContext — enforceCommand 的 host', () => {
  /** 记录询问材料、一律放行的 provider */
  function commandProvider(rules: PolicyRuleSpec[]): {
    provider: SecurityHostProvider
    requestUserInput: Mock<(req: InputRequest) => Promise<InputResponse>>
    warn: Mock
  } {
    const requestUserInput = vi.fn(
      async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
    )
    const warn = vi.fn()
    return {
      provider: makeProvider(
        { autoAllow: false, allowList: [] },
        {
          requestUserInput,
          logger: { info: vi.fn(), warn, error: vi.fn() },
          getUserPolicies: () => [userPolicy('host-gate', rules)]
        }
      ),
      requestUserInput,
      warn
    }
  }

  it('CT-T16 `has(object.host)` 区分远端与本地：prod 被拦，staging 与 bash 不受连坐', async () => {
    const { provider, warn } = commandProvider([
      {
        effect: 'deny',
        match: "object.type == 'command' && has(object.host) && object.host == 'prod'"
      }
    ])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)
    const opts = { toolCallId: 'tc-h', toolName: 'mcp__ssh__exec' }

    await expect(
      ctx.enforceCommand({ channel: 'ssh', command: 'rm -rf /srv/app', host: 'prod' }, opts)
    ).rejects.toThrow(/Denied by security policy rule/)

    await expect(
      ctx.enforceCommand({ channel: 'ssh', command: 'rm -rf /srv/app', host: 'staging' }, opts)
    ).resolves.toEqual({ status: 'allowed' })

    // bash 的客体上根本没有 host 这个键，has() 于是为假 —— 不是靠「等于空串」蒙对的
    await expect(
      ctx.enforceCommand(
        { channel: 'bash', command: 'rm -rf /srv/app' },
        {
          toolCallId: 'tc-b',
          toolName: 'bash'
        }
      )
    ).resolves.toEqual({ status: 'allowed' })
    // 而且不是 fail-safe 蒙中的放行：缺键若报错，deny 会当成命中
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('fail-safe')
  })

  it('CT-T17 卡片上写 `ssh <alias>: <command>`；本地命令一字不改', async () => {
    const { provider, requestUserInput } = commandProvider([])
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)

    // 内置 ask-on-command 会把两条都拦到卡片上，正好看材料
    await ctx.enforceCommand(
      { channel: 'ssh', command: 'systemctl restart app', host: 'prod' },
      { toolCallId: 'tc-c1', toolName: 'mcp__ssh__exec' }
    )
    await ctx.enforceCommand(
      { channel: 'bash', command: 'ls -la' },
      { toolCallId: 'tc-c2', toolName: 'bash' }
    )

    // 远端那条把目标机器写进卡片 —— 否则卡片上只有命令，跑在哪台只能靠模型自己写的
    // description，而那段文字在提示注入的场景里正是攻击者控制的
    const cards = requestUserInput.mock.calls.map(([req]) =>
      req.kind === 'ask' ? req.command : `(not an ask: ${req.kind})`
    )
    expect(cards).toEqual(['ssh prod: systemctl restart app', 'ls -la'])
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
    // autoAllow 抵消内置 ask-on-database 的 ask，只留用户规则的按工具 deny（deny 压过 force-allow）
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
    // 同一客体换工具名：tool 维度不再命中 → force-allow 放行
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

  it('CT-6 只读连接的 allow 是事件（与 L1 非事件相反）：放行且落一条 allow 日志、不弹窗；autoAllow 归因 force-allow', async () => {
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

    // 可写连接 + 免询问：同样放行，但归因 force-allow
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
      memoryDirs: [],
      knowledgeRoot: '/kb',
      knowledgeSessionDirs: [],
      home: '/home/u',
      botsDir: '/home/u/.shuvix/bots',
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
 * 用户策略写 `effect: force-allow` —— 与内置会话授权同一层：压得过询问门、输给 deny。
 * 用户来源没有额外限制（force-allow 不是内置专属），这几条端到端钉住那条结算偏序。
 */
describe('createSecurityContext — 用户策略的 force-allow（端到端）', () => {
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

  it('CU-1 旗舰：用户 force-allow 局部放宽读取门 —— /data 读放行归因用户规则，区外读与 /data 写照旧 ask', () => {
    const ctx = contextWith([
      pathPolicy('trust-data', [
        {
          effect: 'force-allow',
          conditions: { action: ['read'] },
          match: "inDir(object.path, '/data')"
        }
      ])
    ])

    // /data 读：force-allow 压过内置 ask-on-read → allow，归因到用户规则
    const granted = ctx.evaluate('read', { type: 'path', path: '/data/x.txt' })
    expect(granted.effect).toBe('allow')
    expect(granted.winning).toBe('trust-data#0')
    // 门没被拆掉，只是被压过 —— ask-on-read 仍在 matched 里（决策日志据此回链）
    expect(granted.matched).toContain('ask-on-read#0')

    // 放宽是局部的：策略没提的路径仍归内置读取门管
    const elsewhere = ctx.evaluate('read', { type: 'path', path: '/elsewhere/f.txt' })
    expect(elsewhere.effect).toBe('ask')
    expect(elsewhere.winning).toBe('ask-on-read#0')

    // 放宽是按 action 的：同一目录的写入不受这条 read force-allow 影响
    const write = ctx.evaluate('write', { type: 'path', path: '/data/x.txt' })
    expect(write.effect).toBe('ask')
    expect(write.winning).toBe('ask-on-write#0')
  })

  it('CU-2 用户 force-allow 压不过内置 deny：~/.ssh 写入仍 deny，归因 protect-credentials#0', () => {
    const ctx = contextWith([
      pathPolicy('trust-ssh', [
        {
          effect: 'force-allow',
          conditions: { action: ['write'] },
          match: "inDir(object.path, vars.home + '/.ssh')"
        }
      ])
    ])

    const decision = ctx.evaluate('write', { type: 'path', path: '/home/u/.ssh/id_rsa' })
    expect(decision.effect).toBe('deny')
    expect(decision.winning).toBe('protect-credentials#0')
    // force-allow 规则确实命中了（是被 deny 压过，而不是没匹配上）
    expect(decision.matched).toContain('trust-ssh#0')
  })

  it('CU-3 同文件 ask 在前、force-allow 在后 → 仍 allow：优先序由 tier 决定，不是书写顺序', () => {
    const ctx = contextWith([
      pathPolicy('order-probe', [
        { effect: 'ask', conditions: { action: ['read'] }, match: "inDir(object.path, '/data')" },
        {
          effect: 'force-allow',
          conditions: { action: ['read'] },
          match: "inDir(object.path, '/data')"
        }
      ])
    ])

    const decision = ctx.evaluate('read', { type: 'path', path: '/data/x.txt' })
    expect(decision.effect).toBe('allow')
    expect(decision.winning).toBe('order-probe#1')
    // matched 按 tier 序：force-allow 在前、ask 在后（与书写顺序相反）
    expect(decision.matched.indexOf('order-probe#1')).toBeLessThan(
      decision.matched.indexOf('order-probe#0')
    )
  })

  it('CU-F1 旗舰：用户 force-ask 让特定文件在免询问开着时仍然询问，且不给「允许并记住」', () => {
    // 需求原型：某些文件始终要过目一次，免询问开关对它不生效
    const ctx = contextWith(
      [
        pathPolicy('guard-prod', [
          { effect: 'force-ask', match: "inDir(object.path, '/data/prod')" }
        ])
      ],
      { autoAllow: true, allowList: ['Read(/data/prod)'] }
    )

    // 免询问开着 + 该路径还「允许并记住」过 —— 两条 force-allow 都命中，仍然 ask
    const guarded = ctx.evaluate('read', { type: 'path', path: '/data/prod/secrets.env' })
    expect(guarded.effect).toBe('ask')
    expect(guarded.winning).toBe('guard-prod#0')
    expect(guarded.matched).toContain('session-auto-allow#0')
    expect(guarded.matched).toContain('session-path-grants#0')
    // 记忆入口不给：那条授权落在 force-allow 层，点了也压不过这道门
    expect(guarded.ask?.rememberEntry).toBeUndefined()

    // 对照：策略没覆盖的路径照旧被免询问放行
    const elsewhere = ctx.evaluate('read', { type: 'path', path: '/data/other/x.txt' })
    expect(elsewhere.effect).toBe('allow')

    // 对照：force-ask 压不过 deny —— 凭据目录写入仍是拒绝
    const denied = ctx.evaluate('write', { type: 'path', path: '/home/u/.ssh/id_rsa' })
    expect(denied.effect).toBe('deny')
  })

  it('CU-4 evaluateReadOnly 缺省丢弃所有 force-allow（用户策略也不例外）；{includeForceAllow:true} 翻转', () => {
    const ctx = contextWith([
      pathPolicy('trust-data', [
        {
          effect: 'force-allow',
          conditions: { action: ['read'] },
          match: "inDir(object.path, '/data')"
        }
      ])
    ])
    const target: SecurityObject = { type: 'path', path: '/data/x.txt' }

    // 按 tier 过滤而非按来源：用户 md 里写死的 force-allow 同样被丢弃（EvaluateOpts 的显式契约）
    expect(ctx.evaluateReadOnly('read', target)).toBe(false)
    expect(ctx.evaluateReadOnly('read', target, { includeForceAllow: true })).toBe(true)
    // 对照：主动评估（evaluate）缺省纳入 force-allow
    expect(ctx.evaluate('read', target).effect).toBe('allow')
  })

  it('CU-5 照 session-auto-allow 正文的收窄示例同名覆盖：免询问只覆盖读与执行，写仍 ask', () => {
    // 与内置 session-auto-allow 正文「To adjust」示例逐字同构
    const ctx = contextWith(
      [
        scopedPolicy('session-auto-allow', { 'subject.kind': ['agent'] }, [
          {
            effect: 'force-allow',
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
      memoryDirs: [],
      knowledgeRoot: '/kb',
      knowledgeSessionDirs: [],
      home: '/home/u',
      botsDir: '/home/u/.shuvix/bots',
      systemDirs: [] as string[]
    }))

    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, {
      host: 'desktop',
      pathSep: '/',
      getVars,
      getSessionGrants,
      readBuiltinPolicyMd: INLINE_POLICY_MD
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

describe('createSecurityContext — 宿主没供给的目录变量', () => {
  it('CT-W4 缺 botsDir 的桌面宿主经门面反复评估：只记一行「not provided」、零 fail-safe，普通写照常落回 ask-on-write', () => {
    // 缺的 botsDir 由 assemble 替 protect-bot-files（force-ask）绑成 null。不绑的话每次写都缺键
    // 报错、fail-safe 成命中：普通写全变成免不掉的 force-ask，logger 每次评估刷一行 fail-safe。
    // 门面把两个出口（「not provided」与 evaluate 的 fail-safe）都接到 provider.logger，所以在这里一起数
    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() }
    const grants = { autoAllow: false, allowList: [] as string[] }
    const { botsDir: _botsDir, ...varsWithoutBotsDir } = makeProvider(grants).getVars()
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(grants, { getVars: () => varsWithoutBotsDir, logger })
    )

    for (let i = 0; i < 3; i++) {
      expect(ctx.evaluate('write', { type: 'path', path: '/ws/f.txt' })).toMatchObject({
        effect: 'ask',
        winning: 'ask-on-write#0'
      })
    }
    expect(ctx.evaluateReadOnly('write', { type: 'path', path: '/ws/f.txt' })).toBe(false)

    const lines = warn.mock.calls.map((c) => String(c[0]))
    const notProvided = lines.filter((m) => m.includes('is not provided by the host'))
    expect(notProvided).toHaveLength(1)
    expect(notProvided[0]).toContain("'protect-bot-files'")
    expect(notProvided[0]).toContain('vars.botsDir')
    expect(lines.filter((m) => m.includes('match evaluation failed'))).toHaveLength(0)
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

// ─── enforceUrl（浏览器导航守卫）─────────────────────────────────────────
//
// 客体 `{type:'url', url, scheme, host, origin, browser}`、action 'navigate'。应用内的浏览器面板
// （browser app）出厂**没有**任何 url 策略（no policy = allow）—— 这道门的意义是让用户能写
// 「某个域名要问 / 禁止」；用户自己的 Chrome（browser chrome）有一条出厂的 ask-on-new-site
// （CT-U9 系列）。file:// 不走这里：宿主把它当成读那个路径，改走 enforcePath('read')
// （见两端宿主的接线测试）。

/** 一个普通的导航目标（属性按 urlObjectOf 的写法给齐） */
const PAGE: UrlObjectInput = {
  url: 'https://a.example/p?q=1',
  scheme: 'https',
  host: 'a.example',
  origin: 'https://a.example',
  browser: 'app'
}

/** 某台主机上的一页 */
const pageOn = (host: string): UrlObjectInput => ({
  url: `https://${host}/x`,
  scheme: 'https',
  host,
  origin: `https://${host}`,
  browser: 'app'
})

const OPEN_OPTS = {
  toolCallId: 'tc-url',
  toolName: 'mcp__browser__open_tab',
  description: 'Open https://a.example/p?q=1'
}

/** 同一页，在用户自己的 Chrome 里（出厂的 ask-on-new-site 只管它） */
const CHROME_PAGE: UrlObjectInput = { ...PAGE, browser: 'chrome' }

/** Chrome 那台 server 的站点门上下文 */
const CHROME_OPTS = {
  toolCallId: 'tc-url',
  toolName: 'mcp__chrome__read_page',
  description: 'Use a.example in tab 6'
}

/** 出厂 ask-on-new-site 的 en 显示名与话（取自 md，不抄进断言） */
const NEW_SITE = (() => {
  const policy = buildBuiltinPolicies({ readMd: INLINE_POLICY_MD }).find(
    (p) => p.name === 'ask-on-new-site'
  )!
  return { displayName: policy.displayName, prompt: policy.rules[0].prompt! }
})()

/** 抓住一次拒绝的原话 —— toThrow 的字符串参数只做子串匹配，逐字对照要拿出来 toBe */
async function rejectionOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('expected the promise to reject')
}

interface UrlHarness {
  ctx: ReturnType<typeof createSecurityContext>
  requestUserInput: Mock<(req: InputRequest) => Promise<InputResponse>>
  persistGrant: Mock<(mode: string, path: string) => void>
  warn: Mock<(msg: string) => void>
}

/**
 * 用户的 url 策略 + 固定的询问应答。`channel: false` = 这条会话没有输入面板；
 * 没给 response 时询问通道一弹就判红（「不该问」的断言用）。
 */
function urlContext(
  policies: ParsedPolicyFile[],
  opts: { response?: InputResponse; channel?: boolean; autoAllow?: boolean } = {}
): UrlHarness {
  const requestUserInput = opts.response
    ? vi.fn(async (_req: InputRequest): Promise<InputResponse> => opts.response!)
    : rejectingChannel()
  const persistGrant = vi.fn<(mode: string, path: string) => void>()
  const warn = vi.fn<(msg: string) => void>()
  const ctx = createSecurityContext(
    SUBJECT,
    ENVIRONMENT,
    makeProvider(
      { autoAllow: opts.autoAllow ?? false, allowList: [] },
      {
        requestUserInput: opts.channel === false ? undefined : requestUserInput,
        persistGrant,
        logger: { info: vi.fn(), warn, error: vi.fn() },
        getUserPolicies: () => policies
      }
    )
  )
  return { ctx, requestUserInput, persistGrant, warn }
}

/** 按主机拦 / 问的用户策略（规则里自带 type 守卫，与用户照手册写的一致） */
const hostRule = (
  effect: PolicyRuleSpec['effect'],
  host: string,
  prompt?: string
): PolicyRuleSpec => ({
  effect,
  match: `object.type == 'url' && object.host == '${host}'`,
  ...(prompt ? { prompt } : {})
})

describe('createSecurityContext — enforceUrl（浏览器导航守卫）', () => {
  it('CT-U1 四个客体属性、action 与 tool.name 都到得了策略：逐一核对的 deny 命中；换个工具名就放行；零告警', async () => {
    const { ctx, requestUserInput, warn } = urlContext([
      userPolicy('probe', [
        {
          effect: 'deny',
          match:
            "object.type == 'url' && object.url == 'https://a.example/p?q=1' " +
            "&& object.scheme == 'https' && object.host == 'a.example' " +
            "&& object.origin == 'https://a.example' && action == 'navigate' " +
            "&& tool.name == 'mcp__browser__open_tab'"
        }
      ])
    ])

    expect(await rejectionOf(ctx.enforceUrl(PAGE, OPEN_OPTS))).toBe(
      "Denied by security policy rule 'probe#0'"
    )
    // 同一个地址换一个工具名：tool 维度不再命中 → 没有别的 url 策略 → 放行
    await expect(
      ctx.enforceUrl(PAGE, { ...OPEN_OPTS, toolName: 'mcp__browser__navigate' })
    ).resolves.toBeUndefined()

    expect(requestUserInput).not.toHaveBeenCalled()
    // 属性给齐了，match 里读哪一个都不会走 fail-safe
    expect(warn).not.toHaveBeenCalled()

    const logs = getSessionDecisions(SID)
    expect(logs.map((l) => [l.action, l.objectKind])).toEqual([
      ['navigate', 'url'],
      ['navigate', 'url']
    ])
    expect(logs[1]).toMatchObject({
      effect: 'deny',
      winning: 'probe#0',
      toolCallId: 'tc-url',
      objectSummary: 'https://a.example/p?q=1'
    })
    expect(logs[1].tool).toEqual({ name: 'mcp__browser__open_tab' })
    expect(logs[0].tool).toEqual({ name: 'mcp__browser__navigate' })
  })

  it('CT-U2 出厂没有任何策略管 url：免询问关着，https / 带端口 / data: / about: / chrome: 一律放行、不问、零告警，日志归因 default:url', async () => {
    const targets: UrlObjectInput[] = [
      PAGE,
      {
        url: 'http://a.example:8080/',
        scheme: 'http',
        host: 'a.example',
        origin: 'http://a.example:8080',
        browser: 'app'
      },
      { url: 'data:text/html,x', scheme: 'data', host: '', origin: 'null', browser: 'app' },
      { url: 'about:blank', scheme: 'about', host: '', origin: 'null', browser: 'app' },
      {
        url: 'chrome://settings',
        scheme: 'chrome',
        host: 'settings',
        origin: 'null',
        browser: 'app'
      }
    ]
    const { ctx, requestUserInput, warn } = urlContext([])

    for (const target of targets) {
      await expect(ctx.enforceUrl(target, OPEN_OPTS), target.url).resolves.toBeUndefined()
    }
    expect(requestUserInput).not.toHaveBeenCalled()
    // 内置策略里要是有一条没写 type 守卫，读到 url 客体没有的属性就会 fail-safe 成命中 —— 这里零告警
    expect(warn).not.toHaveBeenCalled()

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(targets.length)
    for (const log of logs) {
      expect(log).toMatchObject({ effect: 'allow', winning: 'default:url', matched: [] })
    }
    expect(logs.map((l) => l.objectSummary).reverse()).toEqual(targets.map((t) => t.url))
  })

  it('CT-U2b 免询问开着：照样放行，归因 session-auto-allow#0', async () => {
    const { ctx, requestUserInput } = urlContext([], { autoAllow: true })
    await expect(ctx.enforceUrl(PAGE, OPEN_OPTS)).resolves.toBeUndefined()
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)[0]).toMatchObject({
      effect: 'allow',
      winning: 'session-auto-allow#0'
    })
  })

  it('CT-U3 用户按主机 deny：逐字「Denied by security policy rule …」，有提示语就接在空行后；不弹卡；别的主机照常', async () => {
    const bare = urlContext([userPolicy('host-gate', [hostRule('deny', 'evil.example')])])
    expect(await rejectionOf(bare.ctx.enforceUrl(pageOn('evil.example'), OPEN_OPTS))).toBe(
      "Denied by security policy rule 'host-gate#0'"
    )
    await expect(bare.ctx.enforceUrl(pageOn('good.example'), OPEN_OPTS)).resolves.toBeUndefined()
    expect(bare.requestUserInput).not.toHaveBeenCalled()

    clearSessionDecisions(SID)
    const withPrompt = urlContext([
      userPolicy('host-gate', [hostRule('deny', 'evil.example', 'That site is off limits.')])
    ])
    expect(await rejectionOf(withPrompt.ctx.enforceUrl(pageOn('evil.example'), OPEN_OPTS))).toBe(
      "Denied by security policy rule 'host-gate#0'\n\nThat site is off limits."
    )
    expect(withPrompt.requestUserInput).not.toHaveBeenCalled()
  })

  it('CT-U4 用户按主机 ask：卡片上是地址本身、工具的一句说明与策略提示语；允许 → 放行，日志 ask/allowed', async () => {
    const { ctx, requestUserInput } = urlContext(
      [userPolicy('url-gate', [hostRule('ask', 'a.example', 'Check the site before opening it.')])],
      { response: { kind: 'ask', allowed: true } }
    )

    await expect(ctx.enforceUrl(PAGE, OPEN_OPTS)).resolves.toBeUndefined()
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(requestUserInput.mock.calls[0][0]).toEqual({
      id: 'tc-url',
      kind: 'ask',
      toolName: 'mcp__browser__open_tab',
      command: 'https://a.example/p?q=1',
      description: 'Open https://a.example/p?q=1',
      // 只有 path × read 才探目录
      pathIsDirectory: false,
      policyPrompt: { text: 'Check the site before opening it.', policies: ['url-gate'] },
      createdAt: expect.any(Number)
    })

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      effect: 'ask',
      winning: 'url-gate#0',
      objectKind: 'url',
      objectSummary: 'https://a.example/p?q=1',
      userResponse: 'allowed'
    })
  })

  it.each<[string, InputResponse, Partial<typeof OPEN_OPTS & { abortError: string }>, string]>([
    ['拒绝', { kind: 'ask', allowed: false }, {}, 'User denied opening https://a.example/p?q=1'],
    ['拒绝并写了理由', { kind: 'ask', allowed: false, reason: 'not today' }, {}, 'not today'],
    [
      '取消（宿主给了 abortError）',
      { kind: 'cancel', reason: 'aborted' },
      { abortError: 'TOOL_ABORTED' },
      'TOOL_ABORTED'
    ],
    ['取消（缺省）', { kind: 'cancel', reason: 'aborted' }, {}, 'Aborted'],
    [
      '其它（反馈）',
      { kind: 'other', text: 'read the docs page instead' },
      {},
      'User declined https://a.example/p?q=1 and provided feedback instead: read the docs page instead'
    ]
  ])('CT-U5 询问应答：%s → 抛出逐字文案', async (_label, response, extra, message) => {
    const { ctx } = urlContext([userPolicy('url-gate', [hostRule('ask', 'a.example')])], {
      response
    })
    expect(await rejectionOf(ctx.enforceUrl(PAGE, { ...OPEN_OPTS, ...extra }))).toBe(message)
  })

  it('CT-U5b 没有询问通道：缺省 / missingChannel:deny → fail-closed（地址写全）；missingChannel:allow → 放行', async () => {
    const { ctx } = urlContext([userPolicy('url-gate', [hostRule('ask', 'a.example')])], {
      channel: false
    })
    const failClosed =
      'Access denied: this needs your confirmation but there is no way to ask: https://a.example/p?q=1'
    expect(await rejectionOf(ctx.enforceUrl(PAGE, { ...OPEN_OPTS, missingChannel: 'deny' }))).toBe(
      failClosed
    )
    expect(await rejectionOf(ctx.enforceUrl(PAGE, OPEN_OPTS))).toBe(failClosed)
    await expect(
      ctx.enforceUrl(PAGE, { ...OPEN_OPTS, missingChannel: 'allow' })
    ).resolves.toBeUndefined()
  })

  it('CT-U6 「允许并记住」对地址没有可记的条目：不调 persistGrant，日志记 allowed（不是 allowed_remember）', async () => {
    const { ctx, persistGrant } = urlContext(
      [userPolicy('url-gate', [hostRule('ask', 'a.example')])],
      { response: { kind: 'ask', allowed: true, extra: { rememberPath: true } } }
    )
    await expect(ctx.enforceUrl(PAGE, OPEN_OPTS)).resolves.toBeUndefined()
    expect(persistGrant).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)[0].userResponse).toBe('allowed')
  })

  it('CT-U7 照手册写的一份 url 策略 md：零告警解析；子域名被拦，形似的别的域名照常；路径类访问不受波及', async () => {
    const parseWarn = vi.fn()
    const policy = parsePolicyDefinitionFile(
      [
        '---',
        'shuvix: policy v1',
        'name: block-evil',
        'shuvix-displayName: Keep Off evil.example',
        'shuvix-policy-scope:',
        '  subject.kind: [agent]',
        '  object.type: [url]',
        'shuvix-policy-rules:',
        '  - effect: deny',
        '    action: [navigate]',
        "    match: object.host == 'evil.example' || object.host.endsWith('.evil.example')",
        '    prompt: That site is off limits.',
        '---',
        'The agent stays off evil.example and every subdomain of it.'
      ].join('\n'),
      'block-evil',
      parseWarn
    )
    expect(policy).not.toBeNull()
    expect(parseWarn).not.toHaveBeenCalled()

    const { ctx, requestUserInput, warn } = urlContext([policy!])
    const denied = "Denied by security policy rule 'block-evil#0'\n\nThat site is off limits."
    expect(await rejectionOf(ctx.enforceUrl(pageOn('evil.example'), OPEN_OPTS))).toBe(denied)
    expect(await rejectionOf(ctx.enforceUrl(pageOn('login.evil.example'), OPEN_OPTS))).toBe(denied)
    await expect(ctx.enforceUrl(pageOn('evil.example.com'), OPEN_OPTS)).resolves.toBeUndefined()
    await expect(ctx.enforceUrl(pageOn('notevil.example'), OPEN_OPTS)).resolves.toBeUndefined()

    // scope 把它限定在 url 客体上：工作区里的读照常放行，也不因读不到 object.host 而 fail-safe
    await expect(
      ctx.enforcePath('read', '/ws/a.txt', { toolCallId: 'tc-read', toolName: 'read' })
    ).resolves.toBeUndefined()
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('CT-U8 免询问开着：用户的 ask 规则被静默放行；force-ask 规则照样问', async () => {
    const asking = urlContext([userPolicy('url-gate', [hostRule('ask', 'a.example')])], {
      autoAllow: true
    })
    await expect(asking.ctx.enforceUrl(PAGE, OPEN_OPTS)).resolves.toBeUndefined()
    expect(asking.requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)[0]).toMatchObject({
      effect: 'allow',
      winning: 'session-auto-allow#0'
    })

    const forced = urlContext([userPolicy('url-gate', [hostRule('force-ask', 'a.example')])], {
      autoAllow: true,
      response: { kind: 'ask', allowed: true }
    })
    await expect(forced.ctx.enforceUrl(PAGE, OPEN_OPTS)).resolves.toBeUndefined()
    expect(forced.requestUserInput).toHaveBeenCalledTimes(1)
    expect(forced.requestUserInput.mock.calls[0][0]).toMatchObject({
      kind: 'ask',
      command: 'https://a.example/p?q=1'
    })
    expect(getSessionDecisions(SID)[0]).toMatchObject({
      effect: 'ask',
      winning: 'url-gate#0',
      userResponse: 'allowed'
    })
  })

  it('CT-U1b browser 也到得了策略：按 browser 写的 deny 只拦 Chrome 里的，应用内的照常；零告警', async () => {
    const { ctx, requestUserInput, warn } = urlContext([
      userPolicy('chrome-probe', [
        { effect: 'deny', match: "object.type == 'url' && object.browser == 'chrome'" }
      ])
    ])
    expect(await rejectionOf(ctx.enforceUrl(CHROME_PAGE, CHROME_OPTS))).toBe(
      "Denied by security policy rule 'chrome-probe#0'"
    )
    await expect(ctx.enforceUrl(PAGE, OPEN_OPTS)).resolves.toBeUndefined()
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    // 应用内那一次：没有任何 url 策略命中
    expect(getSessionDecisions(SID)[0]).toMatchObject({ effect: 'allow', winning: 'default:url' })
  })

  it('CT-U9 Chrome 里的新站点、只有出厂策略：卡片是地址本身 + 工具的一句说明 + ask-on-new-site 的话与名字；允许 → 放行，日志 ask/allowed', async () => {
    const { ctx, requestUserInput, warn } = urlContext([], {
      response: { kind: 'ask', allowed: true }
    })
    await expect(ctx.enforceUrl(CHROME_PAGE, CHROME_OPTS)).resolves.toBeUndefined()
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(requestUserInput.mock.calls[0][0]).toEqual({
      id: 'tc-url',
      kind: 'ask',
      toolName: 'mcp__chrome__read_page',
      command: 'https://a.example/p?q=1',
      description: 'Use a.example in tab 6',
      pathIsDirectory: false,
      policyPrompt: { text: NEW_SITE.prompt, policies: [NEW_SITE.displayName] },
      createdAt: expect.any(Number)
    })
    expect(NEW_SITE.displayName).toBe('Ask Before Using a New Site in Chrome')
    expect(warn).not.toHaveBeenCalled()

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-new-site#0',
      objectKind: 'url',
      objectSummary: 'https://a.example/p?q=1',
      userResponse: 'allowed'
    })
  })

  it.each<[string, InputResponse, string]>([
    ['拒绝', { kind: 'ask', allowed: false }, 'User denied opening https://a.example/p?q=1'],
    ['取消', { kind: 'cancel', reason: 'aborted' }, 'Aborted']
  ])('CT-U9 Chrome 里的新站点，用户%s → 抛出逐字文案', async (_l, response, message) => {
    const { ctx } = urlContext([], { response })
    expect(await rejectionOf(ctx.enforceUrl(CHROME_PAGE, CHROME_OPTS))).toBe(message)
  })

  it('CT-U9 Chrome 里的新站点，没有询问通道 → fail-closed（地址写全）', async () => {
    const { ctx } = urlContext([], { channel: false })
    expect(
      await rejectionOf(ctx.enforceUrl(CHROME_PAGE, { ...CHROME_OPTS, missingChannel: 'deny' }))
    ).toBe(
      'Access denied: this needs your confirmation but there is no way to ask: https://a.example/p?q=1'
    )
  })

  it('CT-U9b Chrome 里的新站点，免询问开着 → 不问、放行，日志归因 session-auto-allow#0', async () => {
    const { ctx, requestUserInput } = urlContext([], { autoAllow: true })
    await expect(ctx.enforceUrl(CHROME_PAGE, CHROME_OPTS)).resolves.toBeUndefined()
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)[0]).toMatchObject({
      effect: 'allow',
      winning: 'session-auto-allow#0'
    })
  })

  it('CT-U9c Chrome 里不属于任何站点的页（about:blank / data: / chrome:）→ 不问、放行，归因 default:url', async () => {
    const { ctx, requestUserInput, warn } = urlContext([])
    for (const target of [
      { url: 'about:blank', scheme: 'about', host: '', origin: 'null' },
      { url: 'data:text/html,x', scheme: 'data', host: '', origin: 'null' },
      { url: 'chrome://settings', scheme: 'chrome', host: 'settings', origin: 'null' }
    ]) {
      await expect(
        ctx.enforceUrl({ ...target, browser: 'chrome' }, CHROME_OPTS),
        target.url
      ).resolves.toBeUndefined()
    }
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    for (const log of getSessionDecisions(SID)) {
      expect(log).toMatchObject({ effect: 'allow', winning: 'default:url', matched: [] })
    }
  })
})

// ─── 没有返回值的门：用户的反馈只能是拒绝 ──────────────────────────────────
//
// enforcePath / enforceGitOp / enforceUrl 返回 void —— 用户在询问卡片上选「其它」写的那段反馈
// 没有地方带回给调用方。所以这三道门在内部**强制** onOther:'throw'：调用方误传 'return' 时，
// 反馈也不能悄悄变成一次放行。有返回值的门（命令 / 数据库 / L1）照旧尊重调用方的选择。

describe('createSecurityContext — 无返回值的门强制 onOther:throw', () => {
  const FEEDBACK: InputResponse = { kind: 'other', text: 'try the docs first' }

  function feedbackContext(policies: ParsedPolicyFile[] = []): {
    ctx: ReturnType<typeof createSecurityContext>
    requestUserInput: Mock<(req: InputRequest) => Promise<InputResponse>>
  } {
    const requestUserInput = vi.fn(async (_req: InputRequest): Promise<InputResponse> => FEEDBACK)
    return {
      ctx: createSecurityContext(
        SUBJECT,
        ENVIRONMENT,
        makeProvider(
          { autoAllow: false, allowList: [] },
          { requestUserInput, getUserPolicies: () => policies }
        )
      ),
      requestUserInput
    }
  }

  it('CT-O1 enforcePath：传了 onOther:return，反馈照样抛成「declined access」', async () => {
    const { ctx, requestUserInput } = feedbackContext()
    // 工作区外的读 → 内置 ask-on-read 问
    expect(
      await rejectionOf(
        ctx.enforcePath('read', '/outside/f.txt', {
          toolCallId: 'o1',
          toolName: 'read',
          onOther: 'return'
        })
      )
    ).toBe(
      'User declined access to /outside/f.txt and provided feedback instead: try the docs first'
    )
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(getSessionDecisions(SID)[0].userResponse).toBe('feedback')
  })

  it('CT-O2 enforceGitOp：传了 onOther:return，反馈照样抛', async () => {
    const { ctx, requestUserInput } = feedbackContext()
    expect(
      await rejectionOf(
        ctx.enforceGitOp(GIT_INPUT, { toolCallId: 'o2', toolName: 'git', onOther: 'return' })
      )
    ).toBe('User declined git init and provided feedback instead: try the docs first')
    expect(requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('CT-O3 enforceUrl：传了 onOther:return，反馈照样抛', async () => {
    const { ctx, requestUserInput } = feedbackContext([
      userPolicy('url-gate', [hostRule('ask', 'a.example')])
    ])
    expect(await rejectionOf(ctx.enforceUrl(PAGE, { ...OPEN_OPTS, onOther: 'return' }))).toBe(
      'User declined https://a.example/p?q=1 and provided feedback instead: try the docs first'
    )
    expect(requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('CT-O4 对照：有返回值的门照旧尊重 onOther:return —— 命令与数据库把反馈作为结果交回', async () => {
    const { ctx } = feedbackContext()
    await expect(
      ctx.enforceCommand(COMMAND_INPUT, { toolCallId: 'o4', toolName: 'bash', onOther: 'return' })
    ).resolves.toEqual({ status: 'feedback', text: 'try the docs first' })
    await expect(
      ctx.enforceDatabase(DATABASE_INPUT, {
        toolCallId: 'o5',
        toolName: 'database',
        onOther: 'return'
      })
    ).resolves.toEqual({ status: 'feedback', text: 'try the docs first' })
  })
})

// ─── 真实路径（provider.realPath）────────────────────────────────────────
//
// 门面在评估之前把路径客体换成它真正通向的地方（path = 解析结果，requestedPath = 交来的写法），
// 并把同一个带本次记忆表的解析递给 inDir，让它比较的目录也按位置比。解析器在这里一律是一张表的
// 假件 —— 问的是接线；真文件系统上的那一半在桌面的 realPath.test / realPathPolicy.test。

/** 一张表的假解析器：写法 → 真实去处，表外原样；vi.fn 记下被问过的每个参数 */
const tableResolver = (table: Record<string, string>): Mock<(p: string) => string> =>
  vi.fn((p: string): string => table[p] ?? p)

/** 解析器就绪但什么都没抽到的解析事实（与「宿主没注入解析器」同形态） */
const UNPARSED_FACTS = (source: string): ShellFacts => ({
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

describe('createSecurityContext — 真实路径（provider.realPath）', () => {
  /** 工作区里的一条链接 → 私钥（这组用例的旗舰形态） */
  const KEY_LINK = '/ws/key'
  const KEY_REAL = '/home/u/.ssh/id_rsa'
  const NO_GRANTS = (): { autoAllow: boolean; allowList: string[] } => ({
    autoAllow: false,
    allowList: []
  })

  /** 记下每次评估里策略看到的路径客体（derived 规则恒不命中，只当探针） */
  function captureProbe(): {
    derivedRules: SecurityHostProvider['derivedRules']
    seen: () => MatchContext['object'] | undefined
  } {
    let captured: MatchContext['object'] | undefined
    return {
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
      ],
      seen: () => captured
    }
  }

  it('CT-R1 路径客体换成真实去处：策略、ask 的 command / rememberEntry、卡片、目录探测、「允许并记住」、日志都按它；requestedPath 是交来的写法', async () => {
    const probe = captureProbe()
    const requestUserInput = vi.fn(
      async (_req: InputRequest): Promise<InputResponse> => ({
        kind: 'ask',
        allowed: true,
        extra: { rememberPath: true }
      })
    )
    const persistGrant = vi.fn()
    const isDirectory = vi.fn(() => false)
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(NO_GRANTS(), {
        realPath: tableResolver({ [KEY_LINK]: KEY_REAL }),
        requestUserInput,
        persistGrant,
        isDirectory,
        derivedRules: probe.derivedRules
      })
    )

    // 按写法这是工作区里的一次普通读；按位置是私钥 —— 凭据门接手
    const decision = ctx.evaluate('read', { type: 'path', path: KEY_LINK })
    expect(decision).toMatchObject({ effect: 'ask', winning: 'protect-credentials#1' })
    expect(decision.ask).toEqual({
      command: `Read(${KEY_REAL})`,
      rememberEntry: `Read(${KEY_REAL})`,
      requestedPath: KEY_LINK
    })
    expect(probe.seen()).toMatchObject({ type: 'path', path: KEY_REAL, requestedPath: KEY_LINK })

    await ctx.enforcePath('read', KEY_LINK, {
      toolCallId: 'r1',
      toolName: 'read',
      displayPath: 'key'
    })
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(requestUserInput.mock.calls[0][0]).toMatchObject({
      kind: 'ask',
      id: 'r1',
      command: `Read(${KEY_REAL})`,
      requestedPath: KEY_LINK
    })
    // displayPath 是报错用的写法，门面不动它
    expect(probe.seen()).toMatchObject({
      path: KEY_REAL,
      requestedPath: KEY_LINK,
      displayPath: 'key'
    })
    expect(isDirectory).toHaveBeenCalledWith(KEY_REAL)
    // 记下的是用户在卡片上批准的那个位置，而不是链接名
    expect(persistGrant).toHaveBeenCalledWith('read', KEY_REAL)
    expect(getSessionDecisions(SID)[0]).toMatchObject({
      objectKind: 'path',
      objectSummary: KEY_REAL,
      requestedPath: KEY_LINK,
      userResponse: 'allowed_remember'
    })
  })

  it('CT-R2 解析器给回原样（中间没有链接）：ask 材料、卡片、日志都没有 requestedPath；客体上 requestedPath 与 path 相同', async () => {
    const probe = captureProbe()
    const requestUserInput = vi.fn(
      async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
    )
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(NO_GRANTS(), {
        realPath: vi.fn((p: string) => p),
        requestUserInput,
        derivedRules: probe.derivedRules
      })
    )

    const decision = ctx.evaluate('read', { type: 'path', path: '/outside/f.txt' })
    expect(decision).toMatchObject({ effect: 'ask', winning: 'ask-on-read#0' })
    expect(decision.ask).toEqual({
      command: 'Read(/outside/f.txt)',
      rememberEntry: 'Read(/outside/f.txt)'
    })
    expect(decision.ask).not.toHaveProperty('requestedPath')
    expect(probe.seen()).toMatchObject({ path: '/outside/f.txt', requestedPath: '/outside/f.txt' })

    await ctx.enforcePath('read', '/outside/f.txt', { toolCallId: 'r2', toolName: 'read' })
    const request = requestUserInput.mock.calls[0][0] as AskInputRequest
    expect(request.command).toBe('Read(/outside/f.txt)')
    expect(request.requestedPath).toBeUndefined()
    expect(getSessionDecisions(SID)[0].requestedPath).toBeUndefined()
  })

  it('CT-R3 非路径客体原样过门：命令客体的惰性 getter 没被复制读出、解析器一次都没被问；git / 数据库 / url / L1 同样', async () => {
    const probe = captureProbe()
    const realPath = vi.fn((p: string) => p)
    const analyze = vi.fn(() => UNPARSED_FACTS('ls -la'))
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(NO_GRANTS(), {
        realPath,
        shellParser: { ensureReady: async () => {}, analyze },
        requestUserInput: vi.fn(
          async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
        ),
        derivedRules: probe.derivedRules
      })
    )

    await ctx.enforceCommand(COMMAND_INPUT, { toolCallId: 'c1', toolName: 'bash' })
    // 客体还是门面造出来的那一个：枚举面只有三个标量，结构属性仍是非枚举的惰性 getter
    const commandObject = probe.seen()!
    expect(Object.keys(commandObject)).toEqual(['type', 'command', 'channel'])
    expect('requestedPath' in commandObject).toBe(false)
    // 惰性仍在：只有 block-catastrophic-commands 读了它，且记忆化到一次
    expect(analyze).toHaveBeenCalledTimes(1)

    await ctx.enforceGitOp(GIT_INPUT, { toolCallId: 'g1', toolName: 'git' })
    await ctx.enforceDatabase(DATABASE_INPUT, { toolCallId: 'd1', toolName: 'database' })
    await ctx.enforceUrl(
      {
        url: 'https://a.example/',
        scheme: 'https',
        host: 'a.example',
        origin: 'https://a.example',
        browser: 'app'
      },
      { toolCallId: 'u1', toolName: 'mcp__browser__open_tab' }
    )
    await ctx.enforceInvocation({ toolCallId: 'i1', toolName: 'ssh' })

    expect(realPath).not.toHaveBeenCalled()
    for (const record of getSessionDecisions(SID)) {
      expect(record.requestedPath, record.objectKind).toBeUndefined()
    }
  })

  it('CT-R4 evaluateReadOnly（被动 UI）同样按真实去处判：区内的链接指向凭据 → 不放行；区外的写法实际落在区内 → 放行', () => {
    const table = { [KEY_LINK]: KEY_REAL, '/elsewhere/alias': '/ws/f.txt' }
    const located = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(NO_GRANTS(), { realPath: tableResolver(table) })
    )
    expect(located.evaluateReadOnly('read', { type: 'path', path: KEY_LINK })).toBe(false)
    expect(located.evaluateReadOnly('read', { type: 'path', path: '/elsewhere/alias' })).toBe(true)

    // 同两条在不给解析器的宿主上按写法：结论正相反
    const written = createSecurityContext(SUBJECT, ENVIRONMENT, makeProvider(NO_GRANTS()))
    expect(written.evaluateReadOnly('read', { type: 'path', path: KEY_LINK })).toBe(true)
    expect(written.evaluateReadOnly('read', { type: 'path', path: '/elsewhere/alias' })).toBe(false)
  })

  it('CT-R5 一次评估里每个参数至多解析一次：客体路径被一串内置规则引用、同一个目录被两条规则引用，都只问一次', () => {
    const realPath = vi.fn((p: string) => p)
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(NO_GRANTS(), {
        realPath,
        getUserPolicies: () => [
          userPolicy('twice', [
            { effect: 'ask', match: "object.type == 'path' && inDir(object.path, vars.workspace)" },
            {
              effect: 'ask',
              match: "object.type == 'path' && inDir(object.path, [vars.workspace])"
            }
          ])
        ]
      })
    )

    // 一次写评估里客体路径被 protect-credentials / protect-system（两次）/ protect-bot-files /
    // protect-builtin-knowledge / review-memory-writes / session-path-grants / 上面两条引用
    expect(ctx.evaluate('write', { type: 'path', path: '/ws/f.txt' })).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-write#0'
    })
    const asked = realPath.mock.calls.map(([p]) => p)
    expect(asked).toHaveLength(new Set(asked).size)
    expect(asked.filter((p) => p === '/ws/f.txt')).toHaveLength(1)
    expect(asked.filter((p) => p === '/ws')).toHaveLength(1)

    // 经链接的一次评估：参数照样各问一次（记忆表按参数记）
    const redirected = tableResolver({ [KEY_LINK]: KEY_REAL })
    const viaLink = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(NO_GRANTS(), { realPath: redirected })
    )
    viaLink.evaluate('write', { type: 'path', path: KEY_LINK })
    const askedViaLink = redirected.mock.calls.map(([p]) => p)
    expect(askedViaLink).toHaveLength(new Set(askedViaLink).size)
    expect(askedViaLink.filter((p) => p === KEY_LINK)).toHaveLength(1)
  })

  it('CT-R6 不跨评估缓存：链接在两次评估之间被改指向，第二次就按新目标判（每次评估都重新问）', () => {
    const table: Record<string, string> = { [KEY_LINK]: '/ws/notes.txt' }
    const realPath = vi.fn((p: string): string => table[p] ?? p)
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, makeProvider(NO_GRANTS(), { realPath }))

    expect(ctx.evaluate('read', { type: 'path', path: KEY_LINK })).toMatchObject({
      effect: 'allow',
      winning: 'default:path'
    })
    // 有人把 key 改指向了私钥
    table[KEY_LINK] = KEY_REAL
    expect(ctx.evaluate('read', { type: 'path', path: KEY_LINK })).toMatchObject({
      effect: 'ask',
      winning: 'protect-credentials#1'
    })
    expect(realPath.mock.calls.filter(([p]) => p === KEY_LINK)).toHaveLength(2)
  })

  it('CT-R7 解析抛错：该路径按写法比较、判决照常，provider.logger 恰记一行（点名那条路径与原因）；抛错的是目录也一样', () => {
    const warn = vi.fn()
    const failing = (bad: string): Mock<(p: string) => string> =>
      vi.fn((p: string): string => {
        if (p === bad) throw new Error('EACCES: permission denied')
        return p
      })
    const contextFor = (
      realPath: (p: string) => string
    ): ReturnType<typeof createSecurityContext> =>
      createSecurityContext(
        SUBJECT,
        ENVIRONMENT,
        makeProvider(NO_GRANTS(), {
          realPath,
          logger: { info: vi.fn(), warn, error: vi.fn() }
        })
      )
    const realPathWarnings = (): string[] =>
      warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('realPath'))

    // 客体路径解析不了：按写法判（写 → ask-on-write），卡片上就是写法本身
    const decision = contextFor(failing('/ws/broken')).evaluate('write', {
      type: 'path',
      path: '/ws/broken'
    })
    expect(decision).toMatchObject({ effect: 'ask', winning: 'ask-on-write#0' })
    expect(decision.ask).toEqual({
      command: 'Write(/ws/broken)',
      rememberEntry: 'Write(/ws/broken)'
    })
    // 被好几条规则引用，告警也只有一行（记忆表记下了「按写法」这个结论）
    expect(realPathWarnings()).toHaveLength(1)
    expect(realPathWarnings()[0]).toContain('/ws/broken')
    expect(realPathWarnings()[0]).toContain('EACCES: permission denied')
    // 抛错被门面接住了，没有变成谓词的 fail-safe
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('match evaluation failed'))).toEqual(
      []
    )

    // 目录（vars.workspace）解析不了：那个目录按写法比 —— 区内读照旧放行
    warn.mockClear()
    const dirFails = contextFor(failing('/ws'))
    expect(dirFails.evaluate('read', { type: 'path', path: '/ws/f.txt' })).toMatchObject({
      effect: 'allow',
      winning: 'default:path'
    })
    expect(realPathWarnings()).toHaveLength(1)
    expect(realPathWarnings()[0]).toContain('/ws')
  })

  it("CT-R8 解析器给回空串（或非字符串）：当作解析不了、按写法比较 —— 不崩，也不因 '' 前缀命中一切而凭空多出 deny / ask", () => {
    const written = createSecurityContext(SUBJECT, ENVIRONMENT, makeProvider(NO_GRANTS()))
    const objects: Array<[string, SecurityObject]> = [
      ['write', { type: 'path', path: '/ws/f.txt' }],
      ['read', { type: 'path', path: '/ws/f.txt' }],
      ['read', { type: 'path', path: '/outside/f.txt' }],
      ['write', { type: 'path', path: '/home/u/.ssh/id_rsa' }],
      ['write', { type: 'path', path: '/etc/hosts' }]
    ]
    for (const bogus of ['', undefined, null, 42]) {
      const ctx = createSecurityContext(
        SUBJECT,
        ENVIRONMENT,
        makeProvider(NO_GRANTS(), { realPath: () => bogus as unknown as string })
      )
      for (const [action, object] of objects) {
        const label = `${JSON.stringify(bogus)} × ${action} ${String(object.path)}`
        let decision: ReturnType<typeof ctx.evaluate> | undefined
        expect(() => (decision = ctx.evaluate(action, object)), label).not.toThrow()
        // 与不给解析器的宿主逐字段同一个判决：没有凭空的命中，也没有蒸发的保护
        expect(decision, label).toEqual(written.evaluate(action, object))
      }
    }
    // 对照：真正的保护仍在（上面的「相同」不是「都放行」）
    expect(written.evaluate('write', { type: 'path', path: '/home/u/.ssh/id_rsa' })).toMatchObject({
      effect: 'deny',
      winning: 'protect-credentials#0'
    })
    expect(written.evaluate('write', { type: 'path', path: '/ws/f.txt' }).matched).toEqual([
      'ask-on-write#0'
    ])
  })

  it('CT-R9 宿主不给 realPath（扩展端）：按写法比较；卡片、日志、拒绝文案与从前一致 —— 没有 requestedPath、没有「resolves to」', async () => {
    const requestUserInput = vi.fn(
      async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: false })
    )
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(NO_GRANTS(), { requestUserInput })
    )

    // /ws/key 按写法就是工作区里的一个文件
    expect(ctx.evaluate('read', { type: 'path', path: KEY_LINK })).toMatchObject({
      effect: 'allow',
      winning: 'default:path'
    })

    const denied = await rejectionOf(
      ctx.enforcePath('write', KEY_REAL, { toolCallId: 'w9', toolName: 'write' })
    )
    expect(denied).toMatch(/^Denied by security policy rule 'protect-credentials#0'\n\n/)
    expect(denied).not.toContain('resolves to')

    expect(
      await rejectionOf(
        ctx.enforcePath('read', '/outside/f.txt', { toolCallId: 'r9', toolName: 'read' })
      )
    ).toBe('User denied access to /outside/f.txt')
    const request = requestUserInput.mock.calls[0][0] as AskInputRequest
    expect(request.command).toBe('Read(/outside/f.txt)')
    expect(request.requestedPath).toBeUndefined()
    for (const record of getSessionDecisions(SID)) expect(record.requestedPath).toBeUndefined()
  })

  it('CT-R10 客体已带着 requestedPath（上游交来的原写法）：原样保留，不被这一次的 path 冲掉；再过一遍门面也不变', () => {
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(NO_GRANTS(), { realPath: tableResolver({ [KEY_LINK]: KEY_REAL }) })
    )
    const decision = ctx.evaluate('read', {
      type: 'path',
      path: KEY_LINK,
      requestedPath: '/ws/alias'
    })
    expect(decision.ask).toMatchObject({ command: `Read(${KEY_REAL})`, requestedPath: '/ws/alias' })

    // 已经是真实去处、带着原写法的客体再判一次：幂等
    const again = ctx.evaluate('read', { type: 'path', path: KEY_REAL, requestedPath: KEY_LINK })
    expect(again.ask).toMatchObject({ command: `Read(${KEY_REAL})`, requestedPath: KEY_LINK })
  })
})

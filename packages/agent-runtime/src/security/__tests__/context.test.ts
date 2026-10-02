/**
 * createSecurityContext（PEP 门面）全链 —— evaluateReadOnly 的 force-allow 缺省、
 * enforce 的 action/displayPath 转发、禁缓存红线（grants 变化即生效）、
 * L1 全工具门的 allow 即非事件、路径客体经 provider.realPath 换成真实去处（CT-R 系列）、
 * 询问点的自动审查经门面走到接缝（CT-RV / CT-SG / CT-UR 系列）。
 */
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import { createSecurityContext } from '../context'
import { clearSessionDecisions, getSessionDecisions } from '../decisionLog'
import { clearReviewState } from '../reviewState'
import type {
  AskInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type {
  CommandObjectInput,
  MatchContext,
  ParsedPolicyFile,
  PermissionReviewAnswer,
  PolicyRuleSpec,
  SecurityContext,
  SecurityHostProvider,
  SecurityObject,
  UrlObjectInput,
  UserPolicyFile
} from '../types'
import type { ShellFacts } from '../shell'
import { createInlinePolicyMdReader } from '../builtinPolicies/inlineSources'
import { buildBuiltinPolicies } from '../builtinPolicies'
import { parsePolicyDefinitionFile } from '../policyFile'
import { assembleRules, resolvePolicyFiles } from '../assemble'
import { retiredPolicy } from './fixtures/retiredPolicies'

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
  grants: { allowList: string[] },
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
      sessionArtifactsDir: '/home/u/.shuvix/artifacts/sess-1',
      // 会话目录（外部目录门读）：工作目录、本会话临时目录、artifacts、工具结果 —— 这里自由读写，
      // 家目录 /home/u 里别处的读、会话目录外的写都问；只读的一份是技能目录
      sessionDirs: [
        '/ws',
        '/private/tmp/shuvix-501/ctx',
        '/home/u/.shuvix/artifacts/sess-1',
        '/tool-results/sess-1'
      ],
      sessionReadDirs: ['/skills'],
      // 宿主照旧供给的事实变量：出厂已没有策略读它们（protect-shuvix-config / protect-bot-files
      // 已退役为测试夹具，见 fixtures/retiredPolicies.ts），装上夹具的用例靠它们
      shuvixConfigDirs: [
        '/home/u/.shuvix/policies',
        '/home/u/.shuvix/agents',
        '/home/u/.shuvix/hooks',
        '/home/u/.shuvix/skills'
      ],
      systemDirs: []
    }),
    getSessionGrants: () => grants,
    readBuiltinPolicyMd: INLINE_POLICY_MD,
    ...overrides
  }
}

afterEach(() => clearSessionDecisions(SID))

describe('createSecurityContext', () => {
  it('CT-1 evaluateReadOnly 缺省排除 force-allow；{includeForceAllow:true} 翻转；返回 boolean —— 出厂「允许并记住」是询问门 match 里的豁免、不在 force-allow 层，被动 UI 缺省也认它', () => {
    // 退役的 session-grants 夹具（按用户策略装上）把「允许并记住」放回 force-allow 层：
    // 一道不认授权的用户询问门 + 夹具的 force-allow → 缺省不纳入 → 不放行
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { allowList: ['Read(/data)'] },
        {
          getUserPolicies: () => [
            userPolicy('ask-data', [
              { effect: 'ask', match: "object.type == 'path' && inDir(object.path, '/data')" }
            ]),
            retiredPolicy('session-grants')
          ]
        }
      )
    )
    const data: SecurityObject = { type: 'path', path: '/data/x.txt' }
    expect(ctx.evaluate('read', data)).toMatchObject({
      effect: 'allow',
      winning: 'session-grants#0'
    })
    expect(ctx.evaluateReadOnly('read', data)).toBe(false)
    expect(ctx.evaluateReadOnly('read', data, { includeForceAllow: true })).toBe(true)
    expect(typeof ctx.evaluateReadOnly('read', data)).toBe('boolean')

    // 出厂：家目录里的读有外部目录门；「允许并记住」过的 ~/.ssh 是门 match 里的豁免 —— 门根本没命中，
    // 所以缺省（不纳入 force-allow）也放行
    const credential: SecurityObject = { type: 'path', path: '/home/u/.ssh/id_rsa' }
    const bare = createSecurityContext(SUBJECT, ENVIRONMENT, makeProvider({ allowList: [] }))
    expect(bare.evaluateReadOnly('read', credential)).toBe(false)
    const remembered = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider({ allowList: ['Read(/home/u/.ssh)'] })
    )
    expect(remembered.evaluateReadOnly('read', credential)).toBe(true)

    // 家目录外与会话目录里的读都放行
    expect(bare.evaluateReadOnly('read', { type: 'path', path: '/ws/f.txt' })).toBe(true)
    expect(bare.evaluateReadOnly('read', { type: 'path', path: '/outside/f.txt' })).toBe(true)
  })

  it('CT-2 enforcePath 以 mode 为 action、displayPath 进入展示；enforceCommand/enforceGitOp action=execute', async () => {
    // 询问一律允许：没圈住的命令会问；工作区（会话目录）里的读写与 git（出厂没有 git 策略）放行 ——
    // 问没问都各落一条日志
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { allowList: [] },
        {
          requestUserInput: vi.fn(
            async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
          )
        }
      )
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
    const strict = createSecurityContext(SUBJECT, ENVIRONMENT, makeProvider({ allowList: [] }))
    await expect(
      strict.enforcePath('write', '/outside/b.txt', {
        toolCallId: 'tc-5',
        toolName: 'write',
        displayPath: 'rel/b.txt'
      })
    ).rejects.toThrow('Access denied: path outside workspace and no way to ask: rel/b.txt')
  })

  it('CT-3 禁缓存：同一实例下 grants 变化即生效（加上立即放行、撤掉立即回到询问）', () => {
    const grants = { allowList: [] as string[] }
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, makeProvider(grants))

    // allowList 落库（「允许并记住」）立即可见 —— 用外部目录门的家目录读验证
    const credential: SecurityObject = { type: 'path', path: '/home/u/.ssh/config' }
    expect(ctx.evaluate('read', credential).effect).toBe('ask')
    grants.allowList.push('Read(/home/u/.ssh/config)')
    // 授权是门 match 里的豁免：放行时门根本没命中
    expect(ctx.evaluate('read', credential)).toMatchObject({
      effect: 'allow',
      winning: 'default:path',
      matched: []
    })

    // 写授权同理（会话目录外的写 ask → 记住后同一实例立即 allow）
    const outside: SecurityObject = { type: 'path', path: '/outside/f.txt' }
    expect(ctx.evaluate('write', outside).effect).toBe('ask')
    grants.allowList.push('Write(/outside)')
    expect(ctx.evaluate('write', outside)).toMatchObject({
      effect: 'allow',
      winning: 'default:path',
      matched: []
    })

    // 条目被撤掉（会话配置面板里逐条移除）：同一实例下一次评估就回到询问
    grants.allowList.length = 0
    expect(ctx.evaluate('read', credential).effect).toBe('ask')
    expect(ctx.evaluate('write', outside).effect).toBe('ask')
  })

  it('CT-W1 端到端旗舰：match 取反工作区的 ask 门 —— 工作区内 allow、区外 ask（vars 流入 match 上下文）', () => {
    // 用户自己的读取门（只放过 workspace）—— vars 流入 match 上下文
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { allowList: [] },
        {
          getUserPolicies: () => [
            {
              name: 'ask-outside-workspace',
              displayName: 'ask-outside-workspace',
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
    expect(outside.winning).toBe('ask-outside-workspace#0')
    expect(outside.matched).toEqual(['ask-outside-workspace#0'])
  })

  it('CT-W2 provider.logger.warn 收到 fail-safe 告警（含 <policy>#<index> 规则 id）', () => {
    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() }
    const provider = makeProvider(
      { allowList: [] },
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
      { allowList: [] },
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
      makeProvider({ allowList: [] }, { requestUserInput })
    )
    await expect(ctx.enforceInvocation({ ...INVOCATION_OPTS })).resolves.toEqual({
      status: 'allowed'
    })
    expect(getSessionDecisions(SID)).toEqual([])
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('CT-T1b allow 即非事件：用户 force-allow 恒命中 invocation → 仍 allowed 且无日志、无弹窗', async () => {
    const requestUserInput = rejectingChannel()
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { allowList: [] },
        {
          requestUserInput,
          getUserPolicies: () => [
            userPolicy('trust-tools', [
              { effect: 'force-allow', match: "object.type == 'invocation'" }
            ])
          ]
        }
      )
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
    // 用户同名覆盖内置 ask-on-external-path（避免 ask 门弹窗干扰），换成按工具过滤的 deny
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { allowList: [] },
        {
          getUserPolicies: () => [
            userPolicy('ask-on-external-path', [
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
      ctx.enforcePath('write', '/outside/f.txt', { toolCallId: 'tc-w', toolName: 'write' })
    ).rejects.toThrow(/Denied by security policy rule/)
    await expect(
      ctx.enforcePath('write', '/outside/f.txt', { toolCallId: 'tc-r', toolName: 'read' })
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
        { allowList: [] },
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

describe('createSecurityContext — enforceCommand 的 sandboxed 事实与「完全访问」标记', () => {
  const BASH_OPTS = { toolCallId: 'tc-sbx', toolName: 'bash' }

  /** 截下门面造出的命令客体（静态 allow 层的派生规则，永不命中）、记下询问材料（一律允许） */
  function sandboxProbe(userPolicies: ParsedPolicyFile[] = []): {
    provider: SecurityHostProvider
    requestUserInput: Mock<(req: InputRequest) => Promise<InputResponse>>
    warn: Mock
    lastObject: () => MatchContext['object'] | undefined
  } {
    const requestUserInput = vi.fn(
      async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
    )
    const warn = vi.fn()
    const objects: Array<MatchContext['object']> = []
    return {
      provider: makeProvider(
        { allowList: [] },
        {
          requestUserInput,
          logger: { info: vi.fn(), warn, error: vi.fn() },
          getUserPolicies: () => userPolicies,
          derivedRules: () => [
            {
              id: 'derived:capture',
              effect: 'allow' as const,
              tier: 'static-allow' as const,
              source: { kind: 'derived' as const },
              matches: (matchCtx) => {
                objects.push(matchCtx.object)
                return false
              }
            }
          ]
        }
      ),
      requestUserInput,
      warn,
      lastObject: () => objects[objects.length - 1]
    }
  }

  /** 唯一一张询问卡片 */
  const onlyAsk = (probe: ReturnType<typeof sandboxProbe>): AskInputRequest => {
    expect(probe.requestUserInput).toHaveBeenCalledTimes(1)
    const request = probe.requestUserInput.mock.calls[0][0]
    expect(request.kind).toBe('ask')
    return request as AskInputRequest
  }

  it('PO-7 sandboxed:true → 客体上 sandboxed === true；放行、不弹卡，日志归因 default:command', async () => {
    const probe = sandboxProbe()
    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, probe.provider)
    await expect(
      ctx.enforceCommand({ channel: 'bash', command: 'ls -la', sandboxed: true }, BASH_OPTS)
    ).resolves.toEqual({ status: 'allowed' })

    expect(probe.lastObject()!.sandboxed).toBe(true)
    expect(probe.requestUserInput).not.toHaveBeenCalled()
    const logged = getSessionDecisions(SID)
    expect(logged).toHaveLength(1)
    expect([logged[0].effect, logged[0].winning, logged[0].matched]).toEqual([
      'allow',
      'default:command',
      []
    ])
    expect(probe.warn).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<CommandObjectInput>]>([
    ['省略', {}],
    ['false', { sandboxed: false }],
    // 只有字面 true 才算圈住：非布尔的真值归一成 false，而不是原样交给策略去 fail-safe
    ['非布尔的真值', { sandboxed: 'yes' as never }]
  ])(
    'PO-7 sandboxed %s → 客体上恰是布尔 false，走询问（ask-on-command#0），零告警',
    async (_label, fields) => {
      const probe = sandboxProbe()
      const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, probe.provider)
      await expect(
        ctx.enforceCommand({ channel: 'bash', command: 'ls -la', ...fields }, BASH_OPTS)
      ).resolves.toEqual({ status: 'allowed' })

      expect(probe.lastObject()!.sandboxed).toBe(false)
      expect(onlyAsk(probe).command).toBe('ls -la')
      const logged = getSessionDecisions(SID)
      expect([logged[0].effect, logged[0].winning]).toEqual(['ask', 'ask-on-command#0'])
      expect(probe.warn).not.toHaveBeenCalled()
    }
  )

  it('PO-7 ssh（带 host）与 powershell 不传 sandboxed → 客体上都是 false，都问', async () => {
    const rows: Array<[CommandObjectInput, string]> = [
      [{ channel: 'ssh', command: 'uptime', host: 'prod' }, 'mcp__ssh__exec'],
      [{ channel: 'powershell', command: 'Get-Date' }, 'powershell']
    ]
    for (const [input, toolName] of rows) {
      clearSessionDecisions(SID)
      const probe = sandboxProbe()
      const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, probe.provider)
      await expect(ctx.enforceCommand(input, { toolCallId: 'tc-sbx', toolName })).resolves.toEqual({
        status: 'allowed'
      })

      const object = probe.lastObject()!
      expect({ channel: input.channel, sandboxed: object.sandboxed }).toEqual({
        channel: input.channel,
        sandboxed: false
      })
      onlyAsk(probe)
      const logged = getSessionDecisions(SID)
      expect([logged[0].effect, logged[0].winning]).toEqual(['ask', 'ask-on-command#0'])
    }
  })

  it('PO-7 opts.unsandboxed:true → 卡片带 unsandboxed:true（background 照带）；不传就没有这个标记', async () => {
    const escalated = sandboxProbe()
    await createSecurityContext(SUBJECT, ENVIRONMENT, escalated.provider).enforceCommand(
      { channel: 'bash', command: 'open -a Safari' },
      { ...BASH_OPTS, unsandboxed: true, background: true }
    )
    const escalatedCard = onlyAsk(escalated)
    expect(escalatedCard.unsandboxed).toBe(true)
    expect(escalatedCard.background).toBe(true)
    expect(escalatedCard.command).toBe('open -a Safari')

    const foreground = sandboxProbe()
    await createSecurityContext(SUBJECT, ENVIRONMENT, foreground.provider).enforceCommand(
      { channel: 'bash', command: 'open -a Safari' },
      { ...BASH_OPTS, unsandboxed: true }
    )
    const foregroundCard = onlyAsk(foreground)
    expect(foregroundCard.unsandboxed).toBe(true)
    expect(foregroundCard.background).toBeUndefined()

    // 沙箱套不上时的逐条询问不带标记（宿主不传这个 opt）：卡片上没有「完全访问」
    const plain = sandboxProbe()
    await createSecurityContext(SUBJECT, ENVIRONMENT, plain.provider).enforceCommand(
      { channel: 'bash', command: 'ls -la' },
      BASH_OPTS
    )
    expect(onlyAsk(plain).unsandboxed).toBeUndefined()
  })

  it('PO-7 放行的决策不造询问材料：用户 force-allow 放宽了的完全访问申请、以及 opt 与圈住的执行同时出现 —— 都不弹卡', async () => {
    // 用户自己的 force-allow 压过 ask-on-command：申请完全访问的命令也被放行，卡片（连同标记）根本不存在
    const trusted = sandboxProbe([
      userPolicy('trust-commands', [{ effect: 'force-allow', match: "object.type == 'command'" }])
    ])
    await expect(
      createSecurityContext(SUBJECT, ENVIRONMENT, trusted.provider).enforceCommand(
        { channel: 'bash', command: 'open -a Safari' },
        { ...BASH_OPTS, unsandboxed: true }
      )
    ).resolves.toEqual({ status: 'allowed' })
    expect(trusted.requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)[0].winning).toBe('trust-commands#0')

    // 标记只是卡片上的装饰：询问与否由客体上的 sandboxed 定，opt 不会把一次放行变成询问
    clearSessionDecisions(SID)
    const confined = sandboxProbe()
    await expect(
      createSecurityContext(SUBJECT, ENVIRONMENT, confined.provider).enforceCommand(
        { channel: 'bash', command: 'ls -la', sandboxed: true },
        { ...BASH_OPTS, unsandboxed: true }
      )
    ).resolves.toEqual({ status: 'allowed' })
    expect(confined.requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)[0].winning).toBe('default:command')
  })
})

describe('createSecurityContext — enforceDatabase（数据库查询守卫）', () => {
  const DB_OPTS = { toolCallId: 'tc-db', toolName: 'database', abortError: 'TOOL_ABORTED' }

  /**
   * 固定询问应答的 provider —— 出厂没有数据库策略（默认放行），这里装上退役的 ask-on-database
   * 夹具（按用户策略，对可写连接 ask），好让询问的各个分支走得到
   */
  function databaseProvider(response: InputResponse): {
    provider: SecurityHostProvider
    requestUserInput: ReturnType<typeof vi.fn>
  } {
    const requestUserInput = vi.fn(async (_req: InputRequest): Promise<InputResponse> => response)
    return {
      provider: makeProvider(
        { allowList: [] },
        { requestUserInput, getUserPolicies: () => [retiredPolicy('ask-on-database')] }
      ),
      requestUserInput
    }
  }

  it('CT-4 action/objectKind = execute/database；tool 维度取自 opts.toolName（tool.name 规则可命中）', async () => {
    // 出厂没有数据库策略：只留用户规则的按工具 deny
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { allowList: [] },
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
    // 同一客体换工具名：tool 维度不再命中 → 默认放行
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
        { allowList: [] },
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

  it('CT-6 只读连接的 allow 是事件（与 L1 非事件相反）：放行且落一条 allow 日志、不弹窗；用户 force-allow 放宽的可写连接归因到它', async () => {
    const askOnDatabase = retiredPolicy('ask-on-database')
    const requestUserInput = rejectingChannel()
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider({ allowList: [] }, { requestUserInput, getUserPolicies: () => [askOnDatabase] })
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

    // 可写连接 + 用户对这条连接的 force-allow：同样放行，但归因 force-allow 那条
    // （ask-on-database 仍在 matched 里 —— 门没被拆掉，只是被压过）
    const trustedCtx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(
        { allowList: [] },
        {
          requestUserInput: rejectingChannel(),
          getUserPolicies: () => [
            askOnDatabase,
            userPolicy('trust-prod', [
              {
                effect: 'force-allow',
                match: "object.type == 'database' && object.credential == 'prod-mysql'"
              }
            ])
          ]
        }
      )
    )
    await expect(trustedCtx.enforceDatabase(DATABASE_INPUT, { ...DB_OPTS })).resolves.toEqual({
      status: 'allowed'
    })
    expect(getSessionDecisions(SID)[0]).toMatchObject({
      effect: 'allow',
      winning: 'trust-prod#0',
      matched: ['trust-prod#0', 'ask-on-database#0']
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
        { allowList: [] },
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
        { allowList: [] },
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
        { allowList: [] },
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
        { allowList: [] },
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
      const provider = makeProvider({ allowList: [] }, { getUserPolicies: () => [policy(kind)] })
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
    grants = { allowList: [] as string[] }
  ): ReturnType<typeof createSecurityContext> =>
    createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(grants, { getUserPolicies: () => policies })
    )

  it('CU-1 旗舰：用户 force-allow 局部放宽外部目录的读取门 —— ~/.aws 读放行归因用户规则，别的家目录读与 ~/.aws 写照旧', () => {
    const ctx = contextWith([
      pathPolicy('trust-aws', [
        {
          effect: 'force-allow',
          conditions: { action: ['read'] },
          match: "inDir(object.path, '/home/u/.aws')"
        }
      ])
    ])

    // ~/.aws 读：force-allow 压过内置外部目录门的读询问 → allow，归因到用户规则
    const granted = ctx.evaluate('read', { type: 'path', path: '/home/u/.aws/config' })
    expect(granted.effect).toBe('allow')
    expect(granted.winning).toBe('trust-aws#0')
    // 门没被拆掉，只是被压过 —— ask-on-external-path#0 仍在 matched 里（决策日志据此回链）
    expect(granted.matched).toContain('ask-on-external-path#0')

    // 放宽是局部的：策略没提的家目录路径仍归内置读取门管
    const elsewhere = ctx.evaluate('read', { type: 'path', path: '/home/u/.ssh/config' })
    expect(elsewhere.effect).toBe('ask')
    expect(elsewhere.winning).toBe('ask-on-external-path#0')

    // 放宽是按 action 的：同一目录的写入不受这条 read force-allow 影响，照外部目录门的写规则问
    const write = ctx.evaluate('write', { type: 'path', path: '/home/u/.aws/config' })
    expect(write.effect).toBe('ask')
    expect(write.winning).toBe('ask-on-external-path#1')
    expect(write.matched).toEqual(['ask-on-external-path#1'])
  })

  it('CU-2 force-allow 压不过 deny：用户自己加回的「凭据目录拒写」照拒，另一份策略里的 force-allow 也救不回', () => {
    const ctx = contextWith([
      pathPolicy('no-credential-writes', [
        {
          effect: 'deny',
          conditions: { action: ['write'] },
          match: "inDir(object.path, vars.home + '/.ssh')"
        }
      ]),
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
    expect(decision.winning).toBe('no-credential-writes#0')
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

  it('CU-F1 旗舰：用户 force-ask 让特定文件在 force-allow 放宽、「允许并记住」过（装着 force-allow 的 session-grants 夹具）时仍然询问，且不给「允许并记住」', () => {
    // 需求原型：某些文件始终要过目一次，任何会话级同意都对它不生效。出厂的「允许并记住」只是外部
    // 目录门里的豁免、压不过任何别的门；装上退役的 session-grants 夹具，把它放回 force-allow 层来较量
    const ctx = contextWith(
      [
        retiredPolicy('session-grants'),
        pathPolicy('trust-data', [{ effect: 'force-allow', match: "inDir(object.path, '/data')" }]),
        pathPolicy('guard-prod', [
          { effect: 'force-ask', match: "inDir(object.path, '/data/prod')" },
          {
            effect: 'deny',
            conditions: { action: ['write'] },
            match: "inDir(object.path, '/data/prod/locked')"
          }
        ])
      ],
      { allowList: ['Read(/data/prod)'] }
    )

    // 用户的 force-allow + 该路径还「允许并记住」过（夹具的 force-allow）—— 两条都命中，仍然 ask
    const guarded = ctx.evaluate('read', { type: 'path', path: '/data/prod/secrets.env' })
    expect(guarded.effect).toBe('ask')
    expect(guarded.winning).toBe('guard-prod#0')
    expect(guarded.matched).toContain('trust-data#0')
    expect(guarded.matched).toContain('session-grants#0')
    // 记忆入口不给：那条授权落在 force-allow 层，点了也压不过这道门
    expect(guarded.ask?.rememberEntry).toBeUndefined()

    // 对照：策略没覆盖的路径照旧被 force-allow 放行
    const elsewhere = ctx.evaluate('read', { type: 'path', path: '/data/other/x.txt' })
    expect(elsewhere).toMatchObject({ effect: 'allow', winning: 'trust-data#0' })

    // 对照：force-ask 压不过 deny —— 两条同时命中时是拒绝
    const denied = ctx.evaluate('write', { type: 'path', path: '/data/prod/locked/x' })
    expect(denied.effect).toBe('deny')
    expect(denied.winning).toBe('guard-prod#1')
    expect(denied.matched).toContain('guard-prod#0')
  })

  it('CU-4 evaluateReadOnly 缺省丢弃所有 force-allow（用户策略也不例外）；{includeForceAllow:true} 翻转', () => {
    const ctx = contextWith([
      pathPolicy('trust-aws', [
        {
          effect: 'force-allow',
          conditions: { action: ['read'] },
          match: "inDir(object.path, '/home/u/.aws')"
        }
      ])
    ])
    const target: SecurityObject = { type: 'path', path: '/home/u/.aws/config' }

    // 按 tier 过滤而非按来源：用户 md 里写死的 force-allow 同样被丢弃（EvaluateOpts 的显式契约）
    expect(ctx.evaluateReadOnly('read', target)).toBe(false)
    expect(ctx.evaluateReadOnly('read', target, { includeForceAllow: true })).toBe(true)
    // 对照：主动评估（evaluate）缺省纳入 force-allow
    expect(ctx.evaluate('read', target).effect).toBe('allow')
  })

  it('CU-6 同名覆盖 ask-on-external-path、写规则删掉 vars.grantedWrite 那一截 → 已授权路径的写重新 ask（归因用户那份）；读照旧放行（写授权含读那一截没动）', () => {
    const grants = { allowList: ['Write(/home/u/data)'] }
    const target: SecurityObject = { type: 'path', path: '/home/u/data/x.txt' }

    // 覆盖副本 = 出厂 en 文件原样，只把写规则 match 末尾的授权豁免删掉
    const builtin = parsePolicyDefinitionFile(
      INLINE_POLICY_MD('ask-on-external-path.md')!,
      'ask-on-external-path'
    )!
    const writeMatch = builtin.rules[1].match!
    const stripped = writeMatch.replace(/\s*&& !inDir\(object\.path, vars\.grantedWrite\)$/, '')
    expect(stripped).not.toBe(writeMatch)
    const noWriteGrants: ParsedPolicyFile = {
      ...builtin,
      rules: [builtin.rules[0], { ...builtin.rules[1], match: stripped }]
    }

    // 对照：内置在位时写授权生效（门 match 里的豁免）
    expect(contextWith([], grants).evaluate('write', target)).toMatchObject({
      effect: 'allow',
      winning: 'default:path'
    })

    // 去掉写那一截：条目还在会话里，但没有规则拿它豁免写了 → 回到询问，归因用户那份
    const ctx = contextWith([noWriteGrants], grants)
    const write = ctx.evaluate('write', target)
    expect(write).toMatchObject({ effect: 'ask', winning: 'ask-on-external-path#1' })
    expect(write.prompt?.policies).toEqual([builtin.displayName])

    // 读规则原样留着（写授权含读）
    expect(ctx.evaluate('read', target)).toMatchObject({
      effect: 'allow',
      winning: 'default:path'
    })
  })
})

describe('createSecurityContext — 授权快照一次性（回归守护）', () => {
  it('CV-3 一次 evaluate 里 getSessionGrants / getVars 各恰好 1 次，决策取第一次快照', () => {
    // 每次调用翻转的 stub：若装配与求值各自 buildPolicyVars，两处会看到不同的授权视图
    let call = 0
    const getSessionGrants = vi.fn(() => ({
      allowList: call++ === 0 ? ['Write(/outside)'] : ([] as string[])
    }))
    const getVars = vi.fn(() => ({
      workspace: '/ws',
      toolResultsBase: '/tool-results',
      skillsDirs: ['/skills'],
      memoryDirs: [],
      knowledgeRoot: '/kb',
      knowledgeSessionDirs: [],
      home: '/home/u',
      botsDir: '/home/u/.shuvix/bots',
      systemDirs: [] as string[],
      sessionDirs: ['/ws']
    }))

    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, {
      host: 'desktop',
      pathSep: '/',
      getVars,
      getSessionGrants,
      readBuiltinPolicyMd: INLINE_POLICY_MD
    })

    // 第一次快照里有 Write(/outside) → 会话目录外的写被「允许并记住」豁免
    const first = ctx.evaluate('write', { type: 'path', path: '/outside/f.txt' })
    expect(first).toMatchObject({ effect: 'allow', winning: 'default:path', matched: [] })
    // 丢掉 assembleRules 的第二参（各自 buildPolicyVars）时，这两个计数会变成 2
    expect(getSessionGrants).toHaveBeenCalledTimes(1)
    expect(getVars).toHaveBeenCalledTimes(1)

    // 第二次评估重新取快照（禁缓存），此时授权已经没了 → 询问门回来
    const second = ctx.evaluate('write', { type: 'path', path: '/outside/f.txt' })
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
        { allowList: [] },
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
  it('CT-W4 缺 botsDir 的桌面宿主经门面反复评估：只记一行「not provided」、零 fail-safe，会话目录外的普通写照常落回外部目录门', () => {
    // 用户装了一份只守一个目录的 force-ask（退役的 protect-bot-files 夹具）而宿主没给那个目录：
    // assemble 替它把 botsDir 绑成 null。不绑的话每次写都缺键报错、fail-safe 成命中：普通写全变成
    // 免不掉的 force-ask，logger 每次评估刷一行 fail-safe。
    // 门面把两个出口（「not provided」与 evaluate 的 fail-safe）都接到 provider.logger，所以在这里一起数
    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() }
    const grants = { allowList: [] as string[] }
    const { botsDir: _botsDir, ...varsWithoutBotsDir } = makeProvider(grants).getVars()
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(grants, {
        getVars: () => varsWithoutBotsDir,
        logger,
        getUserPolicies: () => [retiredPolicy('protect-bot-files')]
      })
    )

    for (let i = 0; i < 3; i++) {
      expect(ctx.evaluate('write', { type: 'path', path: '/outside/f.txt' })).toMatchObject({
        effect: 'ask',
        winning: 'ask-on-external-path#1'
      })
    }
    expect(ctx.evaluateReadOnly('write', { type: 'path', path: '/outside/f.txt' })).toBe(false)

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
    literalCommands: [],
    dynamics: [],
    redirects: [],
    depthExceeded: false
  })

  /** 允许一切的询问通道（ask 决策要走完 enforce 才看得到 status） */
  const allowingChannel = (): Mock<(req: InputRequest) => Promise<InputResponse>> =>
    vi.fn(async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: true }))

  /**
   * 出厂策略没有一份读结构属性（block-catastrophic-commands 2026-10-01 已退役）；这组测的是
   * 接线，所以缺省装上它的夹具（按用户策略）当作「引用结构属性的那份策略」。
   * 传 getUserPolicies 覆盖即换掉它。
   */
  const CATASTROPHIC = retiredPolicy('block-catastrophic-commands')

  function shellProvider(
    parser: Partial<SecurityHostProvider['shellParser']> & { analyze: Mock },
    overrides: Partial<SecurityHostProvider> = {}
  ): SecurityHostProvider {
    return makeProvider(
      { allowList: [] },
      {
        shellParser: {
          ensureReady: parser.ensureReady ?? (async () => {}),
          analyze: parser.analyze as unknown as (command: string) => ShellFacts
        },
        requestUserInput: allowingChannel(),
        getUserPolicies: () => [CATASTROPHIC],
        ...overrides
      }
    )
  }

  it('CT-S1 一次 enforce 只解析一次：五条 deny 规则多次引用 object.commands 也只跑一遍', async () => {
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

  it('CT-S3 无策略引用结构属性时一次都不解析（惰性）—— 只有出厂策略时就是这样', async () => {
    // 不装夹具：出厂策略全都不碰 object.commands。此时解析器不该被叫醒：命令工具是高频路径，
    // 「用不上也每条都解析一遍」的成本会一直挂在那里。
    const analyze = vi.fn(() => rmRootFacts())
    const ctx = createSecurityContext(
      SHELL_SUBJECT,
      ENVIRONMENT,
      shellProvider({ analyze }, { getUserPolicies: () => [] })
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
    // sandboxed / unconfinedReason 是宿主上报的标量事实（恒有值），可枚举；解析层的结构属性仍然不可枚举
    expect(Object.keys(captured!)).toEqual([
      'type',
      'command',
      'channel',
      'sandboxed',
      'unconfinedReason'
    ])
    const serialized = JSON.stringify(captured)
    for (const key of ['parsed', 'commands', 'writes']) {
      expect(serialized).not.toContain(key)
    }
    const beforeManualRead = analyze.mock.calls.length
    // 直接读才触发（本次决策里 block-catastrophic-commands 夹具已读过，故已是 1）
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
        { allowList: [] },
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

  /**
   * Windows 的 `powershell` 命令工具：命令交给 PowerShell 自己的扫描器读（bash 解析器读 PowerShell
   * 会得出貌似合理的错事实 —— 反引号在 bash 里是命令替换、在 PowerShell 里是转义），结构规则照常
   * 对它生效。宿主的 bash 解析器只用来读嵌在里面的 `bash -c '…'` 载荷：真有这种载荷时才调用、
   * 收到的是载荷本身而不是整条命令；它的就绪照样要等（载荷随时可能有）；它抛错只跳过那一段载荷
   * 并留下告警，其余事实保留。通道本身照样是策略可见的属性：用户规则能按 `object.channel` 单独管它。
   */
  describe('powershell 通道：PowerShell 扫描器，bash 解析器只读嵌套载荷', () => {
    const PS_OPTS = { toolCallId: 'ps-1', toolName: 'powershell' }

    /** 一个会触发 Windows 格式化规则（夹具 #2）的解析结果 —— 只有 bash 通道会读到它 */
    const formatFacts = (): ShellFacts => ({
      source: 'format C:',
      parsed: true,
      reason: 'ok',
      errorSpans: [],
      literalCommands: [
        {
          name: 'format',
          base: 'format',
          argv: ['format', 'C:'],
          complete: true,
          span: SPAN,
          depth: 0
        }
      ],
      dynamics: [],
      redirects: [],
      depthExceeded: false
    })

    /** `echo x > /dev/sda` 的解析结果：一条写块设备的重定向 */
    const redirectToDiskFacts = (): ShellFacts => ({
      source: 'echo x > /dev/sda',
      parsed: true,
      reason: 'ok',
      errorSpans: [],
      literalCommands: [
        { name: 'echo', base: 'echo', argv: ['echo', 'x'], complete: true, span: SPAN, depth: 0 }
      ],
      dynamics: [],
      redirects: [{ kind: 'write', target: '/dev/sda', span: SPAN }],
      depthExceeded: false
    })

    /** 把门面构造的命令客体截下来（静态 allow 层的派生规则，永不命中） */
    function capturingProvider(
      analyze: Mock,
      ensureReady: Mock
    ): {
      provider: SecurityHostProvider
      captured: () => MatchContext['object'] | undefined
    } {
      let captured: MatchContext['object'] | undefined
      const provider = shellProvider(
        { analyze, ensureReady },
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
      return { provider, captured: () => captured }
    }

    // PowerShell 里 `rm` 是 Remove-Item 的别名，`-rf` 不是 -Recurse 的任何缩写（那条命令在 PowerShell 里
    // 只会报参数错）—— 所以落到询问；bash 解析器只读嵌套的 `bash -c` 载荷，这里一次都不叫
    it('CT-PS1 同一份「rm -rf /」事实：bash 被 block-catastrophic-commands 拒；powershell 落到询问、允许后放行，bash 解析器一次都不叫', async () => {
      const bashAnalyze = vi.fn(() => rmRootFacts())
      const bashCtx = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        shellProvider({ analyze: bashAnalyze })
      )
      await expect(
        bashCtx.enforceCommand(
          { channel: 'bash', command: 'rm -rf /' },
          { ...PS_OPTS, toolName: 'bash' }
        )
      ).rejects.toThrow('block-catastrophic-commands#0')
      expect(bashAnalyze).toHaveBeenCalledTimes(1)

      clearSessionDecisions(SHELL_SID)
      const analyze = vi.fn(() => rmRootFacts())
      const requestUserInput = allowingChannel()
      const ctx = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        shellProvider({ analyze }, { requestUserInput })
      )
      await expect(
        ctx.enforceCommand({ channel: 'powershell', command: 'rm -rf /' }, PS_OPTS)
      ).resolves.toEqual({ status: 'allowed' })
      expect(analyze).not.toHaveBeenCalled()
      expect(requestUserInput).toHaveBeenCalledTimes(1)
      const logged = getSessionDecisions(SHELL_SID)[0]
      expect([logged.effect, logged.winning]).toEqual(['ask', 'ask-on-command#0'])
    })

    it('CT-PS2 powershell 的命令客体：只有 type / command / channel / sandboxed / unconfinedReason 五个可枚举键（没有 host），结构属性来自 PowerShell 扫描器', async () => {
      const analyze = vi.fn(() => redirectToDiskFacts())
      const ensureReady = vi.fn(async () => {})
      const probe = capturingProvider(analyze, ensureReady)
      const ctx = createSecurityContext(SHELL_SUBJECT, ENVIRONMENT, probe.provider)

      // 写块设备的重定向照样被看见 —— 与 bash 同一条规则拒
      await expect(
        ctx.enforceCommand(
          { channel: 'powershell', command: 'echo x > /dev/sda', cwd: '/ws' },
          PS_OPTS
        )
      ).rejects.toThrow('block-catastrophic-commands#1')
      const object = probe.captured()
      expect(object).toBeDefined()
      expect(Object.keys(object!)).toEqual([
        'type',
        'command',
        'channel',
        'sandboxed',
        'unconfinedReason'
      ])
      expect(object!.channel).toBe('powershell')
      expect('host' in object!).toBe(false)
      expect(object!.parsed).toBe(true)
      // echo 是 Write-Output 的别名：base 取规范名，argv 保留字面
      expect(object!.commands).toEqual([
        { base: 'Write-Output', argv: ['echo', 'x'], wrappers: [], complete: true, depth: 0 }
      ])
      expect(object!.writes).toEqual(['/dev/sda'])
      // bash 解析器只用来读嵌套的 `bash -c` 载荷：这里没有，所以没叫它；但就绪照样等（载荷随时可能有）
      expect(analyze).not.toHaveBeenCalled()
      expect(ensureReady).toHaveBeenCalledTimes(1)
    })

    it('CT-PS2b 对照：同一条命令走 bash 通道 —— 等解析器就绪、解析一次、writes 里有 /dev/sda', async () => {
      const analyze = vi.fn(() => redirectToDiskFacts())
      const ensureReady = vi.fn(async () => {})
      const probe = capturingProvider(analyze, ensureReady)
      const ctx = createSecurityContext(SHELL_SUBJECT, ENVIRONMENT, probe.provider)

      await expect(
        ctx.enforceCommand(
          { channel: 'bash', command: 'echo x > /dev/sda', cwd: '/ws' },
          { ...PS_OPTS, toolName: 'bash' }
        )
      ).rejects.toThrow('block-catastrophic-commands#1')
      expect(ensureReady).toHaveBeenCalledTimes(1)
      const object = probe.captured()
      expect(object).toBeDefined()
      expect(object!.parsed).toBe(true)
      expect(object!.writes).toEqual(['/dev/sda'])
      expect(analyze).toHaveBeenCalledTimes(1)
    })

    it('CT-PS3 用户规则可以按通道写：`channel == powershell` 的 deny 只拦 powershell，按 bash 写的也碰不到 powershell', async () => {
      const analyze = vi.fn((command: string) => unparsedFacts(command))
      const denyOn = (channel: string): ParsedPolicyFile =>
        userPolicy(`deny-${channel}`, [
          { effect: 'deny', match: `object.type == 'command' && object.channel == '${channel}'` }
        ])

      const psRule = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        shellProvider({ analyze }, { getUserPolicies: () => [denyOn('powershell')] })
      )
      await expect(
        psRule.enforceCommand({ channel: 'powershell', command: 'Get-Date' }, PS_OPTS)
      ).rejects.toThrow(/Denied by security policy rule/)
      await expect(
        psRule.enforceCommand(
          { channel: 'bash', command: 'date' },
          { ...PS_OPTS, toolName: 'bash' }
        )
      ).resolves.toEqual({ status: 'allowed' })

      const bashRule = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        shellProvider({ analyze }, { getUserPolicies: () => [denyOn('bash')] })
      )
      await expect(
        bashRule.enforceCommand({ channel: 'powershell', command: 'Get-Date' }, PS_OPTS)
      ).resolves.toEqual({ status: 'allowed' })
      await expect(
        bashRule.enforceCommand(
          { channel: 'bash', command: 'date' },
          { ...PS_OPTS, toolName: 'bash' }
        )
      ).rejects.toThrow(/Denied by security policy rule/)
    })

    it('CT-PS4 询问卡片：toolName 是 powershell、命令一字不改（不加任何前缀）、后台标记带到', async () => {
      const requestUserInput = allowingChannel()
      const ctx = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        shellProvider({ analyze: vi.fn(() => rmRootFacts()) }, { requestUserInput })
      )
      const command = 'Get-ChildItem $env:USERPROFILE | Where-Object { $_.Length -gt 1MB }'
      await ctx.enforceCommand(
        { channel: 'powershell', command },
        { ...PS_OPTS, description: 'Big files', background: true }
      )

      expect(requestUserInput).toHaveBeenCalledTimes(1)
      const request = requestUserInput.mock.calls[0][0] as AskInputRequest
      expect(request.kind).toBe('ask')
      expect(request.toolName).toBe('powershell')
      expect(request.command).toBe(command)
      expect(request.background).toBe(true)
      expect(request.description).toBe('Big files')
    })

    /**
     * 这条曾经钉的是一个已知缺口（PowerShell 命令不解析，放宽的会话里它们前面什么都没有）；
     * PowerShell 扫描器接上之后，Windows 的格式化规则对两种 shell 一视同仁，deny 压过 force-allow。
     */
    it('CT-PS5 `format C:`：bash 与 powershell 都被 Windows 格式化规则拒，用户对命令的 force-allow 也压不过', async () => {
      const trusting = (
        analyze: Mock,
        requestUserInput: SecurityHostProvider['requestUserInput']
      ): SecurityHostProvider =>
        shellProvider(
          { analyze },
          {
            requestUserInput,
            getUserPolicies: () => [
              CATASTROPHIC,
              userPolicy('trust-commands', [
                { effect: 'force-allow', match: "object.type == 'command'" }
              ])
            ]
          }
        )

      const bashAnalyze = vi.fn(() => formatFacts())
      const bashCtx = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        trusting(bashAnalyze, rejectingChannel())
      )
      await expect(
        bashCtx.enforceCommand(
          { channel: 'bash', command: 'format C:' },
          { ...PS_OPTS, toolName: 'bash' }
        )
      ).rejects.toThrow('block-catastrophic-commands#2')

      clearSessionDecisions(SHELL_SID)
      const analyze = vi.fn(() => formatFacts())
      const requestUserInput = rejectingChannel()
      const ctx = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        trusting(analyze, requestUserInput)
      )
      await expect(
        ctx.enforceCommand({ channel: 'powershell', command: 'format C:' }, PS_OPTS)
      ).rejects.toThrow('block-catastrophic-commands#2')
      expect(requestUserInput).not.toHaveBeenCalled()
      // 用的是 PowerShell 扫描器，不是 bash 解析器
      expect(analyze).not.toHaveBeenCalled()
      const logged = getSessionDecisions(SHELL_SID)[0]
      expect([logged.effect, logged.winning]).toEqual(['deny', 'block-catastrophic-commands#2'])
    })

    const quietLogger = (warn: Mock): SecurityHostProvider['logger'] => ({
      info: vi.fn(),
      warn,
      error: vi.fn()
    })

    it('CT-PS6 宿主没注入 bash 解析器：PowerShell 照样扫描，Format-Volume 被 #4 拒，零告警', async () => {
      const warn = vi.fn()
      const ctx = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        makeProvider(
          { allowList: [] },
          {
            requestUserInput: rejectingChannel(),
            logger: quietLogger(warn),
            getUserPolicies: () => [CATASTROPHIC]
          }
        )
      )
      await expect(
        ctx.enforceCommand(
          { channel: 'powershell', command: 'Format-Volume -DriveLetter D' },
          PS_OPTS
        )
      ).rejects.toThrow('block-catastrophic-commands#4')
      expect(warn).not.toHaveBeenCalled()
    })

    it('CT-PS7 bash 解析器就绪失败：只告警，PowerShell 的规则照判（Clear-Disk 被 #4 拒）', async () => {
      const warn = vi.fn()
      const analyze = vi.fn(() => unparsedFacts(''))
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
          { requestUserInput: rejectingChannel(), logger: quietLogger(warn) }
        )
      )
      await expect(
        ctx.enforceCommand({ channel: 'powershell', command: 'Clear-Disk 1' }, PS_OPTS)
      ).rejects.toThrow('block-catastrophic-commands#4')
      const messages = warn.mock.calls.map((c) => String(c[0]))
      expect(messages.filter((m) => m.includes('shell 解析器初始化失败'))).toHaveLength(1)
      expect(analyze).not.toHaveBeenCalled()
    })

    it('CT-PS8 嵌套 bash -c：先等就绪，再把载荷本身（不是整条命令）交给 bash 解析器，#0 照拒', async () => {
      const order: string[] = []
      const ensureReady = vi.fn(async () => {
        order.push('ensureReady')
      })
      const analyze = vi.fn((_command: string) => {
        order.push('analyze')
        return rmRootFacts()
      })
      const ctx = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        shellProvider({ analyze, ensureReady }, { requestUserInput: rejectingChannel() })
      )
      await expect(
        ctx.enforceCommand({ channel: 'powershell', command: "bash -c 'rm -rf /'" }, PS_OPTS)
      ).rejects.toThrow('block-catastrophic-commands#0')
      expect(analyze).toHaveBeenCalledTimes(1)
      expect(analyze).toHaveBeenCalledWith('rm -rf /')
      expect(order).toEqual(['ensureReady', 'analyze'])
    })

    it('CT-PS9 惰性与记忆化：每次 enforce 读一次载荷；没有规则引用结构属性时一次都不读，序列化也不读', async () => {
      const analyze = vi.fn((command: string) => unparsedFacts(command))
      const ctx = createSecurityContext(SHELL_SUBJECT, ENVIRONMENT, shellProvider({ analyze }))
      await ctx.enforceCommand({ channel: 'powershell', command: "bash -c 'ls'" }, PS_OPTS)
      expect(analyze).toHaveBeenCalledTimes(1)
      await ctx.enforceCommand({ channel: 'powershell', command: "bash -c 'ls'" }, PS_OPTS)
      expect(analyze).toHaveBeenCalledTimes(2)

      // 不装夹具：只剩出厂策略，没有一份引用结构属性（同 CT-S3）
      const lazyAnalyze = vi.fn(() => rmRootFacts())
      let captured: MatchContext['object'] | undefined
      const lazy = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        shellProvider(
          { analyze: lazyAnalyze },
          {
            getUserPolicies: () => [],
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
      await expect(
        lazy.enforceCommand({ channel: 'powershell', command: "bash -c 'rm -rf /'" }, PS_OPTS)
      ).resolves.toEqual({ status: 'allowed' })
      expect(lazyAnalyze).not.toHaveBeenCalled()
      expect(captured).toBeDefined()
      const serialized = JSON.stringify(captured)
      expect(serialized).not.toContain('commands')
      expect(lazyAnalyze).not.toHaveBeenCalled()
      // 直接读才触发 —— getter 仍然活着，只是没人问
      expect(captured!.commands).toEqual([
        { base: 'bash', argv: ['bash', '-c', 'rm -rf /'], wrappers: [], complete: true, depth: 0 },
        { base: 'rm', argv: ['rm', '-rf', '/'], wrappers: [], complete: true, depth: 1 }
      ])
      expect(lazyAnalyze).toHaveBeenCalledTimes(1)
    })

    it('CT-PS10 （修过的 SB-5）嵌套 bash 解析抛错：留下告警、只跳过那段载荷，前面的 Format-Volume 照拒', async () => {
      const warn = vi.fn()
      const analyze = vi.fn((): ShellFacts => {
        throw new Error('boom')
      })
      const ctx = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        shellProvider(
          { analyze },
          { requestUserInput: rejectingChannel(), logger: quietLogger(warn) }
        )
      )
      await expect(
        ctx.enforceCommand(
          { channel: 'powershell', command: "Format-Volume -DriveLetter D; bash -c 'x'" },
          PS_OPTS
        )
      ).rejects.toThrow('block-catastrophic-commands#4')
      expect(analyze).toHaveBeenCalledTimes(1)
      const messages = warn.mock.calls.map((c) => String(c[0]))
      const nested = messages.filter((m) => m.includes('嵌套 bash 载荷'))
      expect(nested).toHaveLength(1)
      expect(nested[0]).toContain('boom')
      // 没有退化成「整条命令按未解析处理」—— 那条告警出现就说明其余事实也一起丢了
      expect(messages.some((m) => m.includes('shell 解析抛错'))).toBe(false)
    })

    it('CT-PS11 Windows 宿主：pathSep 为 \\ 时相对重定向按 cwd 解析成 Windows 路径', async () => {
      let captured: MatchContext['object'] | undefined
      const ctx = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        shellProvider(
          { analyze: vi.fn(() => unparsedFacts('')) },
          {
            pathSep: '\\',
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
        { channel: 'powershell', command: 'Write-Output x > out.txt', cwd: 'C:\\ws' },
        PS_OPTS
      )
      expect(captured).toBeDefined()
      expect(captured!.writes).toEqual(['C:\\ws\\out.txt'])
    })

    it('CT-PS12 ssh 通道不变：整条命令交给 bash 解析器', async () => {
      const analyze = vi.fn((_command: string) => rmRootFacts())
      const ctx = createSecurityContext(
        SHELL_SUBJECT,
        ENVIRONMENT,
        shellProvider({ analyze }, { requestUserInput: rejectingChannel() })
      )
      const command = "bash -c 'rm -rf /'"
      await expect(
        ctx.enforceCommand(
          { channel: 'ssh', command, host: 'prod' },
          { toolCallId: 'ssh-1', toolName: 'mcp__ssh__exec' }
        )
      ).rejects.toThrow('block-catastrophic-commands#0')
      expect(analyze).toHaveBeenCalledTimes(1)
      expect(analyze).toHaveBeenCalledWith(command)
    })
  })
})

// ─── enforceUrl（浏览器导航守卫）─────────────────────────────────────────
//
// 客体 `{type:'url', url, scheme, host, origin, browser}`、action 'navigate'。出厂**没有**任何
// url 策略（no policy = allow），应用内的浏览器面板（browser app）与用户自己的 Chrome（browser
// chrome）都一样 —— 这道门的意义是让用户能写「某个域名要问 / 禁止」。Chrome 那条「新站点要问」
// 从前是出厂的 ask-on-new-site，2026-10-01 退役为测试夹具；CT-U9 系列把它按用户策略装上，继续钉住
// 站点门的接线。file:// 不走这里：宿主把它当成读那个路径，改走 enforcePath('read')
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

/** 同一页，在用户自己的 Chrome 里（ask-on-new-site 夹具只管它） */
const CHROME_PAGE: UrlObjectInput = { ...PAGE, browser: 'chrome' }

/** Chrome 那台 server 的站点门上下文 */
const CHROME_OPTS = {
  toolCallId: 'tc-url',
  toolName: 'mcp__chrome__read_page',
  description: 'Use a.example in tab 6'
}

/** 退役的 ask-on-new-site（夹具，按用户策略装上）与它的显示名、话（取自 md，不抄进断言） */
const NEW_SITE = (() => {
  const policy = retiredPolicy('ask-on-new-site')
  return { policy, displayName: policy.displayName, prompt: policy.rules[0].prompt! }
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
  opts: { response?: InputResponse; channel?: boolean } = {}
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
      { allowList: [] },
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

  it('CT-U2 出厂没有任何策略管 url：https / 带端口 / data: / about: / chrome:、Chrome 里的新站点一律放行、不问、零告警，日志归因 default:url', async () => {
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
      },
      // 用户自己的 Chrome 也不例外（ask-on-new-site 已不随包发布）
      CHROME_PAGE
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

  it('CT-U8 用户对 url 的 force-allow 开着：用户的 ask 规则被静默放行；force-ask 规则照样问', async () => {
    const trustUrls = userPolicy('trust-urls', [
      { effect: 'force-allow', match: "object.type == 'url'" }
    ])
    const asking = urlContext([trustUrls, userPolicy('url-gate', [hostRule('ask', 'a.example')])])
    await expect(asking.ctx.enforceUrl(PAGE, OPEN_OPTS)).resolves.toBeUndefined()
    expect(asking.requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)[0]).toMatchObject({
      effect: 'allow',
      winning: 'trust-urls#0'
    })

    const forced = urlContext(
      [trustUrls, userPolicy('url-gate', [hostRule('force-ask', 'a.example')])],
      { response: { kind: 'ask', allowed: true } }
    )
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

  it('CT-U9 Chrome 里的新站点、装上 ask-on-new-site 夹具：卡片是地址本身 + 工具的一句说明 + 夹具的话与名字；允许 → 放行，日志 ask/allowed', async () => {
    const { ctx, requestUserInput, warn } = urlContext([NEW_SITE.policy], {
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
  ])('CT-U9 Chrome 里的新站点（夹具），用户%s → 抛出逐字文案', async (_l, response, message) => {
    const { ctx } = urlContext([NEW_SITE.policy], { response })
    expect(await rejectionOf(ctx.enforceUrl(CHROME_PAGE, CHROME_OPTS))).toBe(message)
  })

  it('CT-U9 Chrome 里的新站点（夹具），没有询问通道 → fail-closed（地址写全）', async () => {
    const { ctx } = urlContext([NEW_SITE.policy], { channel: false })
    expect(
      await rejectionOf(ctx.enforceUrl(CHROME_PAGE, { ...CHROME_OPTS, missingChannel: 'deny' }))
    ).toBe(
      'Access denied: this needs your confirmation but there is no way to ask: https://a.example/p?q=1'
    )
  })

  it('CT-U9c Chrome 里不属于任何站点的页（about:blank / data: / chrome:），装着夹具也不问、放行，归因 default:url', async () => {
    const { ctx, requestUserInput, warn } = urlContext([NEW_SITE.policy])
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
        makeProvider({ allowList: [] }, { requestUserInput, getUserPolicies: () => policies })
      ),
      requestUserInput
    }
  }

  it('CT-O1 enforcePath：传了 onOther:return，反馈照样抛成「declined access」', async () => {
    const { ctx, requestUserInput } = feedbackContext()
    // 会话目录外的写 → 内置 ask-on-external-path 问
    expect(
      await rejectionOf(
        ctx.enforcePath('write', '/outside/f.txt', {
          toolCallId: 'o1',
          toolName: 'write',
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
    // 出厂没有 git 策略：装上退役的 git-safety 夹具，让 git init 走到询问
    const { ctx, requestUserInput } = feedbackContext([retiredPolicy('git-safety')])
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
    // 数据库那道门出厂不问：装上退役的 ask-on-database 夹具
    const { ctx } = feedbackContext([retiredPolicy('ask-on-database')])
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
  literalCommands: [],
  dynamics: [],
  redirects: [],
  depthExceeded: false
})

describe('createSecurityContext — 真实路径（provider.realPath）', () => {
  /** 工作区里的一条链接 → 私钥（这组用例的旗舰形态） */
  const KEY_LINK = '/ws/key'
  const KEY_REAL = '/home/u/.ssh/id_rsa'
  const NO_GRANTS = (): { allowList: string[] } => ({ allowList: [] })

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

    // 按写法这是工作区里的一次普通读；按位置是家目录里的私钥 —— 外部目录门接手
    const decision = ctx.evaluate('read', { type: 'path', path: KEY_LINK })
    expect(decision).toMatchObject({ effect: 'ask', winning: 'ask-on-external-path#0' })
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

    const decision = ctx.evaluate('write', { type: 'path', path: '/outside/f.txt' })
    expect(decision).toMatchObject({ effect: 'ask', winning: 'ask-on-external-path#1' })
    expect(decision.ask).toEqual({
      command: 'Write(/outside/f.txt)',
      rememberEntry: 'Write(/outside/f.txt)'
    })
    expect(decision.ask).not.toHaveProperty('requestedPath')
    expect(probe.seen()).toMatchObject({ path: '/outside/f.txt', requestedPath: '/outside/f.txt' })

    await ctx.enforcePath('write', '/outside/f.txt', { toolCallId: 'r2', toolName: 'write' })
    const request = requestUserInput.mock.calls[0][0] as AskInputRequest
    expect(request.command).toBe('Write(/outside/f.txt)')
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
        // 出厂策略不读结构属性：装上 block-catastrophic-commands 夹具，好看见惰性 getter 还活着
        getUserPolicies: () => [retiredPolicy('block-catastrophic-commands')],
        derivedRules: probe.derivedRules
      })
    )

    await ctx.enforceCommand(COMMAND_INPUT, { toolCallId: 'c1', toolName: 'bash' })
    // 客体还是门面造出来的那一个：枚举面只有宿主给的标量，结构属性仍是非枚举的惰性 getter
    const commandObject = probe.seen()!
    expect(Object.keys(commandObject)).toEqual([
      'type',
      'command',
      'channel',
      'sandboxed',
      'unconfinedReason'
    ])
    expect('requestedPath' in commandObject).toBe(false)
    // 惰性仍在：只有 block-catastrophic-commands 夹具读了它，且记忆化到一次
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

  it('CT-R4 evaluateReadOnly（被动 UI）同样按真实去处判：区内的链接指向家目录里的私钥 → 不放行；家目录里的写法实际落在区内 → 放行', () => {
    const ALIAS = '/home/u/.ssh/alias'
    const table = { [KEY_LINK]: KEY_REAL, [ALIAS]: '/ws/f.txt' }
    const located = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(NO_GRANTS(), { realPath: tableResolver(table) })
    )
    expect(located.evaluateReadOnly('read', { type: 'path', path: KEY_LINK })).toBe(false)
    expect(located.evaluateReadOnly('read', { type: 'path', path: ALIAS })).toBe(true)

    // 同两条在不给解析器的宿主上按写法：结论正相反
    const written = createSecurityContext(SUBJECT, ENVIRONMENT, makeProvider(NO_GRANTS()))
    expect(written.evaluateReadOnly('read', { type: 'path', path: KEY_LINK })).toBe(true)
    expect(written.evaluateReadOnly('read', { type: 'path', path: ALIAS })).toBe(false)
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

    // 一次写评估里客体路径被外部目录门的写规则与上面两条引用（读规则的条件把它挡在外面）；
    // 目录 /ws 既是会话目录的一项、又被上面两条各引用一次 —— /ws 是会话目录，胜出的是上面那条
    expect(ctx.evaluate('write', { type: 'path', path: '/ws/f.txt' })).toMatchObject({
      effect: 'ask',
      winning: 'twice#0'
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
      winning: 'ask-on-external-path#0'
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

    // 客体路径解析不了：按写法判（会话目录外的写 → 外部目录门），卡片上就是写法本身
    const decision = contextFor(failing('/outside/broken')).evaluate('write', {
      type: 'path',
      path: '/outside/broken'
    })
    expect(decision).toMatchObject({ effect: 'ask', winning: 'ask-on-external-path#1' })
    expect(decision.ask).toEqual({
      command: 'Write(/outside/broken)',
      rememberEntry: 'Write(/outside/broken)'
    })
    // 被好几处引用，告警也只有一行（记忆表记下了「按写法」这个结论）
    expect(realPathWarnings()).toHaveLength(1)
    expect(realPathWarnings()[0]).toContain('/outside/broken')
    expect(realPathWarnings()[0]).toContain('EACCES: permission denied')
    // 抛错被门面接住了，没有变成谓词的 fail-safe
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('match evaluation failed'))).toEqual(
      []
    )

    // 目录（外部目录门的 vars.home）解析不了：那个目录按写法比 —— 家目录里的读照旧问
    warn.mockClear()
    const dirFails = contextFor(failing('/home/u'))
    expect(dirFails.evaluate('read', { type: 'path', path: '/home/u/.ssh/id_rsa' })).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-external-path#0'
    })
    expect(realPathWarnings()).toHaveLength(1)
    expect(realPathWarnings()[0]).toContain('/home/u')
  })

  it("CT-R8 解析器给回空串（或非字符串）：当作解析不了、按写法比较 —— 不崩，也不因 '' 前缀命中一切而凭空多出 deny / ask", () => {
    const written = createSecurityContext(SUBJECT, ENVIRONMENT, makeProvider(NO_GRANTS()))
    const objects: Array<[string, SecurityObject]> = [
      ['write', { type: 'path', path: '/ws/f.txt' }],
      ['read', { type: 'path', path: '/ws/f.txt' }],
      ['read', { type: 'path', path: '/outside/f.txt' }],
      ['read', { type: 'path', path: '/home/u/.ssh/id_rsa' }],
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
    expect(written.evaluate('read', { type: 'path', path: '/home/u/.ssh/id_rsa' })).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-external-path#0'
    })
    expect(written.evaluate('write', { type: 'path', path: '/etc/hosts' }).matched).toEqual([
      'ask-on-external-path#1'
    ])
  })

  it('CT-R9 宿主不给 realPath（扩展端）：按写法比较；卡片、日志、拒绝文案与从前一致 —— 没有 requestedPath、没有「resolves to」', async () => {
    const requestUserInput = vi.fn(
      async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: false })
    )
    // 拒绝文案要有一条 deny 才看得到：出厂没有，装上退役的 protect-system 夹具
    const ctx = createSecurityContext(
      SUBJECT,
      ENVIRONMENT,
      makeProvider(NO_GRANTS(), {
        requestUserInput,
        getUserPolicies: () => [retiredPolicy('protect-system')]
      })
    )

    // /ws/key 按写法就是工作区里的一个文件
    expect(ctx.evaluate('read', { type: 'path', path: KEY_LINK })).toMatchObject({
      effect: 'allow',
      winning: 'default:path'
    })

    const denied = await rejectionOf(
      ctx.enforcePath('write', '/etc/hosts', { toolCallId: 'w9', toolName: 'write' })
    )
    expect(denied).toMatch(/^Denied by security policy rule 'protect-system#0'\n\n/)
    expect(denied).not.toContain('resolves to')

    expect(
      await rejectionOf(
        ctx.enforcePath('write', '/outside/f.txt', { toolCallId: 'r9', toolName: 'write' })
      )
    ).toBe('User denied access to /outside/f.txt')
    const request = requestUserInput.mock.calls[0][0] as AskInputRequest
    expect(request.command).toBe('Write(/outside/f.txt)')
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

/**
 * 询问点的自动审查经门面走到接缝（provider.onPermissionRequest）：只有策略判出 ask 档的那一次
 * 才先问审查 —— force-ask、deny、用户写的 force-allow、「允许并记住」豁免掉的路径、L1 探测阶段就放行的调用、
 * 被动 UI 的判定都碰不到它。接缝看到的客体与策略判的是同一个（路径已换成真实去处，命令带着
 * unconfinedReason）。出厂已没有 deny / force-ask，也没有 git / 数据库 / url / L1 的门：这几类
 * 由退役策略的夹具按用户策略装上（fixtures/retiredPolicies.ts）。
 */
describe('createSecurityContext — 询问点的审查（onPermissionRequest）', () => {
  type Reviewer = NonNullable<SecurityHostProvider['onPermissionRequest']>

  const usedSids = new Set<string>()
  let seq = 0
  afterEach(() => {
    for (const sid of usedSids) {
      clearReviewState(sid)
      clearSessionDecisions(sid)
    }
    usedSids.clear()
  })

  const ALLOW_ANSWER: PermissionReviewAnswer = {
    verdict: { decision: 'allow', risk: 'low', summary: 's', reason: 'r' },
    source: 'auto-review'
  }
  const BASH = { toolCallId: 'tc-rv', toolName: 'bash' }
  const WRITE = { toolCallId: 'tc-rv', toolName: 'write' }

  /** 内置策略的 en 显示名（取自 md，不抄进断言） */
  const displayNameOf = (name: string): string =>
    buildBuiltinPolicies({ readMd: INLINE_POLICY_MD }).find((p) => p.name === name)!.displayName

  /** 本条用例自己的会话 + 审查接缝 + 一律允许的询问通道 */
  function reviewedContext(
    opts: {
      review?: ReturnType<typeof vi.fn<Reviewer>>
      grants?: { allowList: string[] }
      overrides?: Partial<SecurityHostProvider>
    } = {}
  ): {
    ctx: SecurityContext
    sid: string
    review: ReturnType<typeof vi.fn<Reviewer>>
    requestUserInput: Mock<(req: InputRequest) => Promise<InputResponse>>
    warn: Mock
  } {
    const sid = `context-review-${++seq}`
    usedSids.add(sid)
    const review = opts.review ?? vi.fn<Reviewer>(async () => ALLOW_ANSWER)
    const requestUserInput = vi.fn(
      async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
    )
    const warn = vi.fn()
    const ctx = createSecurityContext(
      { kind: 'agent', sessionId: sid, agentKind: 'root' },
      ENVIRONMENT,
      makeProvider(opts.grants ?? { allowList: [] }, {
        requestUserInput,
        onPermissionRequest: review,
        logger: { info: vi.fn(), warn, error: vi.fn() },
        ...opts.overrides
      })
    )
    return { ctx, sid, review, requestUserInput, warn }
  }

  const onlyCard = (requestUserInput: Mock): AskInputRequest => {
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    return requestUserInput.mock.calls[0][0] as AskInputRequest
  }

  /** 让已排队的微任务跑完（门面到接缝之间隔着几个 await） */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('CT-RV1 没圈进沙箱的 bash 命中 ask-on-command：接缝收到 tier ask 的决策、署名含 ask-on-command 的显示名；审查 allow → 放行、不弹卡', async () => {
    const h = reviewedContext()
    await expect(
      h.ctx.enforceCommand({ channel: 'bash', command: 'ls -la', sandboxed: false }, BASH)
    ).resolves.toEqual({ status: 'allowed' })

    expect(h.review).toHaveBeenCalledTimes(1)
    const event = h.review.mock.calls[0][0]
    expect(event.decision).toMatchObject({
      effect: 'ask',
      tier: 'ask',
      winning: 'ask-on-command#0'
    })
    expect(event.decision.prompt?.policies).toContain(displayNameOf('ask-on-command'))
    expect(event.command).toBe('ls -la')
    expect(event.toolCallId).toBe('tc-rv')
    expect(event.request.subject).toEqual({ kind: 'agent', sessionId: h.sid, agentKind: 'root' })
    expect(event.request.tool).toEqual({ name: 'bash', operation: undefined })
    expect(event.request.object).toMatchObject({
      type: 'command',
      command: 'ls -la',
      channel: 'bash',
      sandboxed: false,
      unconfinedReason: 'unavailable'
    })
    expect(h.requestUserInput).not.toHaveBeenCalled()
    const logs = getSessionDecisions(h.sid)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-command#0',
      review: { decision: 'allow', risk: 'low', source: 'auto-review' }
    })
    expect(logs[0].userResponse).toBeUndefined()
  })

  it('CT-RV2 用户策略的 force-allow 先放行（命令与写都压过询问门）—— 接缝 0 次、不弹卡，归因用户那条', async () => {
    const h = reviewedContext({
      overrides: {
        getUserPolicies: () => [userPolicy('trust-all', [{ effect: 'force-allow', match: 'true' }])]
      }
    })
    await expect(
      h.ctx.enforceCommand({ channel: 'bash', command: 'ls -la' }, BASH)
    ).resolves.toEqual({ status: 'allowed' })
    await h.ctx.enforcePath('write', '/outside/a.txt', WRITE)

    expect(h.review).not.toHaveBeenCalled()
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(h.sid).map((l) => [l.effect, l.winning])).toEqual([
      ['allow', 'trust-all#0'],
      ['allow', 'trust-all#0']
    ])
  })

  it('CT-RV3 allowList 有 Write(/elsewhere)：写 /elsewhere/a 由「允许并记住」放行，接缝 0 次；没授权的地方照旧先问审查', async () => {
    const h = reviewedContext({ grants: { allowList: ['Write(/elsewhere)'] } })
    await h.ctx.enforcePath('write', '/elsewhere/a', WRITE)
    expect(h.review).not.toHaveBeenCalled()
    expect(h.requestUserInput).not.toHaveBeenCalled()
    // 授权是外部目录门 match 里的豁免：放行时门根本没命中
    expect(getSessionDecisions(h.sid)[0]).toMatchObject({
      effect: 'allow',
      winning: 'default:path'
    })

    await h.ctx.enforcePath('write', '/other/a', WRITE)
    expect(h.review).toHaveBeenCalledTimes(1)
  })

  it.each<['protect-shuvix-config' | 'protect-bot-files', string, string]>([
    ['protect-shuvix-config', '/home/u/.shuvix/agents/x.md', 'protect-shuvix-config#0'],
    ['protect-bot-files', '/home/u/.shuvix/bots/x.md', 'protect-bot-files#0']
  ])(
    'CT-RV4 %s（退役夹具，force-ask）：接缝 0 次、照样弹卡、卡片没有 review、不给「允许并记住」；「允许并记住」过结果相同',
    async (policy, path, winning) => {
      for (const allowList of [[], [`Write(${path})`]]) {
        const h = reviewedContext({
          grants: { allowList },
          overrides: { getUserPolicies: () => [retiredPolicy(policy)] }
        })
        const decision = h.ctx.evaluate('write', { type: 'path', path })
        expect({ allowList, effect: decision.effect, tier: decision.tier }).toEqual({
          allowList,
          effect: 'ask',
          tier: 'force-ask'
        })
        expect(decision.winning).toBe(winning)
        expect(decision.ask?.rememberEntry).toBeUndefined()

        await h.ctx.enforcePath('write', path, WRITE)
        expect(h.review).not.toHaveBeenCalled()
        const card = onlyCard(h.requestUserInput)
        expect(card.review).toBeUndefined()
        expect(card.command).toBe(`Write(${path})`)
        const [log] = getSessionDecisions(h.sid)
        expect(log).toMatchObject({ effect: 'ask', winning, userResponse: 'allowed' })
        expect(log.review).toBeUndefined()
      }
    }
  )

  it('CT-RV5 deny 类（rm -rf /、系统目录写 —— 退役夹具按用户策略装上）：接缝 0 次、不弹卡，抛策略拒绝', async () => {
    const rmRoot: ShellFacts = {
      source: 'rm -rf /',
      parsed: true,
      reason: 'ok',
      errorSpans: [],
      literalCommands: [
        {
          name: 'rm',
          base: 'rm',
          argv: ['rm', '-rf', '/'],
          complete: true,
          span: { start: 0, end: 0 },
          depth: 0
        }
      ],
      dynamics: [],
      redirects: [],
      depthExceeded: false
    }
    const h = reviewedContext({
      overrides: {
        shellParser: { ensureReady: async () => {}, analyze: () => rmRoot },
        getUserPolicies: () => [
          retiredPolicy('block-catastrophic-commands'),
          retiredPolicy('protect-system')
        ]
      }
    })

    await expect(
      h.ctx.enforceCommand({ channel: 'bash', command: 'rm -rf /' }, BASH)
    ).rejects.toThrow('block-catastrophic-commands#0')
    await expect(h.ctx.enforcePath('write', '/etc/hosts', WRITE)).rejects.toThrow(
      "Denied by security policy rule 'protect-system#0'"
    )
    expect(h.review).not.toHaveBeenCalled()
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(h.sid).map((l) => [l.effect, l.review])).toEqual([
      ['deny', undefined],
      ['deny', undefined]
    ])
  })

  it('CT-RV6 L1：ask-on-sub-session（退役夹具）命中 → 接缝恰 1 次（command「session: create-sub-session」、客体 invocation）；别的工具在探测阶段放行 → 接缝 0 次、零日志', async () => {
    const h = reviewedContext({
      overrides: { getUserPolicies: () => [retiredPolicy('ask-on-sub-session')] }
    })
    await expect(
      h.ctx.enforceInvocation({
        toolCallId: 'tc-sub',
        toolName: 'session',
        operation: 'create-sub-session'
      })
    ).resolves.toEqual({ status: 'allowed' })
    expect(h.review).toHaveBeenCalledTimes(1)
    const event = h.review.mock.calls[0][0]
    expect(event.command).toBe('session: create-sub-session')
    expect(event.request.object).toEqual({ type: 'invocation' })
    expect(event.request.tool).toEqual({ name: 'session', operation: 'create-sub-session' })
    expect(event.decision).toMatchObject({ tier: 'ask', winning: 'ask-on-sub-session#0' })
    expect(getSessionDecisions(h.sid)).toHaveLength(1)

    clearSessionDecisions(h.sid)
    const others: Array<{ toolName: string; operation?: string }> = [
      { toolName: 'read' },
      { toolName: 'bash' },
      { toolName: 'session', operation: 'prompt-sub-session' },
      { toolName: 'mcp__browser__snapshot' }
    ]
    for (const other of others) {
      await expect(h.ctx.enforceInvocation({ toolCallId: 'tc-x', ...other })).resolves.toEqual({
        status: 'allowed'
      })
    }
    expect(h.review).toHaveBeenCalledTimes(1)
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(h.sid)).toHaveLength(0)
  })

  it('CT-RV7 真实路径：/ws/link 解析到 /outside/f → 接缝里客体 path 是真实去处、requestedPath 是链接写法，command 是 Write(/outside/f)', async () => {
    const h = reviewedContext({
      review: vi.fn<Reviewer>(async () => null),
      overrides: { realPath: tableResolver({ '/ws/link': '/outside/f' }) }
    })
    await h.ctx.enforcePath('write', '/ws/link', WRITE)

    expect(h.review).toHaveBeenCalledTimes(1)
    const event = h.review.mock.calls[0][0]
    expect(event.request.object).toMatchObject({
      type: 'path',
      path: '/outside/f',
      requestedPath: '/ws/link'
    })
    expect(event.command).toBe('Write(/outside/f)')
    expect(event.decision).toMatchObject({ tier: 'ask', winning: 'ask-on-external-path#1' })
    expect(event.decision.ask).toEqual({
      command: 'Write(/outside/f)',
      rememberEntry: 'Write(/outside/f)',
      requestedPath: '/ws/link'
    })
    // 审查答不出 → 卡片与接缝说的是同一个位置
    expect(onlyCard(h.requestUserInput)).toMatchObject({
      command: 'Write(/outside/f)',
      requestedPath: '/ws/link'
    })
  })

  it('CT-RV8 evaluate / evaluateReadOnly 永不调接缝、不写日志（ask 档也一样）', () => {
    const h = reviewedContext()
    const outside: SecurityObject = { type: 'path', path: '/outside/a' }
    expect(h.ctx.evaluate('write', outside)).toMatchObject({ effect: 'ask', tier: 'ask' })
    expect(h.ctx.evaluateReadOnly('write', outside)).toBe(false)
    expect(h.ctx.evaluateReadOnly('read', { type: 'path', path: '/home/u/.ssh/config' })).toBe(
      false
    )
    expect(
      h.ctx.evaluate('execute', {
        type: 'command',
        channel: 'bash',
        command: 'ls -la',
        sandboxed: false,
        unconfinedReason: 'unavailable',
        ...NO_SHELL_FACTS
      })
    ).toMatchObject({ effect: 'ask', tier: 'ask' })

    expect(h.review).not.toHaveBeenCalled()
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(h.sid)).toHaveLength(0)
  })

  it.each<[string, (ctx: SecurityContext, signal: AbortSignal) => Promise<unknown>]>([
    [
      'enforcePath',
      (ctx, signal) => ctx.enforcePath('write', '/outside/a.txt', { ...WRITE, signal })
    ],
    [
      'enforceCommand',
      (ctx, signal) =>
        ctx.enforceCommand({ channel: 'bash', command: 'ls -la' }, { ...BASH, signal })
    ],
    [
      'enforceGitOp',
      (ctx, signal) => ctx.enforceGitOp(GIT_INPUT, { toolCallId: 'tc-rv', toolName: 'git', signal })
    ],
    [
      'enforceDatabase',
      (ctx, signal) =>
        ctx.enforceDatabase(DATABASE_INPUT, {
          toolCallId: 'tc-rv',
          toolName: 'mcp__database__query',
          signal
        })
    ],
    ['enforceUrl', (ctx, signal) => ctx.enforceUrl(CHROME_PAGE, { ...CHROME_OPTS, signal })],
    [
      'enforceInvocation',
      (ctx, signal) =>
        ctx.enforceInvocation({
          toolCallId: 'tc-rv',
          toolName: 'session',
          operation: 'create-sub-session',
          signal
        })
    ]
  ])(
    'CT-SG1 %s：PEP 交来的 signal 落下 → 接缝收到的 signal 随之 aborted，门以中止收尾、不弹卡',
    async (_gate, call) => {
      const review = vi.fn<Reviewer>(() => new Promise<PermissionReviewAnswer | null>(() => {}))
      // git / 数据库 / Chrome 站点 / 子会话这几道门出厂不问：装上对应的退役夹具，让每道门都走到 ask 档
      const h = reviewedContext({
        review,
        overrides: {
          getUserPolicies: () => [
            retiredPolicy('git-safety'),
            retiredPolicy('ask-on-database'),
            retiredPolicy('ask-on-new-site'),
            retiredPolicy('ask-on-sub-session')
          ]
        }
      })
      const ac = new AbortController()

      const result = call(h.ctx, ac.signal)
      await flush()
      expect(review).toHaveBeenCalledTimes(1)
      const seamSignal = review.mock.calls[0][1]!
      expect(seamSignal).toBeInstanceOf(AbortSignal)
      expect(seamSignal.aborted).toBe(false)

      ac.abort()
      expect(seamSignal.aborted).toBe(true)
      await expect(result).rejects.toThrow('Aborted')
      expect(h.requestUserInput).not.toHaveBeenCalled()
      expect(getSessionDecisions(h.sid)[0].userResponse).toBe('cancel')
    }
  )

  /** 截下门面造出的命令客体（静态 allow 层的派生规则，永不命中） */
  function objectOf(input: CommandObjectInput): Promise<MatchContext['object']> {
    let captured: MatchContext['object'] | undefined
    const h = reviewedContext({
      review: vi.fn<Reviewer>(async () => null),
      overrides: {
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
    })
    const toolName = input.channel === 'ssh' ? 'mcp__ssh__exec' : input.channel
    return h.ctx.enforceCommand(input, { toolCallId: 'tc-ur', toolName }).then(() => captured!)
  }

  it.each<[string, CommandObjectInput, string]>([
    ['bash 没给 → unavailable', { channel: 'bash', command: 'ls' }, 'unavailable'],
    ['ssh 没给 → remote', { channel: 'ssh', command: 'uptime', host: 'prod' }, 'remote'],
    [
      'powershell 没给 → unavailable',
      { channel: 'powershell', command: 'Get-Date' },
      'unavailable'
    ],
    [
      '显式 escalated 原样',
      { channel: 'bash', command: 'ls', unconfinedReason: 'escalated' },
      'escalated'
    ],
    [
      '显式 disabled 原样',
      { channel: 'bash', command: 'ls', unconfinedReason: 'disabled' },
      'disabled'
    ],
    [
      '显式 unsupported 原样',
      { channel: 'powershell', command: 'Get-Date', unconfinedReason: 'unsupported' },
      'unsupported'
    ],
    [
      '显式 unavailable 原样',
      { channel: 'bash', command: 'ls', unconfinedReason: 'unavailable' },
      'unavailable'
    ],
    [
      '显式 remote 原样',
      { channel: 'ssh', command: 'uptime', host: 'prod', unconfinedReason: 'remote' },
      'remote'
    ],
    ['sandboxed:true → 空串', { channel: 'bash', command: 'ls', sandboxed: true }, ''],
    [
      'sandboxed:true 同时传 escalated → 仍是空串',
      { channel: 'bash', command: 'ls', sandboxed: true, unconfinedReason: 'escalated' },
      ''
    ],
    // P2：钉现状 —— 宿主显式说「没圈住、原因是空串」时原样交出（不替它回落成 unavailable）
    [
      'sandboxed:false 显式传空串 → 今天原样是空串',
      { channel: 'bash', command: 'ls', sandboxed: false, unconfinedReason: '' },
      ''
    ]
  ])('CT-UR1 命令客体上 unconfinedReason 恒有值：%s', async (_label, input, expected) => {
    const object = await objectOf(input)
    expect('unconfinedReason' in object).toBe(true)
    expect(object.unconfinedReason).toBe(expected)
    expect(object.sandboxed).toBe(input.sandboxed === true)
  })

  it('CT-UR2 用户 force-ask 按 unconfinedReason 写：escalated 走 force-ask（接缝 0 次、卡片标完全访问）；disabled 仍是 ask 档（接缝 1 次）', async () => {
    const h = reviewedContext({
      review: vi.fn<Reviewer>(async () => null),
      overrides: {
        getUserPolicies: () => [
          userPolicy('ask-on-escalation', [
            {
              effect: 'force-ask',
              match: "object.type == 'command' && object.unconfinedReason == 'escalated'"
            }
          ])
        ]
      }
    })

    await h.ctx.enforceCommand(
      { channel: 'bash', command: 'open -a Safari', unconfinedReason: 'escalated' },
      { ...BASH, unsandboxed: true }
    )
    expect(h.review).not.toHaveBeenCalled()
    expect(onlyCard(h.requestUserInput)).toMatchObject({
      command: 'open -a Safari',
      unsandboxed: true
    })
    expect(getSessionDecisions(h.sid)[0]).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-escalation#0'
    })

    await h.ctx.enforceCommand(
      { channel: 'bash', command: 'ls -la', unconfinedReason: 'disabled' },
      BASH
    )
    expect(h.review).toHaveBeenCalledTimes(1)
    expect(h.review.mock.calls[0][0].decision).toMatchObject({
      tier: 'ask',
      winning: 'ask-on-command#0'
    })
    expect(h.review.mock.calls[0][0].request.object.unconfinedReason).toBe('disabled')
  })

  it('CT-W5 装着 protect-shuvix-config 夹具、宿主不提供 shuvixConfigDirs：~/.shuvix/agents 下的写落回外部目录门（ask 档、照常先问审查），不会每次写都 force-ask；「not provided」恰 1 行、零 fail-safe', async () => {
    const grants = { allowList: [] as string[] }
    const { shuvixConfigDirs: _dirs, ...varsWithoutConfigDirs } = makeProvider(grants).getVars()
    const h = reviewedContext({
      review: vi.fn<Reviewer>(async () => null),
      grants,
      overrides: {
        getVars: () => varsWithoutConfigDirs,
        getUserPolicies: () => [retiredPolicy('protect-shuvix-config')]
      }
    })
    const agentMd: SecurityObject = { type: 'path', path: '/home/u/.shuvix/agents/a.md' }

    for (let i = 0; i < 3; i++) {
      expect(h.ctx.evaluate('write', agentMd)).toMatchObject({
        effect: 'ask',
        tier: 'ask',
        winning: 'ask-on-external-path#1'
      })
    }
    await h.ctx.enforcePath('write', '/home/u/.shuvix/agents/a.md', WRITE)
    expect(h.review).toHaveBeenCalledTimes(1)
    expect(h.review.mock.calls[0][0].decision).toMatchObject({
      tier: 'ask',
      winning: 'ask-on-external-path#1'
    })

    const lines = h.warn.mock.calls.map((c) => String(c[0]))
    const notProvided = lines.filter((m) => m.includes('is not provided by the host'))
    expect(notProvided).toHaveLength(1)
    expect(notProvided[0]).toContain("'protect-shuvix-config'")
    expect(notProvided[0]).toContain('vars.shuvixConfigDirs')
    expect(lines.filter((m) => m.includes('match evaluation failed'))).toHaveLength(0)
  })
})

/**
 * ask-on-read 不再是内置策略：这个名字从此只是用户自己的一份普通策略。
 *  - CX-U1 用户写了一份叫 ask-on-read 的：它不遮蔽任何东西、也不被任何东西遮蔽，按它自己的规则判；
 *  - CX-U2 用户手里留着退役前那份出厂文件的原样副本：照样是合法的用户策略；沙箱关着（宿主不给
 *    sandboxActive 也算）时它的「工作区外的读要问」照常生效（归因到用户那份）；沙箱开着时它引用的 sandboxRead* 两个变量
 *    宿主已不再提供 —— 退化成「不问」，不 throw。缺的变量在装配时就被绑空（两支都绑，与走哪一支
 *    无关），每个至多记一行。钉住这个退化行为。
 */
describe('createSecurityContext — 用户自己的 ask-on-read', () => {
  const NO_GRANTS = { allowList: [] as string[] }

  /** 退役前的出厂 ask-on-read.md 原样（git show HEAD:…/builtinPolicies/md/ask-on-read.md） */
  const RETIRED_ASK_ON_READ = [
    '---',
    'shuvix: policy v1',
    'shuvix-builtin: true',
    'name: ask-on-read',
    'shuvix-displayName: Ask Before Reading a File',
    "description: Reads outside the workspace and the app's read-only dirs ask first; while the sandbox is on, only the sensitive places a confined command cannot read ask.",
    'shuvix-policy-scope:',
    '  subject.kind: [agent]',
    '  object.type: [path]',
    '  env.host: [desktop]',
    'shuvix-policy-rules:',
    '  - effect: ask',
    '    action: [read]',
    '    match: >-',
    '      has(vars.sandboxActive) && vars.sandboxActive',
    '      ? inDir(object.path, vars.sandboxReadDenied)',
    '      && !inDir(object.path, vars.sandboxReadAllowed)',
    '      : !inDir(object.path, vars.workspace)',
    '      && !inDir(object.path, vars.toolResultsBase)',
    '      && !inDir(object.path, vars.skillsDirs)',
    '      && !inDir(object.path, vars.memoryDirs)',
    '      && !inDir(object.path, vars.builtinKnowledgeDir)',
    '      && !inDir(object.path, vars.sessionArtifactsDir)',
    '    prompt: Reading this file pulls it into the model context, where later turns and tool calls can carry it further.',
    '---',
    '',
    "**What it does** depends on whether this session's commands run in the",
    'sandbox.',
    '',
    '- **Sandbox on**: a confined command can read almost anything, so the file',
    '  tools do too — asking `read` for a file `cat` gets for free would only',
    '  push the agent toward `cat`. What still asks is the one list the sandbox',
    "  refuses to commands: ShuviX's own data (other conversations, the database,",
    '  the credential key), your personal folders (Documents, Desktop, Downloads,',
    "  Pictures, Movies, Music, iCloud Drive, Mail, Messages, Safari, other apps'",
    '  containers) and the credential directories. The working directory and this',
    "  session's own tool results stay free even when they sit inside one of",
    '  those folders.',
    '- **Sandbox off** (or not available here): the agent reads freely inside',
    "  your working directory and the app's read-only directories — tool results,",
    "  skills, project memories, ShuviX's own built-in knowledge base (reading",
    "  that reference is what it is shipped for) and this conversation's own",
    '  artifacts. Anything outside that range asks first.',
    '',
    '**What it does not do**:',
    '',
    '- It gates the file tools only; commands are governed by ask-on-command and',
    '  the sandbox.',
    '- This policy does not analyze how sensitive a file is beyond those lists.',
    '- It does not always reach you: with the automatic review on, a reviewing',
    '  agent answers first — it lets ordinary work through, refuses what is',
    '  clearly harmful and puts the rest in front of you with its opinion.',
    '- Once you turn the auto-allow switch on, another builtin policy —',
    '  session-grants — takes over and skips the ask.',
    '',
    '**To adjust**: create an override copy and edit it. Replacing the `match`',
    'with its part after `:` restores "outside the workspace asks", sandbox or',
    'not.',
    ''
  ].join('\n')

  const loggerSpy = (): {
    warn: Mock<(msg: string) => void>
    logger: NonNullable<SecurityHostProvider['logger']>
  } => {
    const warn = vi.fn<(msg: string) => void>()
    return { warn, logger: { info: vi.fn(), warn, error: vi.fn() } }
  }

  /**
   * 宿主不再提供 sandboxReadDenied / sandboxReadAllowed：装配时替缺的目录变量绑空并各记一行 ——
   * 每个至多一行（按 logger 去重）、只点名这两个、没有别的告警（fail-safe 之类）
   */
  const expectOnlyRetiredVarWarnings = (warn: Mock<(msg: string) => void>): void => {
    const lines = warn.mock.calls.map((c) => String(c[0]))
    const notProvided = lines.filter((m) => m.includes('is not provided by the host'))
    for (const name of ['sandboxReadDenied', 'sandboxReadAllowed']) {
      expect(
        notProvided.filter((m) => m.includes(`vars.${name} `)).length,
        name
      ).toBeLessThanOrEqual(1)
    }
    for (const line of notProvided) {
      expect(line).toContain("'ask-on-read'")
      expect(line).toMatch(/vars\.sandboxRead(Denied|Allowed) /)
    }
    expect(lines).toEqual(notProvided)
  }

  it('CX-U1 用户文件 ask-on-read.md 是一份普通用户策略：裁决里只有它一份（没有同名内置、不被遮蔽）；规则 ask-on-read#0 归用户；/data 里的读问、别处放行', () => {
    const own: UserPolicyFile = {
      ...userPolicy('ask-on-read', [
        {
          effect: 'ask',
          conditions: { action: ['read'] },
          match: "inDir(object.path, '/data')"
        }
      ]),
      fileName: 'ask-on-read.md'
    }
    const provider = makeProvider(NO_GRANTS, { getUserPolicies: () => [own] })

    const named = resolvePolicyFiles(
      buildBuiltinPolicies({ readMd: INLINE_POLICY_MD }),
      provider.getUserPolicies!()
    ).filter((entry) => entry.policy.name === 'ask-on-read')
    expect(named).toHaveLength(1)
    expect(named[0].sourceKind).toBe('user')
    expect(named[0].fileName).toBe('ask-on-read.md')
    expect(named[0].shadowedBy).toBeUndefined()

    const own0 = assembleRules(provider).filter((r) => r.source.policy === 'ask-on-read')
    expect(own0.map((r) => [r.id, r.source.kind])).toEqual([['ask-on-read#0', 'user']])

    const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)
    const inside = ctx.evaluate('read', { type: 'path', path: '/data/x' })
    expect({ effect: inside.effect, winning: inside.winning }).toEqual({
      effect: 'ask',
      winning: 'ask-on-read#0'
    })
    const outside = ctx.evaluate('read', { type: 'path', path: '/other/x' })
    expect({ effect: outside.effect, winning: outside.winning, matched: outside.matched }).toEqual({
      effect: 'allow',
      winning: 'default:path',
      matched: []
    })
  })

  it('CX-U2 退役前那份出厂文件的原样副本：是合法的用户策略；沙箱关着 → 工作区外的读问（归因用户 ask-on-read#0）；沙箱开着且没有 sandboxRead* → 放行、不 throw、缺的变量各至多一行告警', () => {
    const parsed = parsePolicyDefinitionFile(RETIRED_ASK_ON_READ, 'ask-on-read')
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe('ask-on-read')
    expect(parsed!.rules).toHaveLength(1)
    const copy: UserPolicyFile = { ...parsed!, fileName: 'ask-on-read.md' }

    // ① 宿主不给 sandboxActive（今天的桌面已不提供这个变量，has() 为假）、有 workspace：退役前
    // 「沙箱关着 → 工作区外要问」的那一支
    {
      const { warn, logger } = loggerSpy()
      const provider = makeProvider(NO_GRANTS, { logger, getUserPolicies: () => [copy] })
      const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)
      const outside = ctx.evaluate('read', { type: 'path', path: '/outside/f.txt' })
      expect({ effect: outside.effect, winning: outside.winning }).toEqual({
        effect: 'ask',
        winning: 'ask-on-read#0'
      })
      expect(assembleRules(provider).find((r) => r.id === 'ask-on-read#0')?.source.kind).toBe(
        'user'
      )
      expect(ctx.evaluate('read', { type: 'path', path: '/ws/f.txt' }).effect).toBe('allow')
      expectOnlyRetiredVarWarnings(warn)
    }

    // ② 沙箱开着、宿主不再给 sandboxReadDenied / sandboxReadAllowed：退化成不问
    {
      const { warn, logger } = loggerSpy()
      const base = makeProvider(NO_GRANTS)
      const provider = makeProvider(NO_GRANTS, {
        logger,
        getVars: () => ({ ...base.getVars(), sandboxActive: true }),
        getUserPolicies: () => [copy]
      })
      const ctx = createSecurityContext(SUBJECT, ENVIRONMENT, provider)
      for (const path of ['/outside/f.txt', '/home/u/Documents/a', '/ws/f.txt', '/etc/hosts']) {
        let decision: ReturnType<SecurityContext['evaluate']> | undefined
        expect(() => {
          decision = ctx.evaluate('read', { type: 'path', path })
        }, path).not.toThrow()
        // 用户那份一条都没命中；家目录里那一格是出厂外部目录门在问，与这份副本无关
        const inHome = path.startsWith('/home/u/')
        expect({ path, effect: decision!.effect, matched: decision!.matched }).toEqual({
          path,
          effect: inHome ? 'ask' : 'allow',
          matched: inHome ? ['ask-on-external-path#0'] : []
        })
      }
      expectOnlyRetiredVarWarnings(warn)
      expect(warn).toHaveBeenCalled()
    }
  })
})

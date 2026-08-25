/**
 * assembleRules —— 三层来源装配：用户策略同名覆盖内置、tier 标定、match 编译透传。
 * 会话授权已不在这里编译（下沉为 buildPolicyVars + 内置 session-* 两份策略 md），
 * 相应用例迁到本文件的「会话授权（下沉为 vars + 策略 md）」一节与端到端断言。
 * （lets 求值与 strict fail-safe 的专项用例见 test-designer 清单落地部分）
 */
import { describe, it, expect, vi } from 'vitest'
import { assembleRules, mergePolicyFiles } from '../assemble'
import { parsePolicyDefinitionFile } from '../policyFile'
import { evaluate } from '../evaluate'
import { buildPolicyVars } from '../policyVars'
import type {
  MatchContext,
  ParsedPolicyFile,
  PolicyRuleSpec,
  SecurityHostProvider,
  SecurityRequest,
  SecurityRule
} from '../types'

/** 内置策略引用的完整变量表 —— 全供给以免内置 lets 求值告警干扰断言 */
const BUILTIN_VARS: Record<string, string | string[]> = {
  workspace: '/ws',
  toolResultsBase: '/tool-results',
  skillsDirs: ['/skills/a', '/skills/b'],
  memoryDirs: [],
  home: '/home/u',
  systemDirs: []
}

function makeProvider(overrides: Partial<SecurityHostProvider> = {}): SecurityHostProvider {
  return {
    host: 'desktop',
    pathSep: '/',
    getVars: () => BUILTIN_VARS,
    getSessionGrants: () => ({ autoAllow: false, allowList: [] }),
    ...overrides
  }
}

function userPolicy(
  name: string,
  rules: PolicyRuleSpec[],
  lets?: Record<string, string>
): ParsedPolicyFile {
  const policy: ParsedPolicyFile = { name, displayName: name, description: '', rules, body: '' }
  if (lets) policy.lets = lets
  return policy
}

/** 谓词调用用的最小 MatchContext */
function makeCtx(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    subject: { kind: 'agent', agentKind: 'root', profile: '', sessionId: 's1', depth: 0 },
    action: 'read',
    tool: { name: '', operation: '' },
    object: { type: 'path', path: '/data/a.txt' },
    env: { host: 'desktop', platform: 'darwin' },
    vars: BUILTIN_VARS,
    ...overrides
  }
}

describe('会话授权（下沉为 vars + 策略 md）', () => {
  /** 端到端判定：与生产路径同款 —— vars 走 buildPolicyVars，装配与求值共用同一份 */
  function decide(
    provider: SecurityHostProvider,
    action: string,
    path: string,
    warn?: (msg: string) => void
  ): ReturnType<typeof evaluate> {
    const vars = buildPolicyVars(provider)
    return evaluate(
      assembleRules(provider, vars),
      {
        subject: { kind: 'agent', sessionId: 's1', agentKind: 'root' },
        action,
        object: { type: 'path', path, displayPath: path },
        environment: { host: 'desktop', platform: 'darwin' }
      },
      { vars, warn }
    )
  }

  it('AS-1 allowList → grantedRead/grantedWrite；Write 条目隐含读权限', () => {
    const provider = makeProvider({
      getSessionGrants: () => ({
        autoAllow: false,
        allowList: ['Read(/data/a.txt)', 'Write(/data/b.txt)']
      })
    })
    expect(buildPolicyVars(provider)).toMatchObject({
      autoAllow: false,
      grantedRead: ['/data/a.txt'],
      grantedWrite: ['/data/b.txt']
    })

    // Read 条目：读放行、写仍走询问门
    expect(decide(provider, 'read', '/data/a.txt').effect).toBe('allow')
    expect(decide(provider, 'write', '/data/a.txt').effect).toBe('ask')
    // Write 条目：读写都放行（写授权隐含读）
    expect(decide(provider, 'read', '/data/b.txt').effect).toBe('allow')
    expect(decide(provider, 'write', '/data/b.txt').effect).toBe('allow')
    // 归因到内置策略而非从前的 session:allowList:<entry>
    expect(decide(provider, 'write', '/data/b.txt').winning).toMatch(/^session-path-grants#/)
  })

  it('AS-1b 授权按路径段边界匹配；非 path 客体不受影响且不告警', () => {
    const provider = makeProvider({
      getSessionGrants: () => ({ autoAllow: false, allowList: ['Read(/data)'] })
    })
    expect(decide(provider, 'read', '/data').effect).toBe('allow')
    expect(decide(provider, 'read', '/data/sub/x.txt').effect).toBe('allow')
    // /data 不得命中 /database（inDir 与旧 matchesPathEntry 同一实现）
    expect(decide(provider, 'read', '/database/x.txt').effect).toBe('ask')

    // 非 path 客体：session-path-grants 的 object.type 条件先短路，CEL 不跑、零告警
    const warn = vi.fn()
    const vars = buildPolicyVars(provider)
    const decision = evaluate(
      assembleRules(provider, vars),
      {
        subject: { kind: 'agent', sessionId: 's1', agentKind: 'root' },
        action: 'execute',
        // 结构属性缺省 = 宿主未注入解析器（生产路径由 enforceCommand 挂惰性 getter，
        // 接线细节见 context.test.ts 的 CT-S* 一组；不补齐的后果见 BC-80）
        object: {
          type: 'command',
          command: 'ls',
          channel: 'bash',
          parsed: false,
          commands: [],
          writes: []
        },
        environment: { host: 'desktop', platform: 'darwin' }
      },
      { vars, warn }
    )
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toMatch(/^ask-on-command#/)
    expect(warn).not.toHaveBeenCalled()
  })

  it('AS-2 历史 Bash(...)/SSH(...)/畸形条目 → 不授予任何权限', () => {
    const provider = makeProvider({
      getSessionGrants: () => ({
        autoAllow: false,
        allowList: ['Bash(ls -la)', 'SSH(cat /etc/passwd)', 'garbage', 'Read()']
      })
    })
    expect(buildPolicyVars(provider)).toMatchObject({ grantedRead: [], grantedWrite: [] })
    expect(decide(provider, 'read', '/outside/x.txt').effect).toBe('ask')
  })

  it('AS-3 autoAllow:true → 全域 force-allow 放行（含命令）；false → 照常询问', () => {
    const on = makeProvider({ getSessionGrants: () => ({ autoAllow: true, allowList: [] }) })
    expect(buildPolicyVars(on).autoAllow).toBe(true)
    const decision = decide(on, 'write', '/anywhere/x.txt')
    expect(decision.effect).toBe('allow')
    expect(decision.winning).toBe('session-auto-allow#0')

    expect(decide(makeProvider(), 'write', '/anywhere/x.txt').effect).toBe('ask')
  })

  it('AS-3b deny 压过 force-allow：免询问开着也拦不住内置 deny', () => {
    const on = makeProvider({
      getVars: () => ({ ...BUILTIN_VARS, systemDirs: ['/sysroot'] }),
      getSessionGrants: () => ({ autoAllow: true, allowList: ['Write(/sysroot)'] })
    })
    const decision = decide(on, 'write', '/sysroot/x.conf')
    expect(decision.effect).toBe('deny')
    expect(decision.winning).toMatch(/^protect-system#/)
  })

  it('CA-4 内置 force-allow 与用户 force-allow 同时命中 → winning 取先装配的内置，matched 两条都在', () => {
    const provider = makeProvider({
      getSessionGrants: () => ({ autoAllow: true, allowList: [] }),
      getUserPolicies: () => [
        userPolicy('trust-anywhere', [
          {
            effect: 'force-allow',
            match: "object.type == 'path' && inDir(object.path, '/anywhere')"
          }
        ])
      ]
    })

    const decision = decide(provider, 'write', '/anywhere/x.txt')
    expect(decision.effect).toBe('allow')
    // 同 tier 多条 → 装配顺序第一条胜出；内置在用户之前（mergePolicyFiles）
    expect(decision.winning).toBe('session-auto-allow#0')
    expect(decision.matched).toContain('session-auto-allow#0')
    expect(decision.matched).toContain('trust-anywhere#0')
    // 被压过的 ask 门仍在 matched（门没拆，只是没胜出）
    expect(decision.matched).toContain('ask-on-write#0')
  })

  it('AS-3c 宿主 getVars 同名定义劫持不了会话授权', () => {
    const provider = makeProvider({
      getVars: () => ({ ...BUILTIN_VARS, autoAllow: true, grantedWrite: ['/everything'] }),
      getSessionGrants: () => ({ autoAllow: false, allowList: [] })
    })
    expect(buildPolicyVars(provider)).toMatchObject({ autoAllow: false, grantedWrite: [] })
    expect(decide(provider, 'write', '/everything/x.txt').effect).toBe('ask')
  })
})

/**
 * 授权变量的失效模式守护 —— 装配（lets）与求值（match）必须共用同一份
 * buildPolicyVars 产物。只在一处注入授权变量，另一处就缺键，strict 语义下报错走
 * fail-safe：force-allow 归一后的 effect 是 allow → **视为不命中**，授权静默失效。
 * 方向偏安全（多问一次），但用户会觉得免询问开关坏了 —— 这几条就是让它响。
 */
describe('assembleRules × evaluate — 授权 vars 的失效模式守护', () => {
  /** 授权齐备的 provider：免询问开着 + /data 已「允许并记住」为写授权 */
  const grantedProvider = (warn?: (msg: string) => void): SecurityHostProvider =>
    makeProvider({
      ...(warn ? { logger: { info: vi.fn(), warn, error: vi.fn() } } : {}),
      getSessionGrants: () => ({ autoAllow: true, allowList: ['Write(/data)'] })
    })

  /** 装配用完整 vars，求值用「残缺」vars（缺 autoAllow/granted*）—— 待守护的失效形态 */
  const decideWithVars = (
    provider: SecurityHostProvider,
    action: string,
    path: string,
    evalVars: Record<string, string | string[] | boolean> | undefined,
    warn?: (msg: string) => void
  ): ReturnType<typeof evaluate> =>
    evaluate(
      assembleRules(provider, buildPolicyVars(provider)),
      {
        subject: { kind: 'agent', sessionId: 's1', agentKind: 'root' },
        action,
        object: { type: 'path', path, displayPath: path },
        environment: { host: 'desktop', platform: 'darwin' }
      },
      { vars: evalVars, warn }
    )

  /** 授权若真的生效，这三格都会是 allow —— 因此三格全 ask 才算守住 */
  const GRID: Array<[string, string]> = [
    ['write', '/outside/x.txt'], // autoAllow 该放行的
    ['write', '/data/x.txt'], // Write(/data) 授权该放行的
    ['read', '/data/x.txt'] // 写授权隐含读，该放行的
  ]

  it('CV-1 求值侧拿不到授权变量（provider.getVars() / 完全省略）→ 授权全线失效，任何一格都不得 allow', () => {
    const provider = grantedProvider()

    // 形态①：求值侧传的是 provider.getVars()（宿主静态变量，没有 autoAllow/granted*）
    for (const [action, path] of GRID) {
      const decision = decideWithVars(provider, action, path, provider.getVars(), vi.fn())
      expect(decision.effect, `getVars() × ${action} ${path}`).toBe('ask')
    }

    // 形态②：opts.vars 完全省略（空表）—— 同样一格都不能放行
    for (const [action, path] of GRID) {
      const decision = decideWithVars(provider, action, path, undefined, vi.fn())
      expect(decision.effect, `无 vars × ${action} ${path}`).toBe('ask')
    }

    // 对照：两侧共用同一份完整 vars 时，三格都是 force-allow 放行（上面测的确实是失效而非无授权）
    const vars = buildPolicyVars(provider)
    for (const [action, path] of GRID) {
      const decision = evaluate(
        assembleRules(provider, vars),
        {
          subject: { kind: 'agent', sessionId: 's1', agentKind: 'root' },
          action,
          object: { type: 'path', path, displayPath: path },
          environment: { host: 'desktop', platform: 'darwin' }
        },
        { vars }
      )
      expect(decision.effect, `共用 vars × ${action} ${path}`).toBe('allow')
    }
  })

  it('CV-2 失效不静默：warn 含规则 id 与 "treating as not matched"，且连续两次评估告警次数递增', () => {
    const warn = vi.fn()
    const provider = grantedProvider()

    decideWithVars(provider, 'write', '/data/x.txt', provider.getVars(), warn)
    const messages = warn.mock.calls.map((c) => String(c[0]))
    const notMatched = messages.filter((m) => m.includes('treating as not matched'))
    expect(notMatched.length).toBeGreaterThan(0)
    // 免询问与路径授权两份策略都该报（force-allow 归一为 allow → fail-safe 不命中）
    expect(notMatched.some((m) => m.includes("'session-auto-allow#0'"))).toBe(true)
    expect(notMatched.some((m) => m.includes('session-path-grants#'))).toBe(true)

    // 每次评估现装配现求值：告警不被任何缓存/去重吞掉
    const after1 = warn.mock.calls.length
    decideWithVars(provider, 'write', '/data/x.txt', provider.getVars(), warn)
    expect(warn.mock.calls.length).toBeGreaterThan(after1)
  })

  it('CV-4 assembleRules 省略 vars → 走 buildPolicyVars 而非 provider.getVars：引用 vars.grantedWrite 的 let 求值成功且零告警', () => {
    const warn = vi.fn()
    const provider = makeProvider({
      logger: { info: vi.fn(), warn, error: vi.fn() },
      getSessionGrants: () => ({ autoAllow: false, allowList: ['Write(/data)'] }),
      getUserPolicies: () => [
        userPolicy(
          'granted-echo',
          [
            {
              effect: 'deny',
              conditions: { 'subject.kind': ['agent'], 'object.type': ['path'] },
              match: 'inDir(object.path, granted)'
            }
          ],
          { granted: 'vars.grantedWrite' }
        )
      ]
    })

    const rule = assembleRules(provider).find((r) => r.id === 'granted-echo#0')!
    expect(rule.matches!(makeCtx({ object: { type: 'path', path: '/data/x.txt' } }))).toBe(true)
    expect(rule.matches!(makeCtx({ object: { type: 'path', path: '/elsewhere/x.txt' } }))).toBe(
      false
    )
    // let 求值失败会记警告 —— 零告警即证明缺省参数确实注入了会话授权变量
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('assembleRules — 策略合并与 tier 标定', () => {
  it('AS-4 用户同名策略覆盖内置；不同名追加共存', () => {
    const override = assembleRules(
      makeProvider({
        getUserPolicies: () => [userPolicy('ask-on-write', [{ effect: 'ask' }])]
      })
    )
    // 内置来源的 ask-on-write 规则消失，取而代之的是 user 来源
    expect(
      override.filter((r) => r.source.kind === 'builtin' && r.source.policy === 'ask-on-write')
    ).toEqual([])
    const userRule = override.find((r) => r.id === 'ask-on-write#0')
    expect(userRule!.source).toEqual({
      kind: 'user',
      policy: 'ask-on-write',
      // 询问卡片的策略署名（内置按界面语言本地化；此处 helper 的 displayName = name）
      policyDisplayName: 'ask-on-write'
    })

    const appended = assembleRules(
      makeProvider({
        getUserPolicies: () => [userPolicy('my-policy', [{ effect: 'ask' }])]
      })
    )
    expect(
      appended.some((r) => r.source.kind === 'builtin' && r.source.policy === 'ask-on-write')
    ).toBe(true)
    expect(appended.find((r) => r.id === 'my-policy#0')!.source).toEqual({
      kind: 'user',
      policy: 'my-policy',
      policyDisplayName: 'my-policy'
    })
  })

  it('AS-5 tier 标定：user/builtin 的 allow → static-allow（绝非 force-allow）；deny → deny；ask → ask', () => {
    const rules = assembleRules(
      makeProvider({
        getUserPolicies: () => [
          userPolicy('p', [
            { effect: 'allow', match: "inDir(object.path, '/a')" },
            { effect: 'deny', match: "inDir(object.path, '/b')" },
            { effect: 'ask', match: "inDir(object.path, '/c')" }
          ])
        ]
      })
    )
    expect(rules.find((r) => r.id === 'p#0')!.tier).toBe('static-allow')
    expect(rules.find((r) => r.id === 'p#1')!.tier).toBe('deny')
    expect(rules.find((r) => r.id === 'p#2')!.tier).toBe('ask')

    // 内置门（ask-on-write）是 ask tier
    const builtinGate = rules.find(
      (r) => r.source.kind === 'builtin' && r.source.policy === 'ask-on-write'
    )
    expect(builtinGate!.tier).toBe('ask')
  })

  it('CA-1 用户 md 的 force-allow → {tier:force-allow, effect:allow, source:user}；同文件 allow 仍 static-allow', () => {
    const rules = assembleRules(
      makeProvider({
        getUserPolicies: () => [
          userPolicy('trust-data', [
            { effect: 'force-allow', match: "inDir(object.path, '/data')" },
            { effect: 'allow', match: "inDir(object.path, '/data')" }
          ])
        ]
      })
    )

    // force-allow 归一为 allow 效果 + force-allow tier（用户策略与内置同一条通路，无来源特权）
    expect(rules.find((r) => r.id === 'trust-data#0')).toMatchObject({
      effect: 'allow',
      tier: 'force-allow',
      source: { kind: 'user', policy: 'trust-data' }
    })
    // 同文件里的 allow 不因邻居是 force-allow 而被抬举
    expect(rules.find((r) => r.id === 'trust-data#1')).toMatchObject({
      effect: 'allow',
      tier: 'static-allow',
      source: { kind: 'user', policy: 'trust-data' }
    })
  })

  it('CA-2 四值各一份恒命中策略 → 决策 allow/allow/ask/deny 且归因各自 id；装配产物里不存在 effect==="force-allow"', () => {
    const expected = [
      ['allow', 'allow'],
      ['force-allow', 'allow'],
      ['ask', 'ask'],
      ['deny', 'deny']
    ] as const

    for (const [effect, decided] of expected) {
      const rules = assembleRules(
        makeProvider({ getUserPolicies: () => [userPolicy('p', [{ effect }])] })
      )
      // SecurityRule.effect 恒三态 —— force-allow 只活在 md 与 tier 里
      expect(
        rules.filter((r) => (r.effect as string) === 'force-allow'),
        `${effect}: 装配产物出现 effect force-allow`
      ).toEqual([])

      const own = rules.filter((r) => r.source.policy === 'p')
      const decision = evaluate(own, pathRequest('/data/x.txt'))
      expect(decision.effect, effect).toBe(decided)
      expect(decision.winning, effect).toBe('p#0')
    }
  })

  it('CA-3 完整内置装配：tier force-allow 的规则当且仅当来自两份会话授权策略，且 effect 恒 allow', () => {
    const rules = assembleRules(makeProvider())
    const SESSION_POLICIES = ['session-auto-allow', 'session-path-grants']

    const forceAllowRules = rules.filter((r) => r.tier === 'force-allow')
    expect([...new Set(forceAllowRules.map((r) => r.source.policy))].sort()).toEqual(
      SESSION_POLICIES
    )
    expect(forceAllowRules.every((r) => r.effect === 'allow')).toBe(true)

    // 反向：两份会话授权策略的每条规则都在 force-allow 层（没有半截落回 static-allow 的）
    const sessionRules = rules.filter((r) => SESSION_POLICIES.includes(r.source.policy ?? ''))
    expect(sessionRules.length).toBeGreaterThanOrEqual(3) // auto-allow 1 条 + path-grants 2 条
    expect(sessionRules.every((r) => r.tier === 'force-allow')).toBe(true)
  })

  it('AS-5b matchExpr 原样保留（展示/日志回链）；无 match 的规则两者皆缺省', () => {
    const rules = assembleRules(
      makeProvider({
        getUserPolicies: () => [
          userPolicy('p', [{ effect: 'ask', match: "object.type == 'path'" }, { effect: 'deny' }])
        ]
      })
    )
    const withMatch = rules.find((r) => r.id === 'p#0')!
    expect(withMatch.matchExpr).toBe("object.type == 'path'")
    expect(typeof withMatch.matches).toBe('function')

    const bare = rules.find((r) => r.id === 'p#1')!
    expect(bare.matchExpr).toBeUndefined()
    expect(bare.matches).toBeUndefined()
  })

  it('AS-5c 策略规则谓词经 CEL 求值（含 vars 上下文）', () => {
    const rules = assembleRules(
      makeProvider({
        getUserPolicies: () => [
          userPolicy('p', [{ effect: 'deny', match: 'inDir(object.path, vars.workspace)' }])
        ]
      })
    )
    const rule = rules.find((r) => r.id === 'p#0')!
    expect(rule.matches!(makeCtx({ object: { type: 'path', path: '/ws/x' } }))).toBe(true)
    expect(rule.matches!(makeCtx({ object: { type: 'path', path: '/outside/x' } }))).toBe(false)
  })
})

/** evaluate 用的最小 path 请求 */
const pathRequest = (path: string): SecurityRequest => ({
  subject: { kind: 'agent', sessionId: 's1', agentKind: 'root' },
  action: 'read',
  object: { type: 'path', path },
  environment: { host: 'desktop' }
})

describe('assembleRules — lets 注入', () => {
  it('AS-6 lets 求值结果以顶层名字注入本策略规则的 match 上下文', () => {
    const rules = assembleRules(
      makeProvider({
        getUserPolicies: () => [
          userPolicy('p', [{ effect: 'deny', match: 'inDir(object.path, protectedDirs)' }], {
            protectedDirs: "['/secret', vars.home + '/.keys']"
          })
        ]
      })
    )
    const rule = rules.find((r) => r.id === 'p#0')!
    expect(rule.matches!(makeCtx({ object: { type: 'path', path: '/secret/x' } }))).toBe(true)
    expect(rule.matches!(makeCtx({ object: { type: 'path', path: '/home/u/.keys/id' } }))).toBe(
      true
    )
    expect(rule.matches!(makeCtx({ object: { type: 'path', path: '/elsewhere' } }))).toBe(false)
  })

  it('AS-N2 let 求值失败：首次求值时 warn（惰性）恰 1 次（含策略名与 let 名）；引用规则按 effect fail-safe，不引用的规则不受影响', () => {
    const warn = vi.fn()
    const rules = assembleRules(
      makeProvider({
        logger: { info: vi.fn(), warn, error: vi.fn() },
        getUserPolicies: () => [
          userPolicy(
            'p',
            [
              { effect: 'deny', match: 'inDir(object.path, brokenDirs)' },
              { effect: 'allow', match: 'inDir(object.path, brokenDirs)' },
              { effect: 'deny', match: "inDir(object.path, '/other')" }
            ],
            // vars 缺 missingKey → 该 let 求值失败，名字缺失
            { brokenDirs: '[vars.missingKey]' }
          )
        ]
      })
    )

    // lets 惰性求值：装配本身不触发任何 let（一次不相关的评估不该跑凭据目录的 map 宏）
    expect(warn).not.toHaveBeenCalled()

    const p0 = rules.find((r) => r.id === 'p#0')!
    const p1 = rules.find((r) => r.id === 'p#1')!
    const p2 = rules.find((r) => r.id === 'p#2')!

    // 引用坏 let 的 deny：首次走到 CEL 才求值 let（装配期 warn 此刻才出现），
    // 求值报错 → fail-safe 命中（evaluate 另 warn 一次）
    const evalWarn = vi.fn()
    const denied = evaluate([p0], pathRequest('/data/x'), { warn: evalWarn })
    expect(denied.effect).toBe('deny')
    expect(denied.matched).toEqual(['p#0'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain("'p'")
    expect(warn.mock.calls[0][0]).toContain("'brokenDirs'")
    expect(evalWarn).toHaveBeenCalledTimes(1)
    expect(evalWarn.mock.calls[0][0]).toContain("'p#0'")
    expect(evalWarn.mock.calls[0][0]).toContain('treating as matched (fail-safe)')

    // 引用坏 let 的 allow：fail-safe 不命中 → 不放行（落 default）
    const allowed = evaluate([p1], pathRequest('/data/x'), { warn: vi.fn() })
    expect(allowed.matched).toEqual([])
    expect(allowed.winning).toBe('default:path')
    // lets 按本次装配 memoize：第二条规则求值不再重复告警
    expect(warn).toHaveBeenCalledTimes(1)

    // 同策略不引用该 let 的规则正常匹配不受影响
    expect(p2.matches!(makeCtx({ object: { type: 'path', path: '/other/f' } }))).toBe(true)
    expect(p2.matches!(makeCtx({ object: { type: 'path', path: '/data/f' } }))).toBe(false)
  })

  it('AS-N3 lets 每次装配现算：getVars 变化后第二次装配按新值命中（旧装配产物保持旧值）', () => {
    const vars: Record<string, string | string[]> = { ...BUILTIN_VARS, blocked: '/a' }
    const provider = makeProvider({
      getVars: () => ({ ...vars }),
      getUserPolicies: () => [
        userPolicy('p', [{ effect: 'deny', match: 'inDir(object.path, dirs)' }], {
          dirs: '[vars.blocked]'
        })
      ]
    })

    const first = assembleRules(provider).find((r) => r.id === 'p#0')!
    expect(first.matches!(makeCtx({ object: { type: 'path', path: '/a/x' } }))).toBe(true)
    expect(first.matches!(makeCtx({ object: { type: 'path', path: '/b/x' } }))).toBe(false)

    vars.blocked = '/b'
    const second = assembleRules(provider).find((r) => r.id === 'p#0')!
    expect(second.matches!(makeCtx({ object: { type: 'path', path: '/b/x' } }))).toBe(true)
    expect(second.matches!(makeCtx({ object: { type: 'path', path: '/a/x' } }))).toBe(false)

    // 旧装配产物闭包保持装配时的值（lets 是装配期求值，非求值期）
    expect(first.matches!(makeCtx({ object: { type: 'path', path: '/a/x' } }))).toBe(true)
  })
})

describe('assembleRules — 结构化条件与策略级 scope', () => {
  /** 带 scope 的用户策略（parse 阶段的校验此处刻意绕过 —— 只测装配语义） */
  const scopedPolicy = (
    name: string,
    scope: ParsedPolicyFile['scope'],
    rules: PolicyRuleSpec[]
  ): ParsedPolicyFile => ({ ...userPolicy(name, rules), scope })

  it('AS-C1 条件编译成原生谓词并与 match AND：条件不命中时 CEL 根本不跑（短路）', () => {
    const rules = assembleRules(
      makeProvider({
        getUserPolicies: () => [
          userPolicy('p', [
            // match 引用不存在的 vars 键 —— 一旦真的求值就会抛（strict 语义）
            {
              effect: 'deny',
              conditions: { 'subject.kind': ['agent'], action: ['write'] },
              match: "vars.missingKey == 'x'"
            }
          ])
        ]
      })
    )
    const rule = rules.find((r) => r.id === 'p#0')!

    // 条件不命中（action=read）→ 直接 false，不触碰 CEL
    expect(rule.matches!(makeCtx({ action: 'read' }))).toBe(false)
    // 条件命中 → 才走到 CEL（这里必然抛，由 evaluate 按 effect fail-safe 处置）
    expect(() => rule.matches!(makeCtx({ action: 'write' }))).toThrow()
  })

  it('AS-C2 策略级 scope AND 进每条规则；装配产物的 conditions = 有效条件', () => {
    const rules = assembleRules(
      makeProvider({
        getUserPolicies: () => [
          scopedPolicy('p', { 'subject.kind': ['agent'], 'object.type': ['path'] }, [
            { effect: 'ask', conditions: { action: ['write'] } },
            { effect: 'deny' }
          ])
        ]
      })
    )

    const scoped = rules.find((r) => r.id === 'p#0')!
    expect(scoped.conditions).toEqual({
      'subject.kind': ['agent'],
      'object.type': ['path'],
      action: ['write']
    })
    expect(scoped.matches!(makeCtx({ action: 'write' }))).toBe(true)
    // scope 的每一维都真的在约束
    expect(
      scoped.matches!(
        makeCtx({
          action: 'write',
          subject: { kind: 'user', agentKind: '', profile: '', sessionId: 's1', depth: 0 }
        })
      )
    ).toBe(false)
    expect(
      scoped.matches!(makeCtx({ action: 'write', object: { type: 'command', command: 'ls' } }))
    ).toBe(false)
    expect(scoped.matches!(makeCtx({ action: 'read' }))).toBe(false)

    // 无自身条件的规则同样被 scope 收窄（不是恒命中）
    const bare = rules.find((r) => r.id === 'p#1')!
    expect(bare.conditions).toEqual({ 'subject.kind': ['agent'], 'object.type': ['path'] })
    expect(bare.matches!(makeCtx())).toBe(true)
    expect(bare.matches!(makeCtx({ object: { type: 'command', command: 'ls' } }))).toBe(false)
  })

  it('AS-C3 有效条件 = scope ∩ 规则字段（同键取交、异键取并、`*` 为全集）', () => {
    const rules = assembleRules(
      makeProvider({
        getUserPolicies: () => [
          scopedPolicy('p', { 'subject.kind': ['*'], action: ['read', 'write'] }, [
            { effect: 'ask', conditions: { action: ['write'], 'tool.name': ['write', 'edit'] } }
          ])
        ]
      })
    )
    const rule = rules.find((r) => r.id === 'p#0')!
    expect(rule.conditions).toEqual({
      'subject.kind': ['*'],
      action: ['write'],
      'tool.name': ['write', 'edit']
    })
    // 交集生效：scope 允许 read+write，规则收窄到 write
    expect(rule.matches!(makeCtx({ action: 'read', tool: { name: 'write', operation: '' } }))).toBe(
      false
    )
    expect(rule.matches!(makeCtx({ action: 'write', tool: { name: 'edit', operation: '' } }))).toBe(
      true
    )
    // '*' = 任意主体
    expect(
      rule.matches!(
        makeCtx({
          action: 'write',
          tool: { name: 'write', operation: '' },
          subject: { kind: 'user', agentKind: '', profile: '', sessionId: 's1', depth: 0 }
        })
      )
    ).toBe(true)
  })

  it('AS-C4 条件不命中的请求不触发本策略 lets 求值（短路 = 不跑凭据目录那类 map 宏）', () => {
    const warn = vi.fn()
    const rules = assembleRules(
      makeProvider({
        logger: { info: vi.fn(), warn, error: vi.fn() },
        getUserPolicies: () => [
          userPolicy(
            'p',
            [
              {
                effect: 'deny',
                conditions: { 'subject.kind': ['agent'], 'object.type': ['command'] },
                match: 'inDir(object.path, brokenDirs)'
              }
            ],
            { brokenDirs: '[vars.missingKey]' } // 求值必失败 → 首次真正求值时告警
          )
        ]
      })
    )
    const rule = rules.find((r) => r.id === 'p#0')!

    // object.type=path 不满足条件 → CEL 与 lets 都不跑，零告警
    expect(rule.matches!(makeCtx())).toBe(false)
    expect(warn).not.toHaveBeenCalled()

    // 条件命中后才求值 lets（此刻才告警）
    expect(() => rule.matches!(makeCtx({ object: { type: 'command', command: 'ls' } }))).toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("'brokenDirs'")
  })

  it('AS-C5 无条件且无 match → matches/conditions 皆缺省（恒命中）', () => {
    const rules = assembleRules(
      makeProvider({ getUserPolicies: () => [userPolicy('p', [{ effect: 'deny' }])] })
    )
    const rule = rules.find((r) => r.id === 'p#0')!
    expect(rule.matches).toBeUndefined()
    expect(rule.conditions).toBeUndefined()
  })

  it('AS-C6 装配产物的 conditions 与策略对象不共享引用（内置策略是模块级缓存，不得被下游污染）', () => {
    const scope = { 'subject.kind': ['agent'], 'object.type': ['path'] }
    const ruleConditions = { action: ['read', 'write'] }
    const policy = scopedPolicy('p', scope, [{ effect: 'ask', conditions: ruleConditions }])
    const rule = assembleRules(makeProvider({ getUserPolicies: () => [policy] })).find(
      (r) => r.id === 'p#0'
    )!

    expect(rule.conditions).not.toBe(scope)
    expect(rule.conditions).not.toBe(ruleConditions)
    expect(rule.conditions!['subject.kind']).not.toBe(scope['subject.kind'])
    expect(rule.conditions!.action).not.toBe(ruleConditions.action)

    // 就地改动装配产物不回写策略
    rule.conditions!['subject.kind']!.push('user')
    rule.conditions!.action!.pop()
    expect(scope['subject.kind']).toEqual(['agent'])
    expect(ruleConditions.action).toEqual(['read', 'write'])
  })

  it('AS-C7 scope 与规则条件矛盾（绕过解析器构造）→ 丢弃该规则并告警，绝不当作无条件', () => {
    const warn = vi.fn()
    const rules = assembleRules(
      makeProvider({
        logger: { info: vi.fn(), warn, error: vi.fn() },
        getUserPolicies: () => [
          scopedPolicy('p', { 'subject.kind': ['agent'], action: ['read'] }, [
            { effect: 'deny', conditions: { action: ['write'] } }, // 空交集 = 死规则
            { effect: 'ask', conditions: { action: ['read'] } } // 同策略其余规则不受影响
          ])
        ]
      })
    )

    expect(rules.find((r) => r.id === 'p#0')).toBeUndefined()
    expect(rules.some((r) => r.source.policy === 'p')).toBe(true)
    expect(rules.find((r) => r.id === 'p#1')!.conditions).toEqual({
      'subject.kind': ['agent'],
      action: ['read']
    })

    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toContain("'p'")
    expect(msg).toContain('rule #0')
    expect(msg).toContain('contradict the policy scope')
    expect(msg).toContain('rule dropped')
  })
})

describe('assembleRules — 派生规则与省略容错', () => {
  it('AS-10 derivedRules() 原样追加；省略不炸', () => {
    const derived: SecurityRule = {
      id: 'derived:fsa-root',
      effect: 'allow',
      tier: 'static-allow',
      matches: (ctx) => ctx.object.type === 'path',
      source: { kind: 'derived' }
    }
    const rules = assembleRules(makeProvider({ derivedRules: () => [derived] }))
    expect(rules[rules.length - 1]).toBe(derived)

    expect(() => assembleRules(makeProvider())).not.toThrow()
  })

  it('AS-11 省略 getUserPolicies → 仅 builtin 正常装配（含 force-allow 两份）', () => {
    const rules = assembleRules(
      makeProvider({ getSessionGrants: () => ({ autoAllow: true, allowList: [] }) })
    )
    expect(rules.some((r) => r.source.kind === 'builtin')).toBe(true)
    expect(rules.some((r) => r.id === 'session-auto-allow#0')).toBe(true)
    expect(rules.some((r) => r.source.kind === 'user')).toBe(false)
  })
})

describe('mergePolicyFiles', () => {
  it('AS-12 未覆盖内置在前、用户在后；同名的内置被剔除', () => {
    const b1 = userPolicy('a', [])
    const b2 = userPolicy('b', [])
    const u1 = userPolicy('b', [])
    const u2 = userPolicy('c', [])

    expect(mergePolicyFiles([b1, b2], [u1, u2])).toEqual([
      { policy: b1, sourceKind: 'builtin' },
      { policy: u1, sourceKind: 'user' },
      { policy: u2, sourceKind: 'user' }
    ])
  })
})

/**
 * 规则 prompt（人读提示语）的装配面 —— 装配只做透传与本地化 overlay：
 * 判决语义与 prompt 无关，故各语言之间只有它可以不同。
 */
describe('assembleRules — 规则 prompt 透传', () => {
  it('AS-F1 force-ask 归一：tier=force-ask，effect 落回三态的 ask（SecurityRule 形状不变）', () => {
    const rules = assembleRules(
      makeProvider({
        getUserPolicies: () => [
          userPolicy('guard-secrets', [
            { effect: 'force-ask', conditions: { 'subject.kind': ['agent'] } }
          ])
        ]
      })
    )
    const rule = rules.find((r) => r.id === 'guard-secrets#0')!
    expect(rule.tier).toBe('force-ask')
    expect(rule.effect).toBe('ask')
  })

  it('AS-P1 PolicyRuleSpec.prompt 原样透传为 SecurityRule.prompt；无 prompt 的规则该字段无取值', () => {
    const rules = assembleRules(
      makeProvider({
        getUserPolicies: () => [
          userPolicy('p', [
            {
              effect: 'ask',
              conditions: { 'subject.kind': ['agent'] },
              // 刻意留首尾空白：trim 是解析期的事，装配不再加工
              prompt: '  keep me verbatim — 1 < 2  '
            },
            { effect: 'deny', conditions: { 'subject.kind': ['agent'] } }
          ])
        ]
      })
    )
    expect(rules.find((r) => r.id === 'p#0')!.prompt).toBe('  keep me verbatim — 1 < 2  ')
    expect(rules.find((r) => r.id === 'p#1')!.prompt).toBeUndefined()
  })

  it('AS-P2 getLanguage()=zh → 内置规则 prompt 为中文；判定字段与 en 装配逐字段相等', () => {
    const en = assembleRules(makeProvider())
    const zh = assembleRules(makeProvider({ getLanguage: () => 'zh' }))
    expect(zh.map((r) => r.id)).toEqual(en.map((r) => r.id))

    for (const [i, rule] of zh.entries()) {
      const base = en[i]
      expect(rule.prompt, `${rule.id} 缺 prompt`).toBeTruthy()
      expect(rule.prompt, `${rule.id} 未本地化`).not.toBe(base.prompt)
      expect(/[一-龥]/.test(rule.prompt!), `${rule.id} 的 prompt 不含中文`).toBe(true)
      // 安全语义与语言无关：判定字段必须逐字相等（policyDisplayName 是人读面，允许不同）
      expect(
        {
          effect: rule.effect,
          tier: rule.tier,
          matchExpr: rule.matchExpr,
          conditions: rule.conditions,
          sourceKind: rule.source.kind,
          sourcePolicy: rule.source.policy
        },
        `${rule.id} 判定字段漂移`
      ).toEqual({
        effect: base.effect,
        tier: base.tier,
        matchExpr: base.matchExpr,
        conditions: base.conditions,
        sourceKind: base.source.kind,
        sourcePolicy: base.source.policy
      })
    }
  })

  it('AS-P3 用户 md 的 prompt 透传；source.kind=user，署名取 md 的 shuvix-displayName', () => {
    const policy = parsePolicyDefinitionFile(
      [
        '---',
        'shuvix: policy v1',
        'name: my-gate',
        'shuvix-displayName: My Own Gate',
        'shuvix-policy-scope:',
        '  subject.kind: [agent]',
        '  object.type: [path]',
        'shuvix-policy-rules:',
        '  - effect: deny',
        '    action: [write]',
        '    prompt: Ask me instead, I keep this tree by hand.',
        '---',
        'body'
      ].join('\n'),
      'my-gate'
    )!

    const rule = assembleRules(makeProvider({ getUserPolicies: () => [policy] })).find(
      (r) => r.id === 'my-gate#0'
    )!
    expect(rule.prompt).toBe('Ask me instead, I keep this tree by hand.')
    expect(rule.source).toEqual({
      kind: 'user',
      policy: 'my-gate',
      policyDisplayName: 'My Own Gate'
    })
  })

  it('AS-P4 与 scope 矛盾被丢弃的规则不留下 prompt（连同规则一起消失）', () => {
    const warn = vi.fn()
    const dead: ParsedPolicyFile = {
      ...userPolicy('dead', [
        { effect: 'deny', conditions: { action: ['write'] }, prompt: 'never shown' }
      ]),
      scope: { 'subject.kind': ['agent'], action: ['read'] }
    }

    const rules = assembleRules(
      makeProvider({
        logger: { info: vi.fn(), warn, error: vi.fn() },
        getUserPolicies: () => [dead]
      })
    )
    expect(rules.filter((r) => r.source.policy === 'dead')).toEqual([])
    expect(rules.some((r) => r.prompt === 'never shown')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

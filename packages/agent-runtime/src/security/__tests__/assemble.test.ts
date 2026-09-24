/**
 * assembleRules —— 三层来源装配：用户策略同名覆盖内置、tier 标定、match 编译透传。
 * 会话授权已不在这里编译（下沉为 buildPolicyVars + 内置 session-* 两份策略 md），
 * 相应用例迁到本文件的「会话授权（下沉为 vars + 策略 md）」一节与端到端断言。
 * （lets 求值与 strict fail-safe 的专项用例见 test-designer 清单落地部分）
 * 宿主没供给的目录变量（deny / ask 两档绑定为 null、按 logger 去重告警）见 AS-D 一节；
 * 用户覆盖副本拿掉 ask-on-write 的本会话 artifacts 豁免（用户主权）见文末 AS-A 一节。
 */
import { describe, it, expect, vi } from 'vitest'
import { assembleRules, mergePolicyFiles, resolvePolicyFiles } from '../assemble'
import { parsePolicyDefinitionFile } from '../policyFile'
import { evaluate } from '../evaluate'
import { buildPolicyVars } from '../policyVars'
import type {
  MatchContext,
  ParsedPolicyFile,
  PolicyEffect,
  PolicyRuleSpec,
  PolicyVarValue,
  SecurityHostProvider,
  SecurityObject,
  SecurityRequest,
  SecurityRule,
  UserPolicyFile
} from '../types'
import { createInlinePolicyMdReader } from '../builtinPolicies/inlineSources'

/** 内置策略 md 的构建期内联读取口（运行时单测的宿主接缝；桌面/扩展各注入自己的） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

/** 内置策略引用的完整变量表 —— 全供给以免内置 lets 求值告警干扰断言 */
const BUILTIN_VARS: Record<string, string | string[]> = {
  workspace: '/ws',
  toolResultsBase: '/tool-results',
  skillsDirs: ['/skills/a', '/skills/b'],
  memoryDirs: [],
  knowledgeRoot: '/kb',
  knowledgeSessionDirs: [],
  home: '/home/u',
  botsDir: '/home/u/.shuvix/bots',
  builtinKnowledgeDir: '/opt/shuvix/Resources/knowledge',
  sessionArtifactsDir: '/home/u/.shuvix/artifacts/sess-1',
  systemDirs: []
}

function makeProvider(overrides: Partial<SecurityHostProvider> = {}): SecurityHostProvider {
  return {
    host: 'desktop',
    pathSep: '/',
    getVars: () => BUILTIN_VARS,
    getSessionGrants: () => ({ autoAllow: false, allowList: [] }),
    readBuiltinPolicyMd: INLINE_POLICY_MD,
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
    expect(decide(provider, 'write', '/data/b.txt').winning).toMatch(/^session-grants#[12]$/)
  })

  it('AS-1b 授权按路径段边界匹配；非 path 客体不受影响且不告警', () => {
    const provider = makeProvider({
      getSessionGrants: () => ({ autoAllow: false, allowList: ['Read(/data)'] })
    })
    expect(decide(provider, 'read', '/data').effect).toBe('allow')
    expect(decide(provider, 'read', '/data/sub/x.txt').effect).toBe('allow')
    // /data 不得命中 /database（inDir 与旧 matchesPathEntry 同一实现）
    expect(decide(provider, 'read', '/database/x.txt').effect).toBe('ask')

    // 非 path 客体：session-grants 两条路径规则的 object.type 条件先短路，CEL 不跑、零告警
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
    expect(decision.winning).toBe('session-grants#0')

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
    expect(decision.winning).toBe('session-grants#0')
    expect(decision.matched).toContain('session-grants#0')
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
    // 免询问与路径授权两种规则都该报（force-allow 归一为 allow → fail-safe 不命中）
    expect(notMatched.some((m) => m.includes("'session-grants#0'"))).toBe(true)
    expect(notMatched.some((m) => /'session-grants#[12]'/.test(m))).toBe(true)

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

  it('CA-3 完整内置装配：tier force-allow 的规则当且仅当来自会话授权策略，且 effect 恒 allow', () => {
    const rules = assembleRules(makeProvider())
    const SESSION_POLICIES = ['session-grants']

    const forceAllowRules = rules.filter((r) => r.tier === 'force-allow')
    expect([...new Set(forceAllowRules.map((r) => r.source.policy))].sort()).toEqual(
      SESSION_POLICIES
    )
    expect(forceAllowRules.every((r) => r.effect === 'allow')).toBe(true)

    // 反向：会话授权策略的每条规则都在 force-allow 层（没有半截落回 static-allow 的）
    const sessionRules = rules.filter((r) => SESSION_POLICIES.includes(r.source.policy ?? ''))
    expect(sessionRules.map((r) => r.id)).toEqual([
      'session-grants#0', // 免询问开关
      'session-grants#1', // 路径授权：读
      'session-grants#2' // 路径授权：写
    ])
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
    expect(rules.some((r) => r.id === 'session-grants#0')).toBe(true)
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
 * 同名裁决的策略层投影（AP-SH*）：resolvePolicyFiles 是设置页全量列表与装配（mergePolicyFiles →
 * assembleRules）共用的那一次裁决。规则本身的表在 registryShadowing.test.ts；这里钉顺序、注解、
 * 对象身份，以及「输掉的那份一条规则都进不了评估」。
 */
describe('resolvePolicyFiles —— 同名裁决的策略层投影', () => {
  const withFile = (policy: ParsedPolicyFile, fileName: string): UserPolicyFile => ({
    ...policy,
    fileName
  })

  // 内置 a / b；用户 b 两份（b.md 是名字本身，a.md 更短也更靠前）+ c
  const a = userPolicy('a', [])
  const bBuiltin = userPolicy('b', [{ effect: 'ask' }])
  const bAtA = withFile(userPolicy('b', [{ effect: 'deny' }]), 'a.md')
  const bAtB = withFile(userPolicy('b', [{ effect: 'allow' }]), 'b.md')
  const c = withFile(userPolicy('c', []), 'c.md')

  /** 「没被遮蔽的那些」按 mergePolicyFiles 的形状投影 */
  const activeOf = (
    builtins: readonly ParsedPolicyFile[],
    users: readonly UserPolicyFile[]
  ): Array<{ policy: ParsedPolicyFile; sourceKind: 'builtin' | 'user' }> =>
    resolvePolicyFiles(builtins, users)
      .filter((entry) => !entry.shadowedBy)
      .map(({ policy, sourceKind }) => ({ policy, sourceKind }))

  it('AP-SH1 内置在前、用户在后逐份返回；输的带 shadowedBy 指向胜者、用户份带 fileName；policy 是传进来的原对象', () => {
    const out = resolvePolicyFiles([a, bBuiltin], [bAtA, bAtB, c])
    expect(out).toStrictEqual([
      { policy: a, sourceKind: 'builtin' },
      {
        policy: bBuiltin,
        sourceKind: 'builtin',
        shadowedBy: { source: 'user', fileName: 'b.md' }
      },
      {
        policy: bAtA,
        sourceKind: 'user',
        fileName: 'a.md',
        shadowedBy: { source: 'user', fileName: 'b.md' }
      },
      { policy: bAtB, sourceKind: 'user', fileName: 'b.md' },
      { policy: c, sourceKind: 'user', fileName: 'c.md' }
    ])
    const passedIn = [a, bBuiltin, bAtA, bAtB, c]
    out.forEach((entry, i) => expect(entry.policy, `#${i}`).toBe(passedIn[i]))
  })

  it('AP-SH2 mergePolicyFiles 就是 resolvePolicyFiles 里没被遮蔽的那些，只留 policy / sourceKind 两个键；用户份倒序输入，胜者不变、顺序跟着输入', () => {
    const merged = mergePolicyFiles([a, bBuiltin], [bAtA, bAtB, c])
    expect(merged).toStrictEqual([
      { policy: a, sourceKind: 'builtin' },
      { policy: bAtB, sourceKind: 'user' },
      { policy: c, sourceKind: 'user' }
    ])
    expect(merged).toStrictEqual(activeOf([a, bBuiltin], [bAtA, bAtB, c]))
    for (const entry of merged) expect(Object.keys(entry).sort()).toEqual(['policy', 'sourceKind'])
    expect(merged[1].policy).toBe(bAtB)

    const reversed = mergePolicyFiles([a, bBuiltin], [c, bAtB, bAtA])
    expect(reversed).toStrictEqual([
      { policy: a, sourceKind: 'builtin' },
      { policy: c, sourceKind: 'user' },
      { policy: bAtB, sourceKind: 'user' }
    ])
    expect(reversed).toStrictEqual(activeOf([a, bBuiltin], [c, bAtB, bAtA]))
  })

  it('AP-SH3 assembleRules 只编译胜出的那份：p.md 的 deny 生效，a.md 的两条 ask 一条都进不了评估（两种扫描顺序一样）；规则 id 不重复', () => {
    const canon = withFile(
      userPolicy('p', [{ effect: 'deny', match: "inDir(object.path, '/canon')" }]),
      'p.md'
    )
    const copy = withFile(
      userPolicy('p', [
        { effect: 'ask', match: "inDir(object.path, '/copy')" },
        { effect: 'ask', match: "inDir(object.path, '/copy')" }
      ]),
      'a.md'
    )

    for (const users of [
      [canon, copy],
      [copy, canon]
    ]) {
      const label = users.map((p) => p.fileName).join(',')
      const rules = assembleRules(makeProvider({ getUserPolicies: () => users }))
      const own = rules.filter((r) => r.source.policy === 'p')
      expect(
        own.map((r) => r.id),
        label
      ).toEqual(['p#0'])
      expect(own[0].effect, label).toBe('deny')
      expect(own[0].matchExpr, label).toContain('/canon')
      const ids = rules.map((r) => r.id)
      expect(new Set(ids).size, label).toBe(ids.length)
      // 输掉的 a.md 那两条 ask 要是漏进来，/copy 就落不到 default
      expect(evaluate(own, pathRequest('/copy/x')).winning, label).toBe('default:path')
      expect(evaluate(own, pathRequest('/canon/x')).winning, label).toBe('p#0')
    }
  })

  it('AP-SH4 文件名即名字的那份哪怕是清空规则的「停用」覆盖也照样胜出：同名另一份的 force-allow 漏不进评估（对照：只有那一份时它确实生效）', () => {
    const disable = withFile(userPolicy('ask-on-write', []), 'ask-on-write.md')
    const loosen = withFile(
      userPolicy('ask-on-write', [{ effect: 'force-allow', match: "inDir(object.path, '/data')" }]),
      'a.md'
    )

    for (const users of [
      [disable, loosen],
      [loosen, disable]
    ]) {
      const rules = assembleRules(makeProvider({ getUserPolicies: () => users }))
      expect(
        rules.filter((r) => r.source.policy === 'ask-on-write'),
        users.map((p) => p.fileName).join(',')
      ).toEqual([])
    }

    const control = assembleRules(makeProvider({ getUserPolicies: () => [loosen] })).filter(
      (r) => r.source.policy === 'ask-on-write'
    )
    expect(control).toHaveLength(1)
    expect(control[0]).toMatchObject({
      tier: 'force-allow',
      source: { kind: 'user', policy: 'ask-on-write' }
    })
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

/**
 * 宿主没供给的目录变量 —— 只作 inDir 目录参数出现的 `vars.x`（celMatch.inDirOnlyVarNames）缺键
 * 或值为 undefined 时，deny / force-ask / ask 规则在求值前把它绑定为 null：inDir 当「没有这个目录」，
 * 正向用法命中不了、`!inDir(...)` 为真；并经 provider.logger 按「logger × 策略 × 变量」告警一次。
 * allow / force-allow 不绑（报错本就按不命中处置）；别处的用法照 CEL 原语义（缺键报错走 fail-safe）。
 *
 * 两个告警出口别混：「not provided」走 provider.logger.warn，fail-safe 走 evaluate 的 opts.warn。
 * 去重记忆是模块级 WeakMap、按 logger 对象键控 —— 所以每个用例（循环里是每一轮）都现造 logger。
 */
describe('assembleRules — 宿主没供给的目录变量', () => {
  const NOT_PROVIDED = 'is not provided by the host'

  /** 契约给定的告警原文 */
  const notProvided = (policy: string, name: string): string =>
    `security policy '${policy}': vars.${name} is not provided by the host; inDir treats it as no directory`

  const newLogger = (): {
    warn: ReturnType<typeof vi.fn>
    logger: NonNullable<SecurityHostProvider['logger']>
  } => {
    const warn = vi.fn()
    return { warn, logger: { info: vi.fn(), warn, error: vi.fn() } }
  }

  const linesOf = (spy: ReturnType<typeof vi.fn>): string[] =>
    spy.mock.calls.map((c) => String(c[0]))

  /** 条件限定 agent × path 的一条规则：条件不命中的请求因此跑不到 match */
  const pathRule = (effect: PolicyEffect, match: string): PolicyRuleSpec => ({
    effect,
    conditions: { 'subject.kind': ['agent'], 'object.type': ['path'] },
    match
  })

  const at = (path: string): { type: string; path: string } => ({ type: 'path', path })

  /** 值为 undefined 的缺失形态 —— PolicyVarValue 不收 undefined，只能强转 */
  const withUndefined = (name: string): Record<string, PolicyVarValue> =>
    ({ ...BUILTIN_VARS, [name]: undefined }) as unknown as Record<string, PolicyVarValue>

  /** 用户策略 p 只含这一条规则（其余全是内置） */
  const providerWithRule = (
    rule: PolicyRuleSpec,
    vars: Record<string, PolicyVarValue>,
    logger?: NonNullable<SecurityHostProvider['logger']>
  ): SecurityHostProvider =>
    makeProvider({
      getVars: () => vars,
      getUserPolicies: () => [userPolicy('p', [rule])],
      ...(logger ? { logger } : {})
    })

  const ruleP0 = (provider: SecurityHostProvider): SecurityRule =>
    assembleRules(provider, buildPolicyVars(provider)).find((r) => r.id === 'p#0')!

  /**
   * 生产同款判定：vars 一次现取（buildPolicyVars），装配与求值共用同一份。
   * 给出 policy 时只留该策略的规则 —— 内置门不掺进 matched / winning。
   */
  function decideWith(
    provider: SecurityHostProvider,
    action: string,
    object: SecurityObject,
    warn: (msg: string) => void,
    policy?: string
  ): ReturnType<typeof evaluate> {
    const vars = buildPolicyVars(provider)
    const rules = assembleRules(provider, vars)
    return evaluate(
      policy ? rules.filter((r) => r.source.policy === policy) : rules,
      {
        subject: { kind: 'agent', sessionId: 's1', agentKind: 'root' },
        action,
        object,
        environment: { host: 'desktop', platform: 'darwin' }
      },
      { vars, warn }
    )
  }

  it('AS-D1 deny / force-ask / ask × 缺键或 undefined × vars.x 或 [vars.x] → 不命中、不 throw、不走 fail-safe', () => {
    const missingForms: Array<[string, Record<string, PolicyVarValue>]> = [
      ['缺键', { ...BUILTIN_VARS }],
      ['undefined', withUndefined('extraDir')]
    ]
    for (const effect of ['deny', 'force-ask', 'ask'] as const) {
      for (const dirArg of ['vars.extraDir', '[vars.extraDir]']) {
        const rule = pathRule(effect, `inDir(object.path, ${dirArg})`)

        for (const [form, vars] of missingForms) {
          const label = `${effect} × ${dirArg} × ${form}`
          const log = newLogger()
          const provider = providerWithRule(rule, vars, log.logger)

          const ctx = makeCtx({ vars, object: at('/extra/x') })
          const matches = ruleP0(provider).matches!
          expect(() => matches(ctx), label).not.toThrow()
          expect(matches(ctx), label).toBe(false)

          const evalWarn = vi.fn()
          const decision = decideWith(provider, 'write', at('/extra/x'), evalWarn, 'p')
          expect(decision.matched, label).toEqual([])
          expect(decision.winning, label).toBe('default:path')
          expect(evalWarn, label).not.toHaveBeenCalled()
          // 告警换了出口：不是 fail-safe，而是 logger 上的一行（同一 logger 反复求值也只一行）
          expect(linesOf(log.warn), label).toEqual([notProvided('p', 'extraDir')])
        }

        // 对照：变量在，同一条规则照常生效 —— 上面测到的确实是「没有目录」，不是规则本身写坏了
        const label = `${effect} × ${dirArg} × 对照`
        const log = newLogger()
        const provider = providerWithRule(rule, { ...BUILTIN_VARS, extraDir: '/extra' }, log.logger)
        const evalWarn = vi.fn()
        const hit = decideWith(provider, 'write', at('/extra/x'), evalWarn, 'p')
        expect(hit.winning, label).toBe('p#0')
        expect(hit.effect, label).toBe(effect === 'deny' ? 'deny' : 'ask')
        const sibling = decideWith(provider, 'write', at('/extraneous/x'), evalWarn, 'p')
        expect(sibling.matched, label).toEqual([])
        expect(sibling.winning, label).toBe('default:path')
        expect(evalWarn, label).not.toHaveBeenCalled()
        expect(log.warn, label).not.toHaveBeenCalled()
      }
    }
  })

  it('AS-D2 [vars.gone, vars.extraDir]：有效的那一格照常命中；缺失 + 空串恒不命中', () => {
    const rule = pathRule('deny', 'inDir(object.path, [vars.gone, vars.extraDir])')
    const table: Array<[string, string, Array<[string, boolean]>]> = [
      [
        "A extraDir='/extra'",
        '/extra',
        [
          ['/extra/x', true],
          ['/extra', true],
          ['/elsewhere/x', false],
          ['/extraneous', false]
        ]
      ],
      [
        "B extraDir=''",
        '',
        [
          ['/extra/x', false],
          ['/x', false],
          ['/', false]
        ]
      ]
    ]

    for (const [label, extraDir, paths] of table) {
      const log = newLogger()
      const provider = providerWithRule(rule, { ...BUILTIN_VARS, extraDir }, log.logger)
      const evalWarn = vi.fn()
      for (const [path, denied] of paths) {
        const decision = decideWith(provider, 'write', at(path), evalWarn, 'p')
        expect({ label, path, effect: decision.effect, winning: decision.winning }).toEqual({
          label,
          path,
          effect: denied ? 'deny' : 'allow',
          winning: denied ? 'p#0' : 'default:path'
        })
      }
      expect(evalWarn, label).not.toHaveBeenCalled()
      const lines = linesOf(log.warn)
      expect(
        lines.filter((m) => m.includes('vars.gone')),
        label
      ).toEqual([notProvided('p', 'gone')])
      expect(
        lines.filter((m) => m.includes('extraDir')),
        label
      ).toEqual([])
    }
  })

  it('AS-D3a 同一变量别处也用到（比较）→ 不绑：缺键 throw，deny 走 fail-safe 命中，告警在 evaluate 而不在 logger', () => {
    const log = newLogger()
    const provider = providerWithRule(
      pathRule('deny', "inDir(object.path, vars.gone) || vars.gone == '/x'"),
      { ...BUILTIN_VARS },
      log.logger
    )

    expect(() => ruleP0(provider).matches!(makeCtx({ object: at('/g/x') }))).toThrow(
      /No such key: gone/
    )

    const evalWarn = vi.fn()
    const decision = decideWith(provider, 'write', at('/g/x'), evalWarn, 'p')
    expect(decision.effect).toBe('deny')
    expect(decision.matched).toEqual(['p#0'])
    expect(evalWarn).toHaveBeenCalledTimes(1)
    expect(evalWarn.mock.calls[0][0]).toContain("'p#0'")
    expect(evalWarn.mock.calls[0][0]).toContain('treating as matched (fail-safe)')
    expect(linesOf(log.warn).filter((m) => m.includes(NOT_PROVIDED))).toEqual([])
  })

  it('AS-D3b 绑不绑按变量逐个定：只作目录参数的 gone 绑，同一条 match 里作比较的 flag 不绑', () => {
    const rule = pathRule('deny', "inDir(object.path, vars.gone) || vars.flag == 'on'")

    // flag 在（'off'）：gone 绑成 null → 整条 false，不 throw；logger 恰一行（gone）
    const offVars = { ...BUILTIN_VARS, flag: 'off' }
    const offLog = newLogger()
    const offRule = ruleP0(providerWithRule(rule, offVars, offLog.logger))
    const offCtx = makeCtx({ vars: offVars, object: at('/g/x') })
    expect(() => offRule.matches!(offCtx)).not.toThrow()
    expect(offRule.matches!(offCtx)).toBe(false)
    expect(linesOf(offLog.warn)).toEqual([notProvided('p', 'gone')])

    // flag 缺键：gone 照绑（仍恰一行），flag 不绑 → No such key: flag → deny 走 fail-safe
    const absentLog = newLogger()
    const absent = providerWithRule(rule, { ...BUILTIN_VARS }, absentLog.logger)
    expect(() => ruleP0(absent).matches!(makeCtx({ object: at('/g/x') }))).toThrow(
      /No such key: flag/
    )
    const evalWarn = vi.fn()
    const decision = decideWith(absent, 'write', at('/g/x'), evalWarn, 'p')
    expect(decision.effect).toBe('deny')
    expect(decision.matched).toEqual(['p#0'])
    expect(evalWarn).toHaveBeenCalledTimes(1)
    expect(evalWarn.mock.calls[0][0]).toContain("'p#0'")
    expect(evalWarn.mock.calls[0][0]).toContain('treating as matched (fail-safe)')
    const lines = linesOf(absentLog.warn)
    expect(lines.filter((m) => m.includes(NOT_PROVIDED))).toEqual([notProvided('p', 'gone')])
    expect(lines.filter((m) => m.includes('vars.flag'))).toEqual([])
  })

  it('AS-D3c has(vars.gone) 让 gone 不再只是目录参数：缺键时 has 为 false、整条为真，不绑也不告警', () => {
    const rule = pathRule('deny', '!has(vars.gone) || inDir(object.path, vars.gone)')

    const log = newLogger()
    const absent = ruleP0(providerWithRule(rule, { ...BUILTIN_VARS }, log.logger))
    const ctx = makeCtx({ object: at('/g/x') })
    expect(() => absent.matches!(ctx)).not.toThrow()
    expect(absent.matches!(ctx)).toBe(true)
    expect(log.warn).not.toHaveBeenCalled()

    // 对照：gone 在 → has 为真，退化为普通的 inDir
    const vars = { ...BUILTIN_VARS, gone: '/g' }
    const present = ruleP0(providerWithRule(rule, vars))
    expect(present.matches!(makeCtx({ vars, object: at('/g/x') }))).toBe(true)
    expect(present.matches!(makeCtx({ vars, object: at('/h/x') }))).toBe(false)
  })

  it('AS-D4 allow / force-allow 不绑：缺变量照旧 strict + fail-safe 不命中，每次评估都告警，从不记「not provided」', () => {
    // 绑了会怎样：p 的 `!inDir(…, null)` 为真 —— 一条缺变量的 force-allow 就放行了一切写
    const log = newLogger()
    const provider = makeProvider({
      logger: log.logger,
      getUserPolicies: () => [
        userPolicy('p', [pathRule('force-allow', '!inDir(object.path, vars.gone)')]),
        userPolicy('q', [pathRule('allow', 'inDir(object.path, vars.gone)')])
      ]
    })

    const evalWarn = vi.fn()
    for (let i = 0; i < 2; i++) {
      const decision = decideWith(provider, 'write', at('/ws/f.txt'), evalWarn)
      expect(decision.effect).toBe('ask')
      expect(decision.winning).toBe('ask-on-write#0')
      expect(decision.matched).not.toContain('p#0')
      expect(decision.matched).not.toContain('q#0')
    }

    const notMatched = linesOf(evalWarn).filter((m) => m.includes('treating as not matched'))
    expect(notMatched.filter((m) => m.includes("'p#0'"))).toHaveLength(2)
    expect(notMatched.filter((m) => m.includes("'q#0'"))).toHaveLength(2)
    expect(linesOf(log.warn).filter((m) => m.includes(NOT_PROVIDED))).toEqual([])
  })

  it('AS-D5 「not provided」按 logger × 策略 × 变量只记一次，只在 match 真正求值时记，在的变量从不记', () => {
    const policies = (): ParsedPolicyFile[] => [
      userPolicy('p', [
        pathRule('deny', 'inDir(object.path, vars.gone)'),
        pathRule('force-ask', 'inDir(object.path, [vars.gone, vars.gone2])')
      ]),
      userPolicy('q', [pathRule('ask', 'inDir(object.path, vars.gone)')]),
      userPolicy('r', [pathRule('deny', 'inDir(object.path, vars.workspace)')])
    ]
    const EXPECTED = [
      notProvided('p', 'gone'),
      notProvided('p', 'gone2'),
      notProvided('q', 'gone')
    ].sort()
    const WRITES = ['/ws/f.txt', '/elsewhere/f.txt', '/ws/g.txt']
    const evalWarn = vi.fn()
    /** 三次路径写，每次现装配（decideWith 内部 assembleRules） */
    const writeAll = (provider: SecurityHostProvider): Array<ReturnType<typeof evaluate>> =>
      WRITES.map((path) => decideWith(provider, 'write', at(path), evalWarn))

    const L = newLogger()
    const providerA = makeProvider({ logger: L.logger, getUserPolicies: policies })

    // ① 只装配：谓词一条没跑，一行都没有
    assembleRules(providerA)
    expect(L.warn).not.toHaveBeenCalled()

    // ② command 客体：条件不命中，match 不跑，同样没有
    decideWith(
      providerA,
      'execute',
      { type: 'command', command: 'ls', channel: 'bash', parsed: false, commands: [], writes: [] },
      evalWarn
    )
    expect(L.warn).not.toHaveBeenCalled()

    // ③ 三次路径写 → 恰 3 行：p×gone、p×gone2、q×gone（p#1 里的 gone 与 p#0 同策略同变量，不重复）
    const decisionsA = writeAll(providerA)
    const lines = linesOf(L.warn)
    expect([...lines].sort()).toEqual(EXPECTED)
    for (const line of lines) {
      expect(line).toContain(NOT_PROVIDED)
      expect(line).not.toContain("'r'")
      expect(line).not.toContain('workspace')
    }

    // ④ 桌面形态：每次工具调用新建 provider，logger 是同一个 → 不再记
    writeAll(makeProvider({ logger: L.logger, getUserPolicies: policies }))
    expect(L.warn).toHaveBeenCalledTimes(3)

    // ⑤ 另一个 logger 有自己的一份记忆
    const M = newLogger()
    writeAll(makeProvider({ logger: M.logger, getUserPolicies: policies }))
    expect(linesOf(M.warn).sort()).toEqual(EXPECTED)
    expect(L.warn).toHaveBeenCalledTimes(3)

    // ⑥ 无 logger：决策一模一样，不 throw
    expect(writeAll(makeProvider({ getUserPolicies: policies }))).toEqual(decisionsA)
    // 全程没有一条走到 fail-safe
    expect(evalWarn).not.toHaveBeenCalled()
  })
})

/**
 * 用户主权 × 本会话 artifacts 豁免 —— 出厂的 ask-on-write 对 `vars.sessionArtifactsDir` 不问；
 * 用户把覆盖副本里那行 `match:` 删掉，就是要回「写哪儿都问」。覆盖按策略整份替换，所以只动写
 * 那一份：ask-on-read 仍是出厂的，读同一个文件照样不问。
 */
describe('assembleRules — 用户覆盖拿掉本会话 artifacts 豁免', () => {
  const OWN_ARTIFACT = '/home/u/.shuvix/artifacts/sess-1/x.svg'

  /** 端到端判定（生产同款：vars 一次现取，装配与求值共用） */
  function decide(
    provider: SecurityHostProvider,
    action: string,
    path: string
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
      { vars }
    )
  }

  it('AS-A1 覆盖副本删掉 match 行 → 本会话 artifacts 的写又问，归因用户那份；读不受牵连；对照：不覆盖时放行', () => {
    // 用户拿到的覆盖副本 = 出厂 en 文件原样；删掉的恰是那一行 match（形态守护：真删到了一行）
    const builtinRaw = INLINE_POLICY_MD('ask-on-write.md')!
    const lines = builtinRaw.split('\n')
    const kept = lines.filter((line) => !/^\s+match:/.test(line))
    expect(lines.length - kept.length).toBe(1)
    const parsed = parsePolicyDefinitionFile(kept.join('\n'), 'ask-on-write')
    expect(parsed).not.toBeNull()
    expect(parsed!.rules[0].match).toBeUndefined()

    const overridden = makeProvider({
      getUserPolicies: (): UserPolicyFile[] => [{ ...parsed!, fileName: 'ask-on-write.md' }]
    })
    const rules = assembleRules(overridden, buildPolicyVars(overridden))
    const askOnWrite = rules.filter((r) => r.source.policy === 'ask-on-write')
    expect(askOnWrite.map((r) => [r.id, r.source.kind])).toEqual([['ask-on-write#0', 'user']])

    const write = decide(overridden, 'write', OWN_ARTIFACT)
    expect(write.effect).toBe('ask')
    expect(write.winning).toBe('ask-on-write#0')

    // 覆盖按策略整份替换：ask-on-read 仍是出厂那份，豁免还在
    expect(decide(overridden, 'read', OWN_ARTIFACT).effect).toBe('allow')

    // 对照：没有用户策略时同一次写放行
    expect(decide(makeProvider(), 'write', OWN_ARTIFACT).effect).toBe('allow')
  })
})

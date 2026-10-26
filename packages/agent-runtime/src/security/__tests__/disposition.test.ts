/**
 * 处置维度（2026-10-25，设计见 docs/auto-redaction-design.md §3.1）：
 *   - 解析：`disposition` 单个或列表、去重；未知词、写在 ask / deny 上、落不到写死的 object.type 上 → 整份非法；
 *   - 结算：只取胜出那一档的处置，同档取并集；升一档（不带处置的 force-allow）就丢掉它；
 *   - 执行点：做不到的处置按拒绝结算（withDispositionSupport），做得到的随放行带回；
 *   - tool.restored：工具维度恒有这个列表（缺省空），规则可以按它写。
 */
import { describe, expect, it } from 'vitest'
import { createSecurityContext, withDispositionSupport } from '../context'
import { assembleRules } from '../assemble'
import { evaluate } from '../evaluate'
import { parsePolicyDefinitionFile, serializePolicyDefinitionFile } from '../policyFile'
import { createInlinePolicyMdReader } from '../builtinPolicies/inlineSources'
import type {
  SecurityDecision,
  SecurityHostProvider,
  SecurityRequest,
  SecuritySubject,
  UserPolicyFile
} from '../types'

const INLINE_POLICY_MD = createInlinePolicyMdReader()

const provider = (users: UserPolicyFile[] = []): SecurityHostProvider => ({
  host: 'desktop',
  pathSep: '/',
  getVars: () => ({}),
  readBuiltinPolicyMd: INLINE_POLICY_MD,
  getUserPolicies: () => users
})

const policyText = (rules: string, name = 'redaction'): string =>
  `---\nshuvix: policy v1\nname: ${name}\nshuvix-policy-rules:\n${rules}\n---\n`

const userPolicy = (rules: string, name = 'redaction'): UserPolicyFile => {
  const parsed = parsePolicyDefinitionFile(policyText(rules, name), name)
  expect(parsed, rules).not.toBeNull()
  return { ...parsed!, fileName: `${name}.md` }
}

const rejects = (rules: string): string[] => {
  const warnings: string[] = []
  expect(
    parsePolicyDefinitionFile(policyText(rules), 'redaction', (w) => warnings.push(w))
  ).toBeNull()
  return warnings
}

const agent: SecuritySubject = {
  kind: 'agent',
  sessionId: 's1',
  profileName: 'work',
  agentKind: 'root'
}

const sensitive = (category: string): SecurityRequest => ({
  subject: agent,
  action: 'disclose',
  object: { type: 'sensitive', category, rule: 'r', provider: 'anthropic', model: 'm' },
  environment: { host: 'desktop', platform: 'darwin' }
})

const REDACT_ALL = `  - effect: allow
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    disposition: redact`

describe('处置：解析', () => {
  it('DP-1 单个写成标量、列表去重；序列化回去，单个仍是标量', () => {
    const one = userPolicy(REDACT_ALL)
    expect(one.rules[0].disposition).toEqual(['redact'])
    const listed = userPolicy(`  - effect: force-allow
    subject.kind: [agent]
    object.type: [sensitive]
    disposition: [redact, redact]`)
    expect(listed.rules[0].disposition).toEqual(['redact'])

    const text = serializePolicyDefinitionFile(one)
    expect(text).toMatch(/disposition: redact$/m)
    expect(parsePolicyDefinitionFile(text, 'redaction')?.rules[0].disposition).toEqual(['redact'])
  })

  it('DP-2 未知的处置、写在 ask / deny 上、空列表 → 整份非法，原因进 warn', () => {
    expect(
      rejects(`  - effect: allow
    subject.kind: [agent]
    object.type: [sensitive]
    disposition: scramble`).join('\n')
    ).toMatch(/unknown disposition 'scramble'/)
    for (const effect of ['ask', 'force-ask', 'deny']) {
      expect(
        rejects(`  - effect: ${effect}
    subject.kind: [agent]
    object.type: [sensitive]
    disposition: redact`).join('\n')
      ).toMatch(/only allowed on allow \/ force-allow/)
    }
    expect(
      rejects(`  - effect: allow
    subject.kind: [agent]
    disposition: []`).join('\n')
    ).toMatch(/invalid disposition/)
  })

  it('DP-3 object.type 写死、处置落不到其中某种客体上 → 整份非法；写 * 或不写留给运行时', () => {
    expect(
      rejects(`  - effect: allow
    subject.kind: [agent]
    object.type: [sensitive, path]
    disposition: redact`).join('\n')
    ).toMatch(/'redact' cannot be carried out on object.type 'path'/)
    // scope 里写死的也算
    const warnings: string[] = []
    const scoped = `---\nshuvix: policy v1\nname: scoped\nshuvix-policy-scope:\n  object.type: [modelRequest]\nshuvix-policy-rules:\n  - effect: allow\n    subject.kind: [agent]\n    disposition: redact\n---\n`
    expect(parsePolicyDefinitionFile(scoped, 'scoped', (w) => warnings.push(w))).toBeNull()
    expect(warnings.join('\n')).toMatch(
      /'redact' cannot be carried out on object.type 'modelRequest'/
    )

    for (const typeLine of ['', "\n    object.type: ['*']"]) {
      expect(
        parsePolicyDefinitionFile(
          policyText(`  - effect: allow
    subject.kind: [agent]${typeLine}
    disposition: redact`),
          'redaction'
        )
      ).not.toBeNull()
    }
  })
})

describe('处置：结算', () => {
  const decide = (users: UserPolicyFile[], category = 'API_KEY'): SecurityDecision =>
    evaluate(assembleRules(provider(users)), sensitive(category))

  it('DP-4 allow + redact 命中 → 放行并带回处置；同档的处置取并集、按装配序', () => {
    expect(decide([userPolicy(REDACT_ALL)])).toMatchObject({
      effect: 'allow',
      tier: 'static-allow',
      dispositions: ['redact']
    })
    // 同一档里另一条带 detect（类型没写死，解析放行；点名了 disclose 才碰得到出口）：并集
    const both = decide([
      userPolicy(REDACT_ALL),
      userPolicy(
        `  - effect: allow
    subject.kind: [agent]
    action: [disclose]
    disposition: [detect, redact]`,
        'second'
      )
    ])
    expect(both.dispositions).toEqual(['redact', 'detect'])
  })

  it('DP-5 升一档就丢掉处置：不带处置的 force-allow 压过 allow + redact；deny 压过一切，拒绝不带处置', () => {
    const emailPasses = userPolicy(
      `  - effect: force-allow
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'EMAIL'"`,
      'email-passes'
    )
    const email = decide([userPolicy(REDACT_ALL), emailPasses], 'EMAIL')
    expect(email).toMatchObject({ effect: 'allow', tier: 'force-allow' })
    expect(email.dispositions).toBeUndefined()
    // 别的类别不受影响
    expect(decide([userPolicy(REDACT_ALL), emailPasses], 'API_KEY').dispositions).toEqual([
      'redact'
    ])

    const blocked = decide(
      [
        userPolicy(REDACT_ALL),
        userPolicy(
          `  - effect: deny
    subject.kind: [agent]
    object.type: [sensitive]
    match: "object.category == 'PRIVATE_KEY'"`,
          'no-keys'
        )
      ],
      'PRIVATE_KEY'
    )
    expect(blocked.effect).toBe('deny')
    expect(blocked.dispositions).toBeUndefined()
  })

  it('DP-6 没有规则 = 默认放行，不带处置（出厂的 redact-sensitive 不管家目录用户名这类）', () => {
    const none = decide([], 'USERNAME')
    expect(none).toMatchObject({ effect: 'allow', tier: 'default' })
    expect(none.dispositions).toBeUndefined()
  })
})

describe('处置：执行点', () => {
  const allowWith = (dispositions: SecurityDecision['dispositions']): SecurityDecision => ({
    effect: 'allow',
    tier: 'static-allow',
    matched: ['redaction#0'],
    winning: 'redaction#0',
    dispositions
  })

  it('DP-7 做不到的处置 → 按拒绝结算并说明；做得到、或本来就没有处置 → 原样', () => {
    const refused = withDispositionSupport(allowWith(['redact']), [])
    expect(refused.effect).toBe('deny')
    expect(refused.dispositions).toBeUndefined()
    expect(refused.reason).toMatch(/asks for 'redact', which this check cannot carry out/)

    const kept = allowWith(['redact'])
    expect(withDispositionSupport(kept, ['detect', 'redact'])).toBe(kept)
    const plain = allowWith(undefined)
    expect(withDispositionSupport(plain, [])).toBe(plain)
  })

  it('DP-8 门面：evaluate / judgeGate 按声明的能力结算；没声明 = 一个都做不了', () => {
    const context = createSecurityContext(
      agent,
      { host: 'desktop', platform: 'darwin' },
      provider([userPolicy(REDACT_ALL)])
    )
    const object = { type: 'sensitive', category: 'API_KEY', rule: 'r', provider: 'p', model: 'm' }
    expect(context.evaluate('disclose', object).effect).toBe('deny')
    expect(
      context.evaluate('disclose', object, { supportedDispositions: ['redact'] })
    ).toMatchObject({ effect: 'allow', dispositions: ['redact'] })
    const gate = context.judgeGate('disclose', object, {
      supportedDispositions: ['detect', 'redact']
    })
    expect(gate.allowed).toBe(true)
    expect(gate.decision.dispositions).toEqual(['redact'])
    expect(context.judgeGate('disclose', object).allowed).toBe(false)
  })

  it('DP-9 enforce 放行时把处置交回执行点（object.type 没写死的规则，由运行时按能力结算）', async () => {
    const context = createSecurityContext(
      agent,
      { host: 'desktop', platform: 'darwin' },
      provider([
        userPolicy(`  - effect: allow
    subject.kind: [agent]
    disposition: redact`)
      ])
    )
    const outcome = await context.enforceDatabase(
      { sql: 'select 1', credential: 'c', dbType: 'postgres', readonly: true },
      { toolCallId: 't', toolName: 'query', supportedDispositions: ['redact'] }
    )
    expect(outcome).toEqual({ status: 'allowed', dispositions: ['redact'] })
  })
})

describe('出口只认点名了它的规则', () => {
  const object = { type: 'sensitive', category: 'API_KEY', rule: 'r', provider: 'p', model: 'm' }
  const request = { type: 'modelRequest', provider: 'p', model: 'm' }

  it('DP-11 没写 object.type 也没写 action 的 ask / deny 碰不到模型请求（照样管工具）；点名了的照常', () => {
    const broad = userPolicy(
      `  - effect: deny
    subject.kind: [agent]
    match: "object.path.startsWith('/etc')"
  - effect: ask
    subject.kind: [agent]`,
      'broad'
    )
    const context = createSecurityContext(
      agent,
      { host: 'desktop', platform: 'darwin' },
      provider([broad])
    )
    // 出口：内置 redact-sensitive 照常，宽泛的两条不参与（也不因读 object.path 出错而算命中）
    expect(context.judgeGate('send', request, { supportedDispositions: ['detect'] })).toMatchObject(
      {
        allowed: true,
        decision: { dispositions: ['detect'], winning: 'redact-sensitive#0' }
      }
    )
    expect(
      context.judgeGate('disclose', object, { supportedDispositions: ['redact'] }).decision
    ).toMatchObject({ effect: 'allow', winning: 'redact-sensitive#1' })
    // 工具：宽泛的两条照样管（/tmp 下的读不命中 deny，命中 ask；/etc 下的读命中 deny）
    const path = (p: string): { type: string; path: string; displayPath: string } => ({
      type: 'path',
      path: p,
      displayPath: p
    })
    expect(context.evaluate('read', path('/tmp/x')).effect).toBe('ask')
    expect(context.evaluate('read', path('/etc/hosts')).effect).toBe('deny')

    const named = userPolicy(
      `  - effect: deny
    subject.kind: [agent]
    action: [send]
  - effect: deny
    subject.kind: [agent]
    object.type: [sensitive]
    match: "object.category == 'API_KEY'"`,
      'named'
    )
    const strict = createSecurityContext(
      agent,
      { host: 'desktop', platform: 'darwin' },
      provider([named])
    )
    expect(strict.judgeGate('send', request).allowed).toBe(false)
    expect(strict.judgeGate('disclose', object).allowed).toBe(false)
  })

  it('DP-12 只有内置 redact-sensitive 被停用、没有别的规则点名 → 放行，不带处置', () => {
    const rules = assembleRules({
      ...provider([]),
      isPolicyDisabled: (p) => p.name === 'redact-sensitive'
    })
    const base: SecurityRequest = {
      subject: agent,
      action: 'send',
      object: request,
      environment: { host: 'desktop', platform: 'darwin' }
    }
    expect(evaluate(rules, base)).toMatchObject({ effect: 'allow', tier: 'default' })
  })
})

describe('tool.restored', () => {
  const askWhenRestored = userPolicy(
    `  - effect: ask
    subject.kind: [agent]
    object.type: [invocation]
    match: "size(tool.restored) > 0"`,
    'restored-asks'
  )

  it('DP-10 工具维度恒有 restored（缺省空列表）：规则按它写，没还原的调用不报错也不命中', () => {
    const rules = assembleRules(provider([askWhenRestored]))
    const base: SecurityRequest = {
      subject: agent,
      action: 'execute',
      object: { type: 'invocation' },
      environment: { host: 'desktop', platform: 'darwin' }
    }
    expect(evaluate(rules, { ...base, tool: { name: 'bash' } }).effect).toBe('allow')
    expect(evaluate(rules, base).effect).toBe('allow')
    expect(evaluate(rules, { ...base, tool: { name: 'bash', restored: ['API_KEY'] } }).effect).toBe(
      'ask'
    )
  })
})

/**
 * 远程访问的网络策略在引擎侧的几块（2026-10-19，设计见 docs/network-policy/design.md）：
 *   - cidr.ts / CEL 的 `inCidr`：地址与网段的解析、IPv4 映射的 IPv6 按 IPv4 比、手误的网段不命中；
 *   - 主体的开放属性（`subject.<键>`）：惰性 getter 照搬、没人引用不计算、固定字段不可覆盖；
 *   - judgeGate：先完整结算再把 ask 降级为拒绝（force-allow 照样压过 ask），拒绝的那句话取哪里；
 *   - 解析期软告警：只管 network 主体的 ask / force-ask；
 *   - 内置 network-admission：只放本机，同名用户策略替换它。
 */
import { describe, expect, it, vi } from 'vitest'
import { ipInCidrs, parseCidr, parseIp } from '../cidr'
import { evaluateMatch } from '../celMatch'
import { assembleRules } from '../assemble'
import { evaluate } from '../evaluate'
import { createSecurityContext, GATE_DOWNGRADED_MESSAGE, gateVerdictOf } from '../context'
import { parsePolicyDefinitionFile } from '../policyFile'
import { createInlinePolicyMdReader } from '../builtinPolicies/inlineSources'
import type {
  MatchContext,
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
  getSessionGrants: () => ({ allowList: [] }),
  readBuiltinPolicyMd: INLINE_POLICY_MD,
  getUserPolicies: () => users
})

const userPolicy = (text: string): UserPolicyFile => {
  const parsed = parsePolicyDefinitionFile(text, 'x')
  expect(parsed, text).not.toBeNull()
  return { ...parsed!, fileName: `${parsed!.name}.md` }
}

const networkSubject = (attrs: Record<string, unknown>): SecuritySubject => ({
  kind: 'network',
  sessionId: '',
  attrs
})

const request = (
  subject: SecuritySubject,
  object: SecurityRequest['object'] = { type: 'request', method: 'GET', path: '/', route: 'page' },
  action = 'request'
): SecurityRequest => ({
  subject,
  action,
  object,
  environment: { host: 'desktop', platform: 'darwin' }
})

const ctxWith = (subject: MatchContext['subject']): Record<string, unknown> => ({
  subject,
  action: 'request',
  tool: { name: '', operation: '' },
  object: { type: 'request' },
  env: { host: 'desktop', platform: 'darwin' },
  vars: {}
})

describe('cidr', () => {
  it('NC-1 parseIp：严格点分四段、IPv6 缩写 / 嵌 IPv4 / zone / 方括号；映射地址落成 IPv4；不是地址 → undefined', () => {
    expect(parseIp('192.168.1.23')).toEqual({ family: 4, bits: 0xc0a80117n })
    expect(parseIp('::1')).toEqual({ family: 6, bits: 1n })
    expect(parseIp('[::1]')).toEqual({ family: 6, bits: 1n })
    expect(parseIp('fe80::1%en0')).toEqual({ family: 6, bits: (0xfe80n << 112n) | 1n })
    expect(parseIp('::ffff:127.0.0.1')).toEqual({ family: 4, bits: 0x7f000001n })
    expect(parseIp('::FFFF:7f00:1')).toEqual({ family: 4, bits: 0x7f000001n })
    expect(parseIp('1:2:3:4:5:6:1.2.3.4')?.family).toBe(6)
    for (const bad of [
      '',
      '256.1.1.1',
      '1.2.3',
      '1.2.3.4.5',
      'a.b.c.d',
      '1::2::3',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4:5:6:7::8',
      'localhost',
      42,
      null
    ]) {
      expect(parseIp(bad), String(bad)).toBeUndefined()
    }
  })

  it('NC-2 parseCidr：前缀范围、不带前缀 = 全长、映射网段按 IPv6 前缀写', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ ip: { family: 4, bits: 0x0a000000n }, prefix: 8 })
    expect(parseCidr('10.1.2.3')?.prefix).toBe(32)
    expect(parseCidr('fd00::/8')?.prefix).toBe(8)
    expect(parseCidr('::ffff:10.0.0.0/104')).toEqual({
      ip: { family: 4, bits: 0x0a000000n },
      prefix: 8
    })
    for (const bad of ['10.0.0.0/33', '10.0.0.0/', '10.0.0.0/x', '::/129', '::ffff:10.0.0.0/90']) {
      expect(parseCidr(bad), bad).toBeUndefined()
    }
  })

  it('NC-3 ipInCidrs：任一命中；地址族不同不命中；映射 IPv4 对 IPv4 网段命中；手误的网段与非字符串不命中、不抛', () => {
    expect(ipInCidrs('192.168.1.23', ['10.0.0.0/8', '192.168.1.0/24'])).toBe(true)
    expect(ipInCidrs('192.168.2.23', '192.168.1.0/24')).toBe(false)
    expect(ipInCidrs('::ffff:192.168.1.9', '192.168.1.0/24')).toBe(true)
    expect(ipInCidrs('192.168.1.9', '::ffff:192.168.1.0/120')).toBe(true)
    expect(ipInCidrs('fd12::5', 'fd00::/8')).toBe(true)
    expect(ipInCidrs('fd12::5', '0.0.0.0/0')).toBe(false)
    expect(ipInCidrs('8.8.8.8', '0.0.0.0/0')).toBe(true)
    expect(ipInCidrs('127.0.0.1', '127.0.0.1')).toBe(true)
    expect(ipInCidrs('127.0.0.2', '127.0.0.1')).toBe(false)
    expect(ipInCidrs('192.168.1.23', ['192.168.1.0/99', 7, null])).toBe(false)
    expect(ipInCidrs('not an ip', '0.0.0.0/0')).toBe(false)
    expect(ipInCidrs(undefined, '0.0.0.0/0')).toBe(false)
  })

  it('NC-4 CEL 的 inCidr：字符串或列表都收；参数类型不对是「不命中」而不是求值错误', () => {
    const subject = { kind: 'network', agentKind: '', profile: '', sessionId: '', depth: 0 }
    const ctx = ctxWith({ ...subject, address: '10.8.0.7' })
    expect(evaluateMatch("inCidr(subject.address, '10.8.0.0/16')", ctx, '/')).toBe(true)
    expect(
      evaluateMatch("inCidr(subject.address, ['192.168.0.0/16', '10.8.0.0/16'])", ctx, '/')
    ).toBe(true)
    expect(evaluateMatch("inCidr(subject.address, ['192.168.0.0/16'])", ctx, '/')).toBe(false)
    expect(evaluateMatch('inCidr(subject.depth, 3)', ctx, '/')).toBe(false)
  })
})

describe('主体的开放属性', () => {
  it('NS-1 subject.<键> 读得到开放属性；固定字段恒有值且不可覆盖', () => {
    const decision = evaluate(
      [
        {
          id: 'u#0',
          effect: 'deny',
          tier: 'deny',
          source: { kind: 'user', policy: 'u' },
          matches: (ctx) =>
            ctx.subject.address === '192.168.1.5' &&
            ctx.subject.kind === 'network' &&
            ctx.subject.profile === ''
        }
      ],
      request(networkSubject({ address: '192.168.1.5', kind: 'agent', profile: 'evil' }))
    )
    expect(decision.effect).toBe('deny')
  })

  it('NS-2 惰性 getter 照搬：没有规则引用就不计算，引用了才算（且是同一个 getter）', () => {
    const cookies = vi.fn(() => ({ a: '1' }))
    const attrs: Record<string, unknown> = { address: '10.0.0.1' }
    Object.defineProperty(attrs, 'cookies', { enumerable: false, get: cookies })
    const rules = assembleRules(
      provider([
        userPolicy(`---
name: by-address
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    match: "inCidr(subject.address, '10.0.0.0/8') && false"
---
`)
      ])
    )
    evaluate(rules, request(networkSubject(attrs)))
    expect(cookies).not.toHaveBeenCalled()
    const rules2 = assembleRules(
      provider([
        userPolicy(`---
name: by-cookie
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    match: "'a' in subject.cookies"
---
`)
      ])
    )
    expect(evaluate(rules2, request(networkSubject(attrs))).effect).toBe('deny')
    expect(cookies).toHaveBeenCalled()
  })

  it('NS-3 没有开放属性的主体（agent / user）读 subject.<键> 按 strict 报错 → fail-safe', () => {
    const warn = vi.fn()
    const rules = assembleRules(
      provider([
        userPolicy(`---
name: any-address
shuvix-policy-scope:
  subject.kind: ['*']
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    match: "subject.address == '1.2.3.4'"
---
`)
      ])
    )
    const decision = evaluate(rules, request({ kind: 'agent', sessionId: 's' }), { warn })
    expect(decision.effect).toBe('deny')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fail-safe'))
  })
})

describe('judgeGate', () => {
  const gate = (users: UserPolicyFile[], address: string) =>
    createSecurityContext(
      networkSubject({ address }),
      { host: 'desktop', platform: 'darwin' },
      provider(users)
    ).judgeGate('request', { type: 'request', method: 'GET', path: '/', route: 'page' })

  it('NG-1 结算为 ask → 拒绝且标降级；没写 prompt 用固定一句', () => {
    const verdict = gate(
      [
        userPolicy(`---
name: network-admission
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: ask
---
`)
      ],
      '192.168.1.5'
    )
    expect(verdict).toMatchObject({
      allowed: false,
      downgraded: true,
      message: GATE_DOWNGRADED_MESSAGE
    })
    expect(verdict.decision.effect).toBe('ask')
  })

  it('NG-2 先结算后降级：force-allow 压过 ask → 放行', () => {
    const verdict = gate(
      [
        userPolicy(`---
name: network-admission
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: force-ask
  - effect: force-allow
    match: "inCidr(subject.address, '192.168.1.0/24')"
---
`)
      ],
      '192.168.1.5'
    )
    expect(verdict.allowed).toBe(false)
    const ask = gate(
      [
        userPolicy(`---
name: network-admission
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: ask
  - effect: force-allow
    match: "inCidr(subject.address, '192.168.1.0/24')"
---
`)
      ],
      '192.168.1.5'
    )
    expect(ask).toMatchObject({ allowed: true, downgraded: false })
    expect(ask.message).toBeUndefined()
  })

  it('NG-3 deny 的话取 prompt；没写 prompt 取 reason', () => {
    const withPrompt = gateVerdictOf({
      effect: 'deny',
      matched: ['a#0'],
      winning: 'a#0',
      reason: "Denied by security policy rule 'a#0'",
      prompt: { text: 'Go away.', rules: ['a#0'], policies: ['a'] }
    })
    expect(withPrompt).toMatchObject({ allowed: false, downgraded: false, message: 'Go away.' })
    const bare = gateVerdictOf({
      effect: 'deny',
      matched: ['a#0'],
      winning: 'a#0',
      reason: "Denied by security policy rule 'a#0'"
    })
    expect(bare.message).toBe("Denied by security policy rule 'a#0'")
  })
})

describe('解析期软告警：network 主体的询问', () => {
  it('NW-1 subject.kind 只有 network 的 ask / force-ask 告警；deny、混了别的主体、或 * 不告警', () => {
    const warnings = (text: string): string[] => {
      const out: string[] = []
      parsePolicyDefinitionFile(text, 'x', (msg) => out.push(msg))
      return out.filter((msg) => msg.includes('cannot ask'))
    }
    const policy = (kinds: string, effect: string): string => `---
name: x
shuvix-policy-rules:
  - effect: ${effect}
    subject.kind: ${kinds}
---
`
    expect(warnings(policy('[network]', 'ask'))).toHaveLength(1)
    expect(warnings(policy('[network]', 'force-ask'))).toHaveLength(1)
    expect(warnings(policy('[network]', 'deny'))).toHaveLength(0)
    expect(warnings(policy('[network, agent]', 'ask'))).toHaveLength(0)
    expect(warnings(policy("'*'", 'ask'))).toHaveLength(0)
  })
})

describe('内置 network-admission', () => {
  const judge = (users: UserPolicyFile[], address: string, kind = 'network') =>
    evaluate(
      assembleRules(provider(users)),
      request(kind === 'network' ? networkSubject({ address }) : { kind, sessionId: 's' })
    )

  it('NA-1 本机（127/8、::1、映射的 127.0.0.1）放行；局域网、链路本地、IPv6 唯一本地拒绝且带说明', () => {
    for (const address of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1']) {
      expect(judge([], address).effect, address).toBe('allow')
    }
    for (const address of ['192.168.1.23', '10.0.0.2', 'fe80::1', 'fd00::5', '::ffff:10.0.0.2']) {
      const decision = judge([], address)
      expect(decision.effect, address).toBe('deny')
      expect(decision.winning).toBe('network-admission#0')
      expect(decision.prompt?.text).toMatch(/Network access/)
    }
  })

  it('NA-2 只作用于 network 主体：agent / user 主体的 request 客体不命中', () => {
    expect(judge([], '', 'agent').effect).toBe('allow')
    expect(judge([], '', 'user').effect).toBe('allow')
  })

  it('NA-3 同名用户策略替换它：空规则 = 任何对端都放；按网段写 = 只放那几个网段', () => {
    const open = userPolicy(`---
name: network-admission
shuvix-policy-rules: []
---
`)
    expect(judge([open], '192.168.1.23').effect).toBe('allow')
    const twoNets = userPolicy(`---
name: network-admission
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1', '192.168.1.0/24', '10.8.0.0/16'])"
---
`)
    expect(judge([twoNets], '192.168.1.23').effect).toBe('allow')
    expect(judge([twoNets], '10.8.3.4').effect).toBe('allow')
    expect(judge([twoNets], '192.168.2.1').effect).toBe('deny')
  })

  it('NA-4 另写一份 allow 放不开它：deny 压过 allow 与 force-allow', () => {
    const allow = userPolicy(`---
name: let-my-phone-in
shuvix-policy-scope:
  subject.kind: [network]
shuvix-policy-rules:
  - effect: force-allow
---
`)
    expect(judge([allow], '192.168.1.23').effect).toBe('deny')
  })
})

describe('实测暴露的两处 CEL 陷阱（DeepSeek flash 写出来过）', () => {
  it('NT-1 let 读请求文档（subject / object / action / tool / env）→ 整份非法，原因说清；只读 vars 的照常', () => {
    for (const expr of [
      "subject.device == 'x'",
      "inCidr(subject.address, '10.0.0.0/8')",
      "object.access == 'read'",
      "action == 'request'",
      "tool.name == 'files'",
      "env.host == 'desktop'"
    ]) {
      const warnings: string[] = []
      const parsed = parsePolicyDefinitionFile(
        `---\nname: x\nshuvix-policy-lets:\n  bad: "${expr}"\nshuvix-policy-rules:\n  - effect: deny\n    subject.kind: [network]\n    match: bad\n---\n`,
        'x',
        (w) => warnings.push(w)
      )
      expect(parsed, expr).toBeNull()
      expect(warnings.join('\n'), expr).toMatch(/lets are computed from `vars` only/)
    }
    expect(
      parsePolicyDefinitionFile(
        `---\nname: x\nshuvix-policy-lets:\n  nets: "['127.0.0.0/8', vars.home]"\nshuvix-policy-rules:\n  - effect: deny\n    subject.kind: [network]\n    match: "!inCidr(subject.address, nets)"\n---\n`,
        'x'
      )
    ).not.toBeNull()
  })

  it('NT-2 列表字面量可以混着字符串与 let 的值：名单不再在求值期报错', () => {
    const verdict = createSecurityContext(
      networkSubject({ address: '127.0.0.1', device: '' }),
      { host: 'desktop', platform: 'darwin' },
      provider([
        userPolicy(`---
name: network-admission
shuvix-policy-lets:
  phone: "'PhOnE0000000000000000a'"
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    match: "!(subject.device in ['', phone])"
---
`)
      ])
    ).judgeGate('request', { type: 'request', method: 'GET', path: '/', query: {}, route: 'page' })
    expect(verdict.allowed).toBe(true)
  })
})

describe('网络规则的解析期试算', () => {
  const warningsOf = (rules: string, lets = ''): string[] => {
    const out: string[] = []
    const parsed = parsePolicyDefinitionFile(
      `---\nname: x\n${lets}shuvix-policy-rules:\n${rules}---\n`,
      'x',
      (w) => out.push(w)
    )
    expect(parsed).not.toBeNull()
    return out.filter((w) => w.includes('fails'))
  }

  it('NT-3 读一个请求未必带的头、拼错的属性、对不上的类型 → 软告警（不判非法）；守护好的写法、内置策略不告警', () => {
    expect(
      warningsOf(
        `  - effect: deny\n    subject.kind: [network]\n    object.type: [request]\n    match: "subject.headers['x-real-ip'] == '1.2.3.4'"\n`
      )
    ).toHaveLength(1)
    expect(
      warningsOf(
        `  - effect: deny\n    subject.kind: [network]\n    match: "subject.adress == '1.2.3.4'"\n`
      )[0]
    ).toMatch(/fails on a sample socket request/)
    expect(
      warningsOf(
        `  - effect: deny\n    subject.kind: [network]\n    object.type: [channel]\n    match: "object.size > 'big'"\n`
      )
    ).toHaveLength(1)
    expect(
      warningsOf(
        `  - effect: deny\n    subject.kind: [network]\n    object.type: [request]\n    match: "'x-real-ip' in subject.headers && subject.headers['x-real-ip'] == '1.2.3.4'"\n`
      )
    ).toEqual([])
    expect(
      warningsOf(
        `  - effect: deny\n    subject.kind: [network]\n    match: "!inCidr(subject.address, nets) && !(subject.device in ['', phone])"\n`,
        `shuvix-policy-lets:\n  nets: "['127.0.0.0/8', '::1']"\n  phone: "'P'"\n`
      )
    ).toEqual([])
    // 只试点名了 network 的规则
    expect(
      warningsOf(
        `  - effect: deny\n    subject.kind: [agent]\n    match: "subject.adress == '1'"\n`
      )
    ).toEqual([])
    const builtin = createInlinePolicyMdReader()('network-admission.md')!
    const builtinWarnings: string[] = []
    parsePolicyDefinitionFile(builtin, 'network-admission', (w) => builtinWarnings.push(w))
    expect(builtinWarnings).toEqual([])
  })
})

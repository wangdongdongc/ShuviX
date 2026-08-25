/**
 * 策略定义文件 parse/serialize —— 结构非法整份拒绝（宁可整体拒绝也不静默降级），
 * 宽容仅限编码噪音（BOM/CRLF）与人读面（displayName）。
 * 规则形态 = { effect, match? }；未知键（含旧结构化匹配器键）整份非法。
 */
import { describe, it, expect, vi } from 'vitest'
import { descriptorForType } from '@shuvix/chat-protocol/shuvixMdDescriptors'
import {
  parsePolicyDefinitionFile,
  serializePolicyDefinitionFile,
  POLICY_FILE_MARKER,
  POLICY_FILE_MARKER_KEY,
  POLICY_LETS_KEY,
  POLICY_RULES_KEY,
  POLICY_SCOPE_KEY
} from '../policyFile'
// 模块门面的再导出（渲染层与宿主都从这里取上限），顺带钉住它没被漏出
import { POLICY_PROMPT_MAX } from '../index'
import type { ParsedPolicyFile } from '../types'

const md = (...lines: string[]): string => lines.join('\n')

describe('parsePolicyDefinitionFile — 合法文件', () => {
  it('PF-1 最小合法文件 → 各字段正确', () => {
    const text = md(
      '---',
      'shuvix: policy v1',
      'name: my-policy',
      'description: a test policy',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    subject.kind: [agent]',
      '    action: [write]',
      '    object.type: [path]',
      '    match: "inDir(object.path, vars.home + \'/.ssh\')"',
      '---',
      '',
      'Rationale body.'
    )
    const parsed = parsePolicyDefinitionFile(text, 'fallback')
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe('my-policy')
    expect(parsed!.description).toBe('a test policy')
    expect(parsed!.rules).toEqual([
      {
        effect: 'deny',
        conditions: {
          'subject.kind': ['agent'],
          action: ['write'],
          'object.type': ['path']
        },
        match: "inDir(object.path, vars.home + '/.ssh')"
      }
    ])
    expect(parsed!.body).toBe('Rationale body.')
  })

  it('PF-2 文件类型标记可选（无 shuvix: policy v1 也能解析）', () => {
    const parsed = parsePolicyDefinitionFile(
      md('---', 'shuvix-policy-rules: []', '---', 'body'),
      'x'
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.rules).toEqual([])
  })

  it('PF-3 serialize→parse 互逆（match + lets + 无 match 规则）', () => {
    const data: ParsedPolicyFile = {
      name: 'full',
      displayName: 'full',
      description: 'covers everything',
      scope: { 'subject.kind': ['agent'] },
      lets: { protectedDirs: "['/secret', vars.home + '/.keys']" },
      rules: [
        {
          effect: 'deny',
          conditions: { action: ['write'], 'object.type': ['path'] },
          match: 'inDir(object.path, protectedDirs)'
        },
        {
          effect: 'ask',
          conditions: { 'object.type': ['command'], 'tool.name': ['ssh'] }
        },
        { effect: 'allow', conditions: { 'env.host': ['desktop'] } }
      ],
      body: 'Some rationale.'
    }

    const text = serializePolicyDefinitionFile(data)
    expect(text).toContain(`${POLICY_FILE_MARKER_KEY}: ${POLICY_FILE_MARKER}`)
    expect(text).toContain('shuvix: policy v1')
    expect(parsePolicyDefinitionFile(text, 'other-name')).toEqual(data)
  })

  it('PF-3b 空 description / 无 lets 序列化时省略', () => {
    const data: ParsedPolicyFile = {
      name: 'p',
      displayName: 'p',
      description: '',
      rules: [],
      body: ''
    }
    const text = serializePolicyDefinitionFile(data)
    expect(text).not.toContain('description')
    expect(text).not.toContain('lets')
    expect(parsePolicyDefinitionFile(text, 'x')).toEqual(data)
  })

  it('PF-6 rules: [] 空数组合法', () => {
    const parsed = parsePolicyDefinitionFile(md('---', 'shuvix-policy-rules: []', '---'), 'x')
    expect(parsed).not.toBeNull()
    expect(parsed!.rules).toEqual([])
  })

  it('PF-7 match 省略 = 结构化条件即全部条件', () => {
    const parsed = parsePolicyDefinitionFile(
      md('---', 'shuvix-policy-rules:', '  - effect: ask', '    subject.kind: [agent]', '---'),
      'x'
    )!
    expect(parsed.rules).toEqual([{ effect: 'ask', conditions: { 'subject.kind': ['agent'] } }])
    expect('match' in parsed.rules[0]).toBe(false)
  })
})

describe('parsePolicyDefinitionFile — 非法整份拒绝', () => {
  const rule = (lines: string[]): string =>
    md(
      '---',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    subject.kind: [agent]',
      ...lines.map((l) => `    ${l}`),
      '---'
    )

  const cases: Array<[string, string]> = [
    ['无 frontmatter', 'just a markdown body without frontmatter'],
    [
      'frontmatter 不在文件开头（正文中段的 --- 块）',
      md('# Title', '', '---', 'name: mid', 'shuvix-policy-rules: []', '---', 'body')
    ],
    ['YAML 语法错误', md('---', 'name: [unclosed', '---', 'body')],
    ['frontmatter 为数组', md('---', '- a', '- b', '---', 'body')],
    ['rules 缺失', md('---', 'name: x', '---', 'body')],
    // 裸键（无 shuvix-policy- 前缀）→ 整份非法：旧键名文件不得被静默判"无规则"
    ['裸 rules 键', md('---', 'rules: []', 'shuvix-policy-rules: []', '---')],
    ['仅裸 rules 键', md('---', 'rules:', '  - effect: deny', '    subject.kind: [agent]', '---')],
    ['裸 lets 键', md('---', 'lets: { dirs: "[\'/a\']" }', 'shuvix-policy-rules: []', '---')],
    ['rules 非数组', md('---', 'shuvix-policy-rules: nope', '---')],
    [
      'effect 未知',
      md('---', 'shuvix-policy-rules:', '  - effect: block', '    subject.kind: [agent]', '---')
    ],
    ['effect 缺失', md('---', 'shuvix-policy-rules:', "  - match: 'true'", '---')],
    // 旧结构化匹配器键（嵌套形态）：静默忽略会让用户误信收窄生效 → 整份非法提示迁移。
    // 注意 action 不在其中 —— 它现在是合法的条件键（扁平、值为列表）
    ['旧 object 键', rule(['object:', '  kind: path'])],
    ['旧 subject 键', rule(['subject:', '  kind: [agent]'])],
    ['旧 tool 键', rule(['tool:', '  names: [ssh]'])],
    ['旧 environment 键', rule(['environment:', '  host: [desktop]'])],
    ['旧 when 键', rule(["when: 'true'"])],
    ['未知键', rule(['bogus: 1'])],
    ['match 非字符串', rule(['match: 3'])],
    ['match 空串', rule(["match: ''"])],
    ['match 纯空白', rule(["match: '   '"])],
    ['match 语法错', rule(["match: 'object.type =='"])],
    [
      '多条 rules 一条坏 → 整份 null',
      md(
        '---',
        'shuvix-policy-rules:',
        '  - effect: deny',
        '    subject.kind: [agent]',
        '  - effect: bogus',
        '    subject.kind: [agent]',
        '---'
      )
    ],
    // subject.kind 必填：scope 与规则都没有 → 整份非法
    ['缺 subject.kind', md('---', 'shuvix-policy-rules:', '  - effect: deny', '---')]
  ]

  it.each(cases)('PF-4 %s', (_label, text) => {
    expect(parsePolicyDefinitionFile(text, 'x')).toBeNull()
  })

  it('PF-4b match 含未知标识符 → 文件合法（compileMatch 只校验语法，求值期 fail-safe 兜底）', () => {
    const parsed = parsePolicyDefinitionFile(rule(['match: \'bogusVar == "x"\'']), 'x')
    expect(parsed).not.toBeNull()
    expect(parsed!.rules[0].match).toBe('bogusVar == "x"')
  })

  it('PF-4c match 首尾空白 trim 后存储', () => {
    const parsed = parsePolicyDefinitionFile(rule(['match: \'  action == "read"  \'']), 'x')!
    expect(parsed.rules[0].match).toBe('action == "read"')
  })

  it('PF-4d 早期失败（frontmatter 尚未解析出 name）经 warn 报原因，who 取文件 basename', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['无 frontmatter', 'just a body', /no YAML frontmatter block/],
      ['YAML 语法错', md('---', 'name: [unclosed', '---', 'body'), /invalid YAML \(/],
      [
        'frontmatter 为数组',
        md('---', '- a', '- b', '---', 'body'),
        /frontmatter must be a mapping/
      ]
    ]
    for (const [label, text, reason] of cases) {
      const warn = vi.fn()
      expect(parsePolicyDefinitionFile(text, 'from-file', warn), label).toBeNull()
      expect(warn, label).toHaveBeenCalledTimes(1)
      const msg = String(warn.mock.calls[0][0])
      expect(msg, label).toContain("'from-file'") // 还没有 name，用 basename 报
      expect(msg, label).toMatch(reason)
      expect(msg, label).toContain('the whole file is rejected')
    }
  })
})

describe('parsePolicyDefinitionFile — 条件值形态', () => {
  const withRule = (lines: string[]): string =>
    md(
      '---',
      'name: p',
      'shuvix-policy-rules:',
      '  - effect: deny',
      ...lines.map((l) => `    ${l}`),
      '---'
    )

  it('PF-Z1 标量值 → 单元素列表并 trim（列表条目同样 trim）', () => {
    const scalar = parsePolicyDefinitionFile(
      withRule(['subject.kind: agent', 'action: write', "object.type: '  path  '"]),
      'x'
    )!
    expect(scalar.rules[0].conditions).toEqual({
      'subject.kind': ['agent'],
      action: ['write'],
      'object.type': ['path']
    })

    const list = parsePolicyDefinitionFile(
      withRule(['subject.kind: [agent]', "action: ['  read  ', write]"]),
      'x'
    )!
    expect(list.rules[0].conditions!.action).toEqual(['read', 'write'])
  })

  it('PF-Z2 空列表 → 整份非法（「命中零个」一定是笔误）；YAML null 值 = 未写该键且不告警', () => {
    expect(
      parsePolicyDefinitionFile(withRule(['subject.kind: [agent]', 'action: []']), 'x')
    ).toBeNull()
    expect(parsePolicyDefinitionFile(withRule(['subject.kind: []']), 'x')).toBeNull()
    // 条目为空串 / 非字符串同样非法
    expect(parsePolicyDefinitionFile(withRule(["subject.kind: ['']"]), 'x')).toBeNull()
    expect(
      parsePolicyDefinitionFile(withRule(['subject.kind: [agent]', 'action: [3]']), 'x')
    ).toBeNull()

    // `action:`（YAML null）= 该键没写：不非法、不告警，规则只剩 subject.kind
    const warn = vi.fn()
    const parsed = parsePolicyDefinitionFile(
      withRule(['subject.kind: [agent]', 'action:', 'object.type:']),
      'x',
      warn
    )!
    expect(parsed.rules[0].conditions).toEqual({ 'subject.kind': ['agent'] })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('parsePolicyDefinitionFile — 策略级 scope', () => {
  const withScope = (scopeLines: string[], ruleLines: string[] = ['- effect: ask']): string =>
    md(
      '---',
      'name: p',
      'shuvix-policy-scope:',
      ...scopeLines.map((l) => `  ${l}`),
      'shuvix-policy-rules:',
      ...ruleLines.map((l) => `  ${l}`),
      '---'
    )

  it('PF-S1 合法 scope 解析为条件表（标量/列表混写同 PF-Z1 语义）', () => {
    const parsed = parsePolicyDefinitionFile(
      withScope(['subject.kind: [agent]', 'object.type: path', 'env.host: [desktop]']),
      'x'
    )!
    expect(parsed.scope).toEqual({
      'subject.kind': ['agent'],
      'object.type': ['path'],
      'env.host': ['desktop']
    })
  })

  it('PF-S2 scope 缺省 / 空映射 / YAML null → 解析产物无 scope 键', () => {
    const noScope = parsePolicyDefinitionFile(
      md('---', 'shuvix-policy-rules:', '  - effect: ask', '    subject.kind: [agent]', '---'),
      'x'
    )!
    expect('scope' in noScope).toBe(false)

    const empty = parsePolicyDefinitionFile(
      md(
        '---',
        'shuvix-policy-scope: {}',
        'shuvix-policy-rules:',
        '  - effect: ask',
        '    subject.kind: [agent]',
        '---'
      ),
      'x'
    )!
    expect('scope' in empty).toBe(false)

    const nulled = parsePolicyDefinitionFile(
      md(
        '---',
        'shuvix-policy-scope:',
        'shuvix-policy-rules:',
        '  - effect: ask',
        '    subject.kind: [agent]',
        '---'
      ),
      'x'
    )!
    expect('scope' in nulled).toBe(false)
  })

  it('PF-S3 scope 未知键 → 整份非法（warn 列出允许的条件键）', () => {
    const warn = vi.fn()
    expect(
      parsePolicyDefinitionFile(
        withScope(['subject.kind: [agent]', 'object.kind: [path]']),
        'x',
        warn
      )
    ).toBeNull()
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(msg).toContain("unknown shuvix-policy-scope key 'object.kind'")
    expect(msg).toContain('subject.kind')
  })

  it('PF-S4 scope 非映射（数组/标量）→ 整份非法', () => {
    const asList = md(
      '---',
      'shuvix-policy-scope: [agent]',
      'shuvix-policy-rules:',
      '  - effect: ask',
      '    subject.kind: [agent]',
      '---'
    )
    const asScalar = md(
      '---',
      'shuvix-policy-scope: agent',
      'shuvix-policy-rules:',
      '  - effect: ask',
      '    subject.kind: [agent]',
      '---'
    )
    for (const text of [asList, asScalar]) {
      const warn = vi.fn()
      expect(parsePolicyDefinitionFile(text, 'x', warn)).toBeNull()
      expect(String(warn.mock.calls[0][0])).toContain(
        'shuvix-policy-scope must be a mapping of condition keys'
      )
    }
  })

  it('PF-S5 scope 条件值非法（空列表 / 非字符串条目）→ 整份非法', () => {
    const warn = vi.fn()
    expect(parsePolicyDefinitionFile(withScope(['subject.kind: []']), 'x', warn)).toBeNull()
    expect(String(warn.mock.calls[0][0])).toContain(
      'invalid condition value in shuvix-policy-scope'
    )
    expect(parsePolicyDefinitionFile(withScope(['subject.kind: [3]']), 'x')).toBeNull()
    expect(parsePolicyDefinitionFile(withScope(["object.type: ''"]), 'x')).toBeNull()
  })

  it('PF-S6 scope 满足 subject.kind 必填：规则自身可不写', () => {
    const parsed = parsePolicyDefinitionFile(
      withScope(
        ['subject.kind: [agent]', 'object.type: [path]'],
        ['- effect: ask', '  action: [write]']
      ),
      'x'
    )!
    expect(parsed.scope).toEqual({ 'subject.kind': ['agent'], 'object.type': ['path'] })
    // 规则只保存自身写的字段 —— 与 scope 的合并发生在装配期（见 assemble）
    expect(parsed.rules).toEqual([{ effect: 'ask', conditions: { action: ['write'] } }])
  })

  it('PF-S7 serialize：scope 独立成段（在 rules 之前）；规则条件展平且顺序固定；往返互逆', () => {
    const data: ParsedPolicyFile = {
      name: 'p',
      displayName: 'p',
      description: '',
      scope: { 'subject.kind': ['agent'], 'object.type': ['path'] },
      rules: [
        {
          effect: 'ask',
          conditions: {
            'subject.kind': ['agent'],
            action: ['read', 'write'],
            'object.type': ['path'],
            'env.host': ['desktop'],
            'tool.name': ['read']
          },
          match: "inDir(object.path, '/x')"
        }
      ],
      body: ''
    }
    const text = serializePolicyDefinitionFile(data)
    expect(text).toContain('shuvix-policy-scope:')
    expect(text.indexOf('shuvix-policy-scope:')).toBeLessThan(text.indexOf('shuvix-policy-rules:'))
    // 展平顺序：effect → subject.kind → action → object.type → env.host → tool.name → match
    const order = [
      'effect:',
      'subject.kind:',
      'action:',
      'object.type:',
      'env.host:',
      'tool.name:',
      'match:'
    ].map((k) => text.indexOf(k, text.indexOf('shuvix-policy-rules:')))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(parsePolicyDefinitionFile(text, 'other')).toEqual(data)

    // 空 scope 对象序列化时省略该键
    const noScope: ParsedPolicyFile = { ...data, scope: {}, rules: [] }
    const bare = serializePolicyDefinitionFile(noScope)
    expect(bare).not.toContain('shuvix-policy-scope')
    expect(parsePolicyDefinitionFile(bare, 'p')).toEqual({
      ...noScope,
      scope: undefined,
      rules: []
    })
  })
})

describe('parsePolicyDefinitionFile — scope × 规则条件的合法性校验', () => {
  const withScopeAndRule = (scopeLines: string[], ruleLines: string[]): string =>
    md(
      '---',
      'name: p',
      'shuvix-policy-scope:',
      ...scopeLines.map((l) => `  ${l}`),
      'shuvix-policy-rules:',
      '  - effect: ask',
      ...ruleLines.map((l) => `    ${l}`),
      '---'
    )

  it('PF-C1 scope 与规则同键矛盾（空交集）→ 整份非法，warn 指明规则序号与 scope', () => {
    const warn = vi.fn()
    expect(
      parsePolicyDefinitionFile(
        withScopeAndRule(['subject.kind: [agent]', 'action: [read]'], ['action: [write]']),
        'x',
        warn
      )
    ).toBeNull()
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(msg).toContain('rule #0')
    expect(msg).toContain('contradicts shuvix-policy-scope')

    // 另一维度同理（object.type）
    expect(
      parsePolicyDefinitionFile(
        withScopeAndRule(
          ['subject.kind: [agent]', 'object.type: [path]'],
          ['object.type: [command]']
        ),
        'x'
      )
    ).toBeNull()
  })

  it('PF-C2 scope 与规则同键有交集 → 合法；scope 与规则各自原样保存（合并在装配期）', () => {
    const parsed = parsePolicyDefinitionFile(
      withScopeAndRule(['subject.kind: [agent]', 'action: [read, write]'], ['action: [write]']),
      'x'
    )!
    expect(parsed.scope).toEqual({ 'subject.kind': ['agent'], action: ['read', 'write'] })
    expect(parsed.rules[0].conditions).toEqual({ action: ['write'] })

    // scope 的 '*' 与规则的具体值：交集非空 → 合法
    expect(
      parsePolicyDefinitionFile(
        withScopeAndRule(["subject.kind: ['*']"], ['subject.kind: [agent]']),
        'x'
      )
    ).not.toBeNull()
  })

  it('PF-C3 subject.kind 必填：scope 与规则都没有 → 整份非法（warn 提示可用 * 表示任意主体）', () => {
    const warn = vi.fn()
    expect(
      parsePolicyDefinitionFile(
        md(
          '---',
          'name: p',
          'shuvix-policy-rules:',
          '  - effect: deny',
          '    action: [write]',
          '---'
        ),
        'x',
        warn
      )
    ).toBeNull()
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(msg).toContain("rule #0 has no 'subject.kind'")
    expect(msg).toContain("'*'")

    // 只有 scope 里有 / 只有规则里有 —— 两种写法都满足必填
    expect(
      parsePolicyDefinitionFile(
        withScopeAndRule(['subject.kind: [agent]'], ['action: [write]']),
        'x'
      )
    ).not.toBeNull()
    expect(
      parsePolicyDefinitionFile(
        md('---', 'shuvix-policy-rules:', '  - effect: deny', "    subject.kind: ['*']", '---'),
        'x'
      )
    ).not.toBeNull()

    // 多条规则里只要有一条缺 → 整份非法
    expect(
      parsePolicyDefinitionFile(
        md(
          '---',
          'shuvix-policy-rules:',
          '  - effect: deny',
          '    subject.kind: [agent]',
          '  - effect: ask',
          '    action: [read]',
          '---'
        ),
        'x'
      )
    ).toBeNull()
  })
})

describe('parsePolicyDefinitionFile — lets', () => {
  const withLets = (letsLines: string[]): string =>
    md(
      '---',
      'shuvix-policy-lets:',
      ...letsLines.map((l) => `  ${l}`),
      'shuvix-policy-rules: []',
      '---'
    )

  it('PF-L1 合法 lets：名字 → trim 后的表达式', () => {
    const parsed = parsePolicyDefinitionFile(
      withLets(["dirs: \"['/a', '/b']\"", "home2: '  vars.home  '"]),
      'x'
    )!
    expect(parsed.lets).toEqual({ dirs: "['/a', '/b']", home2: 'vars.home' })
  })

  it('PF-L2 lets 缺省 / 空映射 → 解析产物无 lets 键', () => {
    const noLets = parsePolicyDefinitionFile(md('---', 'shuvix-policy-rules: []', '---'), 'x')!
    expect('lets' in noLets).toBe(false)

    const emptyLets = parsePolicyDefinitionFile(
      md('---', 'shuvix-policy-lets: {}', 'shuvix-policy-rules: []', '---'),
      'x'
    )!
    expect('lets' in emptyLets).toBe(false)
  })

  it('PF-L3 lets 非法 → 整份 null', () => {
    // 名字与内置命名空间冲突
    for (const reserved of ['subject', 'action', 'tool', 'object', 'env', 'vars']) {
      expect(parsePolicyDefinitionFile(withLets([`${reserved}: "'x'"`]), 'x')).toBeNull()
    }
    // 名字非法标识符
    expect(parsePolicyDefinitionFile(withLets(["'my-dirs': \"['/a']\""]), 'x')).toBeNull()
    // 值非字符串 / 空串 / 语法错
    expect(parsePolicyDefinitionFile(withLets(['dirs: 3']), 'x')).toBeNull()
    expect(parsePolicyDefinitionFile(withLets(["dirs: ''"]), 'x')).toBeNull()
    expect(parsePolicyDefinitionFile(withLets(["dirs: '(a'"]), 'x')).toBeNull()
    // lets 为数组
    expect(
      parsePolicyDefinitionFile(
        md('---', 'shuvix-policy-lets: [a]', 'shuvix-policy-rules: []', '---'),
        'x'
      )
    ).toBeNull()
  })

  it('PF-L4 保留字 inDir：let 名叫 inDir → 整份 null（防 let 遮蔽注册函数）', () => {
    expect(parsePolicyDefinitionFile(withLets(['inDir: "\'x\'"']), 'x')).toBeNull()
  })
})

describe('parsePolicyDefinitionFile — 宽容分支与人读面', () => {
  it('PF-5 BOM + CRLF + 前导空白 + 尾无换行', () => {
    const text = '\uFEFF\n  \n---\r\nname: tolerant\r\nshuvix-policy-rules: []\r\n---'
    const parsed = parsePolicyDefinitionFile(text, 'x')
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe('tolerant')
    expect(parsed!.rules).toEqual([])
  })

  it('PF-8 shuvix-displayName：解析取值并 trim；缺省/非字符串/空白回退 name；serialize 互逆且等于 name 时省略', () => {
    const withDisplay = parsePolicyDefinitionFile(
      md('---', 'name: p', "shuvix-displayName: '  读取询问  '", 'shuvix-policy-rules: []', '---'),
      'x'
    )!
    expect(withDisplay.displayName).toBe('读取询问')

    // 缺省 / 非字符串 / 空白 → 回退 name（人读面宽容，不整份拒绝）
    expect(
      parsePolicyDefinitionFile(md('---', 'name: p', 'shuvix-policy-rules: []', '---'), 'x')!
        .displayName
    ).toBe('p')
    expect(
      parsePolicyDefinitionFile(
        md('---', 'name: p', 'shuvix-displayName: 3', 'shuvix-policy-rules: []', '---'),
        'x'
      )!.displayName
    ).toBe('p')
    expect(
      parsePolicyDefinitionFile(
        md('---', 'name: p', "shuvix-displayName: '   '", 'shuvix-policy-rules: []', '---'),
        'x'
      )!.displayName
    ).toBe('p')

    // serialize：displayName ≠ name 时写出并互逆；= name 时省略键
    const distinct: ParsedPolicyFile = {
      name: 'p',
      displayName: '读取询问',
      description: '',
      rules: [],
      body: ''
    }
    const text = serializePolicyDefinitionFile(distinct)
    expect(text).toContain('shuvix-displayName: 读取询问')
    expect(parsePolicyDefinitionFile(text, 'p')).toEqual(distinct)

    const same: ParsedPolicyFile = {
      name: 'p',
      displayName: 'p',
      description: '',
      rules: [],
      body: ''
    }
    expect(serializePolicyDefinitionFile(same)).not.toContain('shuvix-displayName')
  })

  it('PF-5b name 缺省取 defaultName；frontmatter name 覆盖并 trim', () => {
    expect(
      parsePolicyDefinitionFile(md('---', 'shuvix-policy-rules: []', '---'), 'from-file')!.name
    ).toBe('from-file')
    expect(
      parsePolicyDefinitionFile(
        md('---', "name: '  padded  '", 'shuvix-policy-rules: []', '---'),
        'from-file'
      )!.name
    ).toBe('padded')
  })
})

describe('parsePolicyDefinitionFile — effect: force-allow（第四个 effect 值）', () => {
  /** 只写 effect 的最小规则（subject.kind 必填故恒带） */
  const withEffect = (effect: string): string =>
    md(
      '---',
      'name: p',
      'shuvix-policy-rules:',
      `  - effect: ${effect}`,
      '    subject.kind: [agent]',
      '---'
    )

  it('CP-1 force-allow 原样保留：解析期不归一为 allow，也不产出 tier（归一是装配期的事）', () => {
    const parsed = parsePolicyDefinitionFile(
      md(
        '---',
        'name: my-force-allow',
        'shuvix-policy-rules:',
        '  - effect: force-allow',
        '    subject.kind: [agent]',
        '    object.type: [path]',
        '    action: [read]',
        '    match: "inDir(object.path, vars.grantedRead)"',
        '---',
        '',
        'Rationale body.'
      ),
      'x'
    )!
    expect(parsed.rules).toEqual([
      {
        effect: 'force-allow',
        conditions: {
          'subject.kind': ['agent'],
          action: ['read'],
          'object.type': ['path']
        },
        match: 'inDir(object.path, vars.grantedRead)'
      }
    ])
    // tier 是装配产物（SecurityRule）的字段，文件模型里不该出现
    expect('tier' in parsed.rules[0]).toBe(false)
  })

  it.each(['allow', 'force-allow', 'ask', 'force-ask', 'deny'])(
    'CP-2 effect: %s 合法且原样保留',
    (effect) => {
      const parsed = parsePolicyDefinitionFile(withEffect(effect), 'x')
      expect(parsed).not.toBeNull()
      expect(parsed!.rules[0].effect).toBe(effect)
    }
  )

  // 'consent' 是改名前的旧词：必须判非法而不是被当未知取值静默吞掉 ——
  // 老文件若还写着它，用户要立刻看到报错，而不是以为授权仍然生效
  it.each([
    'consent',
    'Force-Allow',
    'FORCE-ASK',
    'force allow',
    'consents',
    'grant',
    'permit',
    'allow-remember'
  ])('CP-2b effect: %s 非法 → 整份拒绝（取值大小写敏感，旧词与近义词都不接受）', (effect) => {
    expect(parsePolicyDefinitionFile(withEffect(effect), 'x')).toBeNull()
  })

  it('CP-3 同一文件混写四值：逐条 effect 与书写顺序逐字一致', () => {
    const parsed = parsePolicyDefinitionFile(
      md(
        '---',
        'name: p',
        'shuvix-policy-scope:',
        '  subject.kind: [agent]',
        'shuvix-policy-rules:',
        '  - effect: deny',
        "    match: \"object.type == 'path' && inDir(object.path, '/deny')\"",
        '  - effect: force-allow',
        "    match: \"object.type == 'path' && inDir(object.path, '/force-allow')\"",
        '  - effect: ask',
        "    match: \"object.type == 'path' && inDir(object.path, '/ask')\"",
        '  - effect: allow',
        "    match: \"object.type == 'path' && inDir(object.path, '/allow')\"",
        '---'
      ),
      'x'
    )!
    expect(parsed.rules.map((r) => r.effect)).toEqual(['deny', 'force-allow', 'ask', 'allow'])
    // 规则 id 是 '<policy>#<下标>'，顺序错位就是归因错位 —— match 逐字对上下标
    expect(parsed.rules.map((r) => r.match)).toEqual([
      "object.type == 'path' && inDir(object.path, '/deny')",
      "object.type == 'path' && inDir(object.path, '/force-allow')",
      "object.type == 'path' && inDir(object.path, '/ask')",
      "object.type == 'path' && inDir(object.path, '/allow')"
    ])
  })

  it('CP-4 serialize→parse 往返保留 force-allow（含 conditions + match）；YAML 里是裸词', () => {
    const data: ParsedPolicyFile = {
      name: 'trust-data',
      displayName: 'trust-data',
      description: 'force-allow round trip',
      scope: { 'subject.kind': ['agent'], 'object.type': ['path'] },
      rules: [
        {
          effect: 'force-allow',
          conditions: { action: ['read', 'write'] },
          match: "inDir(object.path, '/data')"
        },
        { effect: 'ask', conditions: { action: ['read'] } }
      ],
      body: 'Why /data is trusted.'
    }

    const text = serializePolicyDefinitionFile(data)
    // 裸词（不加引号、不改写成 allow）—— 序列化产物本身要能被人读懂
    expect(text).toContain('effect: force-allow')
    expect(text).not.toContain("effect: 'force-allow'")
    expect(parsePolicyDefinitionFile(text, 'other-name')).toEqual(data)
  })

  it('CP-5 force-allow 不豁免任何校验：缺 subject.kind / 与 scope 空交集 → 整份非法；无 object.type 守卫的软告警照常', () => {
    // ① subject.kind 必填对 force-allow 同样成立
    expect(
      parsePolicyDefinitionFile(
        md('---', 'name: p', 'shuvix-policy-rules:', '  - effect: force-allow', '---'),
        'x'
      )
    ).toBeNull()

    // ② 与 scope 空交集 = 死规则 → 整份非法
    const warn = vi.fn()
    expect(
      parsePolicyDefinitionFile(
        md(
          '---',
          'name: p',
          'shuvix-policy-scope:',
          '  subject.kind: [agent]',
          '  action: [read]',
          'shuvix-policy-rules:',
          '  - effect: force-allow',
          '    action: [write]',
          '---'
        ),
        'x',
        warn
      )
    ).toBeNull()
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'contradicts shuvix-policy-scope'
    )

    // ③ match 读客体属性却无 object.type 条件 → 软告警恰 1 次，文件仍合法
    const soft = vi.fn()
    const parsed = parsePolicyDefinitionFile(
      md(
        '---',
        'name: p',
        'shuvix-policy-rules:',
        '  - effect: force-allow',
        '    subject.kind: [agent]',
        '    match: "inDir(object.path, vars.grantedRead)"',
        '---'
      ),
      'x',
      soft
    )
    expect(parsed).not.toBeNull()
    expect(soft).toHaveBeenCalledTimes(1)
    expect(String(soft.mock.calls[0][0])).toContain('object.type')
  })
})

/**
 * 规则的 `prompt`（人读提示语）—— 与其余键**语义相反**的一处宽容：
 * 它不参与匹配、不影响判决，因此没有资格让文件非法。空值按「没写」处理，
 * 类型错与超长记警告后降级 —— 一句被清空的提示语不得弄死用户自己的 deny 规则。
 */
describe('parsePolicyDefinitionFile — 规则 prompt（人读提示语）', () => {
  /** 带一条 deny 规则的最小文件；额外行按规则缩进拼进去 */
  const withRule = (...lines: string[]): string =>
    md(
      '---',
      'name: p',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    subject.kind: [agent]',
      ...lines.map((l) => `    ${l}`),
      '---'
    )

  it('PF-P1 prompt 与 effect/条件/match 同存 → 原文保留、首尾空白 trim', () => {
    const warn = vi.fn()
    const parsed = parsePolicyDefinitionFile(
      md(
        '---',
        'name: p',
        'shuvix-policy-rules:',
        '  - effect: ask',
        '    subject.kind: [agent]',
        '    action: [write]',
        '    object.type: [path]',
        `    match: "inDir(object.path, '/tmp')"`,
        '    prompt: "   Writing replaces what is on disk.   "',
        '---'
      ),
      'x',
      warn
    )!
    expect(parsed.rules).toEqual([
      {
        effect: 'ask',
        conditions: { 'subject.kind': ['agent'], action: ['write'], 'object.type': ['path'] },
        match: "inDir(object.path, '/tmp')",
        prompt: 'Writing replaces what is on disk.'
      }
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it('PF-P2 省略 prompt → 产物无该键', () => {
    const parsed = parsePolicyDefinitionFile(withRule('action: [write]'), 'x')!
    expect(parsed.rules).toEqual([
      { effect: 'deny', conditions: { 'subject.kind': ['agent'], action: ['write'] } }
    ])
    expect('prompt' in parsed.rules[0]).toBe(false)
  })

  it('PF-P3 空串 / 纯空白 prompt → 按「没写」处理：文件合法、无该键、不告警', () => {
    for (const line of ["prompt: ''", "prompt: '   '", 'prompt: "\\t\\n "']) {
      const warn = vi.fn()
      const parsed = parsePolicyDefinitionFile(withRule(line), 'x', warn)
      expect(parsed, line).not.toBeNull()
      expect(parsed!.rules, line).toEqual([
        { effect: 'deny', conditions: { 'subject.kind': ['agent'] } }
      ])
      expect('prompt' in parsed!.rules[0], line).toBe(false)
      expect(warn, line).not.toHaveBeenCalled()
    }
  })

  it('PF-P4 非字符串 prompt（数字/布尔/列表/映射）→ 文件合法、忽略该键、warn 含 prompt must be a string', () => {
    const cases: string[][] = [
      ['prompt: 42'],
      ['prompt: true'],
      ['prompt: [a, b]'],
      ['prompt:', '  text: a']
    ]
    for (const lines of cases) {
      const warn = vi.fn()
      const label = lines.join(' / ')
      const parsed = parsePolicyDefinitionFile(withRule(...lines), 'x', warn)
      // 非法的是写法，不是策略 —— 规则照常生效，只是不带话
      expect(parsed, label).not.toBeNull()
      expect(parsed!.rules[0].prompt, label).toBeUndefined()
      expect(warn, label).toHaveBeenCalledTimes(1)
      const msg = String(warn.mock.calls[0][0])
      expect(msg, label).toContain('prompt must be a string')
      expect(msg, label).toContain("'p'")
      expect(msg, label).toContain('rule #0')
    }
  })

  it('PF-P5 YAML prompt: 空值（null / ~）→ 同「没写」（与条件键的 null 语义一致）', () => {
    for (const line of ['prompt:', 'prompt: null', 'prompt: ~']) {
      const warn = vi.fn()
      const parsed = parsePolicyDefinitionFile(withRule(line), 'x', warn)!
      expect(parsed.rules, line).toEqual([
        { effect: 'deny', conditions: { 'subject.kind': ['agent'] } }
      ])
      expect(warn, line).not.toHaveBeenCalled()
    }
  })

  it('PF-P6 长度：恰 POLICY_PROMPT_MAX 原样；超长截断 + warn（含实际长度与 truncated）；trim 先于计长', () => {
    const exact = 'x'.repeat(POLICY_PROMPT_MAX)
    const quiet = vi.fn()
    expect(
      parsePolicyDefinitionFile(withRule(`prompt: "${exact}"`), 'x', quiet)!.rules[0].prompt
    ).toBe(exact)
    expect(quiet).not.toHaveBeenCalled()

    // 超长：文件仍合法，截到上限，告警说清实际长度
    const warn = vi.fn()
    const long = 'y'.repeat(POLICY_PROMPT_MAX + 37)
    const cut = parsePolicyDefinitionFile(withRule(`prompt: "${long}"`), 'x', warn)
    expect(cut).not.toBeNull()
    expect(cut!.rules[0].prompt).toBe('y'.repeat(POLICY_PROMPT_MAX))
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toContain(String(POLICY_PROMPT_MAX + 37))
    expect(msg).toContain(String(POLICY_PROMPT_MAX))
    expect(msg).toContain('truncated')

    // 截断点落在代理对上：宁可少一个字符，也不留半个坏字符
    const emoji = vi.fn()
    const astral = 'z'.repeat(POLICY_PROMPT_MAX - 1) + '\u{1F600}\u{1F600}'
    const cutAstral = parsePolicyDefinitionFile(withRule(`prompt: "${astral}"`), 'x', emoji)!
      .rules[0].prompt!
    expect(cutAstral).toBe('z'.repeat(POLICY_PROMPT_MAX - 1))
    expect([...cutAstral].every((c) => c.codePointAt(0)! < 0xd800)).toBe(true)

    // 前后各裹 10 空格的 1000 字：trim 之后才计长，不该被截
    const padded = vi.fn()
    const wrapped = parsePolicyDefinitionFile(
      withRule(`prompt: "${' '.repeat(10)}${exact}${' '.repeat(10)}"`),
      'x',
      padded
    )!
    expect(wrapped.rules[0].prompt).toBe(exact)
    expect(padded).not.toHaveBeenCalled()
  })

  it('PF-P7 四个 effect 都能带 prompt（allow/force-allow 不因「不投递」被拒）', () => {
    const warn = vi.fn()
    const parsed = parsePolicyDefinitionFile(
      md(
        '---',
        'name: p',
        'shuvix-policy-scope:',
        '  subject.kind: [agent]',
        'shuvix-policy-rules:',
        ...['allow', 'force-allow', 'ask', 'deny'].flatMap((effect) => [
          `  - effect: ${effect}`,
          `    prompt: ${effect} note`
        ]),
        '---'
      ),
      'x',
      warn
    )!
    expect(parsed.rules.map((r) => [r.effect, r.prompt])).toEqual([
      ['allow', 'allow note'],
      ['force-allow', 'force-allow note'],
      ['ask', 'ask note'],
      ['deny', 'deny note']
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it('PF-P8 serialize→parse 往返：多行 / 含冒号与引号 / 中文与 emoji 逐字段不变；无 prompt 不产出该键', () => {
    const data: ParsedPolicyFile = {
      name: 'prompts',
      displayName: 'prompts',
      description: '',
      rules: [
        {
          effect: 'deny',
          conditions: { 'subject.kind': ['agent'] },
          prompt: 'First line.\nSecond line: a colon, "double" and \'single\' quotes.'
        },
        {
          effect: 'ask',
          conditions: { 'subject.kind': ['agent'] },
          prompt: '写入会改写磁盘 ⚠️ 放行前先确认目标路径与改动范围。'
        },
        { effect: 'ask', conditions: { 'subject.kind': ['agent'] } }
      ],
      body: ''
    }

    const text = serializePolicyDefinitionFile(data)
    expect(parsePolicyDefinitionFile(text, 'other-name')).toEqual(data)
    // 最后一条规则无 prompt → 它那段 YAML 里根本没有该键
    expect(text.split('- effect: ask').pop()).not.toContain('prompt:')
  })

  it('PF-P9 prompt 不参与校验联动：effect + subject.kind + prompt（无 match）合法且零告警', () => {
    const warn = vi.fn()
    const parsed = parsePolicyDefinitionFile(
      withRule('prompt: object.path is only named in prose here, never matched on'),
      'x',
      warn
    )!
    expect(parsed.rules).toEqual([
      {
        effect: 'deny',
        conditions: { 'subject.kind': ['agent'] },
        prompt: 'object.path is only named in prose here, never matched on'
      }
    ])
    // object.type 软告警只看 match —— prompt 里出现 `object.` 不该把它引出来
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('parsePolicyDefinitionFile — object.type 软告警', () => {
  /** 无 object.type 条件的规则（subject.kind 必填故恒带） */
  const denyRule = (match: string): string =>
    md(
      '---',
      'name: p',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    subject.kind: [agent]',
      `    match: "${match}"`,
      '---'
    )

  it('PF-G1 未声明 object.type 却在 match 里读客体属性 → warn 恰 1 次（含策略名与规则序号）；文件仍合法', () => {
    const warn = vi.fn()
    const parsed = parsePolicyDefinitionFile(denyRule("inDir(object.path, '/x')"), 'x', warn)
    expect(parsed).not.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain("'p'")
    expect(warn.mock.calls[0][0]).toContain('rule #0')
    expect(warn.mock.calls[0][0]).toContain('object.type')
  })

  it('PF-G2 声明了 object.type 条件（规则级或 scope）→ 不告警', () => {
    const warn = vi.fn()
    // 规则级声明
    parsePolicyDefinitionFile(
      md(
        '---',
        'shuvix-policy-rules:',
        '  - effect: deny',
        '    subject.kind: [agent]',
        '    object.type: [path]',
        `    match: "inDir(object.path, '/x')"`,
        '---'
      ),
      'x',
      warn
    )
    // scope 级声明同样满足
    parsePolicyDefinitionFile(
      md(
        '---',
        'shuvix-policy-scope:',
        '  subject.kind: [agent]',
        '  object.type: [path]',
        'shuvix-policy-rules:',
        '  - effect: deny',
        `    match: "inDir(object.path, '/x')"`,
        '---'
      ),
      'x',
      warn
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('PF-G3 has( 探测、不碰客体属性的 match、无 match 规则 → 均不告警；未传 warn 不炸', () => {
    const warn = vi.fn()
    parsePolicyDefinitionFile(denyRule('has(object.path)'), 'x', warn)
    parsePolicyDefinitionFile(denyRule("subject.profile == 'widget'"), 'x', warn)
    parsePolicyDefinitionFile(
      md('---', 'shuvix-policy-rules:', '  - effect: deny', '    subject.kind: [agent]', '---'),
      'x',
      warn
    )
    expect(warn).not.toHaveBeenCalled()

    expect(() => parsePolicyDefinitionFile(denyRule("inDir(object.path, '/x')"), 'x')).not.toThrow()
  })

  it('PF-G4 `has(` 出现在 match 任意位置即整条静默（探测式写法自负其责）', () => {
    const warn = vi.fn()
    parsePolicyDefinitionFile(denyRule("has(object.sql) && object.sql != ''"), 'x', warn)
    parsePolicyDefinitionFile(denyRule("inDir(object.path, '/x') || has(object.sql)"), 'x', warn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('PF-G5 match 文本里写了 object.type == … 但没有结构化条件 → 仍告警（守卫只认条件字段）', () => {
    const warn = vi.fn()
    const parsed = parsePolicyDefinitionFile(
      denyRule("object.type == 'path' && inDir(object.path, '/x')"),
      'x',
      warn
    )
    expect(parsed).not.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('object.type')

    // 提成条件字段后不再告警（这就是告警在提示的迁移动作）
    const quiet = vi.fn()
    parsePolicyDefinitionFile(
      md(
        '---',
        'name: p',
        'shuvix-policy-rules:',
        '  - effect: deny',
        '    subject.kind: [agent]',
        '    object.type: [path]',
        `    match: "inDir(object.path, '/x')"`,
        '---'
      ),
      'x',
      quiet
    )
    expect(quiet).not.toHaveBeenCalled()
  })
})

/**
 * 属性卡描述符（chat-protocol，渲染进程够不到 agent-runtime，故键名是抄过去的常量）
 * 与解析器键名的防漂移守护：两边一旦不一致，policy md 的三个结构键会静默落到
 * 属性卡的「未知键通用行」——卡片看着还在，只是不再是结构摘要。
 */
describe('shuvixMdDescriptors — policy 描述符与解析器键名同源', () => {
  it('PU-9 三个结构键与 POLICY_SCOPE_KEY/LETS/RULES 逐一相等，kind 为 conditions/exprMap/policyRules', () => {
    const descriptor = descriptorForType('policy')
    expect(descriptor).not.toBeNull()
    const pick = (key: string): { key: string; kind: string } | undefined => {
      const spec = descriptor!.fields.find((f) => f.key === key)
      return spec && { key: spec.key, kind: spec.kind }
    }
    expect(pick(POLICY_SCOPE_KEY)).toEqual({ key: POLICY_SCOPE_KEY, kind: 'conditions' })
    expect(pick(POLICY_LETS_KEY)).toEqual({ key: POLICY_LETS_KEY, kind: 'exprMap' })
    expect(pick(POLICY_RULES_KEY)).toEqual({ key: POLICY_RULES_KEY, kind: 'policyRules' })
  })
})

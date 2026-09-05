/**
 * 工作流定义文件解析器（`shuvix: workflow v1`）的整份拒绝矩阵 —— 契约见
 * docs/workflow-md-design.md §2.2/§2.4。
 *
 * 解析哲学与 agent/policy 同宗：结构非法**整份拒绝**（null + warn 人读原因），
 * 静默降级是本格式明令禁止的失败模式 —— 写错键名/写坏 schema 块的文件被判「部分生效」
 * 会让用户误信工作流在工作。矩阵故按「哪些形态必须整份死、哪些形态必须整份活」逐条钉死；
 * 唯一的刻意放宽（未知埋点 id 惰性化）也在此钉住，防止未来有人"顺手"把它改成拒绝。
 */
import { describe, expect, it } from 'vitest'
import { parseWorkflowDefinitionFile, type ParsedWorkflowFile } from '../workflowFile'

/** 最小合法脚本块（多数用例的正文基座） */
const SCRIPT_BLOCK = ['```js workflow', 'return 1', '```'].join('\n')

/** 组装一份 md：frontmatter 行 + 正文行（缺省正文 = 一个合法脚本块） */
const md = (fm: string[], body: string[] = [SCRIPT_BLOCK]): string =>
  ['---', ...fm, '---', '', ...body, ''].join('\n')

/** 带 marker 的 frontmatter 快捷方式 */
const fm = (...extra: string[]): string[] => ['shuvix: workflow v1', ...extra]

const parse = (
  raw: string,
  defaultName = 'wf-file'
): { parsed: ParsedWorkflowFile | null; warns: string[] } => {
  const warns: string[] = []
  const parsed = parseWorkflowDefinitionFile(raw, defaultName, (m) => warns.push(m))
  return { parsed, warns }
}

describe('parseWorkflowDefinitionFile — 基础形态与命名', () => {
  it('最小合法文件（marker + 一个脚本块）→ 全字段缺省', () => {
    const { parsed, warns } = parse(md(fm()))
    expect(warns).toEqual([])
    expect(parsed).toEqual({
      name: 'wf-file',
      displayName: 'wf-file',
      description: '',
      bindings: [],
      inputSchema: undefined,
      vars: {},
      model: undefined,
      limits: {},
      concurrency: 'skip',
      script: 'return 1',
      schemas: {},
      prompts: {}
    })
  })

  it('frontmatter name 覆盖 basename；displayName/description 生效且 trim', () => {
    const { parsed } = parse(
      md(fm('name: real-name', "shuvix-displayName: '  Disp  '", "description: '  a summary  '"))
    )
    expect(parsed?.name).toBe('real-name')
    expect(parsed?.displayName).toBe('Disp')
    expect(parsed?.description).toBe('a summary')
  })

  it('拒绝消息含 workflow 名与 "the whole file is rejected"；有 name 用 name、无 name 用 defaultName', () => {
    // 有 name 的非法文件（裸 on）：诊断以 frontmatter name 为 who
    const named = parse(md(fm('name: named-bad', 'on: []')))
    expect(named.parsed).toBeNull()
    expect(named.warns).toHaveLength(1)
    expect(named.warns[0]).toContain("workflow 'named-bad'")
    expect(named.warns[0]).toContain('the whole file is rejected')

    // 无 frontmatter：who 只能是 defaultName
    const bare = parse('just prose, no frontmatter', 'from-basename')
    expect(bare.parsed).toBeNull()
    expect(bare.warns[0]).toContain("workflow 'from-basename'")
    expect(bare.warns[0]).toContain('the whole file is rejected')
  })
})

describe('文件类型标记 —— 读取时必需（与 agent/policy 的关键差异）', () => {
  it('无 marker → null + missing file marker', () => {
    const { parsed, warns } = parse(md(['name: no-marker']))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("missing file marker 'shuvix: workflow v1'")
  })

  it('别家 marker（shuvix: agent v1）→ null（误投文件不静默生效）', () => {
    const { parsed, warns } = parse(md(['shuvix: agent v1']))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('missing file marker')
  })

  it('marker 非字符串（shuvix: true）→ null', () => {
    const { parsed, warns } = parse(md(['shuvix: true']))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('missing file marker')
  })

  it('【钉现状】版本宽容：`shuvix: workflow`（无版本）与 `workflow v2` 均接受（设计 §2.2 成文）', () => {
    expect(parse(md(['shuvix: workflow'])).parsed).not.toBeNull()
    expect(parse(md(['shuvix: workflow v2'])).parsed).not.toBeNull()
  })
})

describe('frontmatter 结构', () => {
  it('无 frontmatter 块 → no YAML frontmatter block', () => {
    const { parsed, warns } = parse(`prose only\n\n${SCRIPT_BLOCK}\n`)
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('no YAML frontmatter block')
  })

  it('空 frontmatter（--- 紧跟 ---）→ 走 marker 缺失路径拒绝', () => {
    const { parsed, warns } = parse(`---\n---\n\n${SCRIPT_BLOCK}\n`)
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('missing file marker')
  })

  it('YAML 语法错 → invalid YAML (...)', () => {
    const { parsed, warns } = parse(md(['shuvix: workflow v1', 'name: [unclosed']))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('invalid YAML (')
  })

  it('frontmatter 顶层是列表 → frontmatter must be a mapping', () => {
    const { parsed, warns } = parse(md(['- a', '- b']))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('frontmatter must be a mapping')
  })
})

describe('键集纪律', () => {
  it.each(['on', 'input', 'vars'] as const)(
    '裸键 %s → null，消息指向 shuvix-workflow-%s（纠正性引导）',
    (bare) => {
      const { parsed, warns } = parse(md(fm(`${bare}: {}`)))
      expect(parsed).toBeNull()
      expect(warns[0]).toContain(`bare '${bare}' key is not read`)
      expect(warns[0]).toContain(`shuvix-workflow-${bare}`)
    }
  )

  it('未知前缀键 shuvix-workflow-foo → null，消息列出全部合法键', () => {
    const { parsed, warns } = parse(md(fm('shuvix-workflow-foo: 1')))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("unknown key 'shuvix-workflow-foo'")
    for (const key of ['on', 'input', 'vars', 'limits', 'concurrency']) {
      expect(warns[0]).toContain(`shuvix-workflow-${key}`)
    }
  })

  it('无前缀陌生键（author: x）忽略 → 合法（给其他应用留活口）', () => {
    const { parsed, warns } = parse(md(fm('author: someone', 'tags: [a, b]')))
    expect(parsed).not.toBeNull()
    expect(warns).toEqual([])
  })

  it('shuvix-builtin: true 解析器不读、不影响结果', () => {
    const plain = parse(md(fm()))
    const marked = parse(md(fm('shuvix-builtin: true')))
    expect(marked.parsed).toEqual(plain.parsed)
    expect(marked.warns).toEqual([])
  })
})

describe('触发绑定（shuvix-workflow-on）', () => {
  it.each([
    ['非数组', 'shuvix-workflow-on: 1', 'must be a list of bindings'],
    ['条目非 mapping', ['shuvix-workflow-on:', '  - just-a-string'], 'entries must be mappings'],
    ['条目缺 trigger', ['shuvix-workflow-on:', "  - when: 'true'"], "needs a 'trigger' id"],
    ['trigger 为空串', ['shuvix-workflow-on:', "  - trigger: ''"], "needs a 'trigger' id"]
  ])('%s → null', (_label, lines, reason) => {
    const { parsed, warns } = parse(md(fm(...(Array.isArray(lines) ? lines : [lines]))))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain(reason)
  })

  it.each([
    ['非字符串', 'when: 1'],
    ['空串', "when: ''"]
  ])('when %s → null', (_label, whenLine) => {
    const { parsed, warns } = parse(
      md(fm('shuvix-workflow-on:', '  - trigger: session.prompt-accepted', `    ${whenLine}`))
    )
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("'when' must be a CEL expression string")
  })

  it('when CEL 语法错 → null，消息含 invalid when CEL 与绑定的 trigger 名', () => {
    const { parsed, warns } = parse(
      md(fm('shuvix-workflow-on:', '  - trigger: session.prompt-accepted', "    when: 'event.'"))
    )
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("binding 'session.prompt-accepted'")
    expect(warns[0]).toContain('invalid when CEL')
  })

  it('合法 when 保留且 trim；trigger/when 之外的键收进 params', () => {
    // 未知埋点才允许携带任意参数键（已知埋点走 bindingParamKeys 校验）
    const { parsed } = parse(
      md(
        fm(
          'shuvix-workflow-on:',
          '  - trigger: file.changed',
          '    when: \'  event.path == "a"  \'',
          '    debounce: 30'
        )
      )
    )
    expect(parsed?.bindings).toEqual([
      { trigger: 'file.changed', when: 'event.path == "a"', params: { debounce: 30 } }
    ])
  })

  it('已知埋点（session.prompt-accepted，无参数键）带任何额外键 → null，消息含 (this trigger takes no params)', () => {
    const { parsed, warns } = parse(
      md(fm('shuvix-workflow-on:', '  - trigger: session.prompt-accepted', '    debounce: 30'))
    )
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("unknown param 'debounce'")
    expect(warns[0]).toContain('(this trigger takes no params)')
  })

  it('未知埋点 id 不判非法：文件合法、绑定保留、warn 含 binding is inert（有意的放宽）', () => {
    const { parsed, warns } = parse(
      md(fm('name: lazy-wf', 'shuvix-workflow-on:', '  - trigger: browser.tab-opened'))
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.bindings).toEqual([
      { trigger: 'browser.tab-opened', when: undefined, params: {} }
    ])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain("workflow 'lazy-wf'")
    expect(warns[0]).toContain('binding is inert')
  })
})

describe('input / vars / model / limits / concurrency', () => {
  it('shuvix-workflow-input 非 mapping 或顶层 type≠object → null；合法 object schema 原样进 inputSchema', () => {
    const nonMapping = parse(md(fm('shuvix-workflow-input: 1')))
    expect(nonMapping.parsed).toBeNull()
    expect(nonMapping.warns[0]).toContain('top-level type: object')

    const wrongType = parse(md(fm('shuvix-workflow-input:', '  type: string')))
    expect(wrongType.parsed).toBeNull()

    const ok = parse(
      md(
        fm(
          'shuvix-workflow-input:',
          '  type: object',
          '  required: [question]',
          '  properties:',
          '    question: { type: string }'
        )
      )
    )
    expect(ok.parsed?.inputSchema).toEqual({
      type: 'object',
      required: ['question'],
      properties: { question: { type: 'string' } }
    })
  })

  it('shuvix-workflow-vars 非 mapping → null；嵌套值原样保留', () => {
    const bad = parse(md(fm('shuvix-workflow-vars: [a]')))
    expect(bad.parsed).toBeNull()
    expect(bad.warns[0]).toContain("'shuvix-workflow-vars' must be a mapping")

    const ok = parse(
      md(fm('shuvix-workflow-vars:', '  dir: reports', '  nested:', '    list: [1, 2]'))
    )
    expect(ok.parsed?.vars).toEqual({ dir: 'reports', nested: { list: [1, 2] } })
  })

  it('shuvix-workflow-model 已退役：写了它即整份非法（模型是被派发 agent 的属性）', () => {
    // 工作流不再参与选模型 —— 未知的 shuvix-workflow-* 键一律整份拒绝，
    // 比静默忽略好：用户会看见「这个键没了」，而不是以为自己钉住了模型
    const r = parse(md(fm('shuvix-workflow-model: kimi/kimi-k2')))
    expect(r.parsed).toBeNull()
    expect(r.warns[0]).toContain("unknown key 'shuvix-workflow-model'")
  })

  it.each([
    ['未知键', 'foo: 1', "unknown key 'foo'"],
    ['值为 0', 'maxAgents: 0', 'must be a positive number'],
    ['负数', 'maxAgents: -1', 'must be a positive number'],
    ['非数字', "maxAgents: 'ten'", 'must be a positive number'],
    ['NaN', 'maxAgents: .nan', 'must be a positive number'],
    ['Infinity', 'maxAgents: .inf', 'must be a positive number']
  ])('limits %s → null', (_label, line, reason) => {
    const { parsed, warns } = parse(md(fm('shuvix-workflow-limits:', `  ${line}`)))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain(reason)
  })

  it('limits 部分键合法（只写 maxAgents）→ 只合并该键；正小数按现状接受', () => {
    const one = parse(md(fm('shuvix-workflow-limits:', '  maxAgents: 5')))
    expect(one.parsed?.limits).toEqual({ maxAgents: 5 })

    const frac = parse(md(fm('shuvix-workflow-limits:', '  maxDurationSec: 0.5')))
    expect(frac.parsed?.limits).toEqual({ maxDurationSec: 0.5 })
  })

  it('concurrency 非法值 → null 且消息列出 skip | queue | parallel；合法值逐一保留；缺省 skip', () => {
    const bad = parse(md(fm('shuvix-workflow-concurrency: both')))
    expect(bad.parsed).toBeNull()
    expect(bad.warns[0]).toContain('skip | queue | parallel')

    for (const mode of ['skip', 'queue', 'parallel'] as const) {
      expect(parse(md(fm(`shuvix-workflow-concurrency: ${mode}`))).parsed?.concurrency).toBe(mode)
    }
    expect(parse(md(fm())).parsed?.concurrency).toBe('skip')
  })
})

describe('正文块提取', () => {
  it('无脚本块 → missing；两个脚本块 → multiple；脚本内容纯空白 → 按 missing 拒绝', () => {
    const none = parse(md(fm(), ['just prose']))
    expect(none.parsed).toBeNull()
    expect(none.warns[0]).toContain('missing the `js workflow` script block')

    const two = parse(md(fm(), [SCRIPT_BLOCK, '', SCRIPT_BLOCK]))
    expect(two.parsed).toBeNull()
    expect(two.warns[0]).toContain('multiple `js workflow` script blocks')

    const blank = parse(md(fm(), ['```js workflow', '   ', '```']))
    expect(blank.parsed).toBeNull()
    expect(blank.warns[0]).toContain('missing the `js workflow` script block')
  })

  it('js workflow / javascript workflow / 多空格均识别；【钉现状】大写 JS workflow 不识别', () => {
    expect(parse(md(fm(), ['```javascript workflow', 'return 2', '```'])).parsed?.script).toBe(
      'return 2'
    )
    expect(parse(md(fm(), ['```js  workflow', 'return 3', '```'])).parsed?.script).toBe('return 3')
    // 大写 info string 不被识别为脚本块 → 按缺脚本块整份拒绝
    const upper = parse(md(fm(), ['```JS workflow', 'return 4', '```']))
    expect(upper.parsed).toBeNull()
    expect(upper.warns[0]).toContain('missing the `js workflow` script block')
  })

  it('普通 ```js 块是纯文档：与真脚本块共存不干扰，script 取带完整 info string 的那个', () => {
    const { parsed, warns } = parse(
      md(fm(), ['```js', 'DOC EXAMPLE', '```', '', '```js workflow', 'REAL', '```'])
    )
    expect(warns).toEqual([])
    expect(parsed?.script).toBe('REAL')
  })

  it('schema 块：具名进 schemas；重名 / JSON 语法错 / 顶层非 object → 各整份拒绝', () => {
    const ok = parse(
      md(fm(), [
        '```json schema=verdict',
        '{ "type": "object", "required": ["ok"] }',
        '```',
        '',
        SCRIPT_BLOCK
      ])
    )
    expect(ok.parsed?.schemas).toEqual({ verdict: { type: 'object', required: ['ok'] } })

    const dup = parse(
      md(fm(), [
        '```json schema=a',
        '{ "type": "object" }',
        '```',
        '```json schema=a',
        '{ "type": "object" }',
        '```',
        SCRIPT_BLOCK
      ])
    )
    expect(dup.parsed).toBeNull()
    expect(dup.warns[0]).toContain("duplicate schema block 'a'")

    const badJson = parse(md(fm(), ['```json schema=broken', '{ nope', '```', SCRIPT_BLOCK]))
    expect(badJson.parsed).toBeNull()
    expect(badJson.warns[0]).toContain("schema block 'broken'")
    expect(badJson.warns[0]).toContain('invalid JSON')

    const nonObject = parse(
      md(fm(), ['```json schema=arr', '{ "type": "array" }', '```', SCRIPT_BLOCK])
    )
    expect(nonObject.parsed).toBeNull()
    expect(nonObject.warns[0]).toContain('top-level type: object')
  })

  it.each(['json schema=1bad', 'json schema =x', 'json schema'])(
    '`json schema` 形状但整体不合规（%s）→ 整份拒绝，消息含 expected `json schema=<name>`（裁决增补 1）',
    (info) => {
      const { parsed, warns } = parse(
        md(fm(), [`\`\`\`${info}`, '{ "type": "object" }', '```', '', SCRIPT_BLOCK])
      )
      expect(parsed).toBeNull()
      expect(warns[0]).toContain('expected `json schema=<name>`')
    }
  )

  it('四反引号外层围栏包住的 ```js workflow 示例不被当作脚本块', () => {
    const { parsed, warns } = parse(
      md(fm(), [
        'A doc example:',
        '',
        '````markdown',
        '```js workflow',
        'INNER EXAMPLE',
        '```',
        '````',
        '',
        '```js workflow',
        'OUTER REAL',
        '```'
      ])
    )
    expect(warns).toEqual([])
    expect(parsed?.script).toBe('OUTER REAL')
  })

  it('未闭合围栏按 CommonMark 延伸到文件尾', () => {
    const { parsed } = parse(
      ['---', ...fm(), '---', '', '```js workflow', 'line1', 'line2'].join('\n')
    )
    expect(parsed?.script).toBe('line1\nline2')
  })

  it('CRLF 文件（frontmatter 与围栏均 \\r\\n）→ 正常解析', () => {
    const raw = [
      '---',
      'shuvix: workflow v1',
      'name: crlf-wf',
      '---',
      '',
      '```js workflow',
      'return 1',
      '```',
      ''
    ].join('\r\n')
    const { parsed, warns } = parse(raw)
    expect(warns).toEqual([])
    expect(parsed?.name).toBe('crlf-wf')
    expect(parsed?.script).toBe('return 1')
  })
})

describe('绑定的分道键（key）—— 与 trigger/when 同为保留字段', () => {
  const withKey = (...lines: string[]): ReturnType<typeof parse> =>
    parse(md(fm('shuvix-workflow-on:', '  - trigger: session.prompt-accepted', ...lines)))

  it('合法 key 保留且 trim，且不进 params', () => {
    const { parsed, warns } = withKey("    key: '  event.sessionId  '")
    expect(warns).toEqual([])
    expect(parsed?.bindings).toEqual([
      {
        trigger: 'session.prompt-accepted',
        when: undefined,
        key: 'event.sessionId',
        params: {}
      }
    ])
  })

  it.each([
    ['非字符串', 'key: 1'],
    ['空串', "key: ''"]
  ])('key %s → 整份非法（键集纪律）', (_label, line) => {
    const { parsed, warns } = withKey(`    ${line}`)
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("'key' must be a CEL expression string")
  })

  it('key CEL 语法错 → 整份非法（语法错不留到运行期），消息含 invalid key CEL 与 trigger 名', () => {
    const { parsed, warns } = withKey("    key: 'event.'")
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("binding 'session.prompt-accepted'")
    expect(warns[0]).toContain('invalid key CEL')
  })

  it('已知埋点（bindingParamKeys 为空）带 key 不算未知参数', () => {
    // 回归守卫：params 收集循环必须跳过 trigger/when/key 三个保留键
    const { parsed, warns } = withKey('    key: "\'shared\'"')
    expect(warns).toEqual([])
    expect(parsed?.bindings[0].key).toBe("'shared'")
    expect(parsed?.bindings[0].params).toEqual({})
  })

  it('未知埋点 + key → 绑定惰性化但 key 保留（两条放宽规则叠加）', () => {
    const { parsed, warns } = parse(
      md(
        fm(
          'name: lazy-key-wf',
          'shuvix-workflow-on:',
          '  - trigger: browser.tab-opened',
          '    key: event.tabId'
        )
      )
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.bindings[0].key).toBe('event.tabId')
    expect(warns.some((w) => w.includes('binding is inert'))).toBe(true)
  })
})

describe('提示词块（```md prompt=<name>）', () => {
  it.each(['md', 'markdown'])('`%s prompt=x` 收进 prompts，内容为原文（不 trim）', (lang) => {
    const { parsed, warns } = parse(
      md(fm(), [
        `\`\`\`${lang} prompt=greeting`,
        'Hello {{name}}.',
        '',
        '  indented line',
        '```',
        '',
        SCRIPT_BLOCK
      ])
    )
    expect(warns).toEqual([])
    // 提示词是文案 —— 内部空行与缩进逐字保留
    expect(parsed?.prompts).toEqual({ greeting: 'Hello {{name}}.\n\n  indented line' })
  })

  it('重名 prompt 块 → 整份非法（同 schema 块纪律）', () => {
    const { parsed, warns } = parse(
      md(fm(), ['```md prompt=x', 'A', '```', '```md prompt=x', 'B', '```', SCRIPT_BLOCK])
    )
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("duplicate prompt block 'x'")
  })

  it.each(['md prompt', 'md prompt=1bad', 'md prompt =x', 'md prompt=x extra'])(
    '`md prompt` 形状但不合规（%s）→ 整份非法（静默当散文会让 prompt() 抛）',
    (info) => {
      const { parsed, warns } = parse(md(fm(), [`\`\`\`${info}`, 'BODY', '```', '', SCRIPT_BLOCK]))
      expect(parsed).toBeNull()
      expect(warns[0]).toContain('expected `md prompt=<name>`')
    }
  )

  it('【钉现状】大写 `MD prompt=x` 不识别 → 当散文，文件合法（与 `JS workflow` 同一口径）', () => {
    const { parsed, warns } = parse(md(fm(), ['```MD prompt=x', 'BODY', '```', '', SCRIPT_BLOCK]))
    expect(warns).toEqual([])
    expect(parsed).not.toBeNull()
    expect(parsed?.prompts).toEqual({})
  })

  it('prompt 名与 schema 名同名可共存（两张表互不覆盖）', () => {
    const { parsed } = parse(
      md(fm(), [
        '```json schema=a',
        '{ "type": "object" }',
        '```',
        '```md prompt=a',
        'PROMPT-A',
        '```',
        SCRIPT_BLOCK
      ])
    )
    expect(parsed?.schemas.a).toEqual({ type: 'object' })
    expect(parsed?.prompts.a).toBe('PROMPT-A')
  })

  it('【钉现状】空 prompt 块 → prompts.x === ""，文件合法（与脚本块「纯空白即拒绝」不同口径）', () => {
    const { parsed, warns } = parse(md(fm(), ['```md prompt=x', '```', '', SCRIPT_BLOCK]))
    expect(warns).toEqual([])
    expect(parsed?.prompts).toEqual({ x: '' })
  })

  it('普通 ```md 块是散文：只认带 prompt= 的 info string', () => {
    const { parsed, warns } = parse(md(fm(), ['```md', 'DOC', '```', '', SCRIPT_BLOCK]))
    expect(warns).toEqual([])
    expect(parsed?.prompts).toEqual({})
  })
})

/**
 * prompt 块之间的 `{{>name}}` 引用在解析期校验（checkPromptIncludes）：指向不存在的块、
 * 或引用成环 → 整份拒绝。与 schema 块同一条纪律 —— 渲染期静默成空会让 prompt() 悄悄
 * 少一段，而模型只会「答得不太对」。成环报的是整条环路（从第一次重复的名字截起），
 * 读到就知道该断哪一条；DAG 的汇合点（done 态）不得误判成环。
 */
describe('提示词块引用校验（{{>name}}）', () => {
  const promptBlock = (name: string, ...lines: string[]): string[] => [
    `\`\`\`md prompt=${name}`,
    ...lines,
    '```'
  ]
  /** 若干 prompt 块 + 缺省脚本块 */
  const withPrompts = (...blocks: string[][]): ReturnType<typeof parse> =>
    parse(md(fm(), [...blocks.flat(), '', SCRIPT_BLOCK]))

  it('WF-1 引用不存在的块 → 整份拒绝：点名引用者与被引用名，提示补一个 md prompt=<name> 块', () => {
    const { parsed, warns } = withPrompts(promptBlock('gate', '## Others', '{{>others}}'))
    expect(parsed).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain("prompt block 'gate' includes unknown prompt block 'others'")
    expect(warns[0]).toContain('md prompt=others')
    expect(warns[0]).toContain('the whole file is rejected')
  })

  it('WF-2 自引 a→a → 整份拒绝，消息报 cycle: a -> a', () => {
    const { parsed, warns } = withPrompts(promptBlock('a', 'A', '{{>a}}'))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('cycle: a -> a')
  })

  it('WF-3 双环 a→b→a → cycle: a -> b -> a', () => {
    const { parsed, warns } = withPrompts(promptBlock('a', '{{>b}}'), promptBlock('b', '{{>a}}'))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('cycle: a -> b -> a')
  })

  it('WF-4 尾环 a→b→c→b → 只报环本身 b -> c -> b，不以 a 起头', () => {
    const { parsed, warns } = withPrompts(
      promptBlock('a', '{{>b}}'),
      promptBlock('b', '{{>c}}'),
      promptBlock('c', '{{>b}}')
    )
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('cycle: b -> c -> b')
    expect(warns[0]).not.toContain('a -> b')
  })

  it('WF-5 菱形 DAG（a→b, a→c, b→d, c→d）与三层链合法：汇合点不误判成环，prompts 各块齐全', () => {
    const diamond = withPrompts(
      promptBlock('a', '{{>b}}', '{{>c}}'),
      promptBlock('b', '{{>d}}'),
      promptBlock('c', '{{>d}}'),
      promptBlock('d', 'leaf {{x}}')
    )
    expect(diamond.warns).toEqual([])
    expect(diamond.parsed?.prompts).toEqual({
      a: '{{>b}}\n{{>c}}',
      b: '{{>d}}',
      c: '{{>d}}',
      d: 'leaf {{x}}'
    })

    const chain = withPrompts(
      promptBlock('a', '{{>b}}'),
      promptBlock('b', '{{>c}}'),
      promptBlock('c', 'leaf')
    )
    expect(chain.warns).toEqual([])
    expect(Object.keys(chain.parsed?.prompts ?? {})).toEqual(['a', 'b', 'c'])
  })

  it('WF-6 `{{ > b }}` 空白变体算引用（b 缺 → 拒绝）；`{{>b.c}}` / `{{>bad name}}` 不算（文件合法、原文保留）', () => {
    const spaced = withPrompts(promptBlock('a', '{{ > b }}'))
    expect(spaced.parsed).toBeNull()
    expect(spaced.warns[0]).toContain("prompt block 'a' includes unknown prompt block 'b'")

    const notRefs = withPrompts(promptBlock('a', '{{>b.c}}', '{{>bad name}}'))
    expect(notRefs.warns).toEqual([])
    expect(notRefs.parsed?.prompts).toEqual({ a: '{{>b.c}}\n{{>bad name}}' })
  })

  it('WF-7 普通 ```md 文档块 / schema 块里的 {{>ghost}} 不参与校验（只有 prompt 块之间才算引用）', () => {
    const { parsed, warns } = parse(
      md(fm(), [
        '```md',
        'Doc example: {{>ghost}}',
        '```',
        '',
        '```json schema=verdict',
        '{ "type": "object", "description": "{{>ghost}}" }',
        '```',
        '',
        SCRIPT_BLOCK
      ])
    )
    expect(warns).toEqual([])
    expect(parsed).not.toBeNull()
    expect(parsed?.prompts).toEqual({})
    expect(parsed?.schemas.verdict).toEqual({ type: 'object', description: '{{>ghost}}' })
  })

  it('WF-8 报错顺序：未知引用先于成环（a→ghost 且 a→b→a → 报 ghost）；脚本块缺失先于引用', () => {
    const both = withPrompts(promptBlock('a', '{{>ghost}}', '{{>b}}'), promptBlock('b', '{{>a}}'))
    expect(both.parsed).toBeNull()
    expect(both.warns[0]).toContain("includes unknown prompt block 'ghost'")
    expect(both.warns[0]).not.toContain('cycle')

    const noScript = parse(md(fm(), promptBlock('a', '{{>ghost}}')))
    expect(noScript.parsed).toBeNull()
    expect(noScript.warns[0]).toContain('missing the `js workflow` script block')
    expect(noScript.warns[0]).not.toContain('unknown prompt block')
  })
})

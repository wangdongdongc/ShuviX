/**
 * Hook 定义文件解析器（`shuvix: hook v1`）的整份拒绝矩阵 —— 契约见 .claude/skills/shuvix-hooks。
 *
 * 解析哲学与 agent/policy/workflow md 同宗：结构非法**整份拒绝**（null + warn 人读原因），
 * 静默降级是本格式明令禁止的失败模式。矩阵按「哪些形态必须整份死、哪些形态必须整份活」逐条钉死；
 * 唯一的刻意放宽（未知埋点 id 惰性化 + warn）也在此钉住，防止未来有人"顺手"把它改成拒绝。
 */
import { describe, expect, it } from 'vitest'
import { parseHookDefinitionFile, type ParsedHookFile } from '../hookFile'
import { BASE_PROFILE_NAMES } from '../../subagent/builtinAgents'

/** 组装一份 md：frontmatter 行 + 正文行（缺省正文 = 一句任务文本） */
const md = (fm: string[], body: string[] = ['Do it.']): string =>
  ['---', ...fm, '---', '', ...body, ''].join('\n')

/** 带 marker 的 frontmatter 快捷方式 */
const fm = (...extra: string[]): string[] => ['shuvix: hook v1', ...extra]

/** 最小合法 frontmatter（marker + agent + 一条绑定） */
const VALID = fm(
  'shuvix-hook-agent: titler',
  'shuvix-hook-on:',
  '  - trigger: session.prompt-accepted'
)

/** 在最小合法 frontmatter 之上追加键 */
const valid = (...extra: string[]): string[] => [...VALID, ...extra]

const parse = (
  raw: string,
  defaultName = 'hook-file'
): { parsed: ParsedHookFile | null; warns: string[] } => {
  const warns: string[] = []
  const parsed = parseHookDefinitionFile(raw, defaultName, (m) => warns.push(m))
  return { parsed, warns }
}

/** HF-1 的期望输出（HF-7 的「陌生键忽略」要与它逐字相同） */
const MINIMAL: ParsedHookFile = {
  name: 'hook-file',
  displayName: 'hook-file',
  description: '',
  agent: 'titler',
  bindings: [{ trigger: 'session.prompt-accepted' }],
  prompt: 'Do it.'
}

describe('parseHookDefinitionFile — 基础形态与命名', () => {
  it('HF-1 最小合法文件 → 全字段缺省，绑定没有 when 键', () => {
    const { parsed, warns } = parse(md(VALID))
    expect(warns).toEqual([])
    expect(parsed).toStrictEqual(MINIMAL)
    expect('when' in parsed!.bindings[0]).toBe(false)
  })

  it('HF-2 name 覆盖 basename；displayName / description trim；空白或非字符串 name 回落 defaultName', () => {
    const named = parse(md(valid('name: real')))
    expect(named.parsed?.name).toBe('real')
    expect(named.parsed?.displayName).toBe('real')

    const decorated = parse(md(valid("shuvix-displayName: '  Disp  '", "description: '  d  '")))
    expect(decorated.parsed?.displayName).toBe('Disp')
    expect(decorated.parsed?.description).toBe('d')

    const blank = parse(md(valid("name: '   '")))
    expect(blank.warns).toEqual([])
    expect(blank.parsed?.name).toBe('hook-file')
    const numeric = parse(md(valid('name: 123')))
    expect(numeric.warns).toEqual([])
    expect(numeric.parsed?.name).toBe('hook-file')
  })

  it("HF-3 拒绝恒为一条 `hook '<who>': <why>; the whole file is rejected`；who 优先取 frontmatter name；无 warn 回调也不抛", () => {
    const named = parse(
      md(fm('name: x', 'shuvix-hook-on:', '  - trigger: session.prompt-accepted'))
    )
    expect(named.parsed).toBeNull()
    expect(named.warns).toHaveLength(1)
    expect(named.warns[0].startsWith("hook 'x': missing 'shuvix-hook-agent'")).toBe(true)
    expect(named.warns[0].endsWith('; the whole file is rejected')).toBe(true)

    // name 之前就失败（无 frontmatter）：who 只能是 defaultName
    const bare = parse('just prose, no frontmatter', 'from-basename')
    expect(bare.parsed).toBeNull()
    expect(bare.warns).toEqual([
      "hook 'from-basename': no YAML frontmatter block; the whole file is rejected"
    ])

    // 每一种拒绝都恰一条、同一形态
    const rejects = [
      md(fm()),
      md(['name: y']),
      md(valid('on: []')),
      md(valid('shuvix-hook-model: x')),
      md(fm('shuvix-hook-agent: work', 'shuvix-hook-on:', '  - trigger: session.prompt-accepted')),
      md(valid("    when: 'event.'"))
    ]
    for (const raw of rejects) {
      const { parsed, warns } = parse(raw)
      expect(parsed).toBeNull()
      expect(warns).toHaveLength(1)
      expect(warns[0]).toMatch(/^hook '[^']+': [\s\S]+; the whole file is rejected$/)
    }

    expect(() => parseHookDefinitionFile(md(fm()), 'silent')).not.toThrow()
    expect(parseHookDefinitionFile(md(fm()), 'silent')).toBeNull()
  })
})

describe('文件类型标记 —— 读取时必需，版本宽容', () => {
  it.each(['hook v1', 'hook', 'hook v2', 'hook   v12', "' hook v1 '"])(
    'HF-4 接受 `shuvix: %s`',
    (marker) => {
      const { parsed, warns } = parse(md([`shuvix: ${marker}`, ...VALID.slice(1)]))
      expect(warns).toEqual([])
      expect(parsed).not.toBeNull()
    }
  )

  it.each([
    'agent v1',
    'workflow v1',
    'bot v2',
    'Hook v1',
    'hookv1',
    'hook v1.1',
    'hook v',
    'true',
    '1',
    '[hook v1]'
  ])('HF-4 拒绝 `shuvix: %s` → missing file marker', (marker) => {
    const { parsed, warns } = parse(md([`shuvix: ${marker}`, ...VALID.slice(1)]))
    expect(parsed).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain("missing file marker 'shuvix: hook v1'")
  })

  it('HF-4 marker 缺失 → missing file marker', () => {
    const { parsed, warns } = parse(md(VALID.slice(1)))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("missing file marker 'shuvix: hook v1'")
  })
})

describe('frontmatter 结构', () => {
  it('HF-5 无 --- 块 → no YAML frontmatter block', () => {
    const { parsed, warns } = parse('Do it.\n')
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('no YAML frontmatter block')
  })

  it('HF-5 空 frontmatter（--- 紧跟 ---）→ 走 marker 缺失路径', () => {
    const { parsed, warns } = parse('---\n---\n\nDo it.\n')
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('missing file marker')
  })

  it('HF-5 YAML 语法错 → invalid YAML (…)', () => {
    const { parsed, warns } = parse(md(fm('name: [unclosed')))
    expect(parsed).toBeNull()
    expect(warns[0].startsWith("hook 'hook-file': invalid YAML (")).toBe(true)
  })

  it('HF-5 顶层是列表 / 标量 → frontmatter must be a mapping', () => {
    const list = parse(md(['- a', '- b']))
    expect(list.parsed).toBeNull()
    expect(list.warns[0]).toContain('frontmatter must be a mapping')

    const scalar = parse(md(['just a string']))
    expect(scalar.parsed).toBeNull()
    expect(scalar.warns[0]).toContain('frontmatter must be a mapping')
  })

  it('HF-5 第一条 --- 之前有文字 → 不算 frontmatter 块', () => {
    const { parsed, warns } = parse(`prose first\n${md(VALID)}`)
    expect(parsed).toBeNull()
    expect(warns[0]).toContain('no YAML frontmatter block')
  })

  it('HF-5 BOM + 前导空行容忍；CRLF 可解析且正文 trim', () => {
    const bom = parse(`\uFEFF\n\n${md(VALID)}`)
    expect(bom.warns).toEqual([])
    expect(bom.parsed).toStrictEqual(MINIMAL)

    const crlf = parse(md(VALID).replace(/\n/g, '\r\n'))
    expect(crlf.warns).toEqual([])
    expect(crlf.parsed).toStrictEqual(MINIMAL)
  })
})

describe('键集纪律', () => {
  it("HF-6 裸 on → bare 'on' key is not read — use 'shuvix-hook-on'（哪怕前缀键同时合法）", () => {
    const alone = parse(
      md(fm('shuvix-hook-agent: titler', 'on:', '  - trigger: session.prompt-accepted'))
    )
    expect(alone.parsed).toBeNull()
    expect(alone.warns[0]).toContain("bare 'on' key is not read — use 'shuvix-hook-on'")

    const both = parse(md(valid('on:', '  - trigger: session.prompt-accepted')))
    expect(both.parsed).toBeNull()
    expect(both.warns[0]).toContain("bare 'on' key is not read — use 'shuvix-hook-on'")

    const nullish = parse(md(valid('on:')))
    expect(nullish.parsed).toBeNull()
    expect(nullish.warns[0]).toContain("bare 'on' key is not read")
  })

  it("HF-6 裸 agent → bare 'agent' key is not read — use 'shuvix-hook-agent'", () => {
    const { parsed, warns } = parse(md(valid('agent: titler')))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("bare 'agent' key is not read — use 'shuvix-hook-agent'")
  })

  it.each(['shuvix-hook-model', 'shuvix-hook-timeout', 'shuvix-hook-concurrency', 'shuvix-hook-'])(
    'HF-7 未知前缀键 %s → unknown key（消息列出全部合法键）',
    (key) => {
      const { parsed, warns } = parse(md(valid(`${key}: x`)))
      expect(parsed).toBeNull()
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain(
        `unknown key '${key}' (allowed: shuvix-hook-on, shuvix-hook-agent)`
      )
    }
  )

  it('HF-7 无前缀陌生键忽略 → 输出与最小合法文件逐字相同', () => {
    const { parsed, warns } = parse(
      md(
        valid(
          'author: someone',
          'shuvix-tools: [read, grep]',
          'shuvix-model: gpt-4o',
          'shuvix-builtin: true'
        )
      )
    )
    expect(warns).toEqual([])
    expect(parsed).toStrictEqual(MINIMAL)
  })

  it('HF-8 检查次序：marker → 裸键 → 未知前缀键 → agent → on', () => {
    // 无 marker + 裸 on → marker 消息
    const noMarker = parse(md(['on: []', 'shuvix-hook-agent: titler']))
    expect(noMarker.warns[0]).toContain('missing file marker')

    // 裸 on + 未知前缀键 → 裸键消息
    const bareAndUnknown = parse(md(valid('on: []', 'shuvix-hook-model: x')))
    expect(bareAndUnknown.warns[0]).toContain("bare 'on' key")

    // agent 与 on 同时缺失 → agent 消息
    const bothMissing = parse(md(fm()))
    expect(bothMissing.warns[0]).toContain("missing 'shuvix-hook-agent'")

    // 未知前缀键 + 基座 agent → 未知键消息（键集先于 agent 校验）
    const unknownAndBase = parse(
      md(
        fm(
          'shuvix-hook-agent: work',
          'shuvix-hook-model: x',
          'shuvix-hook-on:',
          '  - trigger: session.prompt-accepted'
        )
      )
    )
    expect(unknownAndBase.warns[0]).toContain("unknown key 'shuvix-hook-model'")
  })
})

describe('shuvix-hook-agent', () => {
  const withAgent = (line?: string): string =>
    md(
      fm(
        ...(line === undefined ? [] : [line]),
        'shuvix-hook-on:',
        '  - trigger: session.prompt-accepted'
      )
    )

  it("HF-9 缺失 / ~ → missing 'shuvix-hook-agent'", () => {
    for (const raw of [withAgent(), withAgent('shuvix-hook-agent: ~')]) {
      const { parsed, warns } = parse(raw)
      expect(parsed).toBeNull()
      expect(warns[0]).toContain("missing 'shuvix-hook-agent'")
    }
  })

  it.each(["''", "'   '", '123', '[titler]', '{name: titler}'])(
    'HF-9 `shuvix-hook-agent: %s` → must be a non-empty agent name',
    (value) => {
      const { parsed, warns } = parse(withAgent(`shuvix-hook-agent: ${value}`))
      expect(parsed).toBeNull()
      expect(warns[0]).toContain("'shuvix-hook-agent' must be a non-empty agent name")
    }
  )

  it('HF-9 名字 trim；未知但形态合法的名字与 explore / knowledge-writer 都接受（存在与否派发时才解析）', () => {
    expect(parse(withAgent("shuvix-hook-agent: ' titler '")).parsed?.agent).toBe('titler')
    for (const name of ['ghost-agent', 'explore', 'knowledge-writer']) {
      const { parsed, warns } = parse(withAgent(`shuvix-hook-agent: ${name}`))
      expect(warns).toEqual([])
      expect(parsed?.agent).toBe(name)
    }
  })

  it('HF-10 六个基座档案不可点名（trim 后判定，大小写敏感）', () => {
    expect([...BASE_PROFILE_NAMES].sort()).toEqual([
      'bot',
      'chat',
      'coedit',
      'notebook',
      'tab',
      'work'
    ])
    for (const base of BASE_PROFILE_NAMES) {
      const { parsed, warns } = parse(withAgent(`shuvix-hook-agent: ${base}`))
      expect(parsed).toBeNull()
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('names a session base profile')
      expect(warns[0]).toContain(base)
    }
    expect(parse(withAgent("shuvix-hook-agent: ' work '")).parsed).toBeNull()
    expect(parse(withAgent('shuvix-hook-agent: Work')).parsed?.agent).toBe('Work')
  })
})

describe('shuvix-hook-on — 绑定容器与条目', () => {
  const withOn = (...lines: string[]): string => md(fm('shuvix-hook-agent: titler', ...lines))

  it("HF-11 缺失 / ~ → missing 'shuvix-hook-on'", () => {
    for (const raw of [withOn(), withOn('shuvix-hook-on: ~')]) {
      const { parsed, warns } = parse(raw)
      expect(parsed).toBeNull()
      expect(warns[0]).toContain("missing 'shuvix-hook-on'")
    }
  })

  it('HF-11 空列表 / 映射 / 字符串 → must be a non-empty list of bindings', () => {
    const shapes = [
      withOn('shuvix-hook-on: []'),
      withOn('shuvix-hook-on:', '  trigger: session.prompt-accepted'),
      withOn('shuvix-hook-on: session.prompt-accepted')
    ]
    for (const raw of shapes) {
      const { parsed, warns } = parse(raw)
      expect(parsed).toBeNull()
      expect(warns[0]).toContain("'shuvix-hook-on' must be a non-empty list of bindings")
    }
  })

  it('HF-12 字符串条目 → entries must be mappings', () => {
    const { parsed, warns } = parse(withOn('shuvix-hook-on:', '  - session.prompt-accepted'))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("'shuvix-hook-on' entries must be mappings")
  })

  it.each(['{}', 'trigger:', "trigger: ''", 'trigger: 123'])(
    "HF-12 条目 `- %s` → needs a 'trigger' id",
    (entry) => {
      const { parsed, warns } = parse(withOn('shuvix-hook-on:', `  - ${entry}`))
      expect(parsed).toBeNull()
      expect(warns[0]).toContain("each 'shuvix-hook-on' entry needs a 'trigger' id")
    }
  )

  it.each(['params', 'key', 'agent', 'on'])(
    "HF-12 绑定里的多余键 %s → binding '<trigger>': unknown key",
    (key) => {
      const { parsed, warns } = parse(
        withOn('shuvix-hook-on:', '  - trigger: session.prompt-accepted', `    ${key}: x`)
      )
      expect(parsed).toBeNull()
      expect(warns[0]).toContain(`binding 'session.prompt-accepted': unknown key '${key}'`)
    }
  )

  it('HF-12 缺 trigger + 多余键 → trigger 消息优先；trigger trim', () => {
    const { parsed, warns } = parse(withOn('shuvix-hook-on:', '  - params: x'))
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("needs a 'trigger' id")

    const trimmed = parse(withOn('shuvix-hook-on:', "  - trigger: '  session.prompt-accepted  '"))
    expect(trimmed.warns).toEqual([])
    expect(trimmed.parsed?.bindings).toStrictEqual([{ trigger: 'session.prompt-accepted' }])
  })

  it('HF-16 同一埋点的两条绑定都保留', () => {
    const { parsed, warns } = parse(
      withOn(
        'shuvix-hook-on:',
        '  - trigger: session.prompt-accepted',
        '    when: event.isDefaultTitle',
        '  - trigger: session.prompt-accepted',
        '    when: event.profileName == "work"'
      )
    )
    expect(warns).toEqual([])
    expect(parsed?.bindings).toStrictEqual([
      { trigger: 'session.prompt-accepted', when: 'event.isDefaultTitle' },
      { trigger: 'session.prompt-accepted', when: 'event.profileName == "work"' }
    ])
  })
})

describe('shuvix-hook-on — when（CEL）', () => {
  const withWhen = (line?: string, trigger = 'session.prompt-accepted'): string =>
    md(
      fm(
        'shuvix-hook-agent: titler',
        'shuvix-hook-on:',
        `  - trigger: ${trigger}`,
        ...(line === undefined ? [] : [`    ${line}`])
      )
    )

  it('HF-13 省略 → 绑定只有 trigger；字符串 trim', () => {
    expect(parse(withWhen()).parsed?.bindings).toStrictEqual([
      { trigger: 'session.prompt-accepted' }
    ])
    expect(parse(withWhen("when: '  event.isDefaultTitle  '")).parsed?.bindings).toStrictEqual([
      { trigger: 'session.prompt-accepted', when: 'event.isDefaultTitle' }
    ])
  })

  it.each(['true', '1', "''", "'  '", '[a]'])(
    "HF-13 `when: %s` → 'when' must be a CEL expression string",
    (value) => {
      const { parsed, warns } = parse(withWhen(`when: ${value}`))
      expect(parsed).toBeNull()
      expect(warns[0]).toContain(
        "binding 'session.prompt-accepted': 'when' must be a CEL expression string"
      )
    }
  )

  it('HF-13 `when: ~` / `when:`（YAML null）= 没写条件，与省略同义', () => {
    for (const line of ['when: ~', 'when:']) {
      const { parsed, warns } = parse(withWhen(line))
      expect(warns).toEqual([])
      expect(parsed?.bindings).toStrictEqual([{ trigger: 'session.prompt-accepted' }])
    }
  })

  it('HF-13 CEL 语法错 → invalid when CEL —（带引擎原话）；=== 不是 CEL', () => {
    const dangling = parse(withWhen("when: 'event.'"))
    expect(dangling.parsed).toBeNull()
    expect(dangling.warns).toHaveLength(1)
    expect(dangling.warns[0]).toContain("binding 'session.prompt-accepted': invalid when CEL —")
    expect(dangling.warns[0]).toContain('Expected IDENTIFIER')

    const tripleEq = parse(withWhen("when: 'event.a === 1'"))
    expect(tripleEq.parsed).toBeNull()
    expect(tripleEq.warns[0]).toContain('invalid when CEL')
  })

  it('HF-13 两条绑定时消息点名出错的那条 trigger；未知变量在解析期放行（vars.a == 1）', () => {
    const { parsed, warns } = parse(
      md(
        fm(
          'shuvix-hook-agent: titler',
          'shuvix-hook-on:',
          '  - trigger: session.prompt-accepted',
          '    when: event.isDefaultTitle',
          '  - trigger: session.turn-completed',
          "    when: 'event.'"
        )
      )
    )
    expect(parsed).toBeNull()
    expect(warns[0]).toContain("binding 'session.turn-completed': invalid when CEL")

    const lateBound = parse(withWhen("when: 'vars.a == 1'"))
    expect(lateBound.warns).toEqual([])
    expect(lateBound.parsed?.bindings[0].when).toBe('vars.a == 1')
  })
})

describe('未知埋点 id —— 惰性绑定 + warn（刻意不拒绝）', () => {
  it('HF-14 未知 trigger（带合法 when）→ 非 null、绑定保留、恰一条 inert warn', () => {
    const { parsed, warns } = parse(
      md(
        fm(
          'shuvix-hook-agent: titler',
          'shuvix-hook-on:',
          '  - trigger: file.changed',
          '    when: event.isDefaultTitle'
        )
      )
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.bindings).toStrictEqual([
      { trigger: 'file.changed', when: 'event.isDefaultTitle' }
    ])
    expect(warns).toEqual([
      "hook 'hook-file': trigger 'file.changed' is not known on this build — binding is inert"
    ])
  })

  it('HF-14 两条未知 → 两条 warn；已知与未知混合按原序保留', () => {
    const { parsed, warns } = parse(
      md(
        fm(
          'shuvix-hook-agent: titler',
          'shuvix-hook-on:',
          '  - trigger: file.changed',
          '  - trigger: session.prompt-accepted',
          '  - trigger: app.started'
        )
      )
    )
    expect(parsed?.bindings.map((b) => b.trigger)).toEqual([
      'file.changed',
      'session.prompt-accepted',
      'app.started'
    ])
    expect(warns).toEqual([
      "hook 'hook-file': trigger 'file.changed' is not known on this build — binding is inert",
      "hook 'hook-file': trigger 'app.started' is not known on this build — binding is inert"
    ])
  })

  it('HF-14 未知 trigger + 坏 when → CEL 拒绝，没有 inert warn（when 先于埋点检查）', () => {
    const { parsed, warns } = parse(
      md(
        fm(
          'shuvix-hook-agent: titler',
          'shuvix-hook-on:',
          '  - trigger: file.changed',
          "    when: 'event.'"
        )
      )
    )
    expect(parsed).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain("binding 'file.changed': invalid when CEL")
  })
})

describe('正文 → prompt', () => {
  it('HF-15 外层空行 trim，内部空行与缩进保留', () => {
    const { parsed } = parse(md(VALID, ['', '', 'Line 1', '', '  indented', '', '']))
    expect(parsed?.prompt).toBe('Line 1\n\n  indented')
  })

  it('HF-15 正文为空 / 纯空白 → prompt 为空串（事件本身就是任务）', () => {
    expect(parse(md(VALID, [])).parsed?.prompt).toBe('')
    expect(parse(md(VALID, ['   ', '', '\t'])).parsed?.prompt).toBe('')
  })

  it('HF-15 正文中段的 --- 行保留（不被当第二个 frontmatter）', () => {
    const { parsed } = parse(md(VALID, ['Line 1', '---', 'Line 2']))
    expect(parsed?.prompt).toBe('Line 1\n---\nLine 2')
  })

  it('HF-15 围栏代码块与 {{占位符}} 原样保留（没有模板语法）', () => {
    const body = ['Use `{{event.promptText}}` verbatim.', '', '```js', 'return 1', '```']
    const { parsed } = parse(md(VALID, body))
    expect(parsed?.prompt).toBe(body.join('\n'))
  })
})

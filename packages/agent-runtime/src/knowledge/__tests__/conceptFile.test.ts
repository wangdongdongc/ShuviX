/**
 * conceptFile —— 一个 .md = 一个 concept 的解析与组装。
 *
 * 唯一会返回 null 的情况是「这不是一份 OKF 概念」（没有 frontmatter 映射 / type 缺失或非空串 /
 * 带 shuvix 标记）；其余字段形状不符一律取缺省并经 warn 报告 —— 用户要在 Obsidian 里改的文件，
 * 解析失败不能让它从视图里消失。组装侧钉键序与归一化：写出去的每一份都长一样。
 *
 * 笔记读法（readKnowledgeNote，读宽）：库里任何 md 都读得出一条笔记、永不返回 null —— 标题依次取
 * frontmatter title → 正文第一个 `#` 一级标题（跳过代码围栏）→ 文件名；合规的才另挂 concept，
 * 不合规的只带读得出的字段，也不为它发 warn。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildConceptText,
  firstHeading,
  headingsOf,
  isOkfConceptText,
  isVerificationCurrent,
  normalizeKnowledgeType,
  normalizeSources,
  normalizeVerified,
  parseConceptText,
  readKnowledgeNote,
  type BodyHeading
} from '../conceptFile'
import { parseOkfText } from '../okfCodec'

const doc = (frontmatter: string[], body = 'body'): string =>
  ['---', ...frontmatter, '---', '', body].join('\n')

describe('parseConceptText / isOkfConceptText — 「不是概念」的判定表', () => {
  it('CF-1 无 frontmatter / type 缺失 / 空串 / 列表 / 数字 / 带 shuvix 标记 → null；只有 type: Memory 才是概念', () => {
    const notConcepts = [
      '# plain\n\nbody',
      doc(['title: x']),
      doc(["type: ''"]),
      doc(['type: [a]']),
      doc(['type: 5']),
      // 别家契约文件（agent / policy / hook / bot / 旧记忆）即便带 type 也不是 OKF 概念
      doc(['shuvix: memory v1', 'type: Memory'])
    ]
    for (const text of notConcepts) {
      expect(parseConceptText(text, 'global/x.md'), text).toBeNull()
      expect(isOkfConceptText(text), text).toBe(false)
    }
    expect(parseConceptText(doc(['type: Memory']), 'global/x.md')).not.toBeNull()
    expect(isOkfConceptText(doc(['type: Memory']))).toBe(true)
  })

  /**
   * 自述行是**自述**不是准入：带 `shuvix: okf v…` 的照常是概念（我们自己写的就带它），
   * 不带任何标记的也照常是概念（Obsidian / 社区工具 / 用户手写的条目不该因为少一行而消失）。
   * 判别只看类型段不看版本 —— 将来 OKF 升版，老条目仍要读得出来。
   */
  it('CF-1 okf 自述行不影响判定：带 v0.2 / 带别的版本 / 不带标记都是概念；别家标记仍不是', () => {
    const concepts = [
      doc(['shuvix: okf v0.2', 'type: Memory']),
      doc(['shuvix: okf v1', 'type: Memory']),
      doc(['shuvix: okf', 'type: Memory']),
      doc(["shuvix: 'okf v0.2'", 'type: Memory']),
      doc(['type: Memory'])
    ]
    for (const text of concepts) {
      expect(parseConceptText(text, 'global/x.md'), text).not.toBeNull()
      expect(isOkfConceptText(text), text).toBe(true)
    }
    // 类型段必须**全等** okf：okf- 前缀的别家标记不搭便车
    for (const text of [doc(['shuvix: okf-legacy v1', 'type: Memory']), doc(['shuvix: 5'])]) {
      expect(parseConceptText(text, 'global/x.md'), text).toBeNull()
      expect(isOkfConceptText(text), text).toBe(false)
    }
  })

  it('CF-2 只有 type：其余全部缺省（title = 文件名 stem，status = stable），路径归一，正文只剥 frontmatter 后的空行、其余不 trim', () => {
    const concept = parseConceptText(
      '---\ntype: Memory\n---\n\n\nbody \n\n',
      '/global\\token-refresh.md'
    )!
    expect(concept).toMatchObject({
      path: 'global/token-refresh.md',
      type: 'Memory',
      title: 'token-refresh',
      description: '',
      tags: [],
      status: 'stable',
      verified: [],
      sources: [],
      // frontmatter 与正文之间的空行是构建器恒插的分隔，不算正文：parse(build(x)).body === x.body
      body: 'body \n\n'
    })
    expect(concept.generated).toBeUndefined()
    expect(concept.staleAfter).toBeUndefined()
    expect(concept.resource).toBeUndefined()
    // 原始映射原样保留（更新时未知键靠它回写）
    expect(concept.fields).toEqual({ type: 'Memory' })
  })

  it('CF-3 可选字段形状不符：各取缺省、各报一条 warn（点名键名），绝不返回 null', () => {
    const warnings: string[] = []
    const concept = parseConceptText(
      doc([
        'type: Memory',
        'status: reviewed',
        'tags: {a: 1}',
        'generated: nope',
        'sources: not-a-list',
        'verified: [{by: x}]'
      ]),
      'global/x.md',
      (m) => warnings.push(m)
    )!
    expect(concept).not.toBeNull()
    expect(concept.status).toBe('stable')
    expect(concept.tags).toEqual([])
    expect(concept.generated).toBeUndefined()
    expect(concept.sources).toEqual([])
    expect(concept.verified).toEqual([])

    expect(warnings).toHaveLength(5)
    expect(warnings.find((w) => w.startsWith("'status'"))).toContain('treated as stable')
    for (const key of ['status', 'tags', 'generated', 'sources', 'verified']) {
      expect(
        warnings.some((w) => w.includes(`'${key}'`)),
        key
      ).toBe(true)
    }
  })

  it('CF-4 normalizeVerified 接受单个映射或列表；normalizeSources 接受字符串与映射，无 resource 的丢弃并告警', () => {
    const single = parseConceptText(
      doc(['type: Memory', 'verified:', '  by: human:a', "  at: '2026-09-01T00:00:00Z'"]),
      'global/x.md'
    )!
    expect(single.verified).toEqual([{ by: 'human:a', at: '2026-09-01T00:00:00Z' }])
    expect(
      normalizeVerified([
        { by: 'human:a', at: 'T1' },
        { by: 'agent:b', at: 'T2' }
      ])
    ).toHaveLength(2)

    const warnings: string[] = []
    expect(
      normalizeSources(
        [
          '/abs/p.ts',
          {
            id: 's1',
            resource: 'https://example.com/doc',
            title: 'x',
            author: 'y',
            last_modified: '2026-01-01'
          },
          { title: 'no resource' }
        ],
        (m) => warnings.push(m)
      )
    ).toEqual([
      { resource: '/abs/p.ts' },
      {
        id: 's1',
        resource: 'https://example.com/doc',
        title: 'x',
        author: 'y',
        last_modified: '2026-01-01'
      }
    ])
    expect(warnings).toEqual(["'sources' entries must carry a 'resource'"])
  })
})

describe('buildConceptText — 键序固定、可选字段不写、值归一', () => {
  it('CF-5 规范键在前、extra 殿后；extra 不能覆盖已知键或注入 shuvix；正文去首空行、trimEnd、单换行收尾', () => {
    const out = buildConceptText(
      {
        type: 'memory',
        title: ' Title ',
        description: 'd',
        resource: 'r',
        tags: [' a ', 'a', 'b'],
        status: 'stable',
        staleAfter: '2026-12-31',
        sources: [
          { resource: '/p', id: 's1', title: 't', author: 'au', last_modified: '2026-01-01' }
        ],
        generated: { by: 'g', at: '2026-09-09T08:12:03.000Z' },
        verified: [{ by: 'human:v', at: '2026-09-10T00:00:00Z' }],
        extra: { custom: 'kept', type: 'X', shuvix: 'agent v1', verified: 'nope' }
      },
      '\n\n  text  \n\n'
    )
    const { fields, body } = parseOkfText(out)!
    expect(Object.keys(fields)).toEqual([
      // 自述行恒在最前，且由构建器自己写 —— extra 里的 `shuvix` 注入不作数
      'shuvix',
      'type',
      'title',
      'description',
      'resource',
      'tags',
      'status',
      'stale_after',
      'sources',
      'generated',
      'verified',
      'custom'
    ])
    expect(out.startsWith('---\nshuvix: okf v0.2\ntype: Memory\n')).toBe(true)
    expect(fields.shuvix).toBe('okf v0.2')
    expect(out).toContain('\ntitle: Title\n')
    expect(fields.tags).toEqual(['a', 'b'])
    expect(out).toContain('\ntags:\n  - a\n  - b\n')
    // status 恒写出：OKF 缺省 stable，靠省略表达 stable 会让「草稿必须显式」失去对照
    expect(out).toContain('\nstatus: stable\n')
    // extra 里的 `shuvix: agent v1` 不作数：自述行只由构建器写，且恒是知识库自己的那一个
    expect(out).not.toContain('agent v1')
    expect(fields.verified).toEqual([{ by: 'human:v', at: '2026-09-10T00:00:00Z' }])
    expect(fields.custom).toBe('kept')
    // parseOkfText 是原样拆分（分隔空行归正文）；概念解析才把那一行剥掉
    expect(body).toBe('\n  text\n')
    expect(parseConceptText(out, 'global/x.md')!.body).toBe('  text\n')
    expect(out.endsWith('---\n\n  text\n')).toBe(true)
  })

  it('CF-6 经真 YAML 往返：特殊字符标题、嵌套 sources、章、扩展键、未知嵌套键全部保真', () => {
    const input = {
      type: 'Memory',
      title: 'a: b',
      description: `it's #1 — "quoted"`,
      resource: 'x',
      tags: ['auth', 'pitfall'],
      status: 'draft' as const,
      staleAfter: '2026-12-31',
      sources: [{ id: 's1', resource: 'shuvix://session/abc', title: 'sess' }],
      generated: { by: 'shuvix-work/gpt-5', at: '2026-09-09T08:12:03.000Z' },
      verified: [
        { by: 'human:agent', at: '2026-09-10T02:00:00Z' },
        { by: 'agent:x', at: '2026-09-11T02:00:00Z' }
      ],
      // 已退役的扩展键：不再有专门的字段，但落在磁盘上的旧文件必须原样带过（OKF 容忍未知键）
      extra: { meta: { k: 1 }, shuvix_pinned: true }
    }
    const text = buildConceptText(input, 'body')
    const back = parseConceptText(text, 'global/x.md')!
    expect(back).not.toBeNull()
    expect(back.title).toBe('a: b')
    expect(back.description).toBe(`it's #1 — "quoted"`)
    expect(back.resource).toBe('x')
    expect(back.tags).toEqual(['auth', 'pitfall'])
    expect(back.status).toBe('draft')
    expect(back.staleAfter).toBe('2026-12-31')
    expect(back.sources).toEqual(input.sources)
    expect(back.generated).toEqual(input.generated)
    expect(back.verified).toHaveLength(2)
    expect(back.verified).toEqual(input.verified)
    expect((back.fields.meta as { k: number }).k).toBe(1)
    expect(back.fields.shuvix_pinned).toBe(true)
    expect(back.body).toBe('body\n')
  })
})

describe('isVerificationCurrent / normalizeKnowledgeType', () => {
  it('CF-7 验证是否仍当前：无验证 false；无 generated true；at ≥ generated true；更早 false；日期不可解析 true', () => {
    const v = (at: string): { by: string; at: string }[] => [{ by: 'human:me', at }]
    expect(isVerificationCurrent({ verified: [] })).toBe(false)
    expect(isVerificationCurrent({ verified: v('2026-09-01T00:00:00Z') })).toBe(true)
    expect(
      isVerificationCurrent({
        verified: v('2026-09-02T00:00:00Z'),
        generated: { by: 'g', at: '2026-09-02T00:00:00Z' }
      })
    ).toBe(true)
    expect(
      isVerificationCurrent({
        verified: v('2026-09-01T00:00:00Z'),
        generated: { by: 'g', at: '2026-09-02T00:00:00Z' }
      })
    ).toBe(false)
    expect(
      isVerificationCurrent({ verified: v('whenever'), generated: { by: 'g', at: 'sometime' } })
    ).toBe(true)
  })

  it('CF-7 type 归一：词汇表内大小写不敏感归为规范写法，未知值 trim 后原样', () => {
    expect(normalizeKnowledgeType('DECISION')).toBe('Decision')
    expect(normalizeKnowledgeType(' Memory ')).toBe('Memory')
    expect(normalizeKnowledgeType('Runbook')).toBe('Runbook')
    expect(normalizeKnowledgeType('  Custom Thing ')).toBe('Custom Thing')
  })
})

describe('readKnowledgeNote / firstHeading — 任何 md 都是一条笔记', () => {
  /** 缺省路径：回落到文件名时标题是 `Foo Bar` */
  const NOTE_PATH = 'notes/Foo Bar.md'
  const titleOf = (text: string): string => readKnowledgeNote(text, NOTE_PATH).title

  it('CF-8 readKnowledgeNote 的标题取法：frontmatter title → 正文第一个 `#` 一级标题 → 文件名', () => {
    const table: [string, string][] = [
      ['# Heading\n\nbody\n', 'Heading'],
      ['---\ntitle: FM\n---\n# Heading\n', 'FM'],
      // 空 title 算没给
      ["---\ntitle: ''\n---\n# Heading\n", 'Heading'],
      // 非标量不算
      ['---\ntitle: [a, b]\n---\n# Heading\n', 'Heading'],
      // YAML 坏了照样在 frontmatter 之后找
      ['---\ntitle: [unclosed\n---\n# Heading\n', 'Heading'],
      ['## Sub\n# Real\n', 'Real'],
      // 只认 ATX：`#` 后要有空白、最多三格缩进，setext 不算
      ['#Title\n', 'Foo Bar'],
      ['    # Code\n', 'Foo Bar'],
      ['Title\n=====\n', 'Foo Bar'],
      // 收尾的 `#` 剥掉，词里的 `#` 留着；光秃秃的 `#` 不是标题
      ['# Title ##\n', 'Title'],
      ['# C#\n', 'C#'],
      ['#\n# Real\n', 'Real'],
      ['intro\r\n# Real\r\n', 'Real'],
      [`${String.fromCharCode(0xfeff)}---\ntitle: Bom\n---\nbody\n`, 'Bom']
    ]
    for (const [text, title] of table) {
      expect(titleOf(text), JSON.stringify(text)).toBe(title)
    }

    // frontmatter 里的 YAML 注释不是标题；读得出的 description 照带
    const commented = readKnowledgeNote(
      '---\n# not a heading\ndescription: d\n---\nbody\n',
      NOTE_PATH
    )
    expect(commented.title).toBe('Foo Bar')
    expect(commented.description).toBe('d')

    // 路径归一（反斜杠、前导分隔符），文件名回落用归一后的路径
    const backslashed = readKnowledgeNote('just text\n', '\\notes\\a.md')
    expect(backslashed.title).toBe('a')
    expect(backslashed.path).toBe('notes/a.md')
  })

  it('CF-9 找标题时跳过围栏代码块，按 CommonMark 闭合', () => {
    const table: [string, string][] = [
      ['```\n# Inner\n```\n# Real\n', 'Real'],
      // 闭栏必须是同一种字符
      ['~~~\n```\n# Inner\n~~~\n# Real\n', 'Real'],
      // 闭栏可以比开栏长
      ['```\n# Inner\n````\n# Real\n', 'Real'],
      // 没闭合：直到文末都是代码
      ['```\n# Inner\n', 'Foo Bar'],
      // 闭栏不能比开栏短
      ['````md\n```\n# Inner\n```\n````\n# Real\n', 'Real'],
      // 带 info string 的那一行不是闭栏
      ['```\n```js\n# Inner\n```\n# Real\n', 'Real']
    ]
    for (const [text, title] of table) {
      expect(titleOf(text), JSON.stringify(text)).toBe(title)
    }
    // info string 里带反引号的那一行是行内代码，不是开栏
    expect(firstHeading('```code```\n# Real\n')).toBe('Real')
  })

  it('CF-10 不合规的笔记：读得出的 description / tags / status 照带，其余取缺省，concept 为 null，且不对它发 warn', () => {
    expect(
      readKnowledgeNote('---\ndescription: d\ntags: a, b\nstatus: draft\n---\nbody\n', NOTE_PATH)
    ).toMatchObject({
      type: '',
      concept: null,
      description: 'd',
      tags: ['a', 'b'],
      status: 'draft'
    })

    const odd = readKnowledgeNote('---\ntags: [x, "", y]\nstatus: reviewed\n---\n', NOTE_PATH)
    expect(odd.tags).toEqual(['x', 'y'])
    expect(odd.status).toBe('stable')

    // 别家标记的文件带 type 也不是条目
    expect(
      readKnowledgeNote(
        '---\nshuvix: agent v1\nname: a\ndescription: an agent\ntype: Memory\n---\n# Agent\n',
        NOTE_PATH
      )
    ).toMatchObject({ concept: null, type: '', description: 'an agent', title: 'Agent' })

    const warn = vi.fn()
    readKnowledgeNote('---\ntags: {a: 1}\nstatus: wip\n---\n', NOTE_PATH, { warn })
    expect(warn).toHaveBeenCalledTimes(0)
    // 对照：合规条目上同一个非法 status 照常报
    readKnowledgeNote('---\ntype: Memory\nstatus: wip\n---\n', NOTE_PATH, { warn })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('CF-11 读不出的标记（`shuvix: 123`）即便带 type 也不是概念', () => {
    const text = '---\nshuvix: 123\ntype: Memory\n---\nbody\n'
    expect(parseConceptText(text, 'x.md')).toBeNull()
    expect(isOkfConceptText(text)).toBe(false)
    expect(readKnowledgeNote(text, 'x.md').concept).toBeNull()
  })

  it('CF-12 合规条目的标题与 `entry: false` 开关', () => {
    const note = readKnowledgeNote('---\ntype: Memory\n---\n# Heading\n', 'a.md')
    expect(note.concept).not.toBeNull()
    const concept = note.concept!
    // 笔记标题按笔记的取法；概念自己的标题仍回落文件名
    expect(note.title).toBe('Heading')
    expect(concept.title).toBe('a')
    expect({ description: note.description, tags: note.tags, status: note.status }).toEqual({
      description: concept.description,
      tags: concept.tags,
      status: concept.status
    })

    // 保留名下用户自己的笔记：只读字段、不当 OKF 条目
    expect(
      readKnowledgeNote('---\ntype: Memory\ntitle: Home\nstatus: draft\n---\n# x\n', 'index.md', {
        entry: false
      })
    ).toMatchObject({ concept: null, type: '', title: 'Home', status: 'draft' })
  })
})

/**
 * headingsOf —— 正文里的全部 ATX 标题。两个消费方：笔记标题回落（`firstHeading`，老行为）与
 * **检索索引的正文面**（2026-09-17 起索引只收门面 + 标题行，散文一概不进）。所以这里钉的既是
 * 「哪些行算标题」，也是「索引里会出现哪些词」—— 判定放宽一点，库里就会多出一批可搜的散文。
 *
 * 判定刻意窄：只认行首 ATX（`#` 后必须有空白、最多三格缩进），跳过围栏代码块，标题文字**原样**
 * 带出（不解析 markdown）。两条已知取舍见 CF-16 / SR-18。
 */
describe('headingsOf —— 索引的正文面', () => {
  /** `[level, text]` 对照，比整个对象数组读着省事 */
  const pairs = (body: string): [number, string][] =>
    headingsOf(body).map((h): [number, string] => [h.level, h.text])
  const textsOf = (body: string): string[] => headingsOf(body).map((h) => h.text)

  it('CF-13 全部 ATX 标题按出现顺序返回，级别 1–6 原样带出；七个 `#` 不是标题', () => {
    const body = [
      '# One',
      'prose that is not a heading',
      '## Two',
      '### Three',
      '#### Four',
      '##### Five',
      '###### Six',
      '####### Seven',
      '# Back to one'
    ].join('\n')
    expect(pairs(body)).toEqual([
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three'],
      [4, 'Four'],
      [5, 'Five'],
      [6, 'Six'],
      [1, 'Back to one']
    ])
    // 一个标题都没有的正文（检索的正文面因此为空）
    expect(headingsOf('just prose\n\nmore prose\n')).toEqual([])
    expect(headingsOf('')).toEqual([])
  })

  it('CF-14 `#` 之后必须有空白（tab 也算），缩进最多三格', () => {
    const table: [string, string[]][] = [
      ['# Spaced\n', ['Spaced']],
      ['#\tTabbed\n', ['Tabbed']],
      ['#NoSpace\n', []],
      ['##AlsoNoSpace\n', []],
      [' # One space\n', ['One space']],
      ['   # Three spaces\n', ['Three spaces']],
      // 四格缩进是代码块，不是标题
      ['    # Four spaces\n', []],
      ['\t# Tab indented\n', []]
    ]
    for (const [body, expected] of table) {
      expect(textsOf(body), JSON.stringify(body)).toEqual(expected)
    }
  })

  it('CF-15 收尾的 `#` 序列剥掉（须有空白分隔）、词内 `#` 保留、空标题不算', () => {
    const table: [string, string[]][] = [
      ['# Title ##\n', ['Title']],
      ['## Title ######\n', ['Title']],
      // 没有空白分隔就不是收尾序列，是标题的一部分
      ['# Title##\n', ['Title##']],
      ['# C#\n', ['C#']],
      ['# a#b\n', ['a#b']],
      // 光秃秃的 `#` / 只有空白的标题不算
      ['#\n', []],
      ['#   \n', []],
      ['# \t \n', []]
    ]
    for (const [body, expected] of table) {
      expect(textsOf(body), JSON.stringify(body)).toEqual(expected)
    }
  })

  /**
   * CF-16 **已知取舍**：setext（`标题\n====`）不算标题，所以纯 setext 组织的笔记正文面为空。
   * 改它会连带改变笔记的标题（`firstHeading` 与索引同源），那是另一件事。
   */
  it('CF-16 setext 不算标题：纯 setext 的正文返回空数组', () => {
    expect(headingsOf('Title\n=====\n\nbody\n')).toEqual([])
    expect(headingsOf('Sub\n---\n\nbody\n')).toEqual([])
    // 同一篇里的 ATX 照常算，setext 那一行仍然不算
    expect(textsOf('Setext\n======\n\n## Atx\n')).toEqual(['Atx'])
  })

  it('CF-17 围栏内的标题一律跳过，围栏按 CommonMark 闭合', () => {
    const table: [string, string[]][] = [
      ['```\n# Inner\n```\n# Real\n', ['Real']],
      ['~~~\n# Inner\n~~~\n# Real\n', ['Real']],
      // 闭栏可以比开栏长
      ['```\n# Inner\n````\n# Real\n', ['Real']],
      // 闭栏不能比开栏短
      ['````\n```\n# Inner\n```\n````\n# Real\n', ['Real']],
      // 带 info string 的那一行不是闭栏
      ['```\n```js\n# Inner\n```\n# Real\n', ['Real']],
      // 未闭合：吃到文末
      ['# Before\n```\n# Inner\n', ['Before']],
      // 围栏本身可以有三格缩进
      ['   ```\n# Inner\n   ```\n# Real\n', ['Real']]
    ]
    for (const [body, expected] of table) {
      expect(textsOf(body), JSON.stringify(body)).toEqual(expected)
    }
  })

  it('CF-18 info string 含反引号的那一行不是开栏；`~~~` 与 ``` 互不闭合', () => {
    // 行内代码，不是开栏 —— 后面的标题照常算
    expect(textsOf('```code```\n# Real\n')).toEqual(['Real'])
    // 反引号围栏的 info string 里不许有反引号，波浪围栏的可以
    expect(textsOf('~~~js`x`\n# Inner\n~~~\n# Real\n')).toEqual(['Real'])
    // 互不闭合：另一种字符的那一行只是围栏里的一行普通文本
    expect(textsOf('~~~\n# A\n```\n# B\n~~~\n# C\n')).toEqual(['C'])
    expect(textsOf('```\n# A\n~~~\n# B\n```\n# C\n')).toEqual(['C'])
  })

  it('CF-19 CRLF 正文：标题文字不带尾随 `\\r`', () => {
    expect(pairs('# One\r\n\r\nprose\r\n## Two\r\n')).toEqual([
      [1, 'One'],
      [2, 'Two']
    ])
    // 围栏判定同样按 CRLF 切行
    expect(textsOf('```\r\n# Inner\r\n```\r\n# Real\r\n')).toEqual(['Real'])
  })

  it('CF-20 firstHeading = headingsOf 里第一个 `level === 1`', () => {
    expect(firstHeading('## Sub\n\n# Real\n\n# Later\n')).toBe('Real')
    // 全篇只有二级标题：没有一级标题
    expect(firstHeading('## Sub\n\n### Deeper\n')).toBeUndefined()
    expect(firstHeading('body only\n')).toBeUndefined()
    // 两者同源：firstHeading 恒是 headingsOf 里第一个一级标题
    for (const body of ['## Sub\n# Real\n', '# A\n## B\n# C\n', '## only\n']) {
      expect(firstHeading(body), JSON.stringify(body)).toBe(
        headingsOf(body).find((h) => h.level === 1)?.text
      )
    }
  })

  it('CF-21 不做 markdown 解析：链接 / 行内代码 / 强调在标题文字里原样保留', () => {
    expect(
      textsOf(
        [
          '# See [the docs](https://example.com/a)',
          '## Use `readKnowledgeNote` here',
          '### **Bold** and _italic_'
        ].join('\n')
      )
    ).toEqual([
      'See [the docs](https://example.com/a)',
      'Use `readKnowledgeNote` here',
      '**Bold** and _italic_'
    ])
  })

  it('CF-22 只认行首 ATX：引用块与列表里的 `#` 不算', () => {
    const table: [string, string[]][] = [
      ['> # quoted\n', []],
      ['- # in a list\n', []],
      ['* # in a list\n', []],
      ['1. # numbered\n', []],
      ['text # not at line start\n', []],
      // 对照：同一篇里真正行首的那一个照常算
      ['> # quoted\n\n# real\n', ['real']]
    ]
    for (const [body, expected] of table) {
      expect(textsOf(body), JSON.stringify(body)).toEqual(expected)
    }
  })

  it('CF-23 不截断、不去重：超长标题原样带出，全是标题的正文条数与顺序都对得上', () => {
    const long = 'x'.repeat(5000)
    expect(textsOf(`# ${long}\n`)).toEqual([long])

    const headings: BodyHeading[] = Array.from({ length: 200 }, (_, i) => ({
      level: (i % 6) + 1,
      // 每三条重复一次标题文字：去重会让条数对不上
      text: `Heading ${i % 3}`
    }))
    const body = headings.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n\n')
    expect(headingsOf(body)).toEqual(headings)
  })
})

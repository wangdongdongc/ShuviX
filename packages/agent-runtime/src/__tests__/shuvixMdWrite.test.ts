/**
 * 写后审阅（reviewShuvixMdWrite）—— 展示型契约的 YAML 语法兜底。
 *
 * 直接动机：曾有一种生成的 md 在 frontmatter 里写了裸标量「冒号+空格」，每一份的 frontmatter
 * 都非法，而展示型契约的 validate 返回 unknown、写后审阅静默放行 —— agent 全程无从自纠。
 * 这里钉住：unknown 类型的 frontmatter 语法错必须随工具 result 回执。
 */
import { describe, it, expect } from 'vitest'
import { parseOkfText } from '../knowledge/okfCodec'
import { reviewShuvixMdWrite } from '../shuvixMdWrite'

const CTX = { today: '2026-08-28' }

/** 展示型契约的样本：无校验器的假类型（validate 回 unknown —— 没有「整份拒绝」的解析器） */
const displayFile = (description: string): string =>
  [
    '---',
    'shuvix: note v1',
    'name: 测试笔记',
    `description: ${description}`,
    '---',
    '',
    '正文笔记'
  ].join('\n')

describe('reviewShuvixMdWrite — 展示型契约的 YAML 语法兜底', () => {
  it('展示型契约 frontmatter 语法错（裸标量冒号）→ 回执 note，不动文件', () => {
    const out = reviewShuvixMdWrite(
      displayFile('your own notes: the agent reads them'),
      'note.md',
      CTX
    )
    expect(out).not.toBeNull()
    expect(out!.note).toContain('not valid YAML')
    expect(out!.note).toContain('[shuvix note v1]')
    expect(out!.content).toBeNull()
  })

  it('frontmatter 合法 → null：展示型契约没有要盖的章，不产生无意义改写', () => {
    expect(reviewShuvixMdWrite(displayFile('plain description'), 'note.md', CTX)).toBeNull()
  })

  it('其它 unknown 类型同样兜底', () => {
    const note = ['---', 'shuvix: note v1', 'name: [unclosed', '---', 'body'].join('\n')
    const out = reviewShuvixMdWrite(note, 'note.md', CTX)
    expect(out?.note).toContain('not valid YAML')
  })

  it('无 shuvix 标记的普通 md → null（与本机制无关）', () => {
    expect(reviewShuvixMdWrite('# 普通笔记\n', 'note.md', CTX)).toBeNull()
  })

  it('有专用解析器的类型不走兜底：非法 agent md 仍由解析器给 INVALID 原因', () => {
    const agent = ['---', 'shuvix: agent v1', 'name: [unclosed', '---', 'body'].join('\n')
    const out = reviewShuvixMdWrite(agent, 'agent.md', CTX)
    expect(out?.note).toContain('INVALID and will be ignored')
  })
})

/**
 * OKF 知识库分支（reviewKnowledgeWrite）—— 没有 shuvix 标记、但落在某个 bundle 里的 md：
 * 一致性校验作为回执带回；合规的概念**行级** upsert `generated`（注释 / 键序 / 未知键 / 正文 /
 * 行尾 / BOM 全部原样），`verified` 从不碰；保留文件只回执规则、不盖章。
 *
 * 宿主给的是 **bundle 相对**路径（谁属于哪个 bundle 由宿主答，不在任何 bundle 内就不给 ctx）——
 * 诊断规则按 bundle 判「是不是根 index」，给容器相对的路径会让每个 bundle 的根 index 都被
 * 误判成子目录 index。
 */
describe('reviewShuvixMdWrite — OKF 知识库分支', () => {
  const ACTOR = { actor: 'shuvix-work/gpt-5', now: '2026-09-09T08:12:03.000Z' }
  const STAMP = 'generated: { by: "shuvix-work/gpt-5", at: "2026-09-09T08:12:03.000Z" }'
  const STAMP_NOTE =
    '[OKF] Stamped generated: { by: shuvix-work/gpt-5, at: 2026-09-09T08:12:03.000Z } — never write generated or verified yourself.'
  const ERROR_HEAD =
    '[OKF] The file was written, but it breaks the knowledge base format and will not be read as intended until fixed:'
  const DESCRIPTION_WARNING =
    "- 'description' (one line) is recommended — it is what list and search show"

  const concept = (lines: string[], body = 'body'): string =>
    ['---', ...lines, '---', '', body, ''].join('\n')
  const VALID = ['type: Memory', 'title: T', 'description: d', 'status: draft']
  const MARKER = 'shuvix: okf v0.2'
  /** `rel` = 宿主解析出的 bundle 相对路径；null = 不在任何 bundle 内（宿主不给 ctx） */
  const review = (text: string, rel: string | null): ReturnType<typeof reviewShuvixMdWrite> =>
    reviewShuvixMdWrite(text, 'x', {
      today: '2026-09-09',
      knowledge: rel === null ? undefined : { rel, ...ACTOR }
    })

  it('MW-1 分支选择表：宿主没给 knowledge（不在任何 bundle 内 / 扩展端无知识库）→ null；带 shuvix 标记走旧记忆分支', () => {
    expect(reviewShuvixMdWrite(concept(VALID), 'x', { today: '2026-09-09' })).toBeNull()
    expect(review(concept(VALID), null)).toBeNull()

    // 有 shuvix 标记的文件不是 OKF 概念 —— 即便落在根目录下也走各自契约的旧分支
    const memory =
      '---\nshuvix: memory v1\nname: x\ndescription: d\nshuvix-memory-recall: r\n---\nbody\n'
    const out = review(memory, 'global/x.md')!
    expect(out.note).toContain('[shuvix memory v1] Filled in')
    expect(out.note).not.toContain('[OKF]')
    expect(out.content).toContain('shuvix-memory-updated')
    expect(out.content).not.toContain('generated')
  })

  /**
   * 知识库条目自己也带标记（`shuvix: okf v0.2`）—— 分支选择不能再靠「没有标记」，否则我们
   * 自己写出去的每一份条目都会掉进契约分支、既不盖章也不回执。判别只看类型段不看版本。
   */
  it('MW-1 带 okf 自述行的条目走 OKF 分支（照常盖章 / 回执），bundle 外仍不管', () => {
    const marked = concept(['shuvix: okf v0.2', ...VALID])
    const out = review(marked, 'global/x.md')!
    expect(out.note).toBe(STAMP_NOTE)
    expect(out.content).toContain('generated:')
    // 自述行原样留着（行级 upsert 不重排 frontmatter）
    expect(out.content).toContain('shuvix: okf v0.2')

    expect(review(concept(['shuvix: okf v1', ...VALID]), 'global/x.md')!.note).toBe(STAMP_NOTE)
    expect(review(marked, null)).toBeNull()
  })

  it('MW-2 读宽写严：用户的普通笔记（没有 frontmatter / 没有 type）不回执、不盖章、不动文件；frontmatter 写坏只提醒；带自述行却缺 type 的才是 error', () => {
    expect(review('# plain\n\nbody\n', 'global/x.md')).toBeNull()
    expect(review(concept(['title: T', 'description: d']), 'global/x.md')).toBeNull()

    const broken = review('---\ntitle: [unclosed\n---\n\nbody\n', 'global/x.md')!
    expect(broken.note).toContain('[OKF] Written with warnings:')
    expect(broken.note).toContain('frontmatter is not parseable YAML')
    expect(broken.content).toBeNull()

    const marked = review(concept([MARKER, 'title: T', 'description: d']), 'global/x.md')!
    expect(marked.note).toBe(`${ERROR_HEAD}\n- 'type' is required and must be a non-empty string`)
    expect(marked.content).toBeNull()
  })

  it('MW-3 index.md / log.md 不再维护：生成形状的与用户手写的一律 null —— 不回执、不盖章（保留名从来不是条目）', () => {
    const fm = '---\nokf_version: "0.2"\n---\n\n## Entries\n'
    expect(review(fm, 'global/index.md')).toBeNull()
    expect(review(fm, 'index.md')).toBeNull()
    expect(review('# Home\n\nwelcome\n', 'index.md')).toBeNull()
    expect(review('## 2026-09-09\n\n- x\n', 'log.md')).toBeNull()
    expect(review('---\ntype: Memory\n---\n\n- x\n', 'log.md')).toBeNull()
  })

  it('MW-4 首次盖章：注释 / 键序 / 未知键 / 正文 / CRLF / BOM 逐字节原样，只在闭合线前插一行', () => {
    const text =
      '﻿---\r\n# note\r\nshuvix: okf v0.2\r\ntype: Memory\r\ntitle: T\r\ndescription: d\r\nstatus: draft\r\ncustom: kept\r\n---\r\n\r\nbody\r\n'
    const out = review(text, 'global/x.md')!
    expect(out.content).toBe(text.replace('custom: kept\r\n---', `custom: kept\r\n${STAMP}\r\n---`))
    expect(out.note).toBe(STAMP_NOTE)
    expect(parseOkfText(out.content!)!.fields.generated).toEqual({
      by: 'shuvix-work/gpt-5',
      at: '2026-09-09T08:12:03.000Z'
    })
  })

  it('MW-5 既有 generated：流式写法原位改写（恰一行）；块式写法连续行一起换成一行，紧随其后的 verified 块不受波及', () => {
    const flow = review(
      concept([
        'type: Memory',
        'title: T',
        'description: d',
        'status: draft',
        'generated: { by: "old", at: "2020-01-01T00:00:00Z" }',
        'custom: kept'
      ]),
      'global/x.md'
    )!
    const flowLines = flow.content!.split('\n')
    expect(flowLines[5]).toBe(STAMP)
    expect(flowLines[6]).toBe('custom: kept')
    expect(flowLines.filter((l) => l.startsWith('generated:'))).toHaveLength(1)
    expect(flow.content).not.toContain('old')

    const block = review(
      concept([
        'type: Memory',
        'title: T',
        'description: d',
        'status: draft',
        'generated:',
        '  by: old',
        '  at: 2020-01-01T00:00:00Z',
        'verified:',
        '  by: human:me',
        '  at: 2026-09-01T00:00:00Z'
      ]),
      'global/x.md'
    )!
    expect(block.content).toBe(
      `---\ntype: Memory\ntitle: T\ndescription: d\nstatus: draft\n${STAMP}\nverified:\n  by: human:me\n  at: 2026-09-01T00:00:00Z\n---\n\nbody\n`
    )
    const fields = parseOkfText(block.content!)!.fields
    expect(fields.generated).toEqual({ by: 'shuvix-work/gpt-5', at: '2026-09-09T08:12:03.000Z' })
    expect(fields.verified).toEqual({ by: 'human:me', at: '2026-09-01T00:00:00Z' })
  })

  it('MW-6 无事可做 → null；只有告警 → 回执不改文件；告警 + 盖章 → 两段回执以空行相隔、content 回写', () => {
    expect(review(concept([MARKER, ...VALID, STAMP]), 'global/x.md')).toBeNull()

    const warned = review(
      concept([MARKER, 'type: Memory', 'title: T', 'status: draft', STAMP]),
      'global/x.md'
    )!
    expect(warned.note).toBe(`[OKF] Written with warnings:\n${DESCRIPTION_WARNING}`)
    expect(warned.content).toBeNull()

    const both = review(
      concept([
        MARKER,
        'type: Memory',
        'title: T',
        'status: draft',
        'generated: { by: "old", at: "2020-01-01T00:00:00Z" }'
      ]),
      'global/x.md'
    )!
    expect(both.note).toBe(`[OKF] Written with warnings:\n${DESCRIPTION_WARNING}\n\n${STAMP_NOTE}`)
    expect(both.content).toContain(STAMP)
  })

  /**
   * 自述行是属性卡的**识别依据**（`readShuvixMarker` 读不到就不渲染卡）。`knowledge` 的
   * `create` 恒写它；手写 / 外部工具写的那份则不会有，于是回执要点名这件事 —— 上一轮
   * 把新建改成「模型自己拼 frontmatter」，卡片就是这样静默消失的。
   */
  it('MW-7 没有自述行的 OKF 条目（有 type）：照常盖 generated；不催补自述行，也不代填', () => {
    const out = review(concept(VALID), 'global/x.md')!
    expect(out.note).toBe(STAMP_NOTE)
    expect(out.content).toContain(STAMP)
    expect(out.content).not.toContain('shuvix: okf')
  })

  /**
   * 读宽写严（设计附录 L）：写钩子按文件**自称**什么分档。带自述行的是 ShuviX 建出来的条目 —— 自述行按
   * 原文行读，YAML 写坏了、闭合的 `---` 被删掉了也认得出，当场回 error、不盖章；普通笔记最多一条语法
   * 提醒，宿主一个字节都不改；保留名从来不是条目。
   */
  it('MW-8 带自述行但 YAML 写坏：按原文行认出是条目，回 error 而不是普通笔记的 warning，不盖章', () => {
    for (const marker of [MARKER, 'shuvix: "okf v0.2"']) {
      expect(review(concept([marker, 'type: [x', 'title: T']), 'global/x.md'), marker).toEqual({
        note: `${ERROR_HEAD}\n- frontmatter is not parseable YAML, or is not a key/value mapping`,
        content: null
      })
    }
    // 对照：同样的内容去掉自述行，就是一篇 frontmatter 写坏的普通笔记
    expect(review(concept(['type: [x', 'title: T']), 'global/x.md')).toEqual({
      note: '[OKF] Written with warnings:\n- frontmatter is not parseable YAML, or is not a key/value mapping — ShuviX shows a syntax error instead of its fields until it is fixed',
      content: null
    })
  })

  it('MW-9 保留名从不盖章，带自述行、字段合规也一样', () => {
    for (const rel of ['index.md', 'sub/log.md']) {
      expect(review(concept([MARKER, ...VALID]), rel), rel).toBeNull()
    }
  })

  it('MW-10 不是条目就不盖章、不改字节', () => {
    const notEntries = [
      // 读不出的标记
      ['shuvix: 123', ...VALID],
      // type 不是字符串
      ['type: 5', 'title: T'],
      // 没有 type：手写了 generated 也不替它刷新
      ['title: T', 'generated: { by: me, at: x }']
    ]
    for (const lines of notEntries) {
      expect(review(concept(lines), 'global/x.md'), lines.join(' | ')).toBeNull()
    }
  })

  it('MW-11 自称条目却删掉了闭合的 `---`：当场回 error，不盖章；没有自述行的同形文本不回执', () => {
    expect(review('---\nshuvix: okf v0.2\ntype: Memory\ntitle: T\nbody\n', 'global/x.md')).toEqual({
      note: `${ERROR_HEAD}\n- the frontmatter block is never closed — end it with a \`---\` line`,
      content: null
    })
    expect(review('---\ntitle: T\nbody\n', 'global/x.md')).toBeNull()
  })
})

/**
 * WID —— 写后审阅与 `shuvix-id`：写钩子**不分配 id**（新建文件的 id 由宿主的 create 路径写进去，
 * agent 用 write / edit 写出的文件原样落盘）。写坏的 id 只是解析器软提示，随回执带回、不改文件；
 * 知识库条目不认这个键（OKF 允许未知键），不为它出任何声。
 */
describe('reviewShuvixMdWrite — shuvix-id', () => {
  const agent = (...extra: string[]): string =>
    [
      '---',
      'shuvix: agent v1',
      ...extra,
      'name: a1',
      'description: d',
      '---',
      '',
      'Body.',
      ''
    ].join('\n')

  it('WID-1 agent md 带写坏的 id → 回执「Written with parser warnings」并带上 id 那条；不改写文件', () => {
    const out = reviewShuvixMdWrite(agent('shuvix-id: nope'), 'a1.md', CTX)
    expect(out).not.toBeNull()
    expect(out!.note).toContain('Written with parser warnings')
    expect(out!.note).toContain("agent 'a1': 'shuvix-id' is not a valid object id")
    expect(out!.content).toBeNull()
  })

  it('WID-2 agent md 没写 id → null：写钩子不替它补 id', () => {
    expect(reviewShuvixMdWrite(agent(), 'a1.md', CTX)).toBeNull()
    expect(
      reviewShuvixMdWrite(agent('shuvix-id: 0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'), 'a1.md', CTX)
    ).toBeNull()
  })

  it('WID-3 知识库条目带 shuvix-id: garbage → 回执里没有任何关于它的话（照常盖章）；普通笔记仍是 null', () => {
    const ctx = {
      today: '2026-09-09',
      knowledge: { rel: 'global/x.md', actor: 'shuvix-work/gpt-5', now: '2026-09-09T08:12:03.000Z' }
    }
    const entry = [
      '---',
      'shuvix: okf v0.2',
      'type: Memory',
      'title: T',
      'description: d',
      'status: draft',
      'shuvix-id: garbage',
      '---',
      '',
      'body',
      ''
    ].join('\n')
    const out = reviewShuvixMdWrite(entry, 'x', ctx)
    expect(out).not.toBeNull()
    expect(out!.note).not.toContain('shuvix-id')
    expect(out!.content).toContain('generated:')
    expect(out!.content).toContain('shuvix-id: garbage')

    const note = ['---', 'title: T', 'shuvix-id: garbage', '---', '', 'body', ''].join('\n')
    expect(reviewShuvixMdWrite(note, 'x', ctx)).toBeNull()
  })
})

/**
 * DO —— 只要诊断（`diagnoseOnly`）：doc_* 改的是编辑器里的活文档，落盘归编辑器的自动保存，宿主往里
 * 回写的东西会被它覆盖。于是：不补缺省字段、不盖 `generated`（`content` 恒为 null），只回校验的话；
 * 回执开头说的是「文档改了」（还没存盘），而不是「文件写进去了」—— 其余一字不差。
 *
 *   DO-1 合法的记忆 md：诊断模式 → null（对照：不带开关时回写里有 shuvix-memory-updated）
 *   DO-2 会被盖章的 OKF 条目：诊断模式 → null
 *   DO-3 缺 description 的条目：只剩「Written with warnings」那段，content null、不盖章
 *   DO-4 三种错误回执（OKF 错、非法 agent md、展示型契约的 YAML 错）：除开头外与写盘时逐字相同，content null
 *   DO-5 解析器软提示：诊断模式下照样整段带回，没有「Filled in for you」（记忆 md 没有解析器 ——
 *        validate 回 unknown、不出软提示 —— 软提示取 agent md 的写坏 id）
 *   LEAD 两个开头逐字钉住：写盘 = `The file was written`，诊断 = `The document was changed`
 */
describe('reviewShuvixMdWrite — 只要诊断（diagnoseOnly）', () => {
  const ACTOR = { actor: 'shuvix-notebook/gpt-5', now: '2026-10-15T08:00:00.000Z' }
  const MARKER = 'shuvix: okf v0.2'
  const concept = (lines: string[]): string => ['---', ...lines, '---', '', 'body', ''].join('\n')
  const DESCRIPTION_WARNING =
    "- 'description' (one line) is recommended — it is what list and search show"
  /** 同一份文本：写盘口径 / 诊断口径各审一次 */
  const both = (
    text: string,
    rel: string | null = null
  ): {
    written: ReturnType<typeof reviewShuvixMdWrite>
    changed: ReturnType<typeof reviewShuvixMdWrite>
  } => {
    const ctx = {
      sessionId: 'sess-do',
      today: '2026-10-15',
      knowledge: rel === null ? undefined : { rel, ...ACTOR }
    }
    return {
      written: reviewShuvixMdWrite(text, 'x', ctx),
      changed: reviewShuvixMdWrite(text, 'x', { ...ctx, diagnoseOnly: true })
    }
  }
  const MEMORY =
    '---\nshuvix: memory v1\nname: x\ndescription: d\nshuvix-memory-recall: r\n---\nbody\n'
  const INVALID_AGENT = ['---', 'shuvix: agent v1', 'name: [unclosed', '---', 'body'].join('\n')
  const BROKEN_DISPLAY = [
    '---',
    'shuvix: note v1',
    'name: n',
    'description: your own notes: the agent reads them',
    '---',
    '',
    'body'
  ].join('\n')

  it('DO-1 合法的记忆 md → null；不带开关时照旧补 shuvix-memory-updated', () => {
    const { written, changed } = both(MEMORY)
    expect(written?.content).toContain('shuvix-memory-updated: 2026-10-15')
    expect(written?.note).toContain('Filled in for you')
    expect(changed).toBeNull()
  })

  it('DO-2 会被盖章的 OKF 条目 → null（不盖 generated、不回执）', () => {
    const entry = concept([MARKER, 'type: Memory', 'title: T', 'description: d', 'status: draft'])
    const { written, changed } = both(entry, 'notes/x.md')
    expect(written?.note).toContain('[OKF] Stamped generated:')
    expect(written?.content).toContain('generated:')
    expect(changed).toBeNull()
  })

  it('DO-3 缺 description 的条目 → 只剩告警那段；content null，不盖章', () => {
    const entry = concept([MARKER, 'type: Memory', 'title: T', 'status: draft'])
    const { written, changed } = both(entry, 'notes/x.md')
    // 对照：写盘时告警 + 盖章两段
    expect(written?.note).toContain('[OKF] Stamped generated:')
    expect(changed).toEqual({
      note: `[OKF] Written with warnings:\n${DESCRIPTION_WARNING}`,
      content: null
    })
  })

  it.each([
    ['OKF 错（带自述行却缺 type）', concept([MARKER, 'title: T', 'description: d']), 'notes/x.md'],
    ['非法 agent md', INVALID_AGENT, null],
    ['展示型契约的 YAML 错', BROKEN_DISPLAY, null]
  ])('DO-4 %s：除开头外与写盘时逐字相同，content null', (_label, text, rel) => {
    const { written, changed } = both(text, rel)
    expect(written?.content).toBeNull()
    expect(changed?.content).toBeNull()
    expect(written?.note).toContain('The file was written, but')
    expect(changed?.note).toContain('The document was changed, but')
    expect(changed?.note).not.toContain('The file was written')
    expect(changed?.note).toBe(
      written!.note!.replace('The file was written', 'The document was changed')
    )
  })

  it('DO-5 解析器软提示照样整段带回，没有 Filled in for you；content null', () => {
    const agent = [
      '---',
      'shuvix: agent v1',
      'shuvix-id: nope',
      'name: a1',
      'description: d',
      '---',
      '',
      'Body.',
      ''
    ].join('\n')
    const { written, changed } = both(agent)
    expect(changed).not.toBeNull()
    expect(changed!.note).toMatch(/^\[shuvix agent v1\] Written with parser warnings:\n- /)
    expect(changed!.note).toContain("'shuvix-id' is not a valid object id")
    expect(changed!.note).not.toContain('Filled in for you')
    expect(changed!.content).toBeNull()
    expect(changed).toEqual(written)
  })

  it('LEAD 两个开头逐字钉住', () => {
    const agent = both(INVALID_AGENT)
    expect(
      agent.written!.note!.startsWith(
        '[shuvix agent v1] The file was written, but it is INVALID and will be ignored until fixed:\n- '
      )
    ).toBe(true)
    expect(
      agent.changed!.note!.startsWith(
        '[shuvix agent v1] The document was changed, but it is INVALID and will be ignored until fixed:\n- '
      )
    ).toBe(true)

    const okf = both(concept([MARKER, 'title: T', 'description: d']), 'notes/x.md')
    expect(okf.written!.note).toBe(
      "[OKF] The file was written, but it breaks the knowledge base format and will not be read as intended until fixed:\n- 'type' is required and must be a non-empty string"
    )
    expect(okf.changed!.note).toBe(
      "[OKF] The document was changed, but it breaks the knowledge base format and will not be read as intended until fixed:\n- 'type' is required and must be a non-empty string"
    )

    const display = both(BROKEN_DISPLAY)
    expect(
      display.written!.note!.startsWith(
        '[shuvix note v1] The file was written, but its frontmatter is not valid YAML'
      )
    ).toBe(true)
    expect(
      display.changed!.note!.startsWith(
        '[shuvix note v1] The document was changed, but its frontmatter is not valid YAML'
      )
    ).toBe(true)
  })
})

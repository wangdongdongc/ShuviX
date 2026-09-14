/**
 * 写后审阅（reviewShuvixMdWrite）—— 展示型契约的 YAML 语法兜底。
 *
 * 直接动机：wiki 条目横幅曾含裸标量「冒号+空格」，每个生成条目 frontmatter 都非法，
 * 而 wiki-* 的 validate 返回 unknown、写后审阅静默放行 —— agent 全程无从自纠。
 * 这里钉住：unknown 类型的 frontmatter 语法错必须随工具 result 回执。
 */
import { describe, it, expect } from 'vitest'
import { parseOkfText } from '../knowledge/okfCodec'
import { reviewShuvixMdWrite } from '../shuvixMdWrite'

const CTX = { today: '2026-08-28' }

const wikiEntry = (description: string): string =>
  [
    '---',
    'shuvix: wiki-entry v1',
    'name: 测试条目',
    `description: ${description}`,
    'shuvix-wiki-content: |-',
    '  恰好一段话。',
    'shuvix-wiki-status: draft',
    '---',
    '',
    '正文笔记'
  ].join('\n')

describe('reviewShuvixMdWrite — 展示型契约的 YAML 语法兜底', () => {
  it('wiki 条目 frontmatter 语法错（裸标量冒号）→ 回执 note，不动文件', () => {
    const out = reviewShuvixMdWrite(
      wikiEntry('your own notes: the agent reads them'),
      'entry.md',
      CTX
    )
    expect(out).not.toBeNull()
    expect(out!.note).toContain('not valid YAML')
    expect(out!.note).toContain('[shuvix wiki-entry v1]')
    expect(out!.content).toBeNull()
  })

  it('合法 wiki 条目：updated 由宿主盖章（带引号 —— 裸日期会被 YAML 读成时间戳）', () => {
    const out = reviewShuvixMdWrite(wikiEntry('plain banner without yaml hazards'), 'entry.md', CTX)
    expect(out!.note).toContain('Filled in for you: shuvix-wiki-updated: 2026-08-28')
    expect(out!.content).toContain("shuvix-wiki-updated: '2026-08-28'")
    // 盖章不越界：frontmatter 之下的用户笔记原样保留
    expect(out!.content).toContain('正文笔记')
  })

  it('updated 已是今天（带引号）→ null，不产生无意义改写', () => {
    const withToday = wikiEntry('plain banner').replace(
      'shuvix-wiki-status: draft',
      "shuvix-wiki-status: draft\nshuvix-wiki-updated: '2026-08-28'"
    )
    expect(reviewShuvixMdWrite(withToday, 'entry.md', CTX)).toBeNull()
  })

  it('updated 过期（或裸写）→ 刷新为今天并规范成带引号', () => {
    const stale = wikiEntry('plain banner').replace(
      'shuvix-wiki-status: draft',
      'shuvix-wiki-status: draft\nshuvix-wiki-updated: 2024-01-01'
    )
    const out = reviewShuvixMdWrite(stale, 'entry.md', CTX)
    expect(out!.content).toContain("shuvix-wiki-updated: '2026-08-28'")
    expect(out!.content).not.toContain('2024-01-01')
  })

  it('chart 等其它 unknown 类型同样兜底', () => {
    const chart = ['---', 'shuvix: chart v1', 'name: [unclosed', '---', 'body'].join('\n')
    const out = reviewShuvixMdWrite(chart, 'chart.md', CTX)
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
})

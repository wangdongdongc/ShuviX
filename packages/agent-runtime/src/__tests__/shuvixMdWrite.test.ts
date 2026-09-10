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
 * OKF 知识库分支（reviewKnowledgeWrite）—— 没有 shuvix 标记、但落在知识库根目录下的 md：
 * 一致性校验作为回执带回；合规的概念**行级** upsert `generated`（注释 / 键序 / 未知键 / 正文 /
 * 行尾 / BOM 全部原样），`verified` 从不碰；保留文件只回执规则、不盖章。
 */
describe('reviewShuvixMdWrite — OKF 知识库分支', () => {
  const KB = { root: '/kb', actor: 'shuvix-work/gpt-5', now: '2026-09-09T08:12:03.000Z' }
  const STAMP = 'generated: { by: "shuvix-work/gpt-5", at: "2026-09-09T08:12:03.000Z" }'
  const STAMP_NOTE =
    '[OKF] Stamped generated: { by: shuvix-work/gpt-5, at: 2026-09-09T08:12:03.000Z } — never write generated or verified yourself; the user reviews drafts in the knowledge page.'
  const ERROR_HEAD =
    '[OKF] The file was written into the knowledge base, but it is NOT a valid entry and will be ignored until fixed:'
  const DESCRIPTION_WARNING = "- 'description' (one line) is recommended — it is what indexes show"

  const concept = (lines: string[], body = 'body'): string =>
    ['---', ...lines, '---', '', body, ''].join('\n')
  const VALID = ['type: Memory', 'title: T', 'description: d', 'status: draft']
  const review = (text: string, path: string | undefined): ReturnType<typeof reviewShuvixMdWrite> =>
    reviewShuvixMdWrite(text, 'x', { today: '2026-09-09', path, knowledge: KB })

  it('MW-1 分支选择表：无 knowledge / 无 path / 根目录外 / 同前缀兄弟目录 → null；带 shuvix 标记走旧记忆分支', () => {
    expect(
      reviewShuvixMdWrite(concept(VALID), 'x', { today: '2026-09-09', path: '/kb/global/x.md' })
    ).toBeNull()
    expect(review(concept(VALID), undefined)).toBeNull()
    expect(review(concept(VALID), '/elsewhere/x.md')).toBeNull()
    expect(review(concept(VALID), '/kb-other/x.md')).toBeNull()

    // 有 shuvix 标记的文件不是 OKF 概念 —— 即便落在根目录下也走各自契约的旧分支
    const memory =
      '---\nshuvix: memory v1\nname: x\ndescription: d\nshuvix-memory-recall: r\n---\nbody\n'
    const out = review(memory, '/kb/global/x.md')!
    expect(out.note).toContain('[shuvix memory v1] Filled in')
    expect(out.note).not.toContain('[OKF]')
    expect(out.content).toContain('shuvix-memory-updated')
    expect(out.content).not.toContain('generated')
  })

  /**
   * 知识库条目自己也带标记（`shuvix: okf v0.2`）—— 分支选择不能再靠「没有标记」，否则我们
   * 自己写出去的每一份条目都会掉进契约分支、既不盖章也不回执。判别只看类型段不看版本。
   */
  it('MW-1 带 okf 自述行的条目走 OKF 分支（照常盖章 / 回执），落在根目录外仍不管', () => {
    const marked = concept(['shuvix: okf v0.2', ...VALID])
    const out = review(marked, '/kb/global/x.md')!
    expect(out.note).toBe(STAMP_NOTE)
    expect(out.content).toContain('generated:')
    // 自述行原样留着（行级 upsert 不重排 frontmatter）
    expect(out.content).toContain('shuvix: okf v0.2')

    expect(review(concept(['shuvix: okf v1', ...VALID]), '/kb/global/x.md')!.note).toBe(STAMP_NOTE)
    expect(review(marked, '/elsewhere/x.md')).toBeNull()
  })

  it('MW-2 error 回执：文件已写但不是合法条目 —— 无 frontmatter / 缺 type 各一条 bullet，不动文件', () => {
    const none = review('# plain\n\nbody\n', '/kb/global/x.md')!
    expect(none.note).toBe(
      `${ERROR_HEAD}\n- no YAML frontmatter block (an OKF concept starts with \`---\`)`
    )
    expect(none.content).toBeNull()

    const noType = review(concept(['title: T', 'description: d']), '/kb/global/x.md')!
    expect(noType.note).toBe(`${ERROR_HEAD}\n- 'type' is required and must be a non-empty string`)
    expect(noType.content).toBeNull()
  })

  it('MW-3 保留文件：子目录 index.md 带 frontmatter 只回执规则；根 index.md 与 log.md 一律 null，永不盖章', () => {
    const fm = '---\nokf_version: "0.2"\n---\n\n## Entries\n'
    const sub = review(fm, '/kb/global/index.md')!
    expect(sub.note).toBe(
      `${ERROR_HEAD}\n- index.md below the bundle root must not carry frontmatter`
    )
    expect(sub.content).toBeNull()
    expect(review(fm, '/kb/index.md')).toBeNull()
    expect(review('## 2026-09-09\n\n- x\n', '/kb/log.md')).toBeNull()
    expect(review('---\ntype: Memory\n---\n\n- x\n', '/kb/log.md')).toBeNull()
  })

  it('MW-4 首次盖章：注释 / 键序 / 未知键 / 正文 / CRLF / BOM 逐字节原样，只在闭合线前插一行', () => {
    const text =
      '﻿---\r\n# note\r\ntype: Memory\r\ntitle: T\r\ndescription: d\r\nstatus: draft\r\ncustom: kept\r\n---\r\n\r\nbody\r\n'
    const out = review(text, '/kb/global/x.md')!
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
      '/kb/global/x.md'
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
      '/kb/global/x.md'
    )!
    expect(block.content).toBe(
      `---\ntype: Memory\ntitle: T\ndescription: d\nstatus: draft\n${STAMP}\nverified:\n  by: human:me\n  at: 2026-09-01T00:00:00Z\n---\n\nbody\n`
    )
    const fields = parseOkfText(block.content!)!.fields
    expect(fields.generated).toEqual({ by: 'shuvix-work/gpt-5', at: '2026-09-09T08:12:03.000Z' })
    expect(fields.verified).toEqual({ by: 'human:me', at: '2026-09-01T00:00:00Z' })
  })

  it('MW-6 无事可做 → null；只有告警 → 回执不改文件；告警 + 盖章 → 两段回执以空行相隔、content 回写', () => {
    expect(review(concept([...VALID, STAMP]), '/kb/global/x.md')).toBeNull()

    const warned = review(
      concept(['type: Memory', 'title: T', 'status: draft', STAMP]),
      '/kb/global/x.md'
    )!
    expect(warned.note).toBe(`[OKF] Written with warnings:\n${DESCRIPTION_WARNING}`)
    expect(warned.content).toBeNull()

    const both = review(
      concept([
        'type: Memory',
        'title: T',
        'status: draft',
        'generated: { by: "old", at: "2020-01-01T00:00:00Z" }'
      ]),
      '/kb/global/x.md'
    )!
    expect(both.note).toBe(`[OKF] Written with warnings:\n${DESCRIPTION_WARNING}\n\n${STAMP_NOTE}`)
    expect(both.content).toContain(STAMP)
  })
})

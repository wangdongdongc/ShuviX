/**
 * 写后审阅（reviewShuvixMdWrite）—— 展示型契约的 YAML 语法兜底。
 *
 * 直接动机：wiki 条目横幅曾含裸标量「冒号+空格」，每个生成条目 frontmatter 都非法，
 * 而 wiki-* 的 validate 返回 unknown、写后审阅静默放行 —— agent 全程无从自纠。
 * 这里钉住：unknown 类型的 frontmatter 语法错必须随工具 result 回执。
 */
import { describe, it, expect } from 'vitest'
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

  it('合法 wiki 条目 → null（无话可说，不打扰）', () => {
    expect(
      reviewShuvixMdWrite(wikiEntry('plain banner without yaml hazards'), 'entry.md', CTX)
    ).toBeNull()
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

/**
 * okfCodec —— 社区包 core-okf 的唯一接入面。
 *
 * 钉两件事：解析走真 YAML（core-okf 自带解析器读不对块序列，这是引 `yaml` 的全部理由），
 * 构建交给 core-okf 且 undefined/null 键被剔除（core-okf 会把它们当值写出）。
 * 信任分档 / 过期判断 / 链接提取的语义即规范，这里只钉本仓依赖的边界。
 */
import { describe, it, expect } from 'vitest'
import {
  buildOkfConceptDocument,
  deriveTrustTier,
  extractConceptLinks,
  isStaleAfter,
  parseOkfText,
  serializeOkfFrontmatter
} from '../okfCodec'

describe('parseOkfText — null 与拆分的分界', () => {
  it('OC-1 无 frontmatter / 空 frontmatter / YAML 语法错 / 列表 / 合法映射（块序列成真对象）', () => {
    expect(parseOkfText('# plain\n\nbody')).toBeNull()
    // 空 frontmatter 合法：全字段缺省，正文照给
    expect(parseOkfText('---\n---\nbody')).toEqual({ fields: {}, body: 'body' })
    expect(parseOkfText('---\n[unclosed\n---\nbody')).toBeNull()
    expect(parseOkfText('---\n- a\n- b\n---\nbody')).toBeNull()

    const text = [
      '---',
      'type: Memory',
      'sources:',
      '  - id: s1',
      '    resource: shuvix://session/abc',
      'verified:',
      '  - by: human:me',
      '    at: 2026-09-01T00:00:00Z',
      '---',
      'body'
    ].join('\n')
    const split = parseOkfText(text)!
    expect(split).not.toBeNull()
    // core-okf 的解析器会把这个块序列读成 ["id: s1"]、resource 漏到顶层 —— 真 YAML 给嵌套对象
    expect(split.fields.sources).toEqual([{ id: 's1', resource: 'shuvix://session/abc' }])
    expect(typeof (split.fields.sources as { resource: unknown }[])[0].resource).toBe('string')
    expect(split.fields.verified).toEqual([{ by: 'human:me', at: '2026-09-01T00:00:00Z' }])
    expect(split.fields).not.toHaveProperty('resource')
    expect(split.body).toBe('body')
  })
})

describe('serializeOkfFrontmatter / buildOkfConceptDocument — 剔空键，形状归 core-okf', () => {
  it('OC-2 undefined / null 键不写出；文档 = frontmatter + 空行 + 正文（原样）', () => {
    const fields = {
      type: 'Memory',
      title: 'T',
      description: undefined,
      tags: null,
      status: 'draft'
    }
    expect(serializeOkfFrontmatter(fields)).toBe(
      '---\ntype: Memory\ntitle: T\nstatus: draft\n---\n'
    )
    expect(buildOkfConceptDocument(fields, 'b')).toBe(
      '---\ntype: Memory\ntitle: T\nstatus: draft\n---\n\nb'
    )
    expect(buildOkfConceptDocument(fields, 'b\n')).toBe(
      '---\ntype: Memory\ntitle: T\nstatus: draft\n---\n\nb\n'
    )
    // 空正文：文档以 `---\n\n` 收尾（core-okf 的形状，宿主投影按它比对）
    expect(buildOkfConceptDocument(fields, '')).toBe(
      '---\ntype: Memory\ntitle: T\nstatus: draft\n---\n\n'
    )
    const out = serializeOkfFrontmatter(fields)
    expect(out).not.toContain('description')
    expect(out).not.toContain('tags')
  })
})

describe('extractConceptLinks — 只取指向 .md 的标准 markdown 链接', () => {
  it('OC-3 URL / 图片 / mailto / [[wikilink]] 不算；锚点剥掉；扩展名大小写不敏感', () => {
    const body = [
      '[A](/global/a.md) and [B](./b.md#sec) and [img](pic.png)',
      '[w](https://x/y.md) [m](mailto:a@b) [[wikilink]] [C](sub\\c.MD)'
    ].join('\n')
    // [[wikilink]] 可读不写（设计 D7）：它不是 OKF 消费者认的链接，永远不被提取
    expect(extractConceptLinks(body)).toEqual([
      { text: 'A', path: '/global/a.md' },
      { text: 'B', path: './b.md' },
      { text: 'C', path: 'sub\\c.MD' }
    ])
  })
})

describe('deriveTrustTier / isStaleAfter — 薄包装的边界', () => {
  it('OC-4 信任档：空 → unverified；非 human actor → machine-confirmed；human: → human-reviewed', () => {
    expect(deriveTrustTier([])).toBe('unverified')
    expect(deriveTrustTier([{ by: 'agent:x', at: '2026-09-01T00:00:00Z' }])).toBe(
      'machine-confirmed'
    )
    expect(deriveTrustTier([{ by: 'human:me', at: '2026-09-01T00:00:00Z' }])).toBe('human-reviewed')
  })

  it('OC-4 过期：过去为 stale，未来 / 缺省 / 非日期不算；stale_after 当天零点即算（>= 语义）', () => {
    const now = new Date('2026-09-09T00:00:00Z')
    expect(isStaleAfter('2026-01-01', now)).toBe(true)
    expect(isStaleAfter('2027-01-01', now)).toBe(false)
    expect(isStaleAfter(undefined, now)).toBe(false)
    expect(isStaleAfter('not-a-date', now)).toBe(false)
    // 边界钉死：围栏的 (stale) 标注从 stale_after 当天开始亮，不是过了那天才亮
    expect(isStaleAfter('2026-09-09', now)).toBe(true)
    expect(isStaleAfter('2026-09-09', new Date('2026-09-08T23:59:59.999Z'))).toBe(false)
    // core-okf 只认 YYYY-MM-DD：带时间的 ISO 串永远不算过期（校验器放行它，但围栏不会标 stale）
    expect(isStaleAfter('2026-01-01T00:00:00Z', now)).toBe(false)
  })
})

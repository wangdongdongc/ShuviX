/**
 * conceptFile —— 一个 .md = 一个 concept 的解析与组装。
 *
 * 唯一会返回 null 的情况是「这不是一份 OKF 概念」（没有 frontmatter 映射 / type 缺失或非空串 /
 * 带 shuvix 标记）；其余字段形状不符一律取缺省并经 warn 报告 —— 用户要在 Obsidian 里改的文件，
 * 解析失败不能让它从视图里消失。组装侧钉键序与归一化：写出去的每一份都长一样。
 */
import { describe, it, expect } from 'vitest'
import {
  buildConceptText,
  isOkfConceptText,
  isVerificationCurrent,
  normalizeKnowledgeType,
  normalizeSources,
  normalizeVerified,
  parseConceptText
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
      // 旧契约文件（agent / policy / 旧记忆 / 旧 wiki）即便带 type 也不是 OKF 概念
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

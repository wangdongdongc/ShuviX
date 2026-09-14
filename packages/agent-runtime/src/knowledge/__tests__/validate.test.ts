/**
 * validate —— OKF 一致性校验（规范 §7 三条规则 + 本仓的软告警）。
 *
 * 校验是回执不是准入：error 只说明「这份文件不当概念对待」，warning 是「合规但值得修」。
 * 钉：保留文件的特例、三条 error 各自短路、软告警表、链接解析表、整包校验的概念集合。
 */
import { describe, it, expect } from 'vitest'
import {
  isReservedFile,
  resolveLinkTarget,
  validateBundleFiles,
  validateConceptText
} from '../validate'

const doc = (frontmatter: string[], body = 'body'): string =>
  ['---', ...frontmatter, '---', '', body].join('\n')

describe('isReservedFile + 保留文件规则', () => {
  it('VA-1 index.md / log.md（任何目录）保留；根级普通文件与 index.markdown 不是', () => {
    expect(isReservedFile('index.md')).toBe(true)
    expect(isReservedFile('global/index.md')).toBe(true)
    expect(isReservedFile('log.md')).toBe(true)
    expect(isReservedFile('NOTES.md')).toBe(false)
    expect(isReservedFile('index.markdown')).toBe(false)
  })

  it('VA-1 保留名不是条目：validateConceptText 对 index.md / log.md 一律不出诊断（index / log 不再维护，没有规则可查）', () => {
    expect(validateConceptText('---\nokf_version: "0.2"\n---\n\n## X\n', 'index.md')).toEqual([])
    expect(
      validateConceptText('---\nokf_version: "0.2"\n---\n\n## X\n', 'global/index.md')
    ).toEqual([])
    expect(validateConceptText('## Entries\n\n* [A](a.md)\n', 'global/index.md')).toEqual([])
    expect(validateConceptText('---\nanything: 1\n---\nwhatever', 'log.md')).toEqual([])
    expect(validateConceptText('## 2026-09-09\n\n- x\n', 'log.md')).toEqual([])
  })
})

describe('三条 OKF error，各自短路', () => {
  const cases: [string, string, RegExp][] = [
    ['no frontmatter', '# just markdown\n', /no YAML frontmatter block/],
    ['unparseable yaml', doc(['[unclosed']), /not parseable YAML/],
    ['frontmatter is a list', doc(['- a', '- b']), /not parseable YAML/],
    ['type missing', doc(['title: T']), /'type' is required/],
    ['type is a number', doc(['type: 3']), /'type' is required/],
    ['type is blank', doc(["type: '  '"]), /'type' is required/]
  ]

  it.each(cases)('VA-2 %s → 恰一条 error，路径归一，无 warning 混入', (_label, text, re) => {
    const out = validateConceptText(text, '/global/x.md')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ path: 'global/x.md', level: 'error' })
    expect(out[0].message).toMatch(re)
  })
})

describe('软告警表', () => {
  it('VA-3 只有 type：建议 title 与 description；显式写了等于 stem 的 title 就不再提 title', () => {
    const bare = validateConceptText(doc(['type: Memory']), 'global/x.md')
    expect(bare.map((d) => d.level)).toEqual(['warning', 'warning'])
    expect(bare[0].message).toBe("'title' is recommended")
    expect(bare[1].message).toContain("'description' (one line) is recommended")

    const explicit = validateConceptText(doc(['type: Memory', 'title: x']), 'global/x.md')
    expect(explicit.map((d) => d.message)).toEqual([
      "'description' (one line) is recommended — it is what list and search show"
    ])
  })

  it('VA-3 stale_after / generated.at / status / verified 形状问题各一条 warning，零 error', () => {
    const out = validateConceptText(
      doc([
        'type: Memory',
        'title: T',
        'description: d',
        'stale_after: soon',
        'generated: {by: a, at: nope}',
        'status: reviewed',
        'verified: [{by: x}]'
      ]),
      'global/x.md'
    )
    expect(out.every((d) => d.level === 'warning')).toBe(true)
    expect(out.map((d) => d.message).sort()).toEqual(
      [
        "'stale_after' should be an ISO 8601 date (YYYY-MM-DD)",
        "'generated.at' should be an ISO 8601 timestamp",
        "'status' must be one of draft / stable / deprecated; treated as stable",
        "'verified' entries must be mappings with 'by' and 'at'"
      ].sort()
    )
  })

  it('VA-3 合规且齐全的概念：零诊断', () => {
    expect(
      validateConceptText(
        doc([
          'type: Memory',
          'title: T',
          'description: d',
          'status: draft',
          'stale_after: 2026-12-31',
          'generated: { by: "shuvix-work/gpt-5", at: "2026-09-09T08:12:03.000Z" }'
        ]),
        'global/x.md'
      )
    ).toEqual([])
  })

  it('VA-4 bundle 里带 shuvix 标记的文件：不是 error，也不是概念', () => {
    const { diagnostics, concepts } = validateBundleFiles([
      { path: 'global/old.md', text: doc(['shuvix: memory v1', 'type: Memory', 'title: Old']) }
    ])
    expect(diagnostics.filter((d) => d.path === 'global/old.md' && d.level === 'error')).toEqual([])
    expect(concepts).toEqual([])
  })
})

describe('resolveLinkTarget', () => {
  it('VA-5 从 projects/acme/y.md 出发：绝对 / 相对 / 上级 / 越界 / 纯锚点 / 反斜杠 / 带锚点', () => {
    const from = 'projects/acme/y.md'
    const table: [string, string | null][] = [
      ['/global/a.md', 'global/a.md'],
      ['b.md', 'projects/acme/b.md'],
      ['./b.md', 'projects/acme/b.md'],
      ['../x.md', 'projects/x.md'],
      ['../../global/x.md', 'global/x.md'],
      ['../../../x.md', null],
      ['#anchor', null],
      ['sub\\c.md', 'projects/acme/sub/c.md'],
      ['b.md#h', 'projects/acme/b.md']
    ]
    for (const [link, expected] of table) {
      expect(resolveLinkTarget(from, link), link).toBe(expected)
    }
  })

  it('VA-5 从根级文件出发：相对即根下，上级越界', () => {
    expect(resolveLinkTarget('NOTES.md', 'global/x.md')).toBe('global/x.md')
    expect(resolveLinkTarget('NOTES.md', '../x.md')).toBeNull()
  })
})

describe('validateBundleFiles — 链接可解析 + 概念集合', () => {
  it('VA-6 只有 OKF 条目里指向 bundle 内却不存在的链接告警；普通笔记（没有 type）不报 error、不进概念集、链接也不查；保留名不进概念集；路径归一后匹配', () => {
    const files = [
      {
        path: 'global/a.md',
        text: doc(
          ['type: Memory', 'title: A', 'description: da'],
          '[b](b.md) [c](/wiki/auth/c.md) [gone](/global/zzz.md) [url](https://x/y.md) [img](p.png)'
        )
      },
      { path: '/global/b.md', text: doc(['type: Memory', 'title: B', 'description: db']) },
      { path: 'wiki/auth/c.md', text: doc(['type: Concept', 'title: C', 'description: dc']) },
      { path: 'global/index.md', text: '## Entries\n\n* [A](a.md)\n' },
      {
        path: 'global/bad.md',
        text: doc(['title: no type here'], '[a](/global/a.md)')
      }
    ]
    const { diagnostics, concepts } = validateBundleFiles(files)
    expect(diagnostics.filter((d) => d.level === 'warning')).toEqual([
      {
        path: 'global/a.md',
        level: 'warning',
        message: "link to '/global/zzz.md' does not resolve inside the bundle"
      }
    ])
    expect(diagnostics.filter((d) => d.level === 'error')).toEqual([])
    expect(concepts.map((c) => c.path)).toEqual(['global/a.md', 'global/b.md', 'wiki/auth/c.md'])
  })
})

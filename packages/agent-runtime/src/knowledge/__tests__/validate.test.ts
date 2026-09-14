/**
 * validate —— OKF 一致性校验（规范 §7 三条规则 + 本仓的软告警）。
 *
 * 校验是回执不是准入：error 只说明「这份文件不当概念对待」，warning 是「合规但值得修」。
 * 钉：保留文件的特例、三条 error 各自短路、软告警表、链接解析表、整包校验的概念集合。
 *
 * 读宽写严（设计附录 L）：validateKnowledgeText 按文件自称什么分档 —— 带自述行或有 type 的严格查，
 * 普通笔记只查 frontmatter 语法；保留名按内容形状（isProjectionText）分开 ShuviX 早先生成的旧产物
 * 与用户手写的同名笔记。旧产物直接用当年投影的构建器（core-okf）造。
 */
import { describe, it, expect } from 'vitest'
import { buildIndexMd, buildLogMd, buildRootIndexMd } from '@equationalapplications/core-okf'
import {
  isProjectionText,
  isReservedFile,
  resolveLinkTarget,
  validateBundleFiles,
  validateConceptText,
  validateKnowledgeText,
  type KnowledgeDiagnostic
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

/** 当年投影写出的根 index：Entries 节覆盖标题转义 / 描述 / 路径里的空格与一层括号，另带 Sections 节 */
const ROOT_INDEX = buildRootIndexMd('0.2', [
  {
    heading: 'Entries',
    entries: [
      { path: 'token.md', title: 'Token [refresh] pitfalls', description: 'when touching auth' },
      { path: 'dep.md', title: 'Dep (deprecated)' },
      { path: 'zh.md', title: '中文标题', description: '改动登录时看' },
      { path: 'bs.md', title: 'back\\slash' },
      { path: 'with space.md', title: 'With space', description: 'a - b' },
      { path: 'foo (1).md', title: 'Foo' }
    ]
  },
  { heading: 'Sections', entries: [{ path: 'sub/index.md', title: 'sub' }] }
])

const SYNTAX_WARNING =
  'frontmatter is not parseable YAML, or is not a key/value mapping — ShuviX shows a syntax error instead of its fields until it is fixed'
const UNPARSEABLE = 'frontmatter is not parseable YAML, or is not a key/value mapping'
const TYPE_REQUIRED = "'type' is required and must be a non-empty string"
const UNCLOSED = 'the frontmatter block is never closed — end it with a `---` line'
const NO_DESCRIPTION = "'description' (one line) is recommended — it is what list and search show"

const warningAt = (path: string, message = SYNTAX_WARNING): KnowledgeDiagnostic => ({
  path,
  level: 'warning',
  message
})
const errorAt = (path: string, message: string): KnowledgeDiagnostic => ({
  path,
  level: 'error',
  message
})

describe('isProjectionText — ShuviX 早先生成的 index / log 按形状认', () => {
  it('VA-7 isProjectionText：旧投影的真实产物认作生成形状', () => {
    const unquoted = ROOT_INDEX.replace('okf_version: "0.2"', 'okf_version: 0.2')
    // 替换真的发生了：否则「不带引号」这一行测的仍是带引号的原文
    expect(unquoted).toContain('\nokf_version: 0.2\n')

    const cases: [string, string, string][] = [
      ['根 index（Entries 节 + Sections 节）', 'index.md', ROOT_INDEX],
      ['空库的根 index', 'index.md', buildRootIndexMd('0.2', [])],
      [
        '无 frontmatter 的子目录 index（描述含换行）',
        'sub/index.md',
        buildIndexMd([
          {
            heading: 'Entries',
            entries: [{ path: 'x.md', title: 'X', description: 'line one\nline two' }]
          }
        ])
      ],
      [
        '更早一期的节标题',
        'index.md',
        '## Global memory\n\n* [A](a.md) - da\n\n## Bundle\n\n* [B](b.md)\n'
      ],
      [
        'log',
        'log.md',
        buildLogMd([
          { date: '2026-09-14', text: '**Creation** /a.md — T · by shuvix-work/gpt-5' },
          { date: '2026-09-13', text: '**Update** /b.md' }
        ])
      ],
      ['okf_version 不带引号', 'index.md', unquoted]
    ]
    for (const [label, path, text] of cases) {
      expect(isProjectionText(path, text), label).toBe(true)
      expect(isProjectionText(path, text.replace(/\n/g, '\r\n')), `${label}（CRLF）`).toBe(true)
    }
  })
})

describe('validateKnowledgeText — 按文件自称什么分档', () => {
  /** 「普通」路径：不是保留名 */
  const NOTE = 'notes/x.md'

  it('VA-8 validateKnowledgeText 分档表', () => {
    const table: [string, string, KnowledgeDiagnostic[]][] = [
      // 普通笔记：只查 frontmatter 语法
      ['# x\n', NOTE, []],
      ['---\ntitle: T\n---\nbody\n', NOTE, []],
      ['---\ntitle: [x\n---\nbody\n', NOTE, [warningAt(NOTE)]],
      ['---\n- a\n- b\n---\nbody\n', NOTE, [warningAt(NOTE)]],
      // 带自述行：按原文行认出是条目，严格查
      ['---\nshuvix: okf v0.2\ntype: [x\n---\nbody\n', NOTE, [errorAt(NOTE, UNPARSEABLE)]],
      ['---\nshuvix: "okf v0.2"\ntype: [x\n---\nbody\n', NOTE, [errorAt(NOTE, UNPARSEABLE)]],
      ['---\nshuvix: okf v0.2\ntitle: T\n---\n', NOTE, [errorAt(NOTE, TYPE_REQUIRED)]],
      ['---\nshuvix: okf v0.2\ntype: 5\n---\n', NOTE, [errorAt(NOTE, TYPE_REQUIRED)]],
      // 闭合的 `---` 被删掉：有自述行 → error；没有 → 普通文本
      ['---\nshuvix: okf v0.2\ntype: Memory\ntitle: T\nbody\n', NOTE, [errorAt(NOTE, UNCLOSED)]],
      ['---\ntitle: T\nbody\n', NOTE, []],
      // 外来的 OKF 条目（有 type、没有自述行）：同样的检查，只可能出警告
      ['---\ntype: Memory\ntitle: T\n---\n', NOTE, [warningAt(NOTE, NO_DESCRIPTION)]],
      ['---\ntype: 5\n---\n', NOTE, []],
      // 别家标记
      ['---\nshuvix: agent v1\ntype: Memory\n---\n', NOTE, []],
      ['---\nshuvix: agent v1\nname: [x\n---\n', NOTE, [warningAt(NOTE)]],
      // 保留名：生成形状不查；手写的按普通笔记查，带自述行也不当条目
      ['## Entries\n\n* [A](a.md)\n', 'index.md', []],
      ['---\ntitle: [x\n---\n# Home\n', 'index.md', [warningAt('index.md')]],
      ['---\nshuvix: okf v0.2\ntype: Memory\ntitle: T\n---\n# x\n', 'log.md', []]
    ]
    for (const [text, path, expected] of table) {
      expect(validateKnowledgeText(text, path), `${path} ${JSON.stringify(text)}`).toEqual(expected)
    }

    // 诊断里的 path 归一
    expect(validateKnowledgeText('---\ntitle: [x\n---\nbody\n', '/sub\\a.md')).toEqual([
      warningAt('sub/a.md')
    ])
    expect(validateKnowledgeText('---\nshuvix: okf v0.2\ntitle: T\n---\n', '/sub\\a.md')).toEqual([
      errorAt('sub/a.md', TYPE_REQUIRED)
    ])
  })
})

describe('isProjectionText — 用户手写的同名文件', () => {
  it('VA-9 isProjectionText：用户手写的同名文件不是生成形状', () => {
    const cases: [string, string, string][] = [
      ['一级标题的首页', 'index.md', '# Home\n'],
      ['用 - 列表写的目录', 'index.md', '## Reading\n\n- [Book](book.md)\n'],
      ['frontmatter 里有别的键', 'index.md', '---\ntitle: Home\n---\n## A\n'],
      ['生成的根 index 末尾追加了一行', 'index.md', `${ROOT_INDEX}my own line\n`],
      ['非保留名', 'notes.md', '## Entries\n'],
      ['手写日记', 'log.md', '## 2026-09-14\n\n- ran 5km\n'],
      ['空的 index', 'index.md', ''],
      ['只有空白的 index', 'index.md', '  \n\n'],
      ['空的 log', 'log.md', ''],
      ['只有空白的 log', 'log.md', ' \n\t\n']
    ]
    for (const [label, path, text] of cases) {
      expect(isProjectionText(path, text), label).toBe(false)
    }
    // 对照：只有 frontmatter 的根 index（空库）是生成的
    expect(isProjectionText('index.md', '---\nokf_version: "0.2"\n---\n')).toBe(true)
  })
})

describe('validateBundleFiles — 读宽写严', () => {
  it('VA-10 validateBundleFiles：只查概念；保留名即便有 type 也不进概念集', () => {
    const { diagnostics, concepts } = validateBundleFiles([
      { path: 'broken.md', text: '---\ntitle: [x\n---\nbody\n' },
      { path: 'marked.md', text: '---\nshuvix: okf v0.2\ntitle: T\n---\nbody\n' },
      { path: 'index.md', text: '---\ntype: Memory\ntitle: Home\n---\n[gone](/nope.md)\n' },
      { path: 'plain.md', text: '# Plain\n\n[gone](/missing.md)\n' }
    ])
    // 恰这两条：index.md 与 plain.md 里的断链都不报
    expect(diagnostics).toEqual([warningAt('broken.md'), errorAt('marked.md', TYPE_REQUIRED)])
    expect(concepts).toEqual([])
  })
})

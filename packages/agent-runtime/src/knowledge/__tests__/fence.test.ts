/**
 * `<knowledge>` 围栏正文的守护测试（对位 memory/__tests__/memoryIndex.test.ts）。
 *
 * 这份围栏每个会话必付，而它的成败全在几处措辞上 —— 都是散文，改坏了不会有任何编译
 * 或运行期报错。沿用旧记忆索引实测过的两条：条目标识用**路径**（模型拿不到路径就拼不出
 * read 参数），表头写明「动手前先对一遍索引」。预算规则（pinned 全量 / 索引截断 / wiki 只给
 * 主题）与三种写入段口吻也在这里钉死。
 */
import { describe, it, expect } from 'vitest'
import type { KnowledgeConcept } from '../conceptFile'
import { renderKnowledgeFence, type KnowledgeFenceInput } from '../fence'

const ROOT = '/Users/me/.shuvix/knowledge'
const NOW = new Date('2026-09-09T12:00:00Z')

function concept(path: string, overrides: Partial<KnowledgeConcept> = {}): KnowledgeConcept {
  return {
    path,
    type: 'Memory',
    title: 'Title',
    description: 'desc',
    tags: [],
    status: 'stable',
    sources: [],
    verified: [],
    pinned: false,
    fields: {},
    body: 'body',
    ...overrides
  }
}

function render(overrides: Partial<KnowledgeFenceInput> = {}): string {
  return renderKnowledgeFence({
    root: ROOT,
    scopes: [{ label: 'global', dir: 'global' }],
    pinned: [],
    index: [],
    now: NOW,
    writing: 'none',
    ...overrides
  })
}

const section = (text: string, heading: string): string => {
  const start = text.indexOf(heading)
  if (start < 0) return ''
  const next = text.indexOf('\n## ', start + heading.length)
  return next < 0 ? text.slice(start) : text.slice(start, next)
}

describe('表头', () => {
  it('FE-1 根路径给一次（尾斜杠剥掉）、作用域清单区分有无目录、保留实测过的召回措辞', () => {
    const out = render({
      root: `${ROOT}/`,
      scopes: [
        { label: 'global', dir: 'global' },
        { label: 'project "acme"', dir: null },
        { label: 'this session', dir: 'projects/acme/sessions' }
      ]
    })
    expect(out).toContain(`Knowledge base root: ${ROOT} —`)
    expect(out).not.toContain(`${ROOT}/ —`)
    expect(out).toContain(
      'Scopes in this session: global (/global), project "acme" (no entries yet), this session (/projects/acme/sessions).'
    )
    expect(out).toContain('Before you start, check the index below')
    expect(out).toContain(`\`read\` at\n${ROOT}<path>`)
    expect(out).toContain('Entries record what was true when written')
  })

  it('FE-1 空作用域清单回落 global；零条目仍是非空文本，以空索引哨兵收尾', () => {
    const out = render({ scopes: [] })
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain('Scopes in this session: global.')
    expect(out.endsWith('## Index\n\nNo entries recorded yet.')).toBe(true)
  })
})

describe('## Always applies', () => {
  it('FE-2 常驻条目正文全量注入，以路径 + 标注为题，块间空行；无 pinned 则无此节', () => {
    const out = render({
      pinned: [
        concept('global/coding-style.md', {
          status: 'draft',
          verified: [{ by: 'human:me', at: '2026-09-02T00:00:00Z' }],
          generated: { by: 'shuvix-work/gpt-5', at: '2026-09-01T00:00:00Z' },
          body: '\nAlways two spaces.\n\n'
        }),
        concept('global/other.md', { body: 'Other rule.' })
      ]
    })
    expect(out).toContain(
      '## Always applies\n\n### /global/coding-style.md (draft, verified, 2026-09-01)\nAlways two spaces.\n\n### /global/other.md\nOther rule.'
    )
    expect(render()).not.toContain('## Always applies')
  })
})

describe('索引行标注', () => {
  const line = (c: KnowledgeConcept): string => section(render({ index: [c] }), '## Index')

  it('FE-3 无标注 / draft / verified / edited after verification / stale / 日期 / 垃圾日期', () => {
    expect(line(concept('p.md'))).toBe('## Index\n\n- /p.md — desc')
    expect(line(concept('p.md', { status: 'draft' }))).toContain('- /p.md (draft) — desc')
    const verifiedAt = [{ by: 'human:me', at: '2026-09-05T00:00:00Z' }]
    expect(line(concept('p.md', { verified: verifiedAt }))).toContain('- /p.md (verified) — desc')
    expect(
      line(
        concept('p.md', {
          verified: verifiedAt,
          generated: { by: 'g', at: '2026-09-06T00:00:00Z' }
        })
      )
    ).toContain('- /p.md (edited after verification, 2026-09-06) — desc')
    expect(line(concept('p.md', { staleAfter: '2026-01-01' }))).toContain('- /p.md (stale) — desc')
    expect(line(concept('p.md', { generated: { by: 'g', at: '2026-09-09T08:12:03Z' } }))).toContain(
      '- /p.md (2026-09-09) — desc'
    )
    expect(line(concept('p.md', { generated: { by: 'g', at: 'garbage' } }))).toBe(
      '## Index\n\n- /p.md — desc'
    )
  })

  it('FE-3 组合时顺序固定：draft, verified, stale, 日期', () => {
    const out = line(
      concept('p.md', {
        status: 'draft',
        verified: [{ by: 'human:me', at: '2026-09-09T09:00:00Z' }],
        generated: { by: 'g', at: '2026-09-09T08:12:03Z' },
        staleAfter: '2026-01-01'
      })
    )
    expect(out).toContain('- /p.md (draft, verified, stale, 2026-09-09) — desc')
  })
})

describe('索引摘要与截断', () => {
  it('FE-4 description 空回落 title，都空给占位；恰 60 条不截断，61 条截断并指向作用域 index', () => {
    expect(section(render({ index: [concept('p.md', { description: '' })] }), '## Index')).toBe(
      '## Index\n\n- /p.md — Title'
    )
    expect(
      section(render({ index: [concept('p.md', { description: '', title: ' ' })] }), '## Index')
    ).toBe('## Index\n\n- /p.md — (no description)')

    const many = (n: number): KnowledgeConcept[] =>
      Array.from({ length: n }, (_, i) => concept(`global/e${i}.md`, { description: `d${i}` }))
    const sixty = section(render({ index: many(60) }), '## Index')
    expect(sixty.split('\n').filter((l) => l.startsWith('- ')).length).toBe(60)
    expect(sixty).not.toContain('more')

    const sixtyOne = section(render({ index: many(61) }), '## Index')
    const lines = sixtyOne.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(61)
    expect(lines[60]).toBe(`- … 1 more; read the scope's index.md (e.g. ${ROOT}/global/index.md)`)
    expect(sixtyOne).not.toContain('/global/e60.md')
  })

  it('FE-4 maxIndexLines 覆盖缺省上限', () => {
    const five = Array.from({ length: 5 }, (_, i) => concept(`global/e${i}.md`))
    const out = section(render({ index: five, maxIndexLines: 2 }), '## Index')
    const lines = out.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(3)
    expect(lines[2]).toContain('- … 3 more')
  })

  it('FE-5 wiki 主题行：零条目时它就是索引（无哨兵）；空数组给哨兵；排在截断行之后', () => {
    const topics = [
      { topic: 'auth', count: 7 },
      { topic: 'infra', count: 3 }
    ]
    expect(section(render({ wikiTopics: topics }), '## Index')).toBe(
      '## Index\n\n- /wiki/ — topics: auth (7), infra (3); read /wiki/<topic>/index.md for one'
    )
    expect(render({ wikiTopics: topics })).not.toContain('No entries recorded yet.')
    expect(render({ wikiTopics: [] })).toContain('No entries recorded yet.')

    const three = Array.from({ length: 3 }, (_, i) => concept(`global/e${i}.md`))
    const out = section(render({ index: three, maxIndexLines: 1, wikiTopics: topics }), '## Index')
    const lines = out.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('- /global/e0.md — desc')
    expect(lines[1]).toMatch(/^- … 2 more; read the scope's index\.md/)
    expect(lines[2]).toMatch(/^- \/wiki\/ — topics: auth \(7\), infra \(3\)/)
  })
})

describe('## Legacy project memories (read-only)', () => {
  it('FE-6 旧记忆只读列出：绝对路径 + 召回条件（空给占位），明说不要往那里写；无旧记忆则无此节', () => {
    const out = render({
      legacy: [
        { path: '/Users/me/.shuvix/memory/pid/auth.md', recall: 'when touching auth' },
        { path: '/Users/me/.shuvix/memory/pid/b.md', recall: '  ' }
      ],
      writing: 'tool'
    })
    const legacy = section(out, '## Legacy project memories (read-only)')
    expect(legacy).toContain('Read with `read`; do not write there.')
    expect(legacy).toContain('- /Users/me/.shuvix/memory/pid/auth.md — when touching auth')
    expect(legacy).toContain('- /Users/me/.shuvix/memory/pid/b.md — (no recall condition)')
    // 这一节没有写入指令：那是 ## Writing 的事（两段「往这里写」必然写乱）
    expect(legacy).not.toContain('knowledge')
    expect(legacy).not.toContain('frontmatter')
    expect(render({ legacy: [] })).not.toContain('## Legacy')
    expect(render()).not.toContain('## Legacy')
  })
})

describe('## Writing 与分节顺序', () => {
  const full = (writing: KnowledgeFenceInput['writing']): string =>
    render({
      pinned: [concept('global/pin.md', { pinned: true })],
      index: [concept('global/a.md')],
      legacy: [{ path: '/m/a.md', recall: 'r' }],
      writing
    })

  it('FE-7 tool：教用 knowledge 工具、不得自标 verified', () => {
    const out = full('tool')
    expect(out).toContain('Call the `knowledge` tool with action "write"')
    expect(out).toContain('do not mark anything verified')
    expect(out).not.toContain('<root>')
  })

  it('FE-7 file：<root> 全部换成真实根目录，教直接写文件且不写 generated / verified', () => {
    const out = render({ root: '/kb', writing: 'file' })
    expect(out).toContain('/kb/global/')
    expect(out).toContain('/kb/projects/<slug>/')
    expect(out).not.toContain('<root>')
    expect(out).toContain('Never write `generated` or `verified`')
  })

  it('FE-7 none：没有写入段', () => {
    expect(full('none')).not.toContain('## Writing')
  })

  it('FE-7 分节顺序：表头 → Always applies → Index → Legacy → Writing，以空行相隔', () => {
    const out = full('tool')
    const order = [
      'Knowledge base root:',
      '## Always applies',
      '## Index',
      '## Legacy',
      '## Writing'
    ]
    const positions = order.map((h) => out.indexOf(h))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    for (const h of order.slice(1)) expect(out).toContain(`\n\n${h}`)
  })
})

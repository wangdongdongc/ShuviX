/**
 * 属性卡的出卡判定 —— `fallbackMarkerType` 那张判定表（白盒）。
 *
 * 知识库笔记本给编辑器传 `fallbackMarkerType: 'okf'`：OKF 按位置认条目、规范里没有标识字段，
 * 拷进用户库的 bundle 通常不带我们的自述行，不兜底就只剩一段裸 YAML。本文件钉兜底的边界：
 * 自述行永远优先；**有 `shuvix` 键就不兜底** —— 读不出的标记（`shuvix: 123`）也算，与扫描侧
 * 「别家契约、不算条目」同口径；没有 frontmatter 就没有卡；不传兜底时无标记的文件零装饰。
 *
 * 只建 EditorState、不挂 EditorView（node 环境即可）：卡片是 StateField 经 `EditorView.decorations`
 * 提供的块级替换装饰，焦点镜像初值为 false，所以刚建出来的 state 就是折叠态的卡。↑ 键与出卡
 * 共用同一个判定，但要 EditorView 才跑得动，不在本文件测。
 */
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ShuvixMarker } from '@shuvix/chat-protocol/shuvixMdContract'
import {
  descriptorForType,
  type ShuvixMdFieldSpec
} from '@shuvix/chat-protocol/shuvixMdDescriptors'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import { frontmatterCard, frontmatterSummary } from './frontmatterCard'

/** 一条装饰：区间 + 卡片 widget 带的标记（不是卡片的装饰没有标记） */
interface Deco {
  from: number
  to: number
  marker: ShuvixMarker | undefined
}

/** 建 state（不建 view），收齐编辑器装饰 facet 里的全部装饰 */
function decosOf(doc: string, fallbackMarkerType?: string): Deco[] {
  const state = EditorState.create({
    doc,
    extensions: frontmatterCard({ t: (key) => key, fallbackMarkerType })
  })
  const out: Deco[] = []
  for (const source of state.facet(EditorView.decorations)) {
    // facet 的值可以是现成的集合，也可以是要 view 才能求值的函数。卡片走 StateField 提供的集合 ——
    // 真出现函数就说明实现换了路子，下面那几行「零装饰」会变成空转，直接报出来
    if (typeof source === 'function') {
      throw new Error('frontmatterCard provided a view-dependent decoration source')
    }
    source.between(0, state.doc.length, (from, to, value) => {
      const spec = value.spec as { widget?: { marker?: ShuvixMarker } }
      out.push({ from, to, marker: spec.widget?.marker })
    })
  }
  return out
}

/** frontmatter（给出两条定界线之间的各行）+ 正文；`end` 是闭合定界线的行尾 —— 卡片恰好覆盖 [0, end] */
function withFrontmatter(...lines: string[]): { doc: string; end: number } {
  const fm = ['---', ...lines, '---'].join('\n')
  return { doc: `${fm}\n\n# Entry\n\nbody\n`, end: fm.length }
}

const NO_MARKER = withFrontmatter('type: Memory', 'title: Token refresh', 'description: d')
const AGENT = withFrontmatter('shuvix: agent v1', 'name: helper', 'description: d')
const OKF = withFrontmatter('shuvix: okf v0.2', 'type: Memory', 'title: Token refresh')
const UNREADABLE = withFrontmatter('shuvix: 123', 'type: Memory', 'title: Token refresh')

const card = (fm: { end: number }, marker: ShuvixMarker): Deco[] => [
  { from: 0, to: fm.end, marker }
]

const TABLE: { name: string; doc: string; fallback?: string; expected: Deco[] }[] = [
  {
    name: '有 frontmatter、没有 shuvix 行，兜底 okf → 恰好一张覆盖整段 frontmatter 的 okf 卡（无版本）',
    doc: NO_MARKER.doc,
    fallback: 'okf',
    expected: card(NO_MARKER, { type: 'okf', version: null })
  },
  {
    name: '同一份文件不传兜底 → 零装饰',
    doc: NO_MARKER.doc,
    expected: []
  },
  {
    name: '`shuvix: agent v1`，兜底 okf → 标记优先，出的是 agent 卡',
    doc: AGENT.doc,
    fallback: 'okf',
    expected: card(AGENT, { type: 'agent', version: '1' })
  },
  {
    name: '`shuvix: okf v0.2`，兜底 okf → 按标记出卡，版本照读',
    doc: OKF.doc,
    fallback: 'okf',
    expected: card(OKF, { type: 'okf', version: '0.2' })
  },
  {
    name: '完全没有 frontmatter，兜底 okf → 零装饰',
    doc: '# Entry\n\nbody\n',
    fallback: 'okf',
    expected: []
  },
  {
    name: '读不出的标记 `shuvix: 123`，兜底 okf → 零装饰（有 shuvix 键就不兜底）',
    doc: UNREADABLE.doc,
    fallback: 'okf',
    expected: []
  }
]

describe('frontmatterCard —— 出卡判定（fallbackMarkerType）', () => {
  it.each(TABLE)('FC-1 $name', ({ doc, fallback, expected }) => {
    expect(decosOf(doc, fallback)).toEqual(expected)
  })
})

/**
 * 手机上收起的属性卡那一句摘要（`frontmatterSummary`，纯函数）：名字（显示名 > 标题 > 标识名），后面是各个
 * 列表字段有几项；一样都没有才用描述；都没有是空串。
 */
describe('frontmatterSummary', () => {
  const PATTERN_KEY = 'notebook.frontmatter.summaryCount'
  const t = (key: string): string => (key === PATTERN_KEY ? '{n} {label}' : key)
  const known: ShuvixMdFieldSpec[] = [
    { key: 'name', labelKey: 'L.name', kind: 'mono' },
    { key: 'shuvix-displayName', labelKey: 'L.display', kind: 'text' },
    { key: 'description', labelKey: 'L.desc', kind: 'text' },
    { key: 'tools', labelKey: 'L.tools', kind: 'csv' },
    { key: 'blocks', labelKey: 'L.blocks', kind: 'csv' },
    { key: 'bindings', labelKey: 'L.bindings', kind: 'hookBindings' },
    { key: 'secret', labelKey: 'L.secret', kind: 'hidden' },
    { key: 'builtin', labelKey: 'L.builtin', kind: 'tag' }
  ]
  const sum = (fields: Record<string, unknown>): string => frontmatterSummary(known, fields, t)

  it('FS-1 shuvix-displayName wins over title and name', () => {
    expect(sum({ name: 'n', title: 'T', 'shuvix-displayName': 'D' })).toBe('D')
  })

  it.each<[string, unknown]>([
    ['empty', ''],
    ['whitespace', '   '],
    ['a number', 7],
    ['null', null]
  ])('FS-2 a display name that is %s falls to title, then name', (_label, display) => {
    expect(sum({ name: 'n', title: 'T', 'shuvix-displayName': display })).toBe('T')
    expect(sum({ name: 'n', title: '  ', 'shuvix-displayName': display })).toBe('n')
  })

  it('FS-2 an array as the display name is neither a name nor a list to count (a scalar field)', () => {
    expect(sum({ name: 'n', title: 'T', 'shuvix-displayName': ['D'] })).toBe('T')
  })

  it('FS-3 the name is trimmed', () => {
    expect(sum({ name: '  spaced  ' })).toBe('spaced')
  })

  it('FS-4 a csv field as a comma string counts its non-blank entries', () => {
    expect(sum({ tools: 'a, b,, c ' })).toBe('3 L.tools')
  })

  it('FS-5 a csv field as a YAML array counts its entries, blanks dropped', () => {
    expect(sum({ tools: ['a', 'b'] })).toBe('2 L.tools')
    expect(sum({ tools: ['a', 5, '', '  '] })).toBe('2 L.tools')
  })

  it.each<[string, Record<string, unknown>]>([
    ['an empty string', { tools: '' }],
    ['missing', {}],
    ['null', { tools: null }]
  ])('FS-6 a csv field that is %s gives no part', (_label, fields) => {
    expect(sum({ name: 'n', ...fields })).toBe('n')
  })

  it('FS-7 a non-csv field counts only an array value', () => {
    expect(sum({ bindings: [{ a: 1 }, { b: 2 }, { c: 3 }] })).toBe('3 L.bindings')
    expect(sum({ name: 'n', bindings: 'a, b' })).toBe('n')
    expect(sum({ name: 'n', bindings: { a: 1, b: 2 } })).toBe('n')
    expect(sum({ name: 'n', bindings: [] })).toBe('n')
  })

  it('FS-8 hidden and tag fields are skipped even with array values', () => {
    expect(sum({ name: 'n', secret: ['a', 'b'], builtin: ['a'] })).toBe('n')
  })

  it('FS-9 parts follow the order of the known fields, name first', () => {
    expect(sum({ bindings: [1], blocks: 'x', tools: 'a, b', name: 'n' })).toBe(
      'n · 2 L.tools · 1 L.blocks · 1 L.bindings'
    )
  })

  it('FS-10 counts without a name have no leading separator', () => {
    expect(sum({ tools: 'a', blocks: 'x, y' })).toBe('1 L.tools · 2 L.blocks')
  })

  it('FS-11 a name without counts stands alone', () => {
    expect(sum({ name: 'n', description: 'about it' })).toBe('n')
  })

  it('FS-12 with no name and no counts the trimmed description is used', () => {
    expect(sum({ description: '  about it  ' })).toBe('about it')
    expect(sum({ description: 42 })).toBe('')
    expect(sum({ description: null })).toBe('')
  })

  it('FS-13 nothing at all gives an empty string', () => {
    expect(sum({})).toBe('')
  })

  it('FS-14 the description is not used beside a name or a count', () => {
    expect(sum({ title: 'T', description: 'about it' })).toBe('T')
    expect(sum({ tools: 'a', description: 'about it' })).toBe('1 L.tools')
  })

  it('FS-15 a pattern with the label first has both placeholders replaced', () => {
    const jaT = (key: string): string => (key === PATTERN_KEY ? '{label} {n} 件' : key)
    expect(frontmatterSummary(known, { tools: 'a, b' }, jaT)).toBe('L.tools 2 件')
  })

  it('FS-16 a key that is not a known field is not counted', () => {
    expect(sum({ name: 'n', extra: ['a', 'b'], tags: 'a, b' })).toBe('n')
  })

  it('FS-17 the real agent descriptor gives name, tools, prompt blocks', () => {
    const agent = descriptorForType('agent')
    expect(agent).not.toBeNull()
    expect(
      frontmatterSummary(
        agent!.fields,
        {
          name: 'x',
          'shuvix-displayName': 'Name',
          description: 'about it',
          'shuvix-tools': 'read, write',
          'shuvix-prompt-blocks': 'environment',
          'shuvix-builtin': true
        },
        t
      )
    ).toBe('Name · 2 tool.subAgentTools · 1 tool.subAgentPromptBlocks')
  })

  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ] as const)('FS-18 the %s locale has a usable count pattern and empty-page values', (_l, loc) => {
    const pattern = loc.notebook.frontmatter.summaryCount
    expect(pattern.split('{n}')).toHaveLength(2)
    expect(pattern.split('{label}')).toHaveLength(2)
    expect(pattern).not.toContain('{{')
    expect(loc.mobile.emptyExtensionsOff.trim()).not.toBe('')
    expect(loc.mobile.emptyKnowledgeNone.trim()).not.toBe('')
  })
})

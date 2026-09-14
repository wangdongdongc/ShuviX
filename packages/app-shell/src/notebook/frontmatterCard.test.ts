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
import { frontmatterCard } from './frontmatterCard'

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

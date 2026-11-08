// @vitest-environment jsdom
/**
 * 属性卡上的「内置」标签（`shuvix-builtin`，描述符 kind `tag`；jsdom + 真 EditorView）。
 *
 * 这个键说的是「这份文件是什么」，不是一个能拨的设置：值是布尔 true 时在标题行画一枚只读标签，不占一行、没有控件。
 *   FT-1 agent / policy / hook 写着 true → 标题行恰一枚标签；没有这一行，也没有开关
 *   FT-2 没写、写成别的（字符串 "true"、yes / on / 1、null、列表、映射、块标量）→ 什么都不画，也不落通用行；
 *        True / TRUE 是 YAML 的布尔 true，照样画
 *   FT-3 YAML 写坏：视图照建，报错横幅在，没有标签、没有字段区
 *   FT-4 只读与可编辑长得一样：标签的有无相同，开关行都是 shuvix-project-awareness 与 shuvix-user-words，只读时才 disabled
 *   FT-5 标签是死的（mousedown 不改文档、不动选区、卡片不塌）；旁边的开关照常改那一行、不碰 shuvix-builtin；
 *        标签跟着缓冲区走
 *
 * jsdom 没有布局：CM6 量尺寸要的 Range#getClientRects / getBoundingClientRect 在这里补成空矩形（同
 * frontmatterCardBindings.dom.test.ts）。焦点镜像初值为 false，视图一建好就是折叠态的卡。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { frontmatterCard } from './frontmatterCard'

beforeAll(() => {
  const emptyRect = (): DOMRect =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({})
    }) as DOMRect
  const proto = Range.prototype as unknown as {
    getClientRects?: () => DOMRectList
    getBoundingClientRect?: () => DOMRect
  }
  if (!proto.getClientRects) {
    proto.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: [][Symbol.iterator]
      }) as unknown as DOMRectList
  }
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = emptyRect
})

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) {
    if (view.dom.isConnected) view.destroy()
  }
  document.body.innerHTML = ''
})

/** 建视图（挂进 document）；t 原样回键，标签文字即 labelKey */
function makeView(doc: string, readOnly = false): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const extensions: Extension[] = [frontmatterCard({ t: (key) => key })]
  if (readOnly) extensions.push(EditorState.readOnly.of(true))
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) })
  views.push(view)
  return view
}

const docOf = (marker: string, lines: string[]): string =>
  ['---', `shuvix: ${marker}`, 'name: x', ...lines, '---', '', 'body', ''].join('\n')

const TAG_LABEL = 'tool.subAgentBuiltin'
const tagsOf = (view: EditorView): HTMLElement[] => [
  ...view.dom.querySelectorAll<HTMLElement>(
    '.cm-shuvix-fmcard-head .cm-shuvix-fmcard-tag[data-key="shuvix-builtin"]'
  )
]
/** 这个键的行：描述符行与通用行都带 data-key */
const rowOf = (view: EditorView): HTMLElement | null =>
  view.dom.querySelector<HTMLElement>('.cm-shuvix-fmcard-row[data-key="shuvix-builtin"]')
const labelTexts = (view: EditorView): Array<string | null> =>
  [...view.dom.querySelectorAll('.cm-shuvix-fmcard-label')].map((label) => label.textContent)
const togglesOf = (view: EditorView): HTMLButtonElement[] => [
  ...view.dom.querySelectorAll<HTMLButtonElement>('.cm-shuvix-fmcard-toggle')
]
const keyOfToggle = (toggle: HTMLElement): string | undefined =>
  toggle.closest<HTMLElement>('.cm-shuvix-fmcard-row')?.dataset.key
const awarenessToggle = (view: EditorView): HTMLButtonElement => {
  const toggle = togglesOf(view).find((t) => keyOfToggle(t) === 'shuvix-project-awareness')
  if (!toggle) throw new Error('shuvix-project-awareness toggle not rendered')
  return toggle
}

function expectNoTraceOfKey(view: EditorView): void {
  expect(tagsOf(view)).toHaveLength(0)
  expect(rowOf(view)).toBeNull()
  expect(labelTexts(view)).not.toContain('shuvix-builtin')
  expect(labelTexts(view)).not.toContain(TAG_LABEL)
}

/** 派发一次 mousedown，回到事件对象（看 defaultPrevented） */
function mouseDown(target: Element): MouseEvent {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

/** 把文档里唯一的这一行换掉 */
function replaceLine(view: EditorView, from: string, to: string): void {
  const at = view.state.doc.toString().indexOf(from)
  expect(at).toBeGreaterThanOrEqual(0)
  view.dispatch({ changes: { from: at, to: at + from.length, insert: to } })
}

describe('属性卡 —— 内置标签', () => {
  it.each(['agent v1', 'policy v1', 'hook v1'])(
    'FT-1 %s 写着 shuvix-builtin: true → 标题行恰一枚标签，没有这一行、没有开关',
    (marker) => {
      const view = makeView(docOf(marker, ['shuvix-builtin: true']))

      const tags = tagsOf(view)
      expect(tags).toHaveLength(1)
      expect(tags[0].tagName).toBe('SPAN')
      expect(tags[0].textContent).toBe(TAG_LABEL)

      expect(rowOf(view)).toBeNull()
      expect(view.dom.querySelector('[data-key="shuvix-builtin"] .cm-shuvix-fmcard-toggle')).toBe(
        null
      )
      expect(labelTexts(view)).not.toContain('shuvix-builtin')
      expect(labelTexts(view)).not.toContain(TAG_LABEL)
    }
  )

  it.each<[string, string[]]>([
    ['没写', []],
    ['false', ['shuvix-builtin: false']],
    ['"true"', ['shuvix-builtin: "true"']],
    ["'true'", ["shuvix-builtin: 'true'"]],
    ['yes', ['shuvix-builtin: yes']],
    ['on', ['shuvix-builtin: on']],
    ['1', ['shuvix-builtin: 1']],
    ['~', ['shuvix-builtin: ~']],
    ['空值', ['shuvix-builtin:']],
    ['[true]', ['shuvix-builtin: [true]']],
    ['{a: true}', ['shuvix-builtin: {a: true}']],
    ['块标量 true', ['shuvix-builtin: |', '  true']]
  ])('FT-2 %s → 没有标签、没有这一行', (_label, lines) => {
    const view = makeView(docOf('agent v1', lines))

    // 卡片与字段区都在：否则「什么都没画」就白断言了
    expect(view.dom.querySelector('.cm-shuvix-fmcard-err')).toBeNull()
    expect(view.dom.querySelector('.cm-shuvix-fmcard-rows')).not.toBeNull()
    expectNoTraceOfKey(view)
  })

  it.each(['True', 'TRUE'])('FT-2 %s 是 YAML 的布尔 true → 有标签（有意如此）', (value) => {
    const view = makeView(docOf('agent v1', [`shuvix-builtin: ${value}`]))

    expect(tagsOf(view)).toHaveLength(1)
    expect(rowOf(view)).toBeNull()
  })

  it('FT-3 YAML 写坏：视图照建，报错横幅在，没有标签、没有字段区', () => {
    const doc = docOf('agent v1', ['shuvix-builtin: true', 'broken: [unclosed'])

    let view: EditorView | undefined
    expect(() => {
      view = makeView(doc)
    }).not.toThrow()

    expect(view!.dom.querySelector('.cm-shuvix-fmcard-err')).not.toBeNull()
    expect(tagsOf(view!)).toHaveLength(0)
    expect(view!.dom.querySelector('.cm-shuvix-fmcard-rows')).toBeNull()
  })

  it.each<[string, number]>([
    ['true', 1],
    ['false', 0]
  ])(
    'FT-4 shuvix-builtin: %s：只读与可编辑一个样，开关是 awareness 与 user-words，只读时才禁用',
    (value, tags) => {
      const doc = docOf('agent v1', [`shuvix-builtin: ${value}`])
      for (const readOnly of [false, true]) {
        const view = makeView(doc, readOnly)
        expect(tagsOf(view), `readOnly=${readOnly}`).toHaveLength(tags)

        const toggles = togglesOf(view)
        expect(toggles.map(keyOfToggle), `readOnly=${readOnly}`).toEqual([
          'shuvix-project-awareness',
          'shuvix-user-words'
        ])
        for (const toggle of toggles) {
          expect(toggle.disabled, `readOnly=${readOnly}`).toBe(readOnly)
        }
      }
    }
  )

  it('FT-5 标签是死的：mousedown 被吞，文档、选区都不变，卡片不塌', () => {
    const doc = docOf('agent v1', ['shuvix-builtin: true'])
    const view = makeView(doc)
    const card = view.dom.querySelector('.cm-shuvix-fmcard')
    const selection = view.state.selection

    const event = mouseDown(tagsOf(view)[0])

    expect(event.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe(doc)
    expect(view.state.selection.eq(selection)).toBe(true)
    expect(view.dom.querySelector('.cm-shuvix-fmcard')).toBe(card)
    expect(card?.isConnected).toBe(true)
  })

  it('FT-5 旁边的开关照常：只多一行 awareness，shuvix-builtin 那行不动；重建的卡上标签还在、开关是 on', () => {
    const view = makeView(docOf('agent v1', ['shuvix-builtin: true']))

    mouseDown(awarenessToggle(view))

    const lines = view.state.doc.toString().split('\n')
    expect(lines).toContain('shuvix-project-awareness: true')
    expect(lines).toContain('shuvix-builtin: true')
    expect(lines.filter((line) => line.startsWith('shuvix-builtin'))).toEqual([
      'shuvix-builtin: true'
    ])
    expect(tagsOf(view)).toHaveLength(1)
    expect(awarenessToggle(view).dataset.state).toBe('on')
  })

  it('FT-5 标签跟着缓冲区走：改成 false 就没了，改回 true 又回来', () => {
    const view = makeView(docOf('agent v1', ['shuvix-builtin: true']))
    expect(tagsOf(view)).toHaveLength(1)

    replaceLine(view, 'shuvix-builtin: true', 'shuvix-builtin: false')
    expect(tagsOf(view)).toHaveLength(0)
    expect(rowOf(view)).toBeNull()

    replaceLine(view, 'shuvix-builtin: false', 'shuvix-builtin: true')
    expect(tagsOf(view)).toHaveLength(1)
  })
})

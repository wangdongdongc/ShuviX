// @vitest-environment jsdom
/**
 * 属性卡在手机上的那一副长相（`FrontmatterCardConfig.compact`；jsdom + 真 EditorView）。
 *
 * 契约：`compact` 缺省 / false 是桌面的无盒两列清单，一直展开，DOM 与改动前一字不差；`compact: true` 是一张
 * 圆角卡片，默认收起成一行（类型徽章、标签、校验态 + 一句摘要 + 箭头），点标题行（或聚焦后 Enter / 空格）展开；
 * 展开后长的行（列表、描述、写得长的文字）带 `is-long`，「编辑源码」在标题行里。开合记在这个编辑器上：YAML 变了
 * 重建卡片也不变，别的编辑器不受影响。
 *
 *   FC-1..7    桌面：class、子节点次序、没有卡片盒子 / 摘要 / 箭头，点标题行没反应
 *   FC-10..13  手机：盒子结构，默认收起，标题行是按钮
 *   FC-14..17  点击 / 键盘开合
 *   FC-18..21  「编辑源码」按钮
 *   FC-22..25  开合记在编辑器上
 *   FC-26..29  空摘要、坏 YAML、requestMeasure、mousedown
 *   FC-30..34  is-long
 *   FC-35..39  宿主槽位、标签、校验横幅、卡内开关
 *
 * jsdom 没有布局：Range 的矩形在这里补成空的（同 frontmatterCardTag.dom.test.ts）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ShuvixMdValidation } from '@shuvix/chat-protocol/shuvixMdContract'
import {
  frontmatterCard,
  frontmatterSummary,
  type FrontmatterCardConfig,
  type FrontmatterFieldMount
} from './frontmatterCard'
import { descriptorForType } from '@shuvix/chat-protocol/shuvixMdDescriptors'

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

const t = (key: string): string => key

interface ViewOptions extends Partial<Omit<FrontmatterCardConfig, 't'>> {
  readOnly?: boolean
}

function makeView(doc: string, options: ViewOptions = {}): EditorView {
  const { readOnly = false, ...config } = options
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const extensions: Extension[] = [frontmatterCard({ t, ...config })]
  if (readOnly) extensions.push(EditorState.readOnly.of(true))
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) })
  views.push(view)
  return view
}

const docOf = (lines: string[]): string => ['---', ...lines, '---', '', 'body', ''].join('\n')

const AGENT_LINES = [
  'shuvix: agent v1',
  'name: helper',
  'shuvix-displayName: Helper',
  'description: does things',
  'shuvix-thinking: low',
  'shuvix-tools: read, write',
  'shuvix-user-words: false'
]
const AGENT_DOC = docOf(AGENT_LINES)
const AGENT_SUMMARY = 'Helper · notebook.frontmatter.summaryCount'

const q = <T extends Element = HTMLElement>(view: EditorView, selector: string): T | null =>
  view.dom.querySelector<T>(selector)
const must = <T extends Element = HTMLElement>(view: EditorView, selector: string): T => {
  const found = q<T>(view, selector)
  if (!found) throw new Error(`${selector} not rendered`)
  return found
}
const wrapOf = (view: EditorView): HTMLElement => must(view, '.cm-shuvix-fmcard')
const headOf = (view: EditorView): HTMLElement => must(view, '.cm-shuvix-fmcard-head')
const bodyOf = (view: EditorView): HTMLElement => must(view, '.cm-shuvix-fmcard-body')
const summaryOf = (view: EditorView): HTMLElement => must(view, '.cm-shuvix-fmcard-summary')
const srcOf = (view: EditorView): HTMLButtonElement | null =>
  q<HTMLButtonElement>(view, '.cm-shuvix-fmcard-src')
const rowOf = (view: EditorView, key: string): HTMLElement =>
  must(view, `.cm-shuvix-fmcard-row[data-key="${key}"]`)
const isOpen = (view: EditorView): boolean => wrapOf(view).dataset.open === 'true'

function fire(target: Element, type: 'mousedown' | 'click'): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}
function keyDown(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}
function replaceText(view: EditorView, from: string, to: string): void {
  const at = view.state.doc.toString().indexOf(from)
  expect(at).toBeGreaterThanOrEqual(0)
  view.dispatch({ changes: { from: at, to: at + from.length, insert: to } })
}
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('属性卡 —— 桌面（compact 关）', () => {
  it('FC-1 the wrap keeps its classes and has no compact marks', () => {
    const wrap = wrapOf(makeView(AGENT_DOC))
    expect(wrap.className).toBe(
      'cm-shuvix-fmcard group pt-3 pb-2 border-b border-border-secondary/40'
    )
    expect(wrap.classList.contains('is-compact')).toBe(false)
    expect(wrap.hasAttribute('data-open')).toBe(false)
  })

  it('FC-2 there is no card box, body, summary or chevron, and the head is not a button', () => {
    const view = makeView(AGENT_DOC)
    for (const part of ['card', 'body', 'summary', 'chevron']) {
      expect(q(view, `.cm-shuvix-fmcard-${part}`), part).toBeNull()
    }
    const head = headOf(view)
    expect(head.hasAttribute('role')).toBe(false)
    expect(head.hasAttribute('tabindex')).toBe(false)
    expect(head.hasAttribute('aria-expanded')).toBe(false)
  })

  it('FC-3 the head line is badge, tag, status, spacer, source button', () => {
    const view = makeView(docOf([...AGENT_LINES, 'shuvix-builtin: true']))
    const head = headOf(view)
    expect(head.className).toBe('cm-shuvix-fmcard-head flex items-center gap-2 h-6 px-1 mb-0.5')
    const kids = [...head.children] as HTMLElement[]
    expect(kids).toHaveLength(5)
    expect(kids[0].classList.contains('cm-shuvix-fmcard-badge')).toBe(true)
    expect(kids[1].classList.contains('cm-shuvix-fmcard-tag')).toBe(true)
    expect(kids[2].querySelector('.cm-shuvix-fmcard-status-text')).not.toBeNull()
    expect(kids[3].tagName).toBe('DIV')
    expect(kids[3].className).toBe('flex-1')
    expect(kids[4].classList.contains('cm-shuvix-fmcard-src')).toBe(true)
    expect(kids[4].classList.contains('opacity-0')).toBe(true)
    expect(kids[4].classList.contains('group-hover:opacity-100')).toBe(true)
    expect(kids[4].hidden).toBe(false)
  })

  it('FC-4 head, banner, rows and the meta slot are direct children of the wrap', () => {
    const view = makeView(AGENT_DOC, { mountMetaStrip: () => undefined })
    const wrap = wrapOf(view)
    const kids = [...wrap.children] as HTMLElement[]
    expect(kids[0]).toBe(headOf(view))
    expect(kids[1].classList.contains('cm-shuvix-fmcard-banner')).toBe(true)
    expect(kids[1].hidden).toBe(true)
    expect(kids[2].classList.contains('cm-shuvix-fmcard-rows')).toBe(true)
    expect(kids[3].classList.contains('cm-shuvix-fmcard-meta')).toBe(true)
    expect(kids).toHaveLength(4)
    expect(kids.filter((kid) => kid.hidden)).toEqual([kids[1]])
    expect(view.dom.querySelectorAll('.cm-shuvix-fmcard-row.is-long')).toHaveLength(0)
  })

  it('FC-5 clicking the head changes nothing', () => {
    const view = makeView(AGENT_DOC)
    const before = wrapOf(view).outerHTML
    fire(headOf(view), 'click')
    keyDown(headOf(view), 'Enter')
    expect(wrapOf(view).outerHTML).toBe(before)
    expect(q(view, '.cm-shuvix-fmcard-rows')).not.toBeNull()
  })

  it('FC-6 compact: false draws the same DOM as compact omitted', () => {
    const omitted = wrapOf(makeView(AGENT_DOC)).outerHTML
    const off = wrapOf(makeView(AGENT_DOC, { compact: false })).outerHTML
    expect(off).toBe(omitted)
  })

  it.each([false, true])(
    'FC-7 the bool row value box carries its class (compact=%s)',
    (compact) => {
      const view = makeView(AGENT_DOC, { compact })
      const row = rowOf(view, 'shuvix-user-words')
      expect(row.querySelector('.cm-shuvix-fmcard-bool .cm-shuvix-fmcard-toggle')).not.toBeNull()
    }
  )
})

describe('属性卡 —— 手机（compact 开）', () => {
  const compactView = (doc = AGENT_DOC, options: ViewOptions = {}): EditorView =>
    makeView(doc, { compact: true, ...options })

  it('FC-10 the wrap holds one card box: head, then body', () => {
    const view = compactView()
    const wrap = wrapOf(view)
    expect(wrap.classList.contains('is-compact')).toBe(true)
    expect(wrap.classList.contains('group')).toBe(false)
    expect(wrap.dataset.open).toBe('false')
    expect(wrap.children).toHaveLength(1)
    const card = wrap.children[0]
    expect(card.classList.contains('cm-shuvix-fmcard-card')).toBe(true)
    expect([...card.children]).toEqual([headOf(view), bodyOf(view)])
  })

  it('FC-11 banner, rows and the meta slot are inside the body', () => {
    const view = compactView(AGENT_DOC, { mountMetaStrip: () => undefined })
    const body = bodyOf(view)
    const kids = [...body.children]
    expect(kids.map((kid) => kid.className.split(' ')[0])).toEqual([
      'cm-shuvix-fmcard-banner',
      'cm-shuvix-fmcard-rows',
      'cm-shuvix-fmcard-meta'
    ])
    for (const kid of kids) expect(kid.parentElement).not.toBe(wrapOf(view))
  })

  it('FC-12 it starts collapsed: body hidden, summary shown, head is a closed button', () => {
    const view = compactView()
    expect(bodyOf(view).hidden).toBe(true)
    const summary = summaryOf(view)
    expect(summary.hidden).toBe(false)
    const expected = frontmatterSummary(
      descriptorForType('agent')!.fields,
      {
        name: 'helper',
        'shuvix-displayName': 'Helper',
        description: 'does things',
        'shuvix-thinking': 'low',
        'shuvix-tools': 'read, write',
        'shuvix-user-words': false
      },
      t
    )
    expect(expected).toBe(AGENT_SUMMARY)
    expect(summary.textContent).toBe(expected)
    const head = headOf(view)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(head.getAttribute('role')).toBe('button')
    expect(head.tabIndex).toBe(0)
  })

  it('FC-13 the head has a hidden-from-AT chevron, the badge and the status chip', () => {
    const head = headOf(compactView())
    const chevron = head.querySelector('svg.cm-shuvix-fmcard-chevron')
    expect(chevron?.getAttribute('aria-hidden')).toBe('true')
    expect(head.lastElementChild).toBe(chevron)
    expect(head.querySelector('.cm-shuvix-fmcard-badge')).not.toBeNull()
    expect(head.querySelector('.cm-shuvix-fmcard-status-text')).not.toBeNull()
  })

  it('FC-14 a click on the head opens, a second click closes', () => {
    const view = compactView()
    fire(headOf(view), 'click')
    expect(wrapOf(view).dataset.open).toBe('true')
    expect(headOf(view).getAttribute('aria-expanded')).toBe('true')
    expect(bodyOf(view).hidden).toBe(false)
    expect(summaryOf(view).hidden).toBe(true)

    fire(headOf(view), 'click')
    expect(wrapOf(view).dataset.open).toBe('false')
    expect(headOf(view).getAttribute('aria-expanded')).toBe('false')
    expect(bodyOf(view).hidden).toBe(true)
    expect(summaryOf(view).hidden).toBe(false)
  })

  it.each(['.cm-shuvix-fmcard-badge', '.cm-shuvix-fmcard-summary', '.cm-shuvix-fmcard-chevron'])(
    'FC-15 a click on %s inside the head toggles too',
    (selector) => {
      const view = compactView()
      fire(must(view, selector), 'click')
      expect(isOpen(view)).toBe(true)
      fire(must(view, selector), 'click')
      expect(isOpen(view)).toBe(false)
    }
  )

  it.each(['Enter', ' '])('FC-16 the key "%s" on the head toggles and is consumed', (key) => {
    const view = compactView()
    const event = keyDown(headOf(view), key)
    expect(event.defaultPrevented).toBe(true)
    expect(isOpen(view)).toBe(true)
    keyDown(headOf(view), key)
    expect(isOpen(view)).toBe(false)
  })

  it.each(['a', 'Tab', 'Escape'])('FC-16 the key "%s" on the head does nothing', (key) => {
    const view = compactView()
    const event = keyDown(headOf(view), key)
    expect(event.defaultPrevented).toBe(false)
    expect(isOpen(view)).toBe(false)
  })

  it('FC-17 Enter on the source button does not toggle the card', () => {
    const view = compactView()
    fire(headOf(view), 'click')
    keyDown(srcOf(view)!, 'Enter')
    keyDown(srcOf(view)!, ' ')
    expect(isOpen(view)).toBe(true)
  })

  it('FC-18 the source button sits in the head before the chevron, hidden while collapsed', () => {
    const view = compactView()
    const src = srcOf(view)!
    const head = headOf(view)
    expect(src.parentElement).toBe(head)
    expect(src.nextElementSibling).toBe(head.querySelector('.cm-shuvix-fmcard-chevron'))
    expect(src.classList.contains('opacity-0')).toBe(false)
    expect(src.hidden).toBe(true)
    fire(head, 'click')
    expect(src.hidden).toBe(false)
    fire(head, 'click')
    expect(src.hidden).toBe(true)
  })

  it('FC-19 a read-only card has no source button and still toggles', () => {
    const view = compactView(AGENT_DOC, { readOnly: true })
    expect(srcOf(view)).toBeNull()
    fire(headOf(view), 'click')
    expect(isOpen(view)).toBe(true)
    expect(bodyOf(view).hidden).toBe(false)
    fire(headOf(view), 'click')
    expect(isOpen(view)).toBe(false)
  })

  it('FC-20 a click on the source button does not toggle', () => {
    const view = compactView()
    fire(headOf(view), 'click')
    fire(srcOf(view)!, 'click')
    expect(isOpen(view)).toBe(true)
  })

  it('FC-21 the source button reveals the YAML; the card that comes back is still open', async () => {
    const view = compactView()
    fire(headOf(view), 'click')
    fire(srcOf(view)!, 'mousedown')
    // CM6 的焦点通知是定时器里发的，镜像进 state 又隔一个微任务
    await tick(60)
    const head = view.state.selection.main.head
    expect(head).toBe(view.state.doc.line(2).to)
    expect(q(view, '.cm-shuvix-fmcard')).toBeNull()

    view.dispatch({ selection: { anchor: view.state.doc.length } })
    expect(isOpen(view)).toBe(true)
    expect(bodyOf(view).hidden).toBe(false)
  })

  it('FC-22 an open card stays open when the YAML changes and the widget is rebuilt', () => {
    const view = compactView()
    fire(headOf(view), 'click')
    const before = wrapOf(view)
    replaceText(view, 'name: helper', 'name: other')
    const after = wrapOf(view)
    expect(after).not.toBe(before)
    expect(after.dataset.open).toBe('true')
    expect(bodyOf(view).hidden).toBe(false)
    expect(summaryOf(view).hidden).toBe(true)
    expect(srcOf(view)!.hidden).toBe(false)
  })

  it('FC-23 a collapsed card stays collapsed on a YAML change and shows the new summary', () => {
    const view = compactView()
    replaceText(view, 'shuvix-displayName: Helper', 'shuvix-displayName: Renamed')
    expect(wrapOf(view).dataset.open).toBe('false')
    expect(bodyOf(view).hidden).toBe(true)
    expect(summaryOf(view).hidden).toBe(false)
    expect(summaryOf(view).textContent).toBe('Renamed · notebook.frontmatter.summaryCount')
  })

  it('FC-24 opening one editor leaves another on the same document collapsed', () => {
    const first = compactView()
    const second = compactView()
    fire(headOf(first), 'click')
    expect(isOpen(first)).toBe(true)
    expect(isOpen(second)).toBe(false)
    // 第二个之后重建卡片也还是收着的
    replaceText(second, 'name: helper', 'name: other')
    expect(isOpen(second)).toBe(false)
  })

  it('FC-25 a new editor on the same document starts collapsed', () => {
    const first = compactView()
    fire(headOf(first), 'click')
    first.destroy()
    const second = compactView()
    expect(isOpen(second)).toBe(false)
    expect(bodyOf(second).hidden).toBe(true)
  })

  it('FC-26 an empty summary is hidden collapsed and open', () => {
    const view = compactView(docOf(['shuvix: agent v1']))
    expect(summaryOf(view).textContent).toBe('')
    expect(summaryOf(view).hidden).toBe(true)
    fire(headOf(view), 'click')
    expect(summaryOf(view).hidden).toBe(true)
    fire(headOf(view), 'click')
    expect(summaryOf(view).hidden).toBe(true)
  })

  it('FC-27 broken YAML: the card builds with an error chip, an empty summary and no rows', () => {
    const view = compactView(docOf(['shuvix: agent v1', 'name: x', 'broken: [unclosed']))
    expect(headOf(view).querySelector('.cm-shuvix-fmcard-err')).not.toBeNull()
    expect(summaryOf(view).textContent).toBe('')
    expect(summaryOf(view).hidden).toBe(true)
    expect(q(view, '.cm-shuvix-fmcard-rows')).toBeNull()
    fire(headOf(view), 'click')
    expect(isOpen(view)).toBe(true)
    expect(bodyOf(view).hidden).toBe(false)
    fire(headOf(view), 'click')
    expect(isOpen(view)).toBe(false)
  })

  it('FC-28 toggling asks for a re-measure and touches neither document nor selection', () => {
    const view = compactView()
    const selection = view.state.selection
    const measure = vi.spyOn(view, 'requestMeasure')
    fire(headOf(view), 'click')
    expect(measure).toHaveBeenCalledTimes(1)
    fire(headOf(view), 'click')
    expect(measure).toHaveBeenCalledTimes(2)
    expect(view.state.doc.toString()).toBe(AGENT_DOC)
    expect(view.state.selection.eq(selection)).toBe(true)
  })

  it('FC-29 mousedown on the head is swallowed and the click after it still toggles', () => {
    const view = compactView()
    const selection = view.state.selection
    const down = fire(headOf(view), 'mousedown')
    expect(down.defaultPrevented).toBe(true)
    expect(isOpen(view)).toBe(false)
    fire(headOf(view), 'click')
    expect(isOpen(view)).toBe(true)
    expect(view.state.selection.eq(selection)).toBe(true)
  })

  const long = (view: EditorView, key: string): boolean =>
    rowOf(view, key).classList.contains('is-long')

  it('FC-30 list rows are long, with entries and without', () => {
    const filled = compactView(
      docOf(['shuvix: agent v1', 'shuvix-tools: read', 'shuvix-prompt-blocks: environment'])
    )
    expect(long(filled, 'shuvix-tools')).toBe(true)
    expect(long(filled, 'shuvix-prompt-blocks')).toBe(true)
    const empty = compactView(docOf(['shuvix: agent v1', 'name: none', 'shuvix-tools:']))
    expect(long(empty, 'shuvix-tools')).toBe(true)
    expect(long(empty, 'shuvix-prompt-blocks')).toBe(true)
  })

  it('FC-31 the description row is long when short and when absent', () => {
    expect(long(compactView(docOf(['shuvix: agent v1', 'description: x'])), 'description')).toBe(
      true
    )
    expect(long(compactView(docOf(['shuvix: agent v1', 'name: nodesc'])), 'description')).toBe(true)
  })

  it('FC-32 a text value is long from 19 characters on', () => {
    const eighteen = 'a'.repeat(18)
    const nineteen = 'a'.repeat(19)
    const short = compactView(docOf(['shuvix: agent v1', `shuvix-displayName: ${eighteen}`]))
    expect(long(short, 'shuvix-displayName')).toBe(false)
    const lengthy = compactView(docOf(['shuvix: agent v1', `shuvix-displayName: ${nineteen}`]))
    expect(long(lengthy, 'shuvix-displayName')).toBe(true)
  })

  it('FC-33 a text field whose YAML value is a number is not long', () => {
    const view = compactView(
      docOf(['shuvix: agent v1', 'shuvix-displayName: 12345678901234567890'])
    )
    expect(long(view, 'shuvix-displayName')).toBe(false)
  })

  it('FC-34 mono, select, boolean and generic rows are never long', () => {
    const view = compactView(
      docOf([
        'shuvix: agent v1',
        `name: ${'n'.repeat(40)}`,
        `shuvix-thinking: ${'t'.repeat(40)}`,
        `shuvix-model: ${'m'.repeat(40)}`,
        'shuvix-user-words: true',
        `custom-key: ${'c'.repeat(40)}`
      ])
    )
    for (const key of [
      'name',
      'shuvix-thinking',
      'shuvix-model',
      'shuvix-user-words',
      'custom-key'
    ]) {
      expect(long(view, key), key).toBe(false)
    }
    expect(rowOf(view, 'custom-key').classList.contains('is-generic')).toBe(true)
  })

  it('FC-35 mountField gets the same slot contexts as on the desktop', () => {
    const collect = (compact: boolean, readOnly: boolean): unknown[] => {
      const seen: unknown[] = []
      makeView(AGENT_DOC, {
        compact,
        readOnly,
        mountField: (slot: HTMLElement, ctx: FrontmatterFieldMount) => {
          expect(slot.classList.contains('cm-shuvix-fmcard-slot')).toBe(true)
          seen.push({
            key: ctx.key,
            kind: ctx.kind,
            markerType: ctx.markerType,
            value: ctx.value,
            readOnly: ctx.readOnly
          })
        }
      })
      return seen
    }
    for (const readOnly of [false, true]) {
      const desktop = collect(false, readOnly)
      expect(desktop).toContainEqual({
        key: 'shuvix-tools',
        kind: 'csv',
        markerType: 'agent',
        value: 'read, write',
        readOnly
      })
      expect(desktop).toContainEqual({
        key: 'shuvix-thinking',
        kind: 'select',
        markerType: 'agent',
        value: 'low',
        readOnly
      })
      expect(collect(true, readOnly)).toEqual(desktop)
    }
  })

  it('FC-36 host cleanups run when the compact widget is thrown away', () => {
    const fieldCleanup = vi.fn()
    const metaCleanup = vi.fn()
    const mountField = vi.fn(() => fieldCleanup)
    const view = compactView(AGENT_DOC, { mountField, mountMetaStrip: () => metaCleanup })
    const mounted = mountField.mock.calls.length
    expect(mounted).toBeGreaterThan(0)
    expect(fieldCleanup).not.toHaveBeenCalled()

    replaceText(view, 'name: helper', 'name: other')

    expect(fieldCleanup).toHaveBeenCalledTimes(mounted)
    expect(metaCleanup).toHaveBeenCalledTimes(1)
  })

  it('FC-37 the built-in tag is in the head line; clicking it toggles and edits nothing', () => {
    const doc = docOf([...AGENT_LINES, 'shuvix-builtin: true'])
    const view = compactView(doc)
    const tag = must(
      view,
      '.cm-shuvix-fmcard-head .cm-shuvix-fmcard-tag[data-key="shuvix-builtin"]'
    )
    expect(tag.parentElement).toBe(must(view, '.cm-shuvix-fmcard-badge').parentElement)
    expect(q(view, '.cm-shuvix-fmcard-row[data-key="shuvix-builtin"]')).toBeNull()

    expect(fire(tag, 'mousedown').defaultPrevented).toBe(true)
    fire(tag, 'click')
    expect(isOpen(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(doc)
  })

  it('FC-38 the validation banner is in the body; the head chip says invalid while collapsed', async () => {
    const result: ShuvixMdValidation = { status: 'invalid', messages: ['name is missing'] }
    // 校验结果按 YAML 原文缓存在模块里：这份 YAML 只在本用例出现
    const view = compactView(docOf(['shuvix: agent v1', 'description: fc-38 only']), {
      validate: () => Promise.resolve(result)
    })
    await tick()

    const banner = must(view, '.cm-shuvix-fmcard-banner')
    expect(banner.parentElement).toBe(bodyOf(view))
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toBe('name is missing')
    // 收着的时候横幅跟着正文一起看不见，标题行的校验态照样在
    expect(bodyOf(view).hidden).toBe(true)
    const chip = must(view, '.cm-shuvix-fmcard-head .cm-shuvix-fmcard-status-text').parentElement!
    expect(chip.hidden).toBe(false)
    expect(chip.classList.contains('is-err')).toBe(true)
    expect(chip.textContent).toBe('notebook.frontmatter.invalid')

    fire(headOf(view), 'click')
    expect(bodyOf(view).hidden).toBe(false)
    expect(banner.hidden).toBe(false)
  })

  it('FC-39 a toggle inside an open card edits its line and the card stays open', () => {
    const view = compactView()
    fire(headOf(view), 'click')
    const toggle = must(view, '.cm-shuvix-fmcard-row[data-key="shuvix-user-words"] button')
    expect(toggle.dataset.state).toBe('off')

    fire(toggle, 'mousedown')

    expect(view.state.doc.toString().split('\n')).toContain('shuvix-user-words: true')
    expect(isOpen(view)).toBe(true)
    expect(bodyOf(view).hidden).toBe(false)
    expect(
      must(view, '.cm-shuvix-fmcard-row[data-key="shuvix-user-words"] button').dataset.state
    ).toBe('on')
  })
})

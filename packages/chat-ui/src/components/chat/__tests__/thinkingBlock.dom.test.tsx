// @vitest-environment jsdom
/**
 * ThinkingBlock 的 DOM 结构与交互（jsdom）。锚点 `[data-thinking-block]`（e2e 的 `thinkingBlocks()` 同样认它）：
 *
 *   U-1 折叠的已完成态：一个 `role="button"` 的 div（不是 `<button>`、里面也没有 button），可聚焦、
 *       `aria-expanded="false"`；恰一个孩子，是**真正的单行**（`truncate` + 写死的行高、不 pre-wrap），
 *       文字是换行折成一个空格、首尾去空白的那一段
 *   U-2 点击切换：展开后孩子 pre-wrap、留着段落间的空行（= `content.trim()`）；再点回到 U-1 的样子
 *   U-3 Enter / 空格切换（并 preventDefault —— 空格不滚页面）；别的键（a / Tab / Escape）什么都不做、也不拦
 *   U-4 页面里有选中的文字时点击不切换（折叠态、展开态都一样）；选区清掉，下一次点击照常切换
 *   U-5 展开态只去掉首尾的空行，中间的段落空行留着；没在生成时没有光标
 *   U-6 生成中的折叠态照旧是一行高的滚动窗口（overflow-hidden、不 truncate、带光标），内容变长时滚到底；
 *       aria-expanded 仍是 "false"
 *
 * U-1 / U-2 钉的是结构上的修复：之前折叠盒本来就定高 16.5px，回归出在外层 `<button>` 按里面整段换行的高度留位
 * （手机浏览器里折叠的思考块下面空出一大块），所以只量高度抓不住它 —— 断「不是 button、孩子是单行」。
 * ThinkingBlock 不用 i18n，不碰 store。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ThinkingBlock } from '../ThinkingBlock'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const COLLAPSED_LINE = ['h-[16.5px]', 'leading-[16.5px]']
const TWO_PARAS = '  First para.\n\n  Second para.\n'

let container: HTMLDivElement
let root: Root

function render(content: string, isGenerating?: boolean): HTMLElement {
  act(() => {
    root.render(createElement(ThinkingBlock, { content, isGenerating }))
  })
  return block()
}

function block(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-thinking-block]')
  if (!el) throw new Error('no [data-thinking-block] rendered')
  return el
}

/** 恰一个孩子元素（展开 / 折叠 / 生成中三种内容盒都是外层唯一的孩子） */
function child(): HTMLElement {
  const el = block()
  expect(el.children).toHaveLength(1)
  return el.children[0] as HTMLElement
}

function click(): void {
  act(() => {
    block().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function keydown(key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    block().dispatchEvent(ev)
  })
  return ev
}

/** 用真的 Range 选中块里的文字（jsdom 的 Selection 会把它串成字符串，组件读的就是这个） */
function selectBlockText(): void {
  const text = block().querySelector('div')?.firstChild
  if (!text) throw new Error('no text node to select')
  const range = document.createRange()
  range.selectNodeContents(text)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  expect(sel.toString()).not.toBe('')
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}

/** U-1 的样子：折叠、单行 */
function expectCollapsedLine(text: string): void {
  const el = block()
  expect(el.getAttribute('aria-expanded')).toBe('false')
  const line = child()
  for (const cls of [...COLLAPSED_LINE, 'truncate']) expect(line.classList).toContain(cls)
  expect(line.classList).not.toContain('whitespace-pre-wrap')
  expect(line.textContent).toBe(text)
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  clearSelection()
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('ThinkingBlock —— 折叠的已完成态是一行', () => {
  it('U-1 a collapsed settled block is a focusable role=button div with one truncating line', () => {
    const el = render(TWO_PARAS)
    expect(el.tagName).toBe('DIV')
    expect(el.getAttribute('role')).toBe('button')
    expect(el.tabIndex).toBe(0)
    expect(el.getAttribute('aria-expanded')).toBe('false')
    expect(el.hasAttribute('data-thinking-block')).toBe(true)
    expect(el.classList).toContain('block')
    expect(el.querySelector('button')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expectCollapsedLine('First para. Second para.')
  })

  it('U-2 a click expands into the paragraphs (content.trim()); a second click collapses back', () => {
    render(TWO_PARAS)
    click()
    expect(block().getAttribute('aria-expanded')).toBe('true')
    const body = child()
    expect(body.classList).toContain('whitespace-pre-wrap')
    expect(body.classList).not.toContain('truncate')
    expect(body.textContent).toBe('First para.\n\n  Second para.')
    expect(body.textContent).toBe(TWO_PARAS.trim())

    click()
    expectCollapsedLine('First para. Second para.')
  })

  it('U-3 Enter and Space toggle (and are prevented); other keys do nothing', () => {
    render(TWO_PARAS)
    const enter = keydown('Enter')
    expect(enter.defaultPrevented).toBe(true)
    expect(block().getAttribute('aria-expanded')).toBe('true')

    const space = keydown(' ')
    expect(space.defaultPrevented).toBe(true)
    expect(block().getAttribute('aria-expanded')).toBe('false')

    for (const key of ['a', 'Tab', 'Escape']) {
      const ev = keydown(key)
      expect(ev.defaultPrevented, key).toBe(false)
      expect(block().getAttribute('aria-expanded'), key).toBe('false')
    }
    expectCollapsedLine('First para. Second para.')

    // 展开态里别的键同样什么都不做
    keydown('Enter')
    for (const key of ['a', 'Tab', 'Escape']) {
      const ev = keydown(key)
      expect(ev.defaultPrevented, `${key} while expanded`).toBe(false)
      expect(block().getAttribute('aria-expanded'), `${key} while expanded`).toBe('true')
    }
  })

  it('U-4 a text selection blocks the click toggle, collapsed and expanded; cleared, the next click toggles', () => {
    render(TWO_PARAS)
    selectBlockText()
    click()
    expect(block().getAttribute('aria-expanded')).toBe('false')
    clearSelection()
    click()
    expect(block().getAttribute('aria-expanded')).toBe('true')

    selectBlockText()
    click()
    expect(block().getAttribute('aria-expanded')).toBe('true')
    clearSelection()
    click()
    expect(block().getAttribute('aria-expanded')).toBe('false')
  })

  it('U-5 the expanded view trims leading and trailing blank lines only, with no caret when settled', () => {
    render('\n\n\nAlpha line\n\nBeta line\n\n\n')
    click()
    expect(block().getAttribute('aria-expanded')).toBe('true')
    expect(child().textContent).toBe('Alpha line\n\nBeta line')
    expect(block().querySelector('span.animate-pulse')).toBeNull()
  })
})

describe('ThinkingBlock —— 生成中的折叠窗口不变', () => {
  it('U-6 while generating, collapsed is the one-line scrolling window with a caret and follows the end', () => {
    render('thinking about it', true)
    expect(block().getAttribute('aria-expanded')).toBe('false')
    const win = child()
    for (const cls of [...COLLAPSED_LINE, 'overflow-hidden']) expect(win.classList).toContain(cls)
    expect(win.classList).not.toContain('truncate')
    expect(win.querySelector('span.animate-pulse')).not.toBeNull()

    // jsdom 不排版：scrollHeight 恒为 0，钉一个值看 effect 有没有滚到底
    Object.defineProperty(win, 'scrollHeight', { value: 480, configurable: true })
    render('thinking about it, and then some more, and then a lot more than fits on one line', true)
    expect(child()).toBe(win)
    expect(win.scrollTop).toBe(480)
    expect(block().getAttribute('aria-expanded')).toBe('false')
  })
})

// @vitest-environment jsdom
/**
 * FrontmatterFieldPicker 的多选清单在手机上的那一副长相（`compact`；jsdom）。
 *
 * 契约：`compact` 只有多选清单（`shuvix-tools`、`shuvix-prompt-blocks`）认。清单排成一枚枚小标签
 * （`[data-chip]`），整块（`[data-list-trigger]`）是打开选择弹层的触发器；超过两行的收成「+N」
 * （`[data-chip-more]`），点「+N」只展开清单、不开弹层。只读时整块点了没反应，「+N」照样能展开。
 * 不带 `compact` 时还是原来那枚写着逗号串的按钮。
 *
 *   FP-C1..4    分派与基本形状
 *   FP-C5..9    两行的收法
 *   FP-C10..14  「+N」与触发器
 *   FP-C15..17  值变了、宽度变了、弹层开着点「+N」
 *   FP-C18..19  别的控件不认 compact
 *   FP-C20      重复项
 *
 * jsdom 没有布局，`offsetTop` 恒为 0：这里在原型上装一个按「此刻没藏起来的兄弟里排第几」算行号的 getter
 * （一行放 `perRow` 枚），藏起一枚后面的就往前挪，与真折行一个道理。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { AGENT_PROMPT_BLOCKS_KEY } from '@shuvix/chat-protocol/agentPromptBlocks'
import { AGENT_THINKING_KEY } from '@shuvix/chat-protocol/shuvixMdDescriptors'

vi.mock('@shuvix/chat-ui', () => ({
  ModelSelect: () => null,
  useModelCatalogStore: () => [],
  getChatApi: () => ({ tools: { list: async () => [] } })
}))
vi.mock('../common/ToolSelectList', () => ({ ToolSelectList: () => null }))

import { FrontmatterFieldPicker, type FrontmatterFieldPickerProps } from './FrontmatterFieldPicker'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TOOLS_KEY = 'shuvix-tools'
const TOOLS_PANEL = '.cm-shuvix-fmcard-tools-panel'
const BLOCKS_PANEL = '.cm-shuvix-fmcard-blocks-panel'

let container: HTMLDivElement
let root: Root
let onChange: ReturnType<typeof vi.fn<(next: string | null) => void>>
/** 一行放得下几枚（标签与「+N」一视同仁） */
let perRow = Infinity

async function render(props: Partial<FrontmatterFieldPickerProps>): Promise<void> {
  await act(async () => {
    root.render(
      createElement(FrontmatterFieldPicker, {
        fieldKey: TOOLS_KEY,
        markerType: 'agent',
        kind: 'csv',
        value: '',
        onChange,
        ...props
      })
    )
  })
}

const trigger = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-list-trigger]')
const chips = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-chip]')]
const chipNames = (): string[] => chips().map((chip) => chip.textContent ?? '')
const shownChips = (): string[] =>
  chips()
    .filter((chip) => !chip.hidden)
    .map((chip) => chip.textContent ?? '')
const more = (): HTMLElement => {
  const button = container.querySelector<HTMLElement>('[data-chip-more]')
  if (!button) throw new Error('+N button not rendered')
  return button
}
const panel = (selector = TOOLS_PANEL): Element | null => document.body.querySelector(selector)

async function mouseDown(target: Element): Promise<MouseEvent> {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `tool${i + 1}`)
const csv = (n: number): string => names(n).join(', ')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  perRow = Infinity
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      const box = this.parentElement
      if (!box) return 0
      const visible = [...box.querySelectorAll<HTMLElement>('[data-chip],[data-chip-more]')].filter(
        (node) => !node.hidden
      )
      const index = visible.indexOf(this)
      return index < 0 ? 0 : Math.floor(index / perRow) * 24
    }
  })
  onChange = vi.fn<(next: string | null) => void>()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FrontmatterFieldPicker —— 手机上的清单', () => {
  it('FP-C1 without compact the tools field is the comma-text button', async () => {
    await render({ value: 'read, write' })
    expect(trigger()).toBeNull()
    expect(chips()).toHaveLength(0)
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('read, write')
  })

  it('FP-C2 compact draws one chip per entry, trimmed, blanks dropped', async () => {
    await render({ value: 'read, write ,, edit', compact: true })
    expect(trigger()?.tagName).toBe('DIV')
    expect(chipNames()).toEqual(['read', 'write', 'edit'])
    expect(chips().map((chip) => chip.dataset.chip)).toEqual(['read', 'write', 'edit'])
    expect(container.textContent).not.toContain(',')
    expect(container.querySelector('button:not([data-chip-more])')).toBeNull()
  })

  it('FP-C3 the prompt-blocks field draws chips the same way', async () => {
    await render({
      fieldKey: AGENT_PROMPT_BLOCKS_KEY,
      value: 'environment, agents_md',
      compact: true
    })
    expect(trigger()?.tagName).toBe('DIV')
    expect(chipNames()).toEqual(['environment', 'agents_md'])
    await mouseDown(trigger()!)
    expect(panel(BLOCKS_PANEL)).not.toBeNull()
    expect(panel(TOOLS_PANEL)).toBeNull()
  })

  it('FP-C4 an empty compact list shows the unset text and no chips', async () => {
    await render({ value: ' , ', compact: true })
    expect(chips()).toHaveLength(0)
    expect(container.querySelector('[data-chip-more]')).toBeNull()
    expect(trigger()?.textContent).toBe(en.notebook.frontmatter.unset)
  })

  it('FP-C5 a list that fits in two rows hides nothing', async () => {
    perRow = 3
    await render({ value: csv(5), compact: true })
    expect(shownChips()).toEqual(names(5))
    expect(more().hidden).toBe(true)
  })

  it('FP-C6 ten chips at three a row: five stay, the rest become +5', async () => {
    perRow = 3
    await render({ value: csv(10), compact: true })
    expect(shownChips()).toEqual(names(5))
    expect(chips().filter((chip) => chip.hidden)).toHaveLength(5)
    expect(more().hidden).toBe(false)
    expect(more().textContent).toBe('+5')
  })

  it('FP-C7 seven chips at three a row: chips and +N fit in two rows', async () => {
    perRow = 3
    await render({ value: csv(7), compact: true })
    const hidden = chips().filter((chip) => chip.hidden).length
    expect(shownChips().length + 1).toBeLessThanOrEqual(6)
    expect(shownChips()).toEqual(names(7 - hidden))
    expect(more().hidden).toBe(false)
    expect(more().textContent).toBe(`+${hidden}`)
    expect(hidden).toBe(2)
  })

  it('FP-C8 exactly two full rows hide nothing', async () => {
    perRow = 3
    await render({ value: csv(6), compact: true })
    expect(shownChips()).toEqual(names(6))
    expect(more().hidden).toBe(true)
  })

  it('FP-C9 at one a row the first chip always stays', async () => {
    perRow = 1
    await render({ value: csv(5), compact: true })
    expect(shownChips()).toEqual(['tool1'])
    expect(more().hidden).toBe(false)
    expect(more().textContent).toBe('+4')
  })

  it('FP-C10 +N expands the list and opens no popover', async () => {
    perRow = 3
    await render({ value: csv(10), compact: true })
    const event = await mouseDown(more())
    expect(event.defaultPrevented).toBe(true)
    expect(shownChips()).toEqual(names(10))
    expect(more().hidden).toBe(true)
    expect(panel()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('FP-C11 the trigger opens the popover and a second press closes it', async () => {
    await render({ value: 'read, write', compact: true })
    const event = await mouseDown(chips()[0])
    expect(event.defaultPrevented).toBe(true)
    expect(panel()).not.toBeNull()
    await mouseDown(trigger()!)
    expect(panel()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('FP-C12 a read-only compact list is not a button and opens nothing', async () => {
    await render({ value: 'read, write', compact: true, readOnly: true })
    const box = trigger()!
    expect(box.hasAttribute('role')).toBe(false)
    expect(box.querySelector('svg')).toBeNull()
    expect(chipNames()).toEqual(['read', 'write'])
    await mouseDown(box)
    await mouseDown(chips()[0])
    expect(panel()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('FP-C13 a read-only list with overflow still expands from +N', async () => {
    perRow = 3
    await render({ value: csv(10), compact: true, readOnly: true })
    expect(more().hidden).toBe(false)
    expect(more().textContent).toBe('+5')
    await mouseDown(more())
    expect(shownChips()).toEqual(names(10))
    expect(more().hidden).toBe(true)
    expect(panel()).toBeNull()
  })

  it('FP-C14 an editable compact list is a button with a chevron, also when empty', async () => {
    await render({ value: '', compact: true })
    const box = trigger()!
    expect(box.getAttribute('role')).toBe('button')
    expect(box.querySelector('svg')).not.toBeNull()
    await mouseDown(box)
    expect(panel()).not.toBeNull()
  })

  it('FP-C15 a new value is clamped again while collapsed and shown whole while expanded', async () => {
    perRow = 3
    await render({ value: csv(7), compact: true })
    expect(more().textContent).toBe('+2')

    await render({ value: csv(10), compact: true })
    expect(shownChips()).toEqual(names(5))
    expect(more().textContent).toBe('+5')

    await mouseDown(more())
    await render({ value: csv(12), compact: true })
    expect(shownChips()).toEqual(names(12))
    expect(more().hidden).toBe(true)
  })

  it('FP-C16 a width change re-clamps, and the observer is disconnected on unmount', async () => {
    const observers: Array<{ run: () => void; observed: Element[]; disconnect: () => void }> = []
    class FakeResizeObserver {
      observed: Element[] = []
      disconnect = vi.fn()
      constructor(readonly callback: () => void) {
        observers.push({
          run: () => this.callback(),
          observed: this.observed,
          disconnect: this.disconnect
        })
      }
      observe(target: Element): void {
        this.observed.push(target)
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)

    perRow = 3
    await render({ value: csv(10), compact: true })
    expect(observers).toHaveLength(1)
    expect(observers[0].observed).toEqual([chips()[0].parentElement])
    expect(more().textContent).toBe('+5')

    perRow = 2
    act(() => observers[0].run())
    expect(shownChips()).toEqual(names(3))
    expect(more().textContent).toBe('+7')

    perRow = 6
    act(() => observers[0].run())
    expect(shownChips()).toEqual(names(10))
    expect(more().hidden).toBe(true)

    expect(observers[0].disconnect).not.toHaveBeenCalled()
    await act(async () => root.render(null))
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1)
  })

  it('FP-C17 +N pressed while the popover is open expands and leaves it open', async () => {
    perRow = 3
    await render({ value: csv(10), compact: true })
    await mouseDown(chips()[0])
    expect(panel()).not.toBeNull()
    await mouseDown(more())
    expect(panel()).not.toBeNull()
    expect(shownChips()).toEqual(names(10))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('FP-C18 a plain csv key ignores compact and stays a text input', async () => {
    await render({ fieldKey: 'tags', markerType: 'okf', value: 'a, b', compact: true })
    expect(trigger()).toBeNull()
    expect(chips()).toHaveLength(0)
    const input = container.querySelector('input')
    expect(input?.value).toBe('a, b')
  })

  it.each(['', 'off', 'xhigh', 'minimal'])(
    'FP-C19 the thinking select with value "%s" is the same with compact',
    async (value) => {
      const props = { fieldKey: AGENT_THINKING_KEY, kind: 'select' as const, value }
      await render(props)
      const plain = container.innerHTML
      expect(container.querySelector('select')).not.toBeNull()
      await render({ ...props, compact: true })
      expect(container.innerHTML).toBe(plain)
      expect(trigger()).toBeNull()
      expect(onChange).not.toHaveBeenCalled()
    }
  )

  it('FP-C20 a repeated entry draws two chips without a React key warning', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await render({ value: 'read, read', compact: true })
    expect(chipNames()).toEqual(['read', 'read'])
    await render({ value: 'read, read, write', compact: true })
    expect(chipNames()).toEqual(['read', 'read', 'write'])
    expect(error).not.toHaveBeenCalled()
  })
})

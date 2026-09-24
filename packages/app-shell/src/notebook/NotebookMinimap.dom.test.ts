// @vitest-environment jsdom
/**
 * 笔记本右侧目录 NotebookMinimap（jsdom）—— 组件本身的契约：
 *
 *   - 一个 `<nav>`，名字是 `notebook.outline`；
 *   - 第一个孩子是 `aria-hidden` 的横线列：一个标题一条横线，长短按**相对**级别（0 > 1 > 2 > 3，更深的沿用
 *     最后一档；从 H2 写起的文档顶级横线与从 H1 写起的一样长），当前章节那条的样式与其余不同；
 *   - 第二个孩子是目录卡片：一个标题一颗 `<button type="button">`，文字 / title = 标题文字，按相对级别缩进，
 *     当前那颗 `aria-current="location"`；
 *   - 点第 i 项 → `onJump(headings[i].line)`（行号，不是下标）；
 *   - 指针点击后按钮交还焦点（只读预览不会把焦点交还编辑器，留着会让下一次按键把卡片顶开），
 *     键盘触发（`detail === 0`）保留焦点。
 *
 * 只比相对关系（宽度大小、缩进大小、类名集合相同 / 不同），不钉 px 数值与 Tailwind 类名。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { NotebookMinimap } from './NotebookMinimap'
import type { NotebookHeading } from './notebookHeadings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let onJump: ReturnType<typeof vi.fn>

const hd = (level: number, line: number, text: string): NotebookHeading => ({ level, text, line })

/** H1…H6 各一个 → 相对级别 0…5 */
const ALL_LEVELS: NotebookHeading[] = [1, 2, 3, 4, 5, 6].map((level) =>
  hd(level, level * 10, `Level ${level}`)
)

/** 从 H2 写起的文档（相对级别 [0,1,2,0]） */
const H2_ROOTED: NotebookHeading[] = [
  hd(2, 3, 'Intro'),
  hd(3, 9, 'Detail'),
  hd(4, 15, 'Deeper'),
  hd(2, 30, 'Outro')
]

function render(headings: NotebookHeading[], activeIndex: number): void {
  act(() => {
    root.render(
      createElement(NotebookMinimap, {
        headings,
        activeIndex,
        onJump: onJump as unknown as (line: number) => void
      })
    )
  })
}

const nav = (): HTMLElement => {
  const all = container.querySelectorAll('nav')
  expect(all).toHaveLength(1)
  return all[0]
}
/** 横线列 = nav 里 aria-hidden 的那个孩子 */
const rail = (): HTMLElement => {
  const hit = [...nav().children].find((c) => c.getAttribute('aria-hidden') === 'true')
  if (!(hit instanceof HTMLElement)) throw new Error('no aria-hidden rail in nav')
  return hit
}
const dashes = (): HTMLElement[] => [...rail().children] as HTMLElement[]
/** 目录卡片 = nav 里另一个孩子 */
const card = (): HTMLElement => {
  const hit = [...nav().children].find((c) => c !== rail())
  if (!(hit instanceof HTMLElement)) throw new Error('no card in nav')
  return hit
}
const entries = (): HTMLButtonElement[] => [...card().querySelectorAll('button')]

const widthOf = (el: HTMLElement): number => parseFloat(el.style.width)
const indentOf = (el: HTMLElement): number => parseFloat(el.style.paddingLeft)
const classSet = (el: Element): string => [...el.classList].sort().join(' ')
const currentIndexes = (): number[] =>
  entries()
    .map((b, i) => (b.getAttribute('aria-current') === 'location' ? i : -1))
    .filter((i) => i >= 0)

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  onJump = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('结构与名字', () => {
  it('C1 恰好一个 <nav>，aria-label = notebook.outline', () => {
    render(H2_ROOTED, 0)
    const label = i18n.t('notebook.outline')
    expect(label).not.toBe('notebook.outline')
    expect(nav().getAttribute('aria-label')).toBe(label)
  })
})

describe('横线列', () => {
  it('C2 aria-hidden、一个标题一条；相对级别 0 > 1 > 2 > 3 逐级变短，4、5 与 3 同长', () => {
    render(ALL_LEVELS, -1)
    expect(rail().getAttribute('aria-hidden')).toBe('true')
    expect(dashes()).toHaveLength(ALL_LEVELS.length)
    const w = dashes().map(widthOf)
    for (const x of w) expect(Number.isFinite(x) && x > 0).toBe(true)
    expect(w[0]).toBeGreaterThan(w[1])
    expect(w[1]).toBeGreaterThan(w[2])
    expect(w[2]).toBeGreaterThan(w[3])
    expect(w[4]).toBe(w[3])
    expect(w[5]).toBe(w[3])
  })

  it('C2 从 H2 写起的文档：顶级横线与从 H1 写起的一样长；同级同长', () => {
    render(ALL_LEVELS, -1)
    const h1Top = widthOf(dashes()[0])
    const h1Second = widthOf(dashes()[1])
    render(H2_ROOTED, -1)
    const w = dashes().map(widthOf)
    expect(w[0]).toBe(h1Top)
    expect(w[1]).toBe(h1Second)
    // 两个 H2（相对级别 0）一样长
    expect(w[3]).toBe(w[0])
  })

  it('C3 当前章节那条的类名集合与其余不同，其余彼此相同；-1 时全部相同', () => {
    render(H2_ROOTED, 2)
    const sets = dashes().map(classSet)
    const others = sets.filter((_, i) => i !== 2)
    expect(new Set(others).size).toBe(1)
    expect(sets[2]).not.toBe(others[0])

    render(H2_ROOTED, -1)
    expect(new Set(dashes().map(classSet)).size).toBe(1)
  })
})

describe('目录卡片', () => {
  it('C4 一个标题一颗 type=button，按序；文字与 title = 标题文字；aria-current 只在当前项', () => {
    render(H2_ROOTED, 1)
    const btns = entries()
    expect(btns).toHaveLength(H2_ROOTED.length)
    btns.forEach((b, i) => {
      expect(b.getAttribute('type')).toBe('button')
      expect(b.textContent).toBe(H2_ROOTED[i].text)
      expect(b.title).toBe(H2_ROOTED[i].text)
    })
    expect(currentIndexes()).toEqual([1])

    render(H2_ROOTED, -1)
    expect(currentIndexes()).toEqual([])
  })

  it('C4 缩进随相对级别增长，同级同缩进', () => {
    render(H2_ROOTED, -1)
    const pad = entries().map(indentOf)
    for (const x of pad) expect(Number.isFinite(x)).toBe(true)
    expect(pad[1]).toBeGreaterThan(pad[0])
    expect(pad[2]).toBeGreaterThan(pad[1])
    expect(pad[3]).toBe(pad[0])
  })

  it('C5 点第 i 项 → onJump 恰好一次、参数是它的行号（不是下标）；同名标题各报各的行', () => {
    const twins = [hd(2, 4, 'Same'), hd(3, 12, 'Other'), hd(2, 27, 'Same')]
    render(twins, -1)
    act(() => entries()[1].click())
    expect(onJump).toHaveBeenCalledTimes(1)
    expect(onJump).toHaveBeenLastCalledWith(12)

    act(() => entries()[0].click())
    expect(onJump).toHaveBeenCalledTimes(2)
    expect(onJump).toHaveBeenLastCalledWith(4)

    act(() => entries()[2].click())
    expect(onJump).toHaveBeenCalledTimes(3)
    expect(onJump).toHaveBeenLastCalledWith(27)
  })

  it('C6 换 activeIndex 重渲染：aria-current 与横线的加深一起挪走，不留旧的', () => {
    render(H2_ROOTED, 0)
    expect(currentIndexes()).toEqual([0])
    const emphasised = (): number[] => {
      const sets = dashes().map(classSet)
      // 与多数不同的那条（只有一种样式时为空）
      const counts = new Map<string, number>()
      for (const s of sets) counts.set(s, (counts.get(s) ?? 0) + 1)
      return sets.map((s, i) => (counts.get(s) === 1 ? i : -1)).filter((i) => i >= 0)
    }
    expect(emphasised()).toEqual([0])

    render(H2_ROOTED, 3)
    expect(currentIndexes()).toEqual([3])
    expect(emphasised()).toEqual([3])

    render(H2_ROOTED, -1)
    expect(currentIndexes()).toEqual([])
    expect(emphasised()).toEqual([])
  })
})

describe('点击后的焦点', () => {
  it('C7 指针点击（detail 1）交还焦点；键盘触发（detail 0）保留焦点；两次都跳转', () => {
    render(H2_ROOTED, -1)
    const btn = entries()[2]

    act(() => btn.focus())
    expect(document.activeElement).toBe(btn)
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    })
    expect(onJump).toHaveBeenCalledTimes(1)
    expect(onJump).toHaveBeenLastCalledWith(H2_ROOTED[2].line)
    expect(document.activeElement).not.toBe(btn)

    act(() => btn.focus())
    expect(document.activeElement).toBe(btn)
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))
    })
    expect(onJump).toHaveBeenCalledTimes(2)
    expect(onJump).toHaveBeenLastCalledWith(H2_ROOTED[2].line)
    expect(document.activeElement).toBe(btn)
  })
})

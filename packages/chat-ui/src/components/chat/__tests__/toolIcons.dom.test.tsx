// @vitest-environment jsdom
/**
 * 内置工具的图标真能画出来（`renderToolIcon`，jsdom）。
 *
 * 图标名是 chat-protocol `LucideIconName` 里的字面量，组件映射是 ToolCallBlock 里的 `ICON_MAP`；两边各改一处，
 * 漏了映射那一处时 `resolveLucideIcon` 不报错、静悄悄落回扳手 —— 类型检查抓不到，只有画出来看得到。
 *
 *   TIc-1 `BUILTIN_TOOL_PRESENTATIONS` 里每个图标不是 `Wrench` 的工具，`renderToolIcon(presentation)` 都不画
 *         `lucide-wrench`（`show_image` 的 `Image` 在内）；对照：没给图标 / 明写 `Wrench` 时画的就是扳手
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'
import { renderToolIcon } from '../ToolCallBlock'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function draw(pres?: Omit<ToolPresentation, 'label'>): SVGElement {
  act(() =>
    root.render(createElement(Fragment, null, renderToolIcon(pres as ToolPresentation | undefined)))
  )
  const svg = container.querySelector<SVGElement>('svg')
  expect(svg).not.toBeNull()
  return svg!
}

const isWrench = (svg: SVGElement): boolean =>
  (svg.getAttribute('class') ?? '').split(/\s+/).includes('lucide-wrench')

const withIcon = Object.entries(BUILTIN_TOOL_PRESENTATIONS).filter(
  ([, def]) => def.presentation?.icon !== undefined && def.presentation.icon !== 'Wrench'
)

describe('TIc-1 内置工具的图标', () => {
  it('TIc-1 对照：没给图标、明写 Wrench → 画的是扳手', () => {
    expect(isWrench(draw(undefined))).toBe(true)
    expect(isWrench(draw({ icon: 'Wrench' }))).toBe(true)
  })

  it('TIc-1 show_image 的 Image 在被检查之列', () => {
    expect(withIcon.map(([name]) => name)).toContain('show_image')
  })

  it('TIc-1 tool_search 的 Puzzle 真画成拼图（映射漏了就落回扳手）', () => {
    expect(withIcon.map(([name]) => name)).toContain('tool_search')
    const svg = draw(BUILTIN_TOOL_PRESENTATIONS.tool_search.presentation)
    expect((svg.getAttribute('class') ?? '').split(/\s+/)).toContain('lucide-puzzle')
  })

  it.each(withIcon)('TIc-1 %s：图标不落回扳手', (_name, def) => {
    const svg = draw(def.presentation)
    expect(isWrench(svg)).toBe(false)
  })
})

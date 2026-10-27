// @vitest-environment jsdom
/**
 * TouchSheet（触屏密度下的底部抽屉，jsdom）与 `useChatDensity`：
 *
 *   TC-TS-1 portal 到 body：`[data-touch-sheet="<name>"]` 是 body 的直接子节点（不在挂载容器里）；里面一块
 *           `[data-touch-sheet-backdrop][aria-hidden="true"]` 遮罩、恰一个 `[role="dialog"]` 包着内容；
 *           `panelRef` 指向那个 dialog；底部留安全区（`pb-[env(safe-area-inset-bottom)]`）；卸载即移除
 *   TC-TS-2 只有遮罩会关：点内容、点 dialog 本身 → onClose 0 次；点遮罩 → 恰 1 次
 *   TC-TS-3 标题可选：给了 → dialog 三个子节点（把手、标题、内容），标题在内容前；没给 → 两个，没有那段字
 *   TC-TS-4 useChatDensity：没有 Provider → compact；`{density:'touch'}` → touch；Provider 不带 density → compact
 *
 * 文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TouchSheet } from '../TouchSheet'
import {
  ChatHostContext,
  useChatDensity,
  type ChatDensity,
  type ChatHostValue
} from '../../../host/chatHostContext'

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
  document.body.innerHTML = ''
})

/** children 走 createElement 的第三个参数（lint 不让当 prop 传）：类型上把它从必填 props 里拿掉 */
const Sheet = TouchSheet as (
  props: Omit<Parameters<typeof TouchSheet>[0], 'children'> & { children?: ReactNode }
) => React.JSX.Element

function renderSheet(
  props: { title?: ReactNode; panelRef?: React.Ref<HTMLDivElement> } = {}
): ReturnType<typeof vi.fn> {
  const onClose = vi.fn()
  act(() =>
    root.render(
      createElement(
        Sheet,
        { name: 'x', onClose, ...props },
        createElement('button', { type: 'button', 'data-child': '' }, 'child content')
      )
    )
  )
  return onClose
}

const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-touch-sheet]')
const dialog = (): HTMLElement => sheet()!.querySelector<HTMLElement>('[role="dialog"]')!
const backdrop = (): HTMLElement =>
  sheet()!.querySelector<HTMLElement>('[data-touch-sheet-backdrop]')!
const child = (): HTMLElement => document.querySelector<HTMLElement>('[data-child]')!

describe('TouchSheet', () => {
  it('TC-TS-1 portal 到 body、遮罩 + 一个 dialog 包着内容、panelRef、安全区、卸载即移除', () => {
    const panelRef = createRef<HTMLDivElement>()
    renderSheet({ panelRef })
    const el = sheet()
    expect(el).not.toBeNull()
    expect(el!.getAttribute('data-touch-sheet')).toBe('x')
    expect(el!.parentElement).toBe(document.body)
    expect(container.contains(el)).toBe(false)
    expect(container.querySelector('[data-touch-sheet]')).toBeNull()

    const bd = el!.querySelector('[data-touch-sheet-backdrop]')
    expect(bd).not.toBeNull()
    expect(bd!.getAttribute('aria-hidden')).toBe('true')
    const dialogs = el!.querySelectorAll('[role="dialog"]')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]!.contains(child())).toBe(true)
    expect(bd!.contains(child())).toBe(false)
    expect(panelRef.current).toBe(dialogs[0])
    expect(dialogs[0]!.className).toContain('pb-[env(safe-area-inset-bottom)]')

    act(() => root.unmount())
    expect(sheet()).toBeNull()
    expect(document.querySelector('[data-child]')).toBeNull()
    // afterEach 还要再卸载一次：换一个新 root
    root = createRoot(container)
  })

  it('TC-TS-2 只有遮罩会关：点内容、点 dialog → 0 次；点遮罩 → 恰 1 次', () => {
    const onClose = renderSheet()
    act(() => child().click())
    expect(onClose).not.toHaveBeenCalled()
    act(() => dialog().click())
    expect(onClose).not.toHaveBeenCalled()
    act(() => backdrop().click())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('TC-TS-3 给了标题：三个子节点（把手、标题、内容），标题在内容前', () => {
    renderSheet({ title: 'T' })
    const kids = [...dialog().children]
    expect(kids).toHaveLength(3)
    const titleIndex = kids.findIndex((k) => k.textContent === 'T')
    const bodyIndex = kids.findIndex((k) => k.contains(child()))
    expect(titleIndex).toBe(1)
    expect(bodyIndex).toBe(2)
    // 第一个是把手：既不是标题也不装内容
    expect(kids[0]!.textContent).toBe('')
  })

  it('TC-TS-3 没给标题：两个子节点（把手、内容），没有 T', () => {
    renderSheet()
    const kids = [...dialog().children]
    expect(kids).toHaveLength(2)
    expect(kids[1]!.contains(child())).toBe(true)
    expect(dialog().textContent).toBe('child content')
    expect(dialog().textContent).not.toContain('T')
  })
})

describe('useChatDensity', () => {
  /** 把读到的密度画出来（渲染期不写外面的变量） */
  function Probe(): React.JSX.Element {
    return createElement('span', { 'data-density': useChatDensity() })
  }
  const seen = (): ChatDensity | null =>
    (container.querySelector('[data-density]')?.getAttribute('data-density') as ChatDensity) ?? null

  it('TC-TS-4 没有 Provider → compact', () => {
    act(() => root.render(createElement(Probe)))
    expect(seen()).toBe('compact')
  })

  it("TC-TS-4 Provider 给 {density:'touch'} → touch", () => {
    act(() =>
      root.render(
        createElement(
          ChatHostContext.Provider,
          { value: { density: 'touch' } as ChatHostValue },
          createElement(Probe)
        )
      )
    )
    expect(seen()).toBe('touch')
  })

  it('TC-TS-4 Provider 不带 density → compact', () => {
    act(() =>
      root.render(
        createElement(
          ChatHostContext.Provider,
          { value: {} as ChatHostValue },
          createElement(Probe)
        )
      )
    )
    expect(seen()).toBe('compact')
  })
})

// @vitest-environment jsdom
/**
 * chat-ui 包内的 ConfirmDialog（jsdom）：不给 `cancelText` = 纯说明框，只有确认这一颗按钮。
 *
 *   CD-1 不给 cancelText：恰好一颗按钮，点它 → onConfirm（不调 onCancel）；Escape、点遮罩 → 退出动画后
 *        onCancel；点框里面不关
 *   CD-2 给了 cancelText：两颗（取消在前、确认在后），取消 → onCancel；`danger: false` → 确认按钮用强调色
 *        （bg-accent），缺省 / `danger: true` → 危险色（bg-error）
 *
 * 文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConfirmDialog, type ConfirmDialogProps } from '../ConfirmDialog'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(props: Partial<ConfirmDialogProps> = {}): {
  onConfirm: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
} {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  act(() =>
    root.render(
      createElement(ConfirmDialog, {
        title: 'Title',
        description: 'Why it failed',
        confirmText: 'Close',
        onConfirm,
        onCancel,
        ...props
      })
    )
  )
  return { onConfirm, onCancel }
}

const overlay = (): HTMLElement => container.querySelector<HTMLElement>('.dialog-overlay')!
const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll('button')]
/** 退出动画（useDialogClose 的 120ms）走完 */
const finishAnimation = (): void => {
  act(() => {
    vi.advanceTimersByTime(200)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('chat-ui ConfirmDialog', () => {
  it('CD-1 不给 cancelText：恰好一颗按钮，点它 → onConfirm', () => {
    const { onConfirm, onCancel } = render({ danger: false })
    expect(container.querySelector('h3')!.textContent).toBe('Title')
    expect(container.textContent).toContain('Why it failed')
    expect(buttons()).toHaveLength(1)
    expect(buttons()[0].textContent).toBe('Close')
    act(() => buttons()[0].click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    finishAnimation()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('CD-1 Escape → 退出动画后 onCancel', () => {
    const { onConfirm, onCancel } = render()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(overlay().className).toContain('dialog-closing')
    expect(onCancel).not.toHaveBeenCalled()
    finishAnimation()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('CD-1 点遮罩 → onCancel；点框里面不关', () => {
    const { onCancel } = render()
    act(() => container.querySelector<HTMLElement>('h3')!.click())
    finishAnimation()
    expect(onCancel).not.toHaveBeenCalled()
    act(() => overlay().click())
    finishAnimation()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('CD-2 给了 cancelText：两颗，取消在前；取消 → onCancel，确认 → onConfirm', () => {
    const { onConfirm, onCancel } = render({ cancelText: 'Cancel', confirmText: 'Delete' })
    expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'Delete'])
    act(() => buttons()[0].click())
    finishAnimation()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    act(() => buttons()[1].click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('CD-2 danger:false → 确认按钮 bg-accent；缺省 / danger:true → bg-error', () => {
    render({ cancelText: 'Cancel', danger: false })
    const confirm = (): HTMLButtonElement => buttons().at(-1)!
    expect(confirm().className).toContain('bg-accent')
    expect(confirm().className).not.toContain('bg-error')

    render({ cancelText: 'Cancel' })
    expect(confirm().className).toContain('bg-error')
    expect(confirm().className).not.toContain('bg-accent')

    render({ cancelText: 'Cancel', danger: true })
    expect(confirm().className).toContain('bg-error')
  })
})

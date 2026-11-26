// @vitest-environment jsdom
/**
 * ScrollToBottomButton（jsdom）：waiting="form" 时渲染 [data-pending-jump="form"]、等待文案并响应点击。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { ScrollToBottomButton } from '../ScrollToBottomButton'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ScrollToBottomButton', () => {
  it('AF-20 waiting="form" 时渲染 [data-pending-jump="form"] 及等待文案并响应点击', () => {
    const onClick = vi.fn()
    act(() => {
      root.render(
        createElement(ScrollToBottomButton, {
          visible: true,
          running: true,
          waiting: 'form',
          onClick
        })
      )
    })
    const btn = container.querySelector<HTMLButtonElement>('[data-pending-jump="form"]')
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toContain(en.pendingInputs.jumpChoice)
    expect(btn!.classList.contains('border-accent/45')).toBe(true)
    act(() => btn!.click())
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

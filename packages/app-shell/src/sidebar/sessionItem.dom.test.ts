// @vitest-environment jsdom
/**
 * SessionItem 的「被中断」圆点（jsdom，P3-12-14，Q-P3-10）：
 *
 *   - `interrupted` → `[data-interrupted]`，带悬浮提示；
 *   - 在跑（`isStreaming`）时不显示圆点；
 *   - 与待答询问计数并存；
 *   - 顶层行、子会话行（`isSub`）、bot 行都一样。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { SessionItem, type SessionItemProps } from './SessionItem'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(props: Partial<SessionItemProps>): void {
  act(() =>
    root.render(
      createElement(SessionItem, {
        session: { id: 's1', title: 'Session one' },
        active: false,
        onSelect: () => {},
        ...props
      })
    )
  )
}

const dot = (): HTMLElement | null => container.querySelector('[data-interrupted]')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
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

describe('P3-12-14 sidebar row', () => {
  it('P3-12-14 interrupted renders [data-interrupted] with a tooltip; absent otherwise', () => {
    render({ interrupted: true })
    expect(dot()).not.toBeNull()
    expect(dot()!.title).toBe(en.sidebar.interrupted)
    render({ interrupted: false })
    expect(dot()).toBeNull()
    render({})
    expect(dot()).toBeNull()
  })

  it('P3-12-14 isStreaming suppresses the dot', () => {
    render({ interrupted: true, isStreaming: true })
    expect(dot()).toBeNull()
  })

  it('P3-12-14 it coexists with the pending-ask count', () => {
    render({ interrupted: true, pendingCount: 2 })
    expect(dot()).not.toBeNull()
    expect(container.textContent).toContain('2')
  })

  it.each<[string, Partial<SessionItemProps>]>([
    ['top-level', {}],
    ['sub-session', { isSub: true }],
    ['bot', { isBot: true }],
    ['parent with subs', { subCount: 2 }]
  ])('P3-12-14 a %s row supports it', (_label, props) => {
    render({ ...props, interrupted: true })
    expect(dot()).not.toBeNull()
  })
})

// @vitest-environment jsdom
/**
 * 浏览器卡片（BrowserCard）上「页面崩溃了」的那一面（CR-U18）。
 *
 * 崩溃的 view 什么也不画：卡片不给页面占位（不渲染 `[data-page-area]`、不登记 placeholder —— 不进布局表，
 * 主进程就不把那张空白的原生页面叠上来），换成标题「This page crashed」+ 一句带原因的说明 + 重试；
 * 没有「Error code」那行、也没有证书提示。重试按 loadError 的地址导航（主进程那头就是 IPC navigate）。
 * 对照：普通的加载失败（-105）照旧是「This site can't be reached」+「Error code: -105 (…)」。
 *
 * 真 en 资源；`window.api.browserView` 只是个空壳（工具条的按钮不点）。桌面 vitest 对渲染层只收
 * `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { BrowserCard, type BrowserCardProps } from '../BrowserCard'
import type { BrowserTabInfo } from '../../../stores/browserTabsStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PAGE_URL = 'https://x.test/'

let container: HTMLDivElement
let root: Root

function tabWith(loadError: BrowserTabInfo['loadError']): BrowserTabInfo {
  return {
    id: 'tab-1',
    url: PAGE_URL,
    title: 'X',
    isLoading: false,
    loadError,
    cdpAttached: false,
    cdpIntercepting: false
  }
}

function props(tab: BrowserTabInfo): BrowserCardProps & {
  onNavigate: ReturnType<typeof vi.fn>
  registerPlaceholder: ReturnType<typeof vi.fn>
} {
  return {
    tab,
    isActive: true,
    live: true,
    zoomPercent: 50,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onNavigate: vi.fn<(url: string) => void>(),
    onOpenExternal: vi.fn(),
    registerPlaceholder: vi.fn<(el: HTMLDivElement | null) => void>()
  }
}

async function mount(p: BrowserCardProps): Promise<void> {
  await act(async () => {
    root.render(createElement(BrowserCard, p))
  })
}

/** 错误面板里的标题与它下面那一段 */
const heading = (): HTMLHeadingElement | null => container.querySelector('h2')
const detail = (): string => (heading()?.nextElementSibling?.textContent ?? '').trim()

const retryButton = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === 'Retry'
  )

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = { browserView: {} }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('页面崩溃了的卡片（CR-U18）', () => {
  it('CR-U18 标题「This page crashed」、说明带原因；没有错误码、没有证书提示、不给页面占位；重试按 loadError 的地址导航一次', async () => {
    const p = props(
      tabWith({ errorCode: 0, errorDescription: 'oom', url: PAGE_URL, crashed: true })
    )
    await mount(p)

    expect(heading()?.textContent?.trim()).toBe('This page crashed')
    expect(detail()).toBe("The page's process stopped (oom).")
    expect(container.textContent).not.toContain('Error code')
    expect(container.textContent).not.toContain(i18n.t('browser.error.certHint'))
    expect(container.textContent).not.toContain("This site can't be reached")
    expect(container.querySelector('[data-page-area]')).toBeNull()
    expect(p.registerPlaceholder.mock.calls.filter(([el]) => el != null)).toEqual([])

    const retry = retryButton()
    expect(retry).toBeDefined()
    await act(async () => {
      retry!.click()
    })
    expect(p.onNavigate).toHaveBeenCalledTimes(1)
    expect(p.onNavigate).toHaveBeenCalledWith(PAGE_URL)
  })

  it("CR-U18 对照：普通的加载失败（-105）→「This site can't be reached」+「Error code: -105 (…)」", async () => {
    await mount(
      props(tabWith({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', url: PAGE_URL }))
    )
    expect(heading()?.textContent?.trim()).toBe("This site can't be reached")
    expect(detail()).toBe('Error code: -105 (ERR_NAME_NOT_RESOLVED)')
    expect(container.textContent).not.toContain('This page crashed')
  })
})

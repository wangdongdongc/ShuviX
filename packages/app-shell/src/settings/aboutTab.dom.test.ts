// @vitest-environment jsdom
/**
 * AboutTab 的更新区块在主进程装不了更新时（无头运行，`available` 带 `manual`）：不给下载按钮，改为说明 +
 * 要在那台电脑上执行的命令（带复制）；没有命令（非 Linux）只给说明；没有 `manual` 时照旧给下载按钮。
 *
 *   AB-1 manual 带命令：没有下载按钮；[data-update-manual] 的说明 = about.updateManual；[data-update-command] = 命令；
 *        复制钮写着 about.copyCommand；状态行 = about.updateAvailable；检查钮可点、调 onCheck；onDownload 从不调
 *   AB-2 点复制（假计时器）：copyToClipboard 恰以命令调一次；钮变成 about.commandCopied；1499ms 时仍是，1500ms 时变回
 *   AB-3 manual {command: null}：说明 = about.updateManualNoCommand；没有命令、没有复制钮、没有 code 元素、没有下载钮
 *   AB-4 没有 manual：有下载钮、点它调 onDownload；没有 manual 区块
 *   AB-5 重新渲染成 up-to-date / null → manual 区块消失
 *   AB-6 协议那行的 GitHub 图标钮：点它以仓库地址调 openExternal；不再有「项目」区块
 *   AB-7 appLog：日志区块写着路径；「查看」调 onView；复制钮复制路径并显示 about.pathCopied 1500ms；给了 onReveal 才有
 *        「在文件夹中显示」，点它调 onReveal
 *   AB-8 不给 appLog（扩展）→ 没有日志区块
 *
 * `@shuvix/chat-ui` 的包入口很重（mermaid 等），这里只给它一个 copyToClipboard 替身。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { UpdateEvent } from '@shuvix/chat-protocol/chatApi'

const mocks = vi.hoisted(() => ({ copyToClipboard: vi.fn<(text: string) => void>() }))
vi.mock('@shuvix/chat-ui', () => ({ copyToClipboard: mocks.copyToClipboard }))

import { AboutTab, type AboutTabLogApi, type AboutTabUpdateApi } from './AboutTab'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CMD =
  'curl -fsSL https://github.com/wangdongdongc/ShuviX/releases/download/v0.2.13/install-linux.sh | bash -s -- --version v0.2.13'
const AVAILABLE = {
  type: 'available',
  version: '0.2.13',
  releaseDate: '2026-10-14T00:00:00.000Z',
  releaseNotes: null
} as const

let container: HTMLDivElement
let root: Root
type VoidMock = ReturnType<typeof vi.fn<() => void>>
let update: AboutTabUpdateApi & {
  onToggleAutoCheck: VoidMock
  onCheck: VoidMock
  onDownload: VoidMock
  onInstall: VoidMock
}

async function render(event: UpdateEvent | null): Promise<void> {
  update = { ...update, event }
  await act(async () => {
    root.render(createElement(AboutTab, { appVersion: '0.2.12', openExternal: vi.fn(), update }))
  })
}

const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll('button')]
const buttonWithText = (text: string): HTMLButtonElement | undefined =>
  buttons().find((b) => b.textContent?.trim() === text)
const manualBlock = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-update-manual]')
const copyButton = (): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>('[data-update-command-copy]')
  if (!el) throw new Error('[data-update-command-copy] not rendered')
  return el
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  mocks.copyToClipboard.mockReset()
  update = {
    autoCheck: true,
    event: null,
    onToggleAutoCheck: vi.fn<() => void>(),
    onCheck: vi.fn<() => void>(),
    onDownload: vi.fn<() => void>(),
    onInstall: vi.fn<() => void>()
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('AboutTab 的手动更新区块', () => {
  it('AB-1 manual 带命令：说明 + 命令 + 复制钮，没有下载钮；检查钮照旧可点', async () => {
    await render({ ...AVAILABLE, manual: { command: CMD } })
    expect(buttonWithText(i18n.t('about.updateDownload'))).toBeUndefined()

    const manual = manualBlock()
    expect(manual).not.toBeNull()
    expect(manual!.querySelector('p')?.textContent).toBe(i18n.t('about.updateManual'))
    expect(container.querySelector('[data-update-command]')?.textContent).toBe(CMD)
    expect(copyButton().textContent?.trim()).toBe(i18n.t('about.copyCommand'))

    expect(container.textContent).toContain(i18n.t('about.updateAvailable', { version: '0.2.13' }))

    const check = buttonWithText(i18n.t('about.checkUpdate'))
    expect(check).toBeDefined()
    expect(check!.disabled).toBe(false)
    await act(async () => {
      check!.click()
    })
    expect(update.onCheck).toHaveBeenCalledTimes(1)
    expect(update.onDownload).not.toHaveBeenCalled()
  })

  it('AB-2 点复制：复制那条命令；显示「已复制」恰 1500ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await render({ ...AVAILABLE, manual: { command: CMD } })
    await act(async () => {
      copyButton().click()
    })
    expect(mocks.copyToClipboard).toHaveBeenCalledTimes(1)
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(CMD)
    expect(copyButton().textContent?.trim()).toBe(i18n.t('about.commandCopied'))

    act(() => {
      vi.advanceTimersByTime(1499)
    })
    expect(copyButton().textContent?.trim()).toBe(i18n.t('about.commandCopied'))
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(copyButton().textContent?.trim()).toBe(i18n.t('about.copyCommand'))
    expect(mocks.copyToClipboard).toHaveBeenCalledTimes(1)
  })

  it('AB-3 manual {command: null}：只有说明，没有命令 / 复制钮 / code / 下载钮', async () => {
    await render({ ...AVAILABLE, manual: { command: null } })
    const manual = manualBlock()
    expect(manual).not.toBeNull()
    expect(manual!.textContent).toBe(i18n.t('about.updateManualNoCommand'))
    expect(container.querySelector('[data-update-command]')).toBeNull()
    expect(container.querySelector('[data-update-command-copy]')).toBeNull()
    expect(container.querySelector('code')).toBeNull()
    expect(buttonWithText(i18n.t('about.updateDownload'))).toBeUndefined()
    expect(buttonWithText(i18n.t('about.copyCommand'))).toBeUndefined()
  })

  it('AB-4 没有 manual：照旧有下载钮，点它调 onDownload；没有 manual 区块', async () => {
    await render({ ...AVAILABLE })
    expect(manualBlock()).toBeNull()
    const download = buttonWithText(i18n.t('about.updateDownload'))
    expect(download).toBeDefined()
    await act(async () => {
      download!.click()
    })
    expect(update.onDownload).toHaveBeenCalledTimes(1)
  })

  it('AB-5 重新渲染成 up-to-date / null → manual 区块消失', async () => {
    await render({ ...AVAILABLE, manual: { command: CMD } })
    expect(manualBlock()).not.toBeNull()
    await render({ type: 'up-to-date', version: '0.2.13' })
    expect(manualBlock()).toBeNull()
    expect(container.querySelector('[data-update-command]')).toBeNull()

    await render({ ...AVAILABLE, manual: { command: CMD } })
    expect(manualBlock()).not.toBeNull()
    await render(null)
    expect(manualBlock()).toBeNull()
    expect(container.querySelector('[data-update-command]')).toBeNull()
  })

  it('AB-6 协议那行的 GitHub 图标钮打开仓库；没有「项目」区块', async () => {
    const openExternal = vi.fn<(url: string) => void>()
    await act(async () => {
      root.render(createElement(AboutTab, { appVersion: '0.2.12', openExternal }))
    })
    const repo = container.querySelector<HTMLButtonElement>('[data-about-repo]')
    expect(repo).not.toBeNull()
    expect(repo!.getAttribute('aria-label')).toBe(i18n.t('about.sourceCode'))
    expect(repo!.parentElement?.textContent).toContain(i18n.t('about.license'))
    await act(async () => {
      repo!.click()
    })
    expect(openExternal).toHaveBeenCalledWith('https://github.com/wangdongdongc/ShuviX')
    expect(container.textContent).not.toContain('Project')
  })
})

describe('AboutTab 的日志区块', () => {
  const LOG_PATH = '/Users/someone/Library/Logs/ShuviX/main.log'

  async function renderLog(appLog?: AboutTabLogApi): Promise<void> {
    await act(async () => {
      root.render(createElement(AboutTab, { appVersion: '0.2.30', openExternal: vi.fn(), appLog }))
    })
  }

  it('AB-7 路径 + 查看 + 复制路径 + 在文件夹中显示', async () => {
    vi.useFakeTimers()
    const onView = vi.fn<() => void>()
    const onReveal = vi.fn<() => void>()
    await renderLog({ path: LOG_PATH, onView, onReveal })
    expect(container.textContent).toContain(i18n.t('about.logGroup'))
    expect(container.querySelector('[data-about-log-path]')?.textContent).toBe(LOG_PATH)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-about-log-view]')!.click()
    })
    expect(onView).toHaveBeenCalledTimes(1)

    const copy = container.querySelector<HTMLButtonElement>('[data-about-log-copy]')!
    expect(copy.textContent?.trim()).toBe(i18n.t('about.copyPath'))
    await act(async () => {
      copy.click()
    })
    expect(mocks.copyToClipboard).toHaveBeenCalledExactlyOnceWith(LOG_PATH)
    expect(copy.textContent?.trim()).toBe(i18n.t('about.pathCopied'))
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(copy.textContent?.trim()).toBe(i18n.t('about.copyPath'))

    const reveal = container.querySelector<HTMLButtonElement>('[data-about-log-reveal]')!
    expect(reveal.textContent?.trim()).toBe(i18n.t('about.revealLog'))
    await act(async () => {
      reveal.click()
    })
    expect(onReveal).toHaveBeenCalledTimes(1)

    // web 客户端不给 onReveal → 没有这个钮，别的照旧
    await renderLog({ path: LOG_PATH, onView })
    expect(container.querySelector('[data-about-log-reveal]')).toBeNull()
    expect(container.querySelector('[data-about-log-copy]')).not.toBeNull()
  })

  it('AB-8 不给 appLog → 没有日志区块', async () => {
    await renderLog(undefined)
    expect(container.querySelector('[data-about-log-path]')).toBeNull()
    expect(container.textContent).not.toContain(i18n.t('about.logGroup'))
  })
})

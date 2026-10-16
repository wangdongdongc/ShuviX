// @vitest-environment jsdom
/**
 * 证书错误的整页警告（PageFaces.tsx 的 PageErrorView → CertInterstitial，Chrome 的「您的连接不是私密连接」）。
 *
 *   BS-U37  证书错误码（-200 … -211）且没崩：`[data-page-error="cert"][data-cert-interstitial="<出错地址的 host>"]`，
 *           标题、`net::<errorDescription>`（没有时 `net::ERR_CERT_INVALID`）、Back to safety、Advanced；没有 Retry，
 *           点 Advanced 之前也没有 [data-cert-proceed]；范围外的码（-199 / -212）是普通的「无法访问」；崩了的
 *           是崩溃页（码在范围里也一样）；
 *   BS-U38  Advanced 展开 / 收起「继续前往 <host>（不安全）」与说明；点继续前往 → 只调 proceedUnsafe(id)（不导航、
 *           不后退、不重试）；
 *   BS-U39  Back to safety：能后退就 goBack(id)，不能就 navigate(id, 'about:blank')；紧凑版（卡片里）是同一套控件。
 *
 * `window.api` 是 browserDomSupport 的假件；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { PageErrorView } from '../PageFaces'
import type { BrowserTabInfo } from '../../../stores/browserTabsStore'
import {
  click,
  initEnI18n,
  installFakeApi,
  mountInto,
  tabInfo,
  type FakeApi,
  type Mounted
} from './browserDomSupport'

let api: FakeApi
let m: Mounted | null = null
let onRetry: Mock<(url: string) => void>

const FAILED_URL = 'https://self-signed.test:8443/login?next=1'
const HOST = 'self-signed.test:8443'

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const buttons = (): HTMLButtonElement[] => [...m!.container.querySelectorAll('button')]
const byText = (text: string): HTMLButtonElement | undefined =>
  buttons().find((b) => b.textContent?.trim() === text)

function certTab(
  over: Partial<BrowserTabInfo> = {},
  code = -202,
  description = 'ERR_CERT_AUTHORITY_INVALID'
): BrowserTabInfo {
  return tabInfo({
    id: 't1',
    url: 'https://previous.test/',
    loadError: { errorCode: code, errorDescription: description, url: FAILED_URL },
    ...over
  })
}

async function mount(tab: BrowserTabInfo, compact?: boolean): Promise<void> {
  m = await mountInto(PageErrorView, { tab, onRetry, ...(compact ? { compact } : {}) })
}

/** 除了这几个之外，browserView 的动作一个都没被调过 */
function onlyCalled(...names: string[]): void {
  for (const [name, fn] of Object.entries(api.browserView)) {
    if (name.startsWith('on') || name === 'listTabs') continue
    if (names.includes(name)) continue
    expect(fn, `browserView.${name}`).not.toHaveBeenCalled()
  }
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  onRetry = vi.fn<(url: string) => void>()
})

afterEach(() => {
  m?.unmount()
  m = null
})

describe('什么时候是证书警告（BS-U37）', () => {
  it.each([[-200], [-202], [-211]])(
    'BS-U37 错误码 %i：整页警告，host 取自出错的地址；标题、net:: 码、Back to safety、Advanced；没有 Retry、没有继续前往',
    async (code) => {
      await mount(certTab({}, code))
      const page = $('[data-page-error]')!
      expect(page.getAttribute('data-page-error')).toBe('cert')
      expect(page.getAttribute('data-cert-interstitial')).toBe(HOST)
      expect(page.textContent).toContain('Your connection is not private')
      expect(page.textContent).toContain(
        `Attackers might be trying to steal your information from ${HOST}`
      )
      expect(page.textContent).toContain('net::ERR_CERT_AUTHORITY_INVALID')
      expect($('[data-cert-back]')?.textContent?.trim()).toBe('Back to safety')
      expect($('[data-cert-advanced]')?.textContent?.trim()).toBe('Advanced')
      expect(byText('Retry')).toBeUndefined()
      expect($('[data-cert-proceed]')).toBeNull()
    }
  )

  it('BS-U37 没有 errorDescription：net::ERR_CERT_INVALID', async () => {
    await mount(certTab({}, -201, ''))
    expect($('[data-page-error="cert"]')?.textContent).toContain('net::ERR_CERT_INVALID')
  })

  it('BS-U37 出错的地址为空：host 取 tab 自己的地址', async () => {
    await mount(
      tabInfo({
        id: 't1',
        url: 'https://own.test:9443/p',
        loadError: { errorCode: -202, errorDescription: 'ERR_CERT_DATE_INVALID', url: '' }
      })
    )
    expect($('[data-page-error="cert"]')?.getAttribute('data-cert-interstitial')).toBe(
      'own.test:9443'
    )
  })

  it.each([[-199], [-212], [-105]])(
    'BS-U37 错误码 %i：普通的「无法访问」页（有 Retry，没有证书警告）',
    async (code) => {
      await mount(certTab({}, code, 'ERR_SOMETHING'))
      expect($('[data-page-error]')?.getAttribute('data-page-error')).toBe('failed')
      expect($('[data-cert-interstitial]')).toBeNull()
      expect($('[data-page-error]')?.textContent).toContain("This site can't be reached")
      expect(byText('Retry')).toBeDefined()
    }
  )

  it('BS-U37 崩了的（码在证书范围里也一样）：崩溃页', async () => {
    await mount(
      tabInfo({
        id: 't1',
        url: FAILED_URL,
        loadError: { errorCode: -202, errorDescription: 'oom', url: FAILED_URL, crashed: true }
      })
    )
    expect($('[data-page-error]')?.getAttribute('data-page-error')).toBe('crashed')
    expect($('[data-cert-interstitial]')).toBeNull()
    expect($('[data-page-error]')?.textContent).toContain('This page crashed')
  })
})

describe('高级与继续前往（BS-U38）', () => {
  it('BS-U38 Advanced 展开继续前往与说明（按钮变成 Hide advanced）；再点收起', async () => {
    await mount(certTab())
    click($('[data-cert-advanced]')!)
    const proceed = $('[data-cert-proceed]')
    expect(proceed).not.toBeNull()
    expect(proceed!.textContent?.trim()).toBe(`Proceed to ${HOST} (unsafe)`)
    expect($('[data-page-error="cert"]')!.textContent).toContain(
      `This server could not prove that it is ${HOST}`
    )
    expect($('[data-cert-advanced]')!.textContent?.trim()).toBe('Hide advanced')

    click($('[data-cert-advanced]')!)
    expect($('[data-cert-proceed]')).toBeNull()
    expect($('[data-cert-advanced]')!.textContent?.trim()).toBe('Advanced')
    onlyCalled()
  })

  it('BS-U38 继续前往 → 只调 proceedUnsafe(id)', async () => {
    await mount(certTab())
    click($('[data-cert-advanced]')!)
    click($('[data-cert-proceed]')!)
    expect(api.browserView.proceedUnsafe.mock.calls).toEqual([['t1']])
    onlyCalled('proceedUnsafe')
    expect(onRetry).not.toHaveBeenCalled()
  })
})

describe('返回安全的页面与紧凑版（BS-U39）', () => {
  it('BS-U39 能后退：goBack(id)', async () => {
    await mount(certTab({ canGoBack: true }))
    click($('[data-cert-back]')!)
    expect(api.browserView.goBack.mock.calls).toEqual([['t1']])
    onlyCalled('goBack')
  })

  it("BS-U39 不能后退：navigate(id, 'about:blank')", async () => {
    await mount(certTab({ canGoBack: false }))
    click($('[data-cert-back]')!)
    expect(api.browserView.navigate.mock.calls).toEqual([['t1', 'about:blank']])
    onlyCalled('navigate')
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('BS-U39 紧凑版：同一套控件（警告、Back to safety、Advanced → 继续前往 → proceedUnsafe）', async () => {
    await mount(certTab(), true)
    const page = $('[data-page-error="cert"]')!
    expect(page.getAttribute('data-cert-interstitial')).toBe(HOST)
    expect(page.textContent).toContain('Your connection is not private')
    expect($('[data-cert-back]')).not.toBeNull()
    expect(byText('Retry')).toBeUndefined()
    expect($('[data-cert-proceed]')).toBeNull()
    click($('[data-cert-advanced]')!)
    click($('[data-cert-proceed]')!)
    expect(api.browserView.proceedUnsafe.mock.calls).toEqual([['t1']])
    click($('[data-cert-back]')!)
    expect(api.browserView.navigate.mock.calls).toEqual([['t1', 'about:blank']])
  })
})

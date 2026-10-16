// @vitest-environment jsdom
/**
 * 站点信息气泡（SiteInfoBubble）—— 地址栏左侧安全图标打开的 Chrome「page info」。
 *
 *   BS-U30  连接一行：https → 安全；http → 不安全 + 一句提醒；放行过证书错误的站点（certException）压过「安全」；
 *           本地文件 → 「正在查看本地文件」，没有 Cookie 一节、也不去问 siteInfo；
 *   BS-U31  Cookie 一节：问 siteInfo(url)，数量文字（单数 / 复数），还没回答时显示「…」；「删除此网站的数据」在
 *           没回答时与 0 个 cookie 时禁用；
 *   BS-U32  删除要确认：确认 → clearSiteData(url)，然后 onClose，然后 reload(id)（这个顺序）；clearSiteData 失败 →
 *           不 reload、不 onClose、气泡留着（确认还能再点）、没有未处理的拒绝；「网站设置」→ onClose、
 *           openInternal('settings')、settingsFocus = {section:'privacy', search:<主机名，不含端口>}；本地文件
 *           没有 search 这个键。
 *
 * `window.api` 是 browserDomSupport 的假件；store 是真的；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act } from 'react'
import { SiteInfoBubble } from '../SiteInfoBubble'
import { useBrowserTabsStore, type BrowserTabInfo } from '../../../stores/browserTabsStore'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  installRaf,
  mountInto,
  tabInfo,
  type FakeApi,
  type Mounted
} from './browserDomSupport'

let api: FakeApi
let m: Mounted | null = null
let onClose: Mock<() => void>

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)

async function mount(tab: BrowserTabInfo): Promise<void> {
  m = await mountInto(SiteInfoBubble, { tab, onClose })
  await flush()
}

const connection = (): { kind: string | null; text: string } => {
  const el = $('[data-site-connection]')
  return { kind: el?.getAttribute('data-site-connection') ?? null, text: el?.textContent ?? '' }
}
const btn = (sel: string): HTMLButtonElement => {
  const b = $<HTMLButtonElement>(sel)
  if (!b) throw new Error(`no ${sel}`)
  return b
}

/** 一个还没回答的 promise */
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  installRaf()
  onClose = vi.fn<() => void>()
  useBrowserTabsStore.setState({
    tabs: [],
    activeTabId: null,
    settingsFocus: null,
    pageCover: null
  })
})

afterEach(() => {
  m?.unmount()
  m = null
})

describe('连接一行（BS-U30）', () => {
  it('BS-U30 https：Connection is secure，没有提醒', async () => {
    await mount(tabInfo({ id: 't1', url: 'https://example.com/a' }))
    expect(connection()).toEqual({ kind: 'secure', text: 'Connection is secure' })
    expect($('[data-site-info]')?.getAttribute('data-site-info')).toBe('example.com')
  })

  it('BS-U30 http：Connection is not secure + 不要输入密码的提醒', async () => {
    await mount(tabInfo({ id: 't1', url: 'http://plain.test/a' }))
    const c = connection()
    expect(c.kind).toBe('insecure')
    expect(c.text).toContain('Connection is not secure')
    expect(c.text).toContain('Don’t enter sensitive information like passwords or credit cards')
  })

  it('BS-U30 放行过证书错误的 https 站点：「你关掉了这个站点的证书警告」压过「安全」', async () => {
    api.browserData.siteInfo.mockResolvedValue({ cookieCount: 0, certException: true })
    await mount(tabInfo({ id: 't1', url: 'https://self-signed.test:8443/' }))
    const c = connection()
    expect(c.text).toContain('You turned off certificate warnings for this site')
    expect(c.text).toContain('No more warnings until ShuviX quits.')
    expect(c.text).not.toContain('Connection is secure')
  })

  it('BS-U30 本地文件：正在查看本地文件；没有 Cookie 一节，也不问 siteInfo', async () => {
    await mount(tabInfo({ id: 't1', url: 'file:///Users/me/a.html' }))
    expect(connection()).toEqual({ kind: 'local', text: 'You’re viewing a local file' })
    expect($('[data-site-cookies]')).toBeNull()
    expect($('[data-site-clear]')).toBeNull()
    expect(api.browserData.siteInfo).not.toHaveBeenCalled()
    expect($('[data-site-settings]')).not.toBeNull()
  })
})

describe('Cookie 一节（BS-U31）', () => {
  it.each([
    [0, 'This site has 0 cookies'],
    [1, 'This site has 1 cookie'],
    [3, 'This site has 3 cookies']
  ])('BS-U31 %i 个 cookie：「%s」；问的是 siteInfo(url)', async (count, text) => {
    api.browserData.siteInfo.mockResolvedValue({ cookieCount: count, certException: false })
    await mount(tabInfo({ id: 't1', url: 'https://example.com/a?b' }))
    expect(api.browserData.siteInfo.mock.calls).toEqual([['https://example.com/a?b']])
    const el = $('[data-site-cookies]')!
    expect(el.getAttribute('data-site-cookies')).toBe(String(count))
    expect(el.textContent).toBe(text)
  })

  it('BS-U31 siteInfo 还没回答：显示「…」、删除按钮禁用；回答 2 个之后可点', async () => {
    const pending = deferred<{ cookieCount: number; certException: boolean }>()
    api.browserData.siteInfo.mockImplementation(() => pending.promise)
    await mount(tabInfo({ id: 't1', url: 'https://example.com/' }))
    expect($('[data-site-cookies]')!.textContent).toBe('…')
    expect(btn('[data-site-clear]').disabled).toBe(true)

    await act(async () => {
      pending.resolve({ cookieCount: 2, certException: false })
    })
    await flush()
    expect(btn('[data-site-clear]').disabled).toBe(false)
  })

  it('BS-U31 0 个 cookie：删除按钮禁用', async () => {
    api.browserData.siteInfo.mockResolvedValue({ cookieCount: 0, certException: false })
    await mount(tabInfo({ id: 't1', url: 'https://example.com/' }))
    expect(btn('[data-site-clear]').disabled).toBe(true)
  })
})

describe('删除与网站设置（BS-U32）', () => {
  const URL_X = 'https://127.0.0.1:5173/x'

  it('BS-U32 删除要确认：点删除 → 出现确认；确认 → clearSiteData(url)，然后 onClose，然后 reload(id)', async () => {
    api.browserData.siteInfo.mockResolvedValue({ cookieCount: 2, certException: false })
    await mount(tabInfo({ id: 't1', url: URL_X }))
    expect($('[data-site-clear-confirm]')).toBeNull()
    click(btn('[data-site-clear]'))
    expect(api.browserData.clearSiteData).not.toHaveBeenCalled()
    expect(btn('[data-site-clear-confirm]').textContent).toContain('Confirm (signs you out)')

    click(btn('[data-site-clear-confirm]'))
    await flush()
    expect(api.browserData.clearSiteData.mock.calls).toEqual([[URL_X]])
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.browserView.reload.mock.calls).toEqual([['t1']])
    const cleared = api.browserData.clearSiteData.mock.invocationCallOrder[0]
    const closed = onClose.mock.invocationCallOrder[0]
    const reloaded = api.browserView.reload.mock.invocationCallOrder[0]
    expect(cleared).toBeLessThan(closed)
    expect(closed).toBeLessThan(reloaded)
  })

  it('BS-U32 确认里的取消：回到删除按钮，什么也不清', async () => {
    api.browserData.siteInfo.mockResolvedValue({ cookieCount: 2, certException: false })
    await mount(tabInfo({ id: 't1', url: URL_X }))
    click(btn('[data-site-clear]'))
    const cancel = [...m!.container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cancel'
    )
    click(cancel!)
    expect($('[data-site-clear-confirm]')).toBeNull()
    expect($('[data-site-clear]')).not.toBeNull()
    expect(api.browserData.clearSiteData).not.toHaveBeenCalled()
  })

  it('BS-U32 clearSiteData 失败：不 reload、不 onClose，气泡留着、确认还能再点；没有未处理的拒绝', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      api.browserData.siteInfo.mockResolvedValue({ cookieCount: 2, certException: false })
      api.browserData.clearSiteData.mockRejectedValueOnce(new Error('partition locked'))
      await mount(tabInfo({ id: 't1', url: URL_X }))
      click(btn('[data-site-clear]'))
      click(btn('[data-site-clear-confirm]'))
      await flush()
      await new Promise((r) => setTimeout(r, 0))

      expect(api.browserData.clearSiteData).toHaveBeenCalledTimes(1)
      expect(api.browserView.reload).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      expect($('[data-site-info]')).not.toBeNull()
      const again = btn('[data-site-clear-confirm]')
      expect(again.disabled).toBe(false)
      expect(unhandled).not.toHaveBeenCalled()

      // 再点一次成功了：照常 onClose + reload
      click(again)
      await flush()
      expect(api.browserData.clearSiteData).toHaveBeenCalledTimes(2)
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(api.browserView.reload.mock.calls).toEqual([['t1']])
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it("BS-U32 网站设置：onClose、openInternal('settings')、settingsFocus = {privacy, 主机名（不含端口）}", async () => {
    await mount(tabInfo({ id: 't1', url: URL_X }))
    click(btn('[data-site-settings]'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.browserView.openInternal.mock.calls).toEqual([['settings']])
    const focus = useBrowserTabsStore.getState().settingsFocus
    expect(focus).toMatchObject({ section: 'privacy', search: '127.0.0.1' })
    expect(focus?.nonce).toEqual(expect.any(Number))
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      api.browserView.openInternal.mock.invocationCallOrder[0]
    )
  })

  it('BS-U32 本地文件的网站设置：settingsFocus 没有 search 这个键', async () => {
    await mount(tabInfo({ id: 't1', url: 'file:///Users/me/a.html' }))
    click(btn('[data-site-settings]'))
    expect(api.browserView.openInternal.mock.calls).toEqual([['settings']])
    const focus = useBrowserTabsStore.getState().settingsFocus
    expect(focus).toMatchObject({ section: 'privacy' })
    expect(focus).not.toHaveProperty('search')
  })
})

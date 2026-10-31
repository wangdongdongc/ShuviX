// @vitest-environment jsdom
/**
 * 主设置窗口 MCP → 内置 `browser` 那一行的展开区（BrowserSettingsLink，2026-10-16）：浏览器的设置搬进了浏览器
 * 窗口自己的设置页（shuvix://settings），这里只剩一个入口。
 *
 *   BS-U45  标题「Browser settings」、行文字「Search engine, site data, certificates」、一颗
 *           [data-open-browser-settings]「Open browser settings」→ browserView.openSettings() 一次（不带参数）；
 *           没有开关、没有站点列表 / 搜索框；McpSettings 只给**内置**的 browser 行挂它（ssh、同名的用户行都不挂）。
 *
 * `window.api` 是浏览器窗口 DOM 单测共用的假件（browserDomSupport）；SettingsPrimitives 走 vitest 别名到
 * app-shell 的真组件；真 en 文案。McpSettings 那条只看接线：McpClientPanel 换成记下 props 的替身。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement } from 'react'

const captured = vi.hoisted(() => ({
  props: null as null | { renderServerExtra?: (server: Record<string, unknown>) => unknown }
}))

vi.mock('@shuvix/app-shell', () => ({
  McpClientPanel: (props: { renderServerExtra?: (server: Record<string, unknown>) => unknown }) => {
    captured.props = props
    return null
  }
}))
vi.mock('../DatabaseConnectionsSettings', () => ({ DatabaseConnectionsSettings: () => null }))
vi.mock('../ChromeExtensionSettings', () => ({ ChromeExtensionSettings: () => null }))

import { BrowserSettingsLink } from '../BrowserSettingsLink'
import { McpSettings } from '../McpSettings'
import {
  click,
  initEnI18n,
  installFakeApi,
  mountInto,
  type FakeApi,
  type Mounted
} from '../../browser/__tests__/browserDomSupport'

let api: FakeApi
let m: Mounted | null = null

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  captured.props = null
})

afterEach(() => {
  m?.unmount()
  m = null
})

describe('MCP 行里的浏览器设置入口（BS-U45）', () => {
  it('BS-U45 标题、行文字与「Open browser settings」按钮 → openSettings() 一次', async () => {
    m = await mountInto(BrowserSettingsLink, {})
    const root = $('[data-browser-settings-link]')
    expect(root).not.toBeNull()
    expect(root!.querySelector('h3')?.textContent?.trim()).toBe('Browser settings')
    expect(root!.textContent).toContain('Search engine, site data, certificates')

    const open = $<HTMLButtonElement>('[data-open-browser-settings]')
    expect(open?.textContent?.trim()).toBe('Open browser settings')
    expect(api.browserView.openSettings).not.toHaveBeenCalled()
    click(open!)
    expect(api.browserView.openSettings).toHaveBeenCalledTimes(1)
    expect(api.browserView.openSettings.mock.calls[0]).toEqual([])
    expect(api.browserView.openInternal).not.toHaveBeenCalled()
  })

  it('BS-U45 没有开关、没有站点列表与搜索框，也不去读浏览器数据', async () => {
    m = await mountInto(BrowserSettingsLink, {})
    expect($('button.rounded-full')).toBeNull()
    expect($('[data-site-row]')).toBeNull()
    expect($('[data-site-search]')).toBeNull()
    expect($('input')).toBeNull()
    expect($('select')).toBeNull()
    expect(api.browserData.listSites).not.toHaveBeenCalled()
    expect(api.settings.getAll).not.toHaveBeenCalled()
  })

  it('BS-U45 McpSettings：内置 browser 行挂 BrowserSettingsLink；ssh、用户自己的同名行不挂', async () => {
    m = await mountInto(McpSettings, {})
    const render = captured.props?.renderServerExtra
    expect(render).toBeTypeOf('function')

    const browserExtra = render!({ isBuiltin: 1, name: 'browser' })
    expect(isValidElement(browserExtra)).toBe(true)
    expect((browserExtra as ReactElement).type).toBe(BrowserSettingsLink)

    expect(render!({ isBuiltin: 1, name: 'ssh' })).toBeNull()
    expect(render!({ isBuiltin: 0, name: 'browser' })).toBeNull()
  })

  it('MCP-X-3 McpSettings：内置 plan 行（任务列表）没有附加区', async () => {
    m = await mountInto(McpSettings, {})
    const render = captured.props?.renderServerExtra
    expect(render).toBeTypeOf('function')
    expect(render!({ isBuiltin: 1, name: 'plan', type: 'inproc' })).toBeNull()
  })
})

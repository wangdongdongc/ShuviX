// @vitest-environment jsdom
/**
 * 内置浏览器的设置（BrowserDataSettings，挂在 MCP 设置里内置 browser 那一行的展开区）—— 地址栏的搜索引擎
 * （CB-U56）：下拉显示存着的引擎（没存 / 不认识 → Google），四个选项按品牌名写（百度不翻译），换一个就写
 * `browser.searchEngine`。
 *
 * `window.api.settings` / `browserData` 是假的；真 en 文案（找那一行按它的标题）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'

// 本地的 SettingsPrimitives 只是再导出 `@shuvix/app-shell/settings/SettingsPrimitives`；这份 vitest 配置没有 app-shell
// 的路径别名，按相对路径把**真件**接过来（同 networkAccessSettings.dom.test.ts）
vi.mock(
  '../SettingsPrimitives',
  () => import('../../../../../../../../packages/app-shell/src/settings/SettingsPrimitives')
)

import { BrowserDataSettings } from '../BrowserDataSettings'
import {
  flush,
  initEnI18n,
  installFakeApi,
  mountInto,
  type FakeApi,
  type Mounted
} from '../../browser/__tests__/browserDomSupport'

let api: FakeApi
let m: Mounted | null = null

/** 搜索引擎那一行的下拉（页面上第一个 select） */
const engineSelect = (): HTMLSelectElement => {
  const sel = m!.container.querySelector('select')
  if (!sel) throw new Error('no search engine select')
  return sel
}

async function mount(settings: Record<string, string>): Promise<void> {
  api.settingsMap = settings
  m = await mountInto(BrowserDataSettings, {})
  await flush()
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
})

afterEach(() => {
  m?.unmount()
  m = null
  vi.restoreAllMocks()
})

describe('地址栏搜索引擎（CB-U56）', () => {
  it('CB-U56 那一行在；四个选项：google / bing / baidu / duckduckgo，写作 Google / Bing / 百度 / DuckDuckGo', async () => {
    await mount({})
    expect(m!.container.textContent).toContain('Address bar search engine')
    expect(
      [...engineSelect().querySelectorAll('option')].map((o) => [o.value, o.textContent])
    ).toEqual([
      ['google', 'Google'],
      ['bing', 'Bing'],
      ['baidu', '百度'],
      ['duckduckgo', 'DuckDuckGo']
    ])
  })

  it.each([
    [{}, 'google'],
    [{ 'browser.searchEngine': 'duckduckgo' }, 'duckduckgo'],
    [{ 'browser.searchEngine': 'baidu' }, 'baidu'],
    [{ 'browser.searchEngine': 'yahoo' }, 'google'],
    [{ 'browser.searchEngine': 'toString' }, 'google']
  ])('CB-U56 存着 %j → 下拉显示 %s', async (settings, shown) => {
    await mount(settings)
    expect(engineSelect().value).toBe(shown)
  })

  it('CB-U56 换成 Bing → settings.set({ key: browser.searchEngine, value: bing })，下拉跟着变', async () => {
    await mount({})
    const sel = engineSelect()
    act(() => {
      sel.value = 'bing'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.settings.set.mock.calls).toEqual([[{ key: 'browser.searchEngine', value: 'bing' }]])
    expect(engineSelect().value).toBe('bing')
  })
})

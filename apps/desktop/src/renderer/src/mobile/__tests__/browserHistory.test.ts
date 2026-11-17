/**
 * 手机布局「浏览器」那几页在浏览器历史里的记号（mobile/browserHistory.ts，纯函数）。
 *
 * 契约：`history.state.shuvixMobileBrowser` 是一摞页面 id（从设置页往上数），只有五种形状：
 * `['tabs']`、`['tabs','tab:<id>']`、`['tabs','settings']`、`['tabs','settings','sites']`、
 * `['tabs','settings','sites','site:<网站>']`；别的（含一个成员不是字符串、前缀后面是空的）整摞不算。
 * `canPushBrowserPage` = 推入之后还是这五种之一。
 *
 *   BH-0      记号的名字
 *   BH-1..10  browserStackOf
 *   BH-11..13 页面 id 的拼与拆
 *   BH-14..15 canPushBrowserPage
 */
import { describe, expect, it } from 'vitest'
import {
  BROWSER_HISTORY_MARK,
  browserSiteOf,
  browserSitePage,
  browserStackOf,
  browserTabIdOf,
  browserTabPage,
  canPushBrowserPage
} from '../browserHistory'

const marked = (value: unknown): Record<string, unknown> => ({ [BROWSER_HISTORY_MARK]: value })

describe('browserStackOf', () => {
  it('BH-0 记号叫 shuvixMobileBrowser', () => {
    expect(BROWSER_HISTORY_MARK).toBe('shuvixMobileBrowser')
  })

  it('BH-1 不是带记号的对象 → 空', () => {
    for (const state of [null, undefined, {}, 'x', 5]) {
      expect(browserStackOf(state)).toEqual([])
    }
  })

  it('BH-2 记号不是数组、或是空数组 → 空', () => {
    for (const value of ['tabs', { 0: 'tabs' }, true, []]) {
      expect(browserStackOf(marked(value))).toEqual([])
    }
  })

  it('BH-3 五种形状原样交回', () => {
    const stacks = [
      ['tabs'],
      ['tabs', 'tab:7'],
      ['tabs', 'settings'],
      ['tabs', 'settings', 'sites'],
      ['tabs', 'settings', 'sites', 'site:github.com']
    ]
    for (const stack of stacks) {
      expect(browserStackOf(marked(stack))).toBe(stack)
    }
  })

  it('BH-4 第一页不是 tabs → 空', () => {
    for (const stack of [['settings'], ['tab:1'], ['sites']]) {
      expect(browserStackOf(marked(stack))).toEqual([])
    }
  })

  it('BH-5 第二层不对 → 空', () => {
    for (const second of ['sites', 'site:x', 'tabs', 'x']) {
      expect(browserStackOf(marked(['tabs', second]))).toEqual([])
    }
  })

  it('BH-6 第三、四层不对 → 空', () => {
    const stacks = [
      ['tabs', 'tab:1', 'sites'],
      ['tabs', 'tab:1', 'tab:2'],
      ['tabs', 'settings', 'settings'],
      ['tabs', 'settings', 'site:x'],
      ['tabs', 'settings', 'sites', 'tab:1'],
      ['tabs', 'settings', 'sites', 'sites']
    ]
    for (const stack of stacks) {
      expect(browserStackOf(marked(stack))).toEqual([])
    }
  })

  it('BH-7 太长 → 空', () => {
    expect(browserStackOf(marked(['tabs', 'settings', 'sites', 'site:a', 'site:b']))).toEqual([])
  })

  it('BH-8 有一个成员不是字符串 → 整摞不算', () => {
    for (const stack of [['tabs', 5], ['tabs', null], [['tabs']]]) {
      expect(browserStackOf(marked(stack))).toEqual([])
    }
  })

  it('BH-9 前缀后面是空的 → 空', () => {
    expect(browserStackOf(marked(['tabs', 'tab:']))).toEqual([])
    expect(browserStackOf(marked(['tabs', 'settings', 'sites', 'site:']))).toEqual([])
  })

  it('BH-10 同一条 state 上别的记号不碍事', () => {
    expect(browserStackOf({ shuvixMobileChat: true, shuvixMobileBrowser: ['tabs'] })).toEqual([
      'tabs'
    ])
  })
})

describe('页面 id', () => {
  it('BH-11 标签页那一页来回对得上（id 里有 : 和 / 也行）', () => {
    expect(browserTabPage('7')).toBe('tab:7')
    expect(browserTabIdOf('tab:7')).toBe('7')
    expect(browserTabIdOf(browserTabPage('a:b/c'))).toBe('a:b/c')
  })

  it('BH-12 不是标签页那一页 → null', () => {
    for (const page of ['tab:', 'tabs', 'settings', 'site:x', '']) {
      expect(browserTabIdOf(page)).toBeNull()
    }
  })

  it('BH-13 网站那一页来回对得上；不是 → null', () => {
    for (const site of ['github.com', '127.0.0.1', 'localhost']) {
      expect(browserSitePage(site)).toBe(`site:${site}`)
      expect(browserSiteOf(browserSitePage(site))).toBe(site)
    }
    for (const page of ['site:', 'sites', 'tab:x']) {
      expect(browserSiteOf(page)).toBeNull()
    }
  })
})

describe('canPushBrowserPage', () => {
  it('BH-14 放得下的', () => {
    expect(canPushBrowserPage([], 'tabs')).toBe(true)
    expect(canPushBrowserPage(['tabs'], 'tab:1')).toBe(true)
    expect(canPushBrowserPage(['tabs'], 'settings')).toBe(true)
    expect(canPushBrowserPage(['tabs', 'settings'], 'sites')).toBe(true)
    expect(canPushBrowserPage(['tabs', 'settings', 'sites'], 'site:a')).toBe(true)
  })

  it('BH-15 放不下的；传入的数组不被改', () => {
    const cases: Array<[string[], string]> = [
      [[], 'settings'],
      [[], 'tab:1'],
      [['tabs'], 'tabs'],
      [['tabs', 'tab:1'], 'tab:1'],
      [['tabs', 'tab:1'], 'tab:2'],
      [['tabs', 'tab:1'], 'settings'],
      [['tabs', 'settings'], 'tab:1'],
      [['tabs', 'settings', 'sites', 'site:a'], 'site:b'],
      [['tabs'], 'sites']
    ]
    for (const [stack, page] of cases) {
      const before = [...stack]
      expect(canPushBrowserPage(stack, page)).toBe(false)
      expect(stack).toEqual(before)
    }
  })
})

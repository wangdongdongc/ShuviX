/**
 * 手机布局「浏览器」那几页里不画东西的小函数（mobile/browserPure.ts）。
 *
 * 契约：
 * - `hostOfTab`：网页写主机名（带端口）；内部页面、空地址、about:blank 不写；没有主机的地址写协议名；解析不了的原样；
 * - `siteBytes` = 配额存储 + Cookie；
 * - `shownSites`：名字包含搜索词（不分大小写、去掉两头空白），或搜索词是这个网站下面的一个主机；按名称或占用排，
 *   不改传入的数组。
 *
 *   BP-1..5   hostOfTab
 *   BP-6      siteBytes
 *   BP-7..13  shownSites
 */
import { describe, expect, it } from 'vitest'
import type { SiteSummary } from '../../../../shared/browserSiteData'
import { hostOfTab, shownSites, siteBytes } from '../browserPure'

const site = (name: string, over: Partial<SiteSummary> = {}): SiteSummary => ({
  site: name,
  cookieCount: 0,
  cookieBytes: 0,
  usageBytes: 0,
  localStorage: false,
  originCount: 1,
  ...over
})
const names = (list: SiteSummary[]): string[] => list.map((entry) => entry.site)

describe('hostOfTab', () => {
  it('BP-1 网页 → 主机名，端口留着', () => {
    expect(hostOfTab({ url: 'https://example.com/a?b=1' })).toBe('example.com')
    expect(hostOfTab({ url: 'http://localhost:3000/x' })).toBe('localhost:3000')
  })

  it('BP-2 内部页面 → 空', () => {
    expect(hostOfTab({ url: 'shuvix://settings', internalPage: 'settings' })).toBe('')
    expect(hostOfTab({ url: 'https://example.com/', internalPage: 'history' })).toBe('')
  })

  it('BP-3 空地址、空白、about:blank → 空', () => {
    for (const url of ['', '  ', 'about:blank']) {
      expect(hostOfTab({ url })).toBe('')
    }
  })

  it('BP-4 没有主机的地址 → 协议名', () => {
    expect(hostOfTab({ url: 'data:text/html,hi' })).toBe('data')
    expect(hostOfTab({ url: 'file:///a/b' })).toBe('file')
  })

  it('BP-5 解析不了 → 原样（去掉两头空白）', () => {
    expect(hostOfTab({ url: 'not a url' })).toBe('not a url')
    expect(hostOfTab({ url: '  not a url ' })).toBe('not a url')
  })
})

describe('siteBytes', () => {
  it('BP-6 配额存储 + Cookie', () => {
    expect(siteBytes(site('a.test', { usageBytes: 1000, cookieBytes: 24 }))).toBe(1024)
  })
})

describe('shownSites', () => {
  const all = [site('github.com'), site('example.org'), site('127.0.0.1'), site('b.test')]

  it('BP-7 没有搜索词 → 全部，按名称排；不改传入的数组', () => {
    const input = [...all]
    const expected = [...names(all)].sort((a, b) => a.localeCompare(b))
    expect(names(shownSites(input, '', 'name'))).toEqual(expected)
    expect(names(input)).toEqual(names(all))
  })

  it('BP-8 名字包含搜索词：不分大小写、去掉两头空白', () => {
    expect(names(shownSites(all, ' GitHub ', 'name'))).toEqual(['github.com'])
    expect(names(shownSites(all, '.TEST', 'name'))).toEqual(['b.test'])
  })

  it('BP-9 搜索词是这个网站下面的一个主机', () => {
    expect(names(shownSites(all, 'www.github.com', 'name'))).toEqual(['github.com'])
    expect(names(shownSites(all, 'a.b.example.org', 'name'))).toEqual(['example.org'])
  })

  it('BP-10 只是以网站名结尾、中间没有点 → 不算；上一级（com）按「包含」算', () => {
    expect(shownSites(all, 'notgithub.com', 'name')).toEqual([])
    expect(names(shownSites(all, 'com', 'name'))).toEqual(['github.com'])
  })

  it('BP-11 没有一个对得上 → 空', () => {
    expect(shownSites(all, 'zzz', 'name')).toEqual([])
  })

  it('BP-12 按占用排：大的在前（Cookie 算进去），一样大按名称', () => {
    const list = [
      site('small.test', { usageBytes: 10 }),
      site('cookie.test', { usageBytes: 0, cookieBytes: 500 }),
      site('b-same.test', { usageBytes: 100 }),
      site('a-same.test', { usageBytes: 60, cookieBytes: 40 })
    ]
    expect(names(shownSites(list, '', 'size'))).toEqual([
      'cookie.test',
      'a-same.test',
      'b-same.test',
      'small.test'
    ])
  })

  it('BP-13 按名称排不看占用；搜索与排序一起用', () => {
    const list = [
      site('b.test', { usageBytes: 900 }),
      site('a.test', { usageBytes: 1 }),
      site('c.example', { usageBytes: 5000 })
    ]
    expect(names(shownSites(list, '', 'name'))).toEqual(['a.test', 'b.test', 'c.example'])
    expect(names(shownSites(list, 'test', 'size'))).toEqual(['b.test', 'a.test'])
    expect(names(shownSites(list, 'test', 'name'))).toEqual(['a.test', 'b.test'])
  })
})

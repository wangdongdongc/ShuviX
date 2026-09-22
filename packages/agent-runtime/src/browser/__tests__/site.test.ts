/**
 * browserSiteOf —— 「站点」的写法：server 的按站点记账（approvedSites / siteChecks）与桌面的
 * 授权记录（chromeBridge/siteGrants）共用这一份键，所以这里钉的是两边都依赖的口径：
 *
 *   SITE-1  网页（http / https）的 host：小写、去掉结尾的点（一个或几个）、不带账号口令；
 *           协议与端口不算；IP 字面量原样、IPv6 保留方括号；首尾空白不算；国际化域名按 punycode；
 *   SITE-2  「看上去不是网页、其实是某个站点」的地址按里面那个站点算（否则一道站点门就能被绕开）：
 *           blob:（创建它的那个源）、view-source:（大小写、叠几层都一样）、filesystem:；
 *   SITE-3  没有站点的：不透明来源的 blob:（blob:null、blob:file:、扩展页的 blob:）、
 *           about: / data: / chrome: / 扩展页 / devtools: / file: / javascript: / ws: / ftp:、
 *           空串、undefined、解析不了的、只有外壳的、主机名只剩点的；
 *   SITE-4  与 urlObjectOf 同一种主机写法（策略客体的 host 与站点键不会对不上）；
 *   SITE-5  从 @shuvix/agent-runtime 导出的就是它。
 */
import { describe, expect, it } from 'vitest'
import { browserSiteOf } from '../site'
import { urlObjectOf } from '../../security/urlObject'

describe('browserSiteOf', () => {
  it.each<[string, string]>([
    ['https://a.com/x?q=1', 'a.com'],
    ['https://A.COM./y', 'a.com'],
    ['https://a.com../x', 'a.com'],
    ['HTTPS://B.COM/', 'b.com'],
    ['http://a.com:8080/', 'a.com'],
    ['https://a.com:443/', 'a.com'],
    ['https://user:pw@A.com/', 'a.com'],
    ['http://[::1]:3000/', '[::1]'],
    ['http://127.0.0.1:8080/', '127.0.0.1'],
    ['http://localhost:3000/', 'localhost'],
    ['  https://a.com/ ', 'a.com'],
    ['https://bücher.example/', 'xn--bcher-kva.example']
  ])('SITE-1 %s → %s', (raw, site) => {
    expect(browserSiteOf(raw)).toBe(site)
  })

  it('SITE-1 同一台机器换协议、端口、大小写、结尾的点 → 同一个站点', () => {
    const sites = [
      'http://a.com:8080/',
      'https://a.com/',
      'https://A.com./login',
      'http://a.com/x#y',
      'https://someone@a.com:8443/'
    ].map(browserSiteOf)
    expect(new Set(sites)).toEqual(new Set(['a.com']))
    // 子域名是另一个站点
    expect(browserSiteOf('https://sub.a.com/')).toBe('sub.a.com')
  })

  it.each<[string, string]>([
    ['blob:https://x/u', 'x'],
    ['blob:https://A.COM.:8443/u', 'a.com'],
    ['blob:http://[::1]:3000/u', '[::1]'],
    ['view-source:https://x/', 'x'],
    ['VIEW-SOURCE:https://x/', 'x'],
    ['view-source:view-source:https://x/', 'x'],
    ['View-Source:VIEW-SOURCE:https://X./', 'x'],
    ['view-source:blob:https://x/u', 'x'],
    ['filesystem:https://x/temporary/a', 'x'],
    ['FILESYSTEM:https://x/temporary/a', 'x'],
    ['filesystem:view-source:https://x/', 'x']
  ])('SITE-2 %s → 按里面那个站点算：%s', (raw, site) => {
    expect(browserSiteOf(raw)).toBe(site)
  })

  it.each<[string, string | undefined]>([
    ['blob:null/u', 'blob:null/u'],
    ['blob:file:', 'blob:file:///x'],
    ['扩展页的 blob:', 'blob:chrome-extension://abc/u'],
    ['about:blank', 'about:blank'],
    ['data:', 'data:text/html,x'],
    ['chrome://', 'chrome://settings'],
    ['chrome-extension://', 'chrome-extension://x/y'],
    ['devtools://', 'devtools://x'],
    ['file:', 'file:///tmp/a'],
    ['view-source 包着的本地文件', 'view-source:file:///etc/hosts'],
    ['javascript:', 'javascript:alert(1)'],
    ['ws:', 'ws://a.com/'],
    ['ftp:', 'ftp://a.com/'],
    ['空串', ''],
    ['undefined', undefined],
    ['解析不了', 'not a url'],
    ['没写协议', 'a.com'],
    ['只有 view-source: 外壳', 'view-source:'],
    ['只有 blob: 外壳', 'blob:'],
    ['主机名只剩点', 'https://.../x']
  ])('SITE-3 %s → 没有站点（undefined）', (_l, raw) => {
    expect(browserSiteOf(raw)).toBeUndefined()
  })

  it.each([
    'https://A.COM./y',
    'http://a.com:8080/',
    'https://user:pw@Evil.Example./x',
    'http://[::1]:3000/',
    'blob:https://A.Example.:8443/0b1c'
  ])('SITE-4 %s：站点就是策略客体的 host（urlObjectOf 同一种写法）', (raw) => {
    expect(browserSiteOf(raw)).toBe(urlObjectOf(raw, 'chrome').host)
  })

  it('SITE-5 从包入口导出的就是它', async () => {
    const runtime = await import('../../index')
    expect(runtime.browserSiteOf).toBe(browserSiteOf)
  })
})

/**
 * `shared/networkRoutes.ts`（server mode phase D）—— 网络服务 HTTP 路由的地址怎么拼（纯字符串，主进程匹配、渲染端拼地址）。
 *
 *   NR-1 media / preview / download 的地址以各自的路由开头；用 URL 解析回来，session 与 path 原样取回
 *        （空格、& = # ? + %、字面的 %20、CJK、emoji、Windows 路径、换行）
 *   NR-2 networkLibBase：origin 尾部的斜杠（一个或几个）都折成一个，接 `/lib/`；拼出来的基址过得了
 *        isSandboxLibBase（局域网 IP、127.0.0.1、https 主机名、IPv6 字面量）
 *   NR-3 networkWidgetUrl：widget 服务的 `/w/…` 地址换成 origin 下的同一个路径（查询串与片段保留）；不是 `/w/` 下的、
 *        解析不了的、空串 → 原样
 */
import { describe, expect, it } from 'vitest'
import { isSandboxLibBase } from '@shuvix/chat-protocol/utils/interactiveFence'
import {
  NETWORK_DOWNLOAD_PATH,
  NETWORK_LIB_PREFIX,
  NETWORK_MEDIA_PATH,
  NETWORK_PREVIEW_PATH,
  networkDownloadUrl,
  networkLibBase,
  networkMediaUrl,
  networkPreviewUrl,
  networkWidgetUrl
} from '../networkRoutes'

const TRICKY = [
  '/a b/c d.png',
  '/x/a&b=c#d?e+f%g.png',
  '/x/%20literal.png',
  '/文档/报告 1.png',
  '/emoji/🎉 party.mp3',
  'C:\\a b\\c.png',
  '/line\nbreak.png',
  'relative/sub dir/x.pdf'
]

/** 渲染端拼的是以 `/` 开头的相对地址：随便给个 base 解析回来 */
const parse = (url: string): URL => new URL(url, 'http://192.168.1.10:7766')

describe('NR-1 media / preview / download', () => {
  it('NR-1 以路由开头；path 原样取回', () => {
    for (const path of TRICKY) {
      const media = networkMediaUrl(path)
      expect(media.startsWith(`${NETWORK_MEDIA_PATH}?`), path).toBe(true)
      expect(parse(media).pathname, path).toBe(NETWORK_MEDIA_PATH)
      expect(parse(media).searchParams.get('path'), path).toBe(path)

      const download = networkDownloadUrl(path)
      expect(download.startsWith(`${NETWORK_DOWNLOAD_PATH}?`), path).toBe(true)
      expect(parse(download).pathname, path).toBe(NETWORK_DOWNLOAD_PATH)
      expect(parse(download).searchParams.get('path'), path).toBe(path)
    }
  })

  it('NR-1 preview：session 与 path 都原样取回', () => {
    for (const path of TRICKY) {
      for (const session of ['s1', 's 1&x=y#z', '会话 🎉', 'a+b%20c']) {
        const url = networkPreviewUrl(session, path)
        expect(url.startsWith(`${NETWORK_PREVIEW_PATH}?`), path).toBe(true)
        const parsed = parse(url)
        expect(parsed.pathname, path).toBe(NETWORK_PREVIEW_PATH)
        expect(parsed.searchParams.get('session'), `${session} ${path}`).toBe(session)
        expect(parsed.searchParams.get('path'), `${session} ${path}`).toBe(path)
        expect([...parsed.searchParams.keys()].sort()).toStrictEqual(['path', 'session'])
      }
    }
  })
})

describe('NR-2 networkLibBase', () => {
  it('NR-2 尾部斜杠折成一个，接 /lib/', () => {
    expect(NETWORK_LIB_PREFIX).toBe('/lib/')
    for (const origin of ['http://h:1', 'http://h:1/', 'http://h:1///']) {
      expect(networkLibBase(origin), origin).toBe('http://h:1/lib/')
    }
  })

  it('NR-2 拼出来的基址过得了 isSandboxLibBase', () => {
    for (const origin of [
      'http://192.168.1.10:7766',
      'http://127.0.0.1:7766',
      'https://shuvix.lan:8443',
      'http://[::1]:7766'
    ]) {
      const base = networkLibBase(origin)
      expect(base, origin).toBe(`${origin}/lib/`)
      expect(isSandboxLibBase(base), base).toBe(true)
    }
  })
})

describe('NR-3 networkWidgetUrl', () => {
  it('NR-3 /w/ 下的地址换成 origin 下的同一路径，查询串与片段保留', () => {
    expect(
      networkWidgetUrl('http://127.0.0.1:5555/w/demo-widget/?a=1#h', 'http://192.168.1.10:7766/')
    ).toBe('http://192.168.1.10:7766/w/demo-widget/?a=1#h')
    expect(
      networkWidgetUrl('http://127.0.0.1:5555/w/demo-widget/', 'http://192.168.1.10:7766')
    ).toBe('http://192.168.1.10:7766/w/demo-widget/')
  })

  it('NR-3 不是 /w/ 下的、解析不了的、空串 → 原样', () => {
    for (const url of [
      'http://127.0.0.1:5555/other/demo/',
      'http://127.0.0.1:5555/w',
      'not a url',
      ''
    ]) {
      expect(networkWidgetUrl(url, 'http://192.168.1.10:7766'), url).toBe(url)
    }
  })
})

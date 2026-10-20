/**
 * widget 文件路由的密钥（widgetFsKey.ts）—— 只补给「widget 页面读它自己的文件路由」的请求。
 *
 *   FK-1  hasWidgetFsKey：只认本进程的那一个值（字符串、等长、逐字节相同）
 *   FK-2  isOwnWidgetFilesRequest：目标是本机这个端口的 `/w/<id>/fs/…`，发起页面在同一服务的 `/w/<id>/` 下
 *   FK-3  不算的：别的端口、别的主机、https、不是文件路由、别的 widget 的页面、别的源的页面、没有发起页面、
 *         端口还是 0（服务没起来）、解析不了的地址
 *   FK-4  installWidgetFsKey：钩在 127.0.0.1 / localhost 上；该补的补上密钥（frame 地址优先，没有看 Referer）；
 *         页面自己冒充的同名头（任何大小写）一律去掉；其余头原样；frame 访问抛错当作没有
 */
import { describe, expect, it } from 'vitest'
import {
  hasWidgetFsKey,
  installWidgetFsKey,
  isOwnWidgetFilesRequest,
  WIDGET_FS_KEY_HEADER,
  widgetFsKey
} from '../widgetFsKey'

const PORT = 41234
const BASE = `http://127.0.0.1:${PORT}`

describe('widgetFsKey', () => {
  it('FK-1 hasWidgetFsKey 只认本进程的值', () => {
    expect(widgetFsKey()).toMatch(/^[0-9a-f]{64}$/)
    expect(hasWidgetFsKey(widgetFsKey())).toBe(true)
    expect(hasWidgetFsKey(undefined)).toBe(false)
    expect(hasWidgetFsKey('')).toBe(false)
    expect(hasWidgetFsKey([widgetFsKey()])).toBe(false)
    expect(hasWidgetFsKey(widgetFsKey() + '0')).toBe(false)
    expect(hasWidgetFsKey('0'.repeat(64))).toBe(false)
  })

  it('FK-2 widget 页面读它自己的文件路由', () => {
    const url = `${BASE}/w/photo-wall/fs/file?path=%2Ftmp%2Fa.png`
    expect(isOwnWidgetFilesRequest(url, `${BASE}/w/photo-wall/`, PORT)).toBe(true)
    expect(isOwnWidgetFilesRequest(url, `${BASE}/w/photo-wall/sub/page?x=1`, PORT)).toBe(true)
    expect(
      isOwnWidgetFilesRequest(
        `http://localhost:${PORT}/w/photo-wall/fs/list?path=~`,
        `http://localhost:${PORT}/w/photo-wall/`,
        PORT
      )
    ).toBe(true)
  })

  it.each([
    ['别的端口', `http://127.0.0.1:9/w/a-b/fs/file?path=~`, `${BASE}/w/a-b/`, PORT],
    ['别的主机', `http://10.0.0.2:${PORT}/w/a-b/fs/file?path=~`, `${BASE}/w/a-b/`, PORT],
    ['https', `https://127.0.0.1:${PORT}/w/a-b/fs/file?path=~`, `${BASE}/w/a-b/`, PORT],
    ['不是文件路由', `${BASE}/w/a-b/db/items`, `${BASE}/w/a-b/`, PORT],
    ['别的 widget 的页面', `${BASE}/w/a-b/fs/file?path=~`, `${BASE}/w/c-d/`, PORT],
    ['别的源的页面', `${BASE}/w/a-b/fs/file?path=~`, 'https://evil.example/w/a-b/', PORT],
    [
      'localhost 与 127.0.0.1 不同源',
      `${BASE}/w/a-b/fs/file?path=~`,
      `http://localhost:${PORT}/w/a-b/`,
      PORT
    ],
    ['没有发起页面', `${BASE}/w/a-b/fs/file?path=~`, undefined, PORT],
    ['服务还没起来', `http://127.0.0.1:0/w/a-b/fs/file?path=~`, 'http://127.0.0.1:0/w/a-b/', 0],
    ['解析不了', 'not a url', `${BASE}/w/a-b/`, PORT]
  ])('FK-3 %s → 不补', (_label, url, initiator, port) => {
    expect(isOwnWidgetFilesRequest(url, initiator, port)).toBe(false)
  })

  it('FK-4 installWidgetFsKey 补头、去掉冒充的头、其余原样', () => {
    type Details = {
      url: string
      referrer: string
      frame?: { url: string } | null
      requestHeaders: Record<string, string>
    }
    let filter: { urls: string[] } | undefined
    let listener:
      | ((d: Details, cb: (r: { requestHeaders: Record<string, string> }) => void) => void)
      | undefined
    const ses = {
      webRequest: {
        onBeforeSendHeaders: (f: { urls: string[] }, l: typeof listener) => {
          filter = f
          listener = l
        }
      }
    }
    installWidgetFsKey(ses as never, () => PORT)
    expect(filter).toEqual({ urls: ['http://127.0.0.1/*', 'http://localhost/*'] })

    const run = (d: Partial<Details>): Record<string, string> => {
      let out: Record<string, string> = {}
      listener!(
        { url: '', referrer: '', requestHeaders: {}, ...d } as Details,
        (r) => (out = r.requestHeaders)
      )
      return out
    }
    const fileUrl = `${BASE}/w/photo-wall/fs/file?path=~`

    // frame 地址优先
    expect(
      run({
        url: fileUrl,
        frame: { url: `${BASE}/w/photo-wall/` },
        requestHeaders: { Accept: '*/*' }
      })
    ).toEqual({ Accept: '*/*', [WIDGET_FS_KEY_HEADER]: widgetFsKey() })
    // 没有 frame 看 Referer
    expect(run({ url: fileUrl, referrer: `${BASE}/w/photo-wall/` })).toEqual({
      [WIDGET_FS_KEY_HEADER]: widgetFsKey()
    })
    // frame 访问抛错当作没有 → 落到 Referer
    const disposed = {
      get url(): string {
        throw new Error('Render frame was disposed')
      }
    }
    expect(run({ url: fileUrl, frame: disposed, referrer: `${BASE}/w/photo-wall/` })).toEqual({
      [WIDGET_FS_KEY_HEADER]: widgetFsKey()
    })
    // 别的页面冒充同名头（大小写不同也算）：去掉，不补
    expect(
      run({
        url: fileUrl,
        referrer: 'https://evil.example/',
        requestHeaders: { 'X-Shuvix-Widget-Key': 'forged', Accept: 'a' }
      })
    ).toEqual({ Accept: 'a' })
    // 非文件路由：原样
    expect(
      run({
        url: `${BASE}/w/photo-wall/bundle.js`,
        referrer: `${BASE}/w/photo-wall/`,
        requestHeaders: { A: '1' }
      })
    ).toEqual({ A: '1' })
  })
})

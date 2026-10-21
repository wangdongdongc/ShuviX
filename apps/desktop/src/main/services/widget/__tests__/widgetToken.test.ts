/**
 * widget 路由的令牌（widgetToken.ts）—— 按 widget 签发、由宿主补在请求头上。
 *
 *   WT-1  签发 / 校验：JWT 形状（三段、HS256 头）；对签发它的 widget 回它的范围（ui / cli）；同一 widget 同一范围稳定
 *   WT-2  校验拒绝：别的 widget 的、改过载荷的、改过签名的、换了头的、段数不对的、不是字符串的、数组、载荷不是 JSON、
 *         范围不认识的 → null
 *   WT-3  widgetIdOf：本机这个端口上 `/w/<id>/…`（含没有尾斜杠的 `/w/<id>`）→ id；别的端口 / 主机 / https / 不是 widget
 *         路径 / 端口 0 / 解析不了 → null
 *   WT-4  widgetToInject 子资源：发起它的页面（frame 地址，没有就看 Referer）在同一个 widget 下才补；别的 widget、
 *         别的源、没有发起页面 → 不补
 *   WT-5  widgetToInject 文档加载：ShuviX 自己的界面（父 frame 是应用页面）、没有 Referer、同一 widget 的重载 → 补；
 *         父 frame 或 Referer 是**别的** widget 的页面 → 不补；目标不是 widget 路由 → 不补
 *   WT-6  installWidgetTokens：钩在 127.0.0.1 / localhost 上；该补的补上那个 widget 的 ui 令牌（服务端认得出）；页面
 *         冒充的同名头（任何大小写）一律去掉；其余头原样；frame 访问抛错当作没有；端口现取
 */
import { describe, expect, it } from 'vitest'
import {
  installWidgetTokens,
  issueWidgetToken,
  WIDGET_TOKEN_HEADER,
  widgetIdOf,
  widgetToInject,
  widgetTokenScope
} from '../widgetToken'

const PORT = 41234
const BASE = `http://127.0.0.1:${PORT}`
const APP = 'file:///Applications/ShuviX.app/Contents/Resources/app.asar/out/renderer/index.html'

describe('签发与校验', () => {
  it('WT-1 JWT 形状；对它的 widget 回范围；稳定', () => {
    const ui = issueWidgetToken('photo-wall', 'ui')
    const parts = ui.split('.')
    expect(parts).toHaveLength(3)
    expect(JSON.parse(Buffer.from(parts[0], 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT'
    })
    expect(JSON.parse(Buffer.from(parts[1], 'base64url').toString())).toEqual({
      w: 'photo-wall',
      s: 'ui'
    })
    expect(widgetTokenScope(ui, 'photo-wall')).toBe('ui')
    expect(widgetTokenScope(issueWidgetToken('photo-wall', 'cli'), 'photo-wall')).toBe('cli')
    expect(issueWidgetToken('photo-wall', 'ui')).toBe(ui)
  })

  it('WT-2 拒绝一切不对的', () => {
    const token = issueWidgetToken('photo-wall', 'ui')
    const [h, p, sig] = token.split('.')
    const forgedPayload = Buffer.from(JSON.stringify({ w: 'photo-wall', s: 'ui', x: 1 })).toString(
      'base64url'
    )
    const otherHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url'
    )
    const flip = (s: string): string => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
    const garbage = Buffer.from('not json').toString('base64url')
    const weird = (claims: unknown): string => {
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
      return `${h}.${payload}.${sig}`
    }
    for (const bad of [
      issueWidgetToken('other-widget', 'ui'),
      `${h}.${forgedPayload}.${sig}`,
      `${h}.${p}.${flip(sig)}`,
      `${otherHeader}.${p}.${sig}`,
      `${h}.${p}`,
      `${token}.extra`,
      '',
      `${h}.${garbage}.${sig}`,
      weird({ w: 'photo-wall', s: 'admin' })
    ]) {
      expect(widgetTokenScope(bad, 'photo-wall'), bad).toBeNull()
    }
    expect(widgetTokenScope(undefined, 'photo-wall')).toBeNull()
    expect(widgetTokenScope([token], 'photo-wall')).toBeNull()
  })
})

describe('认 widget 路由', () => {
  it.each([
    [`${BASE}/w/photo-wall/`, 'photo-wall'],
    [`${BASE}/w/photo-wall`, 'photo-wall'],
    [`${BASE}/w/photo-wall/db/items?x=1`, 'photo-wall'],
    [`http://localhost:${PORT}/w/a-b/fs/file?path=~`, 'a-b'],
    [`http://127.0.0.1:9/w/a-b/`, null],
    [`http://10.0.0.2:${PORT}/w/a-b/`, null],
    [`https://127.0.0.1:${PORT}/w/a-b/`, null],
    [`${BASE}/other/a-b/`, null],
    [`${BASE}/wx/a-b/`, null],
    ['not a url', null],
    [undefined, null]
  ])('WT-3 %s → %s', (url, id) => {
    expect(widgetIdOf(url as string | undefined, PORT)).toBe(id)
  })

  it('WT-3 端口 0（服务还没起来）→ null', () => {
    expect(widgetIdOf('http://127.0.0.1:0/w/a-b/', 0)).toBeNull()
  })
})

describe('补给谁', () => {
  it.each([
    ['同一 widget 的页面发的 fetch', { frameUrl: `${BASE}/w/a-b/` }, 'a-b'],
    ['没有 frame 看 Referer', { referrer: `${BASE}/w/a-b/sub/page` }, 'a-b'],
    ['别的 widget 的页面', { frameUrl: `${BASE}/w/c-d/` }, null],
    ['别的源的页面', { frameUrl: 'https://evil.example/w/a-b/' }, null],
    ['ShuviX 自己的界面发的子资源', { frameUrl: APP }, null],
    ['没有发起页面', {}, null]
  ])('WT-4 子资源：%s', (_label, facts, expected) => {
    expect(
      widgetToInject({ url: `${BASE}/w/a-b/db/items`, resourceType: 'xhr', ...facts }, PORT)
    ).toBe(expected)
  })

  it.each([
    ['面板里的 iframe（父 frame 是应用页面）', 'subFrame', { parentFrameUrl: APP }, 'a-b'],
    ['预览的离屏窗口（顶层、没有 Referer）', 'mainFrame', {}, 'a-b'],
    [
      '同一 widget 自己重载',
      'subFrame',
      { parentFrameUrl: APP, referrer: `${BASE}/w/a-b/` },
      'a-b'
    ],
    ['别的 widget 嵌它', 'subFrame', { parentFrameUrl: `${BASE}/w/c-d/` }, null],
    ['别的 widget 跳过来', 'mainFrame', { referrer: `${BASE}/w/c-d/` }, null]
  ])('WT-5 文档加载：%s', (_label, resourceType, facts, expected) => {
    expect(widgetToInject({ url: `${BASE}/w/a-b/`, resourceType, ...facts }, PORT)).toBe(expected)
  })

  it('WT-5 目标不是 widget 路由 → 不补', () => {
    expect(widgetToInject({ url: `${BASE}/lib/x.js`, resourceType: 'subFrame' }, PORT)).toBeNull()
    expect(
      widgetToInject({ url: 'http://localhost:5173/index.html', resourceType: 'mainFrame' }, PORT)
    ).toBeNull()
  })
})

describe('installWidgetTokens', () => {
  type Details = {
    url: string
    referrer: string
    resourceType?: string
    frame?: { url: string; parent?: { url: string } | null } | null
    requestHeaders: Record<string, string>
  }

  it('WT-6 补上那个 widget 的 ui 令牌、去掉冒充的头、其余原样；端口现取', () => {
    let filter: { urls: string[] } | undefined
    let listener:
      | ((d: Details, cb: (r: { requestHeaders: Record<string, string> }) => void) => void)
      | undefined
    let port = 0
    installWidgetTokens(
      {
        webRequest: {
          onBeforeSendHeaders: (f: { urls: string[] }, l: typeof listener) => {
            filter = f
            listener = l
          }
        }
      } as never,
      () => port
    )
    expect(filter).toEqual({ urls: ['http://127.0.0.1/*', 'http://localhost/*'] })

    const run = (d: Partial<Details>): Record<string, string> => {
      let out: Record<string, string> = {}
      listener!(
        { url: '', referrer: '', requestHeaders: {}, ...d } as Details,
        (r) => (out = r.requestHeaders)
      )
      return out
    }
    const fetchFromWidget: Partial<Details> = {
      url: `${BASE}/w/a-b/db/items`,
      resourceType: 'xhr',
      frame: { url: `${BASE}/w/a-b/` },
      requestHeaders: { Accept: '*/*' }
    }

    // 服务还没起来（端口 0）：什么都不补
    expect(run(fetchFromWidget)).toEqual({ Accept: '*/*' })

    port = PORT
    const injected = run(fetchFromWidget)
    expect(injected.Accept).toBe('*/*')
    expect(widgetTokenScope(injected[WIDGET_TOKEN_HEADER], 'a-b')).toBe('ui')

    // 文档加载：面板里的 iframe
    const doc = run({
      url: `${BASE}/w/a-b/`,
      resourceType: 'subFrame',
      frame: { url: 'about:blank', parent: { url: APP } }
    })
    expect(widgetTokenScope(doc[WIDGET_TOKEN_HEADER], 'a-b')).toBe('ui')

    // frame 已销毁（访问抛）→ 落到 Referer
    const disposed = {
      get url(): string {
        throw new Error('Render frame was disposed')
      }
    }
    const viaReferrer = run({
      url: `${BASE}/w/a-b/bundle.js`,
      resourceType: 'script',
      frame: disposed,
      referrer: `${BASE}/w/a-b/`
    })
    expect(widgetTokenScope(viaReferrer[WIDGET_TOKEN_HEADER], 'a-b')).toBe('ui')

    // 别的 widget 的页面打过来、还冒充了同名头（大小写不同也算）：去掉，不补
    expect(
      run({
        url: `${BASE}/w/a-b/fs/file?path=~`,
        resourceType: 'xhr',
        frame: { url: `${BASE}/w/c-d/` },
        requestHeaders: { 'X-Shuvix-Widget-Token': issueWidgetToken('a-b', 'ui'), A: '1' }
      })
    ).toEqual({ A: '1' })
  })
})

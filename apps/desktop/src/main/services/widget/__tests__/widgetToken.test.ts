/**
 * widget 路由的令牌（widgetToken.ts）—— 按 widget 签发、由宿主补在请求头上。
 *
 *   WT-1  签发 / 校验：JWT 形状（三段、HS256 头）；对签发它的 widget 回它的范围（ui / preview）；同一 widget 同一范围稳定
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
 *   WT4-PV-01 preview 令牌带会话：载荷 `{w, s:'preview', sid}`，验出 `{scope:'preview', sessionId}`；ui 验出来没有
 *         sessionId 键；preview 不带会话 / 会话是空串 / 会话不是字符串（签名照样有效）→ `{scope:'preview'}`；
 *         widgetTokenScope 照旧只回范围
 *   WT4-PV-02 签名有效但范围是旧的 `cli` → null；B 的 preview 令牌拿到 A 上 → null
 *   WT4-PV-03 installWidgetTokens 自带 `issue`：补它交回的那个、只补给那个 widget；交回 null → 不补，页面冒充的头
 *         照样去掉；不该补的请求根本不问 issue；不给 issue 照旧补 ui
 */
import { describe, expect, it, vi } from 'vitest'
import {
  installWidgetTokens,
  issueWidgetToken,
  verifyWidgetToken,
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
    expect(widgetTokenScope(issueWidgetToken('photo-wall', 'preview', 's1'), 'photo-wall')).toBe(
      'preview'
    )
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

describe('WT4-PV preview 令牌的范围与会话', () => {
  const payloadOf = (token: string): unknown =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

  it('WT4-PV-01 preview 带会话、ui 不带；没有 / 空 / 不是字符串的会话 → 只有范围', () => {
    const preview = issueWidgetToken('photo-wall', 'preview', 's1')
    expect(payloadOf(preview)).toStrictEqual({ w: 'photo-wall', s: 'preview', sid: 's1' })
    expect(verifyWidgetToken(preview, 'photo-wall')).toStrictEqual({
      scope: 'preview',
      sessionId: 's1'
    })

    const ui = issueWidgetToken('photo-wall', 'ui')
    expect(verifyWidgetToken(ui, 'photo-wall')).toStrictEqual({ scope: 'ui' })
    expect('sessionId' in verifyWidgetToken(ui, 'photo-wall')!).toBe(false)

    const noSession = issueWidgetToken('photo-wall', 'preview')
    expect(payloadOf(noSession)).toStrictEqual({ w: 'photo-wall', s: 'preview' })
    const emptySession = issueWidgetToken('photo-wall', 'preview', '')
    expect(payloadOf(emptySession)).toStrictEqual({ w: 'photo-wall', s: 'preview', sid: '' })
    // 签名有效、会话却不是字符串（只可能是宿主自己签错了）：不当成会话
    const numericSession = issueWidgetToken('photo-wall', 'preview', 123 as never)
    expect(payloadOf(numericSession)).toStrictEqual({ w: 'photo-wall', s: 'preview', sid: 123 })
    for (const token of [noSession, emptySession, numericSession]) {
      expect(verifyWidgetToken(token, 'photo-wall'), token).toStrictEqual({ scope: 'preview' })
      expect(widgetTokenScope(token, 'photo-wall'), token).toBe('preview')
    }

    expect(widgetTokenScope(preview, 'photo-wall')).toBe('preview')
    expect(widgetTokenScope(ui, 'photo-wall')).toBe('ui')
  })

  it('WT4-PV-02 旧的 cli 范围（签名有效）→ null；别的 widget 的 preview 令牌 → null', () => {
    const cli = issueWidgetToken('photo-wall', 'cli' as never)
    expect(payloadOf(cli)).toStrictEqual({ w: 'photo-wall', s: 'cli' })
    expect(verifyWidgetToken(cli, 'photo-wall')).toBeNull()
    expect(widgetTokenScope(cli, 'photo-wall')).toBeNull()

    const ofB = issueWidgetToken('book-shelf', 'preview', 's1')
    expect(verifyWidgetToken(ofB, 'photo-wall')).toBeNull()
    expect(widgetTokenScope(ofB, 'photo-wall')).toBeNull()
    expect(verifyWidgetToken(ofB, 'book-shelf')).toStrictEqual({
      scope: 'preview',
      sessionId: 's1'
    })
  })

  it('WT4-PV-03 installWidgetTokens 的 issue：补它给的、只给那个 widget；null 不补也去掉冒充的头', () => {
    type Listener = (
      d: {
        url: string
        referrer: string
        resourceType?: string
        frame?: { url: string } | null
        requestHeaders: Record<string, string>
      },
      cb: (r: { requestHeaders: Record<string, string> }) => void
    ) => void
    const install = (issue?: (id: string) => string | null): Listener => {
      let listener: Listener | undefined
      installWidgetTokens(
        {
          webRequest: {
            onBeforeSendHeaders: (_f: unknown, l: Listener) => {
              listener = l
            }
          }
        } as never,
        () => PORT,
        issue
      )
      return listener!
    }
    const send = (
      listener: Listener,
      id: string,
      from: string,
      extra: Record<string, string> = {}
    ): Record<string, string> => {
      let out: Record<string, string> = {}
      listener(
        {
          url: `${BASE}/w/${id}/api/listBooks`,
          referrer: '',
          resourceType: 'xhr',
          frame: { url: `${BASE}/w/${from}/` },
          requestHeaders: { Accept: '*/*', ...extra }
        },
        (r) => (out = r.requestHeaders)
      )
      return out
    }

    const issue = vi.fn((id: string) => (id === 'a-b' ? `custom-for-${id}` : null))
    const listener = install(issue)

    // a-b 的页面打 a-b：补 issue 给的那个
    expect(send(listener, 'a-b', 'a-b')).toEqual({
      Accept: '*/*',
      [WIDGET_TOKEN_HEADER]: 'custom-for-a-b'
    })
    expect(issue.mock.calls).toEqual([['a-b']])

    // c-d 的页面打 c-d：issue 交回 null → 不补；页面冒充的头照样去掉
    expect(
      send(listener, 'c-d', 'c-d', { 'X-Shuvix-Widget-Token': issueWidgetToken('c-d', 'ui') })
    ).toEqual({ Accept: '*/*' })
    expect(issue.mock.calls).toEqual([['a-b'], ['c-d']])

    // c-d 的页面打 a-b（不该补）：根本不问 issue
    expect(send(listener, 'a-b', 'c-d')).toEqual({ Accept: '*/*' })
    expect(issue).toHaveBeenCalledTimes(2)

    // 不给 issue：照旧补 ui
    const fallback = send(install(), 'a-b', 'a-b')
    expect(verifyWidgetToken(fallback[WIDGET_TOKEN_HEADER], 'a-b')).toStrictEqual({ scope: 'ui' })
  })
})

/**
 * `host/hostUrls.ts`（server mode phase D）—— 桌面窗口与浏览器里的 web 客户端拼地址的差别。纯函数：平台与页面地址由调用方
 * 交进来；桌面那一支一律原样 / undefined（桌面行为不因此改变）。
 *
 *   HU-1 isWebPlatform 只认 'web'（不认 'Web' / 'darwin' / undefined）
 *   HU-2 sandboxLibBaseFor：web → `<origin>/lib/`；别的 → undefined
 *   HU-3 widgetFrameUrl：web → 经网络服务转发的地址；桌面 → 原样（即使是 `/w/` 地址）
 *   HU-4 webPageUrl：保留 pathname，hash 开头的一个 `#` 去掉
 *   HU-5 filePreviewPageUrl：openedBy 缺省 user、给 agent 就是 agent；按 FilePreviewWindowShell 的 parseHash 那样解析
 *        回来，路径原样（& # + %、空格、CJK）
 *   HU-6 widgetPageUrl：按 WidgetWindowShell 的 parseWidgetIdFromHash 那样解析回来，id 原样
 *   （外加：webPreviewUrl 就是网络服务的 `/files/preview` 地址）
 */
import { describe, expect, it } from 'vitest'
import { networkPreviewUrl } from '../../../../shared/networkRoutes'
import {
  filePreviewPageUrl,
  isWebPlatform,
  sandboxLibBaseFor,
  webPageUrl,
  webPreviewUrl,
  widgetFrameUrl,
  widgetPageUrl
} from '../hostUrls'

const ORIGIN = 'http://192.168.1.10:7766'
const LOCATION = { origin: ORIGIN, pathname: '/' }

/** 与 FilePreviewWindowShell 的 parseHash 同一套读法（那个函数没导出；读的是页面地址的 hash） */
function parsePreviewHash(url: string): {
  sessionId: string | null
  path: string | null
  agent: boolean
} {
  const hash = new URL(url).hash
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return { sessionId: null, path: null, agent: false }
  const params = new URLSearchParams(hash.slice(qIdx + 1))
  return {
    sessionId: params.get('sessionId'),
    path: params.get('path'),
    agent: params.get('openedBy') === 'agent'
  }
}

/** 与 WidgetWindowShell 的 parseWidgetIdFromHash 同一套读法 */
function parseWidgetHash(url: string): string | null {
  const hash = new URL(url).hash
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return null
  return new URLSearchParams(hash.slice(qIdx + 1)).get('widgetId')
}

describe('HU-1 isWebPlatform', () => {
  it("HU-1 只认 'web'", () => {
    expect(isWebPlatform('web')).toBe(true)
    for (const platform of ['Web', 'WEB', 'darwin', 'win32', 'linux', '', undefined]) {
      expect(isWebPlatform(platform), String(platform)).toBe(false)
    }
  })
})

describe('HU-2 sandboxLibBaseFor', () => {
  it('HU-2 web → <origin>/lib/；别的 → undefined', () => {
    expect(sandboxLibBaseFor('web', ORIGIN)).toBe(`${ORIGIN}/lib/`)
    expect(sandboxLibBaseFor('web', `${ORIGIN}/`)).toBe(`${ORIGIN}/lib/`)
    for (const platform of ['darwin', 'win32', 'Web', undefined]) {
      expect(sandboxLibBaseFor(platform, ORIGIN), String(platform)).toBeUndefined()
    }
  })
})

describe('HU-3 widgetFrameUrl', () => {
  it('HU-3 web → 经网络服务转发；桌面 → 原样', () => {
    const local = 'http://127.0.0.1:5555/w/demo-widget/?a=1#h'
    expect(widgetFrameUrl('web', local, ORIGIN)).toBe(`${ORIGIN}/w/demo-widget/?a=1#h`)
    for (const platform of ['darwin', 'win32', 'linux', undefined]) {
      expect(widgetFrameUrl(platform, local, ORIGIN), String(platform)).toBe(local)
    }
  })
})

describe('HU-4 webPageUrl', () => {
  it('HU-4 保留 pathname；开头的一个 # 去掉', () => {
    expect(webPageUrl(LOCATION, 'settings')).toBe(`${ORIGIN}/#settings`)
    expect(webPageUrl(LOCATION, '#settings')).toBe(`${ORIGIN}/#settings`)
    expect(webPageUrl({ origin: ORIGIN, pathname: '/web.html' }, 'x')).toBe(`${ORIGIN}/web.html#x`)
    expect(webPageUrl(LOCATION, '##a')).toBe(`${ORIGIN}/##a`)
  })
})

describe('HU-5 filePreviewPageUrl', () => {
  it('HU-5 openedBy 缺省 user；给 agent 就是 agent', () => {
    const user = filePreviewPageUrl(LOCATION, { sessionId: 's1', path: '/a.png' })
    expect(user.startsWith(`${ORIGIN}/#file-preview?`)).toBe(true)
    expect(new URLSearchParams(new URL(user).hash.split('?')[1]).get('openedBy')).toBe('user')
    expect(parsePreviewHash(user).agent).toBe(false)

    const agent = filePreviewPageUrl(LOCATION, {
      sessionId: 's1',
      path: '/a.png',
      openedBy: 'agent'
    })
    expect(new URLSearchParams(new URL(agent).hash.split('?')[1]).get('openedBy')).toBe('agent')
    expect(parsePreviewHash(agent).agent).toBe(true)
  })

  it('HU-5 解析回来路径与会话原样', () => {
    for (const path of [
      '/x/a&b=c.png',
      '/x/a#b.png',
      '/x/a+b.png',
      '/x/100%.png',
      '/x/a b/c d.pdf',
      '/文档/报告.md',
      'relative/sub dir/x.txt'
    ]) {
      const url = filePreviewPageUrl(LOCATION, { sessionId: 's 1&x', path })
      expect(parsePreviewHash(url), path).toStrictEqual({
        sessionId: 's 1&x',
        path,
        agent: false
      })
    }
  })
})

describe('HU-6 widgetPageUrl', () => {
  it('HU-6 解析回来 id 原样', () => {
    for (const id of ['demo-widget', 'a b', 'x&y=z#w', '小组件']) {
      const url = widgetPageUrl(LOCATION, id)
      expect(url.startsWith(`${ORIGIN}/#widget-window?`), id).toBe(true)
      expect(parseWidgetHash(url), id).toBe(id)
    }
  })
})

describe('webPreviewUrl', () => {
  it('就是网络服务的 /files/preview 地址', () => {
    expect(webPreviewUrl('s1', 'sub/b.png')).toBe(networkPreviewUrl('s1', 'sub/b.png'))
  })
})

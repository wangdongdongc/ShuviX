/**
 * `shared/widgetRoutes.ts` —— widget 文件路由的纯字符串部分（主进程路由匹配与渲染端都引）。
 *
 *   WR-1 isWidgetFilesPath：`/w/<id>/fs/…` 才算（`fs` 后必须有 `/`、大小写敏感、id 非空、`/w/` 后不能多斜杠、
 *        `/fs/` 必须紧跟 id）；整串带查询串也照样认
 *   WR-2 widgetFileUrl / widgetListUrl：前缀固定；`path` 经 URL 解析后原样取回（空格、`&` `#` `?` `+` `%`、
 *        `~`、中文、Windows 路径、emoji、换行）；pathname 仍是文件路由；`+` 编成 `%2B`
 *   WR-3 路由常量都以 WIDGET_FILES_SEGMENT 开头；WIDGET_LIST_LIMIT 是 10000
 */
import { describe, expect, it } from 'vitest'
import {
  WIDGET_FILES_SEGMENT,
  WIDGET_FILE_ROUTE,
  WIDGET_LIST_LIMIT,
  WIDGET_LIST_ROUTE,
  isWidgetFilesPath,
  widgetFileUrl,
  widgetListUrl
} from '../widgetRoutes'

describe('WR-1 isWidgetFilesPath', () => {
  it.each(['/w/photo-wall/fs/file', '/w/photo-wall/fs/list', '/w/x/fs/'])(
    'WR-1 %j → true',
    (path) => {
      expect(isWidgetFilesPath(path)).toBe(true)
    }
  )

  it.each([
    '/w/photo-wall/fs',
    '/w/photo-wall/fsx/file',
    '/w/photo-wall/FS/file',
    '/w//fs/file',
    '/w/photo-wall//fs/file',
    '/w/a/db/fs/file',
    '/files/media',
    '/',
    ''
  ])('WR-1 %j → false', (path) => {
    expect(isWidgetFilesPath(path)).toBe(false)
  })

  it('WR-1 整串带查询串照样认', () => {
    expect(isWidgetFilesPath('/w/a/fs/file?path=x')).toBe(true)
  })
})

describe('WR-2 widgetFileUrl / widgetListUrl', () => {
  const PATHS = [
    '/a b/c.png',
    '/x/a&b=c#d?e+f%g',
    '/x/%20lit',
    '~/照片/1.jpg',
    'C:\\Users\\me\\a.png',
    '🎉.mp3',
    '/x/line\nbreak'
  ]

  it('WR-2 前缀固定', () => {
    expect(widgetFileUrl('photo-wall', '/a').startsWith('/w/photo-wall/fs/file?path=')).toBe(true)
    expect(widgetListUrl('photo-wall', '/a').startsWith('/w/photo-wall/fs/list?path=')).toBe(true)
  })

  it.each(PATHS)('WR-2 %j 经 URL 解析原样取回，pathname 仍是文件路由', (path) => {
    for (const [make, route] of [
      [widgetFileUrl, '/w/photo-wall/fs/file'],
      [widgetListUrl, '/w/photo-wall/fs/list']
    ] as const) {
      const url = new URL(make('photo-wall', path), 'http://x')
      expect(url.searchParams.get('path')).toBe(path)
      expect(url.pathname).toBe(route)
      expect(isWidgetFilesPath(url.pathname)).toBe(true)
    }
  })

  it('WR-2 `+` 编成 %2B（不会被读成空格）', () => {
    expect(widgetFileUrl('photo-wall', '/a+b')).toBe('/w/photo-wall/fs/file?path=%2Fa%2Bb')
    expect(widgetListUrl('photo-wall', '/a+b')).toContain('%2B')
  })
})

describe('WR-3 常量', () => {
  it('WR-3 路由以 WIDGET_FILES_SEGMENT 开头；WIDGET_LIST_LIMIT === 10000', () => {
    expect(WIDGET_FILE_ROUTE.startsWith(WIDGET_FILES_SEGMENT)).toBe(true)
    expect(WIDGET_LIST_ROUTE.startsWith(WIDGET_FILES_SEGMENT)).toBe(true)
    expect(WIDGET_LIST_LIMIT).toBe(10000)
  })
})

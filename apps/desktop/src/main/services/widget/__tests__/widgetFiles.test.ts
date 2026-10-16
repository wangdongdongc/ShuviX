/**
 * `services/widget/widgetFiles.ts` —— widget 的文件路由（`/w/<id>/fs/file`、`/w/<id>/fs/list`）。
 * `resolveWidgetFilePath` 直接调（显式给 home）；HTTP 用一个裸的 `node:http` 服务（127.0.0.1 随机端口），handler 把
 * `/w/<id>` 剥掉后交给 `serveWidgetFiles`（两道门在 widgetServer，不在这里）。文件是临时目录里的真文件；
 * `~` 走 HTTP 时 `node:os` 的 homedir 换成临时家目录。请求用 `node:http`（`agent:false`，正文按字节收）。
 *
 *   WF-P1 缺 / 空 / 带 NUL / 相对路径 / `~user` / `~x` → undefined
 *   WF-P2 `~`、`~/` → home；`~/Pictures/2024` → home 下
 *   WF-P3 归一：`..`、尾斜杠、双斜杠；`~/../x` → home 的上一层
 *   WF-P4 Windows 盘符路径：win32 原样；posix 不是绝对路径 → undefined
 *   WF-F1 GET png → 200 image/png、accept-ranges、content-length、no-cache、nosniff、字节一致、没有 ACAO
 *   WF-F2 MIME：txt / json → octet-stream；大写 .MP4 → video/mp4；svg 带 `CSP: sandbox`；html → octet-stream 不带 CSP
 *   WF-F3 Range：一段 → 206；后缀 → 最后 N 个字节；落在外 → 416（content-range 不带范围、length 0、空正文）
 *   WF-F4 HEAD → 同样的头、空正文；HEAD + Range → 206 只回头
 *   WF-F5 空文件 → 200 length 0，不挂住
 *   WF-F6 坏 path（缺、空、相对、带 NUL、`~foo`）→ 400 text/plain 那句话
 *   WF-F7 文件不在 / 是目录 → 404 `Not found.`
 *   WF-F8 没有读权限 → 403 `Forbidden.`（root / win32 跳过）
 *   WF-F9 widgetFileUrl 拼的地址（`+`、空格、`%`、`#`、中文）→ 200 字节一致
 *   WF-F10 `~/notes/a.txt` → 家目录下的文件
 *   WF-F11 POST / PUT / DELETE / OPTIONS → 405 text/plain + allow: GET, HEAD；预检形状的 OPTIONS 也一样、没有 ACAO
 *   WF-F12 认不出的子路径（`/fs/`、`/fs/other`、`/fs/file/`、`/fs/list/x`）→ 404 `Not found.`
 *   WF-L1 列目录：path 是解析后的路径（不是 realpath）；按码元排序；跟随符号链接看类型；断链 → other；没截断
 *         （符号链接 win32 跳过）
 *   WF-L2 空目录 → entries []
 *   WF-L3 `<dir>/a/../` → path 归一成 dir
 *   WF-L4 `~` / `~/sub` → 家目录下
 *   WF-L5 截断：LIMIT+1 条 → 前 LIMIT 条 + truncated；恰好 LIMIT 条 → 不截断
 *   WF-L6 错误也是 JSON `{code,message}`：不在 → 404 NOT_FOUND（带路径）；是文件 → 404 NOT_A_DIRECTORY；坏 path → 400 BAD_PATH
 *   WF-L7 没权限 → 403 FORBIDDEN：目录本身 000（readdir）；上层 000（stat）（root / win32 跳过）
 *   WF-L8 HEAD → 200，content-length 等于 GET 正文的字节数，空正文
 *   WF-L9 POST / PUT / DELETE / OPTIONS → 405 JSON METHOD_NOT_ALLOWED + allow: GET, HEAD
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server
} from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WIDGET_LIST_LIMIT, widgetFileUrl, widgetListUrl } from '../../../../shared/widgetRoutes'

const osState = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => osState.home }
})

import { resolveWidgetFilePath, serveWidgetFiles } from '../widgetFiles'

const BAD_PATH_TEXT = 'Bad request: path must be an absolute path or start with ~.'
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const posixNonRoot = process.platform !== 'win32' && !isRoot

let root = ''
let fakeHome = ''
let server: Server
let port = 0
/** afterEach 里要恢复权限的路径 */
let locked: string[] = []
let counter = 0

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

function http(
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<HttpResult> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        headers: options.headers,
        agent: false
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
        )
        res.on('error', fail)
      }
    )
    req.on('error', fail)
    req.end()
  })
}

/** `/w/photo-wall/fs/file?path=<编码后的 raw>` */
const fileUrl = (raw: string): string => widgetFileUrl('photo-wall', raw)
const listUrl = (raw: string): string => widgetListUrl('photo-wall', raw)

/** 每条用例一个新的子目录 */
function freshDir(): string {
  const dir = join(root, `case-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function json(res: HttpResult): Record<string, unknown> {
  return JSON.parse(res.body.toString('utf8')) as Record<string, unknown>
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shuvix-widget-fs-'))
  fakeHome = join(root, 'home')
  mkdirSync(fakeHome, { recursive: true })
  osState.home = fakeHome
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://h')
    void serveWidgetFiles(u.pathname.replace(/^\/w\/[^/]+/, ''), req, res, u.searchParams)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  port = (server.address() as { port: number }).port
})

afterEach(() => {
  for (const p of locked) chmodSync(p, 0o755)
  locked = []
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  rmSync(root, { recursive: true, force: true })
})

describe('WF-P resolveWidgetFilePath（纯）', () => {
  const HOME = resolve('/home/u')

  it.each([null, undefined, '', '/a\0b', 'rel/x', './x', '~user/x', '~x'])(
    'WF-P1 %j → undefined',
    (raw) => {
      expect(resolveWidgetFilePath(raw, HOME)).toBeUndefined()
    }
  )

  it('WF-P2 `~`、`~/` → home；`~/Pictures/2024` → home 下', () => {
    expect(resolveWidgetFilePath('~', HOME)).toBe(HOME)
    expect(resolveWidgetFilePath('~/', HOME)).toBe(HOME)
    expect(resolveWidgetFilePath('~/Pictures/2024', HOME)).toBe(join(HOME, 'Pictures', '2024'))
  })

  it('WF-P3 归一：`..`、尾斜杠、双斜杠；`~/../x`', () => {
    expect(resolveWidgetFilePath('/a/b/../c/', HOME)).toBe(resolve('/a/c'))
    expect(resolveWidgetFilePath('/a//b', HOME)).toBe(resolve('/a/b'))
    expect(resolveWidgetFilePath('~/../x', HOME)).toBe(resolve(HOME, '..', 'x'))
  })

  it.runIf(process.platform === 'win32')('WF-P4 win32：盘符路径原样', () => {
    expect(resolveWidgetFilePath('C:\\Users\\me', HOME)).toBe('C:\\Users\\me')
  })

  it.runIf(process.platform !== 'win32')('WF-P4 posix：盘符路径不是绝对路径 → undefined', () => {
    expect(resolveWidgetFilePath('C:\\x', HOME)).toBeUndefined()
  })
})

describe('WF-F fs/file', () => {
  it('WF-F1 GET png → 200 与各个头、字节一致、没有 ACAO', async () => {
    const dir = freshDir()
    const bytes = randomBytes(3072)
    const file = join(dir, 'a.png')
    writeFileSync(file, bytes)

    const res = await http(fileUrl(file))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(res.headers['content-length']).toBe('3072')
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.body.equals(bytes)).toBe(true)
  })

  it('WF-F2 MIME：txt / json / html → octet-stream；.MP4 → video/mp4；svg 带 CSP sandbox', async () => {
    const dir = freshDir()
    const cases: Array<[string, string, string | undefined]> = [
      ['a.txt', 'application/octet-stream', undefined],
      ['a.json', 'application/octet-stream', undefined],
      ['a.MP4', 'video/mp4', undefined],
      ['a.svg', 'image/svg+xml', 'sandbox'],
      ['a.html', 'application/octet-stream', undefined]
    ]
    for (const [name, type, csp] of cases) {
      const file = join(dir, name)
      writeFileSync(file, 'x')
      const res = await http(fileUrl(file))
      expect(res.status, name).toBe(200)
      expect(res.headers['content-type'], name).toBe(type)
      expect(res.headers['content-security-policy'], name).toBe(csp)
    }
  })

  it('WF-F3 Range：一段 → 206；后缀 → 最后 3 个字节；落在外 → 416', async () => {
    const dir = freshDir()
    const file = join(dir, 'ten.bin')
    writeFileSync(file, Buffer.from('0123456789'))

    const part = await http(fileUrl(file), { headers: { Range: 'bytes=2-5' } })
    expect(part.status).toBe(206)
    expect(part.headers['content-range']).toBe('bytes 2-5/10')
    expect(part.headers['content-length']).toBe('4')
    expect(part.body.toString()).toBe('2345')

    const suffix = await http(fileUrl(file), { headers: { Range: 'bytes=-3' } })
    expect(suffix.status).toBe(206)
    expect(suffix.body.toString()).toBe('789')

    const out = await http(fileUrl(file), { headers: { Range: 'bytes=20-30' } })
    expect(out.status).toBe(416)
    expect(out.headers['content-range']).toBe('bytes */10')
    expect(out.headers['content-length']).toBe('0')
    expect(out.body.length).toBe(0)
  })

  it('WF-F4 HEAD → 同样的头、空正文；HEAD + Range → 206 只回头', async () => {
    const dir = freshDir()
    const file = join(dir, 'a.png')
    writeFileSync(file, randomBytes(100))

    const get = await http(fileUrl(file))
    const head = await http(fileUrl(file), { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
    for (const h of [
      'content-type',
      'content-length',
      'accept-ranges',
      'cache-control',
      'x-content-type-options'
    ]) {
      expect(head.headers[h], h).toBe(get.headers[h])
    }

    const headRange = await http(fileUrl(file), {
      method: 'HEAD',
      headers: { Range: 'bytes=0-9' }
    })
    expect(headRange.status).toBe(206)
    expect(headRange.headers['content-range']).toBe('bytes 0-9/100')
    expect(headRange.headers['content-length']).toBe('10')
    expect(headRange.body.length).toBe(0)
  })

  it('WF-F5 空文件 → 200 length 0，不挂住', async () => {
    const dir = freshDir()
    const file = join(dir, 'empty.png')
    writeFileSync(file, '')
    const res = await http(fileUrl(file))
    expect(res.status).toBe(200)
    expect(res.headers['content-length']).toBe('0')
    expect(res.body.length).toBe(0)
  })

  it.each([
    ['缺 path', '/w/photo-wall/fs/file'],
    ['空 path', '/w/photo-wall/fs/file?path='],
    ['相对路径', '/w/photo-wall/fs/file?path=rel%2Fx'],
    ['带 NUL', '/w/photo-wall/fs/file?path=%2Fa%00b'],
    ['~foo', '/w/photo-wall/fs/file?path=~foo']
  ])('WF-F6 %s → 400 text/plain 那句话', async (_label, url) => {
    const res = await http(url)
    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(res.body.toString()).toBe(BAD_PATH_TEXT)
  })

  it('WF-F7 文件不在 / 是目录 → 404 `Not found.`', async () => {
    const dir = freshDir()
    for (const p of [join(dir, 'nope.png'), dir]) {
      const res = await http(fileUrl(p))
      expect(res.status, p).toBe(404)
      expect(res.body.toString(), p).toBe('Not found.')
    }
  })

  it.runIf(posixNonRoot)('WF-F8 没有读权限 → 403 `Forbidden.`', async () => {
    const dir = freshDir()
    const file = join(dir, 'secret.png')
    writeFileSync(file, 'secret-bytes')
    chmodSync(file, 0o000)
    locked.push(file)
    const res = await http(fileUrl(file))
    expect(res.status).toBe(403)
    expect(res.body.toString()).toBe('Forbidden.')
  })

  it('WF-F9 widgetFileUrl 拼的地址（+ 空格 % # 与中文）→ 200 字节一致', async () => {
    const dir = freshDir()
    for (const name of ['a+b c%#.txt', '照片 一.png']) {
      const file = join(dir, name)
      const bytes = randomBytes(64)
      writeFileSync(file, bytes)
      const res = await http(fileUrl(file))
      expect(res.status, name).toBe(200)
      expect(res.body.equals(bytes), name).toBe(true)
    }
  })

  it('WF-F10 `~/notes/a.txt` → 家目录下的文件', async () => {
    mkdirSync(join(fakeHome, 'notes'), { recursive: true })
    writeFileSync(join(fakeHome, 'notes', 'a.txt'), 'home note')
    const res = await http(fileUrl('~/notes/a.txt'))
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('home note')
  })

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])(
    'WF-F11 %s → 405 text/plain + allow: GET, HEAD',
    async (method) => {
      const dir = freshDir()
      const file = join(dir, 'a.txt')
      writeFileSync(file, 'x')
      const res = await http(fileUrl(file), { method })
      expect(res.status).toBe(405)
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
      expect(res.headers.allow).toBe('GET, HEAD')
    }
  )

  it('WF-F11 预检形状的 OPTIONS（Origin + ACRM）→ 仍是 405，没有 ACAO', async () => {
    const dir = freshDir()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')
    const res = await http(fileUrl(file), {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' }
    })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('GET, HEAD')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it.each(['/fs/', '/fs/other', '/fs/file/', '/fs/list/x'])(
    'WF-F12 %s → 404 `Not found.`',
    async (route) => {
      const res = await http(`/w/photo-wall${route}?path=%2F`)
      expect(res.status).toBe(404)
      expect(res.body.toString()).toBe('Not found.')
    }
  )
})

describe('WF-L fs/list', () => {
  function expectJsonHeaders(res: HttpResult): void {
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  }

  it.skipIf(process.platform === 'win32')(
    'WF-L1 列目录：解析后的路径、码元排序、跟随链接、断链 other',
    async () => {
      const dir = freshDir()
      writeFileSync(join(dir, 'b.txt'), 'abc')
      writeFileSync(join(dir, 'C.md'), '# c')
      writeFileSync(join(dir, '.hidden'), '')
      mkdirSync(join(dir, 'a'))
      symlinkSync(join(dir, 'a'), join(dir, 'link-dir'))
      symlinkSync(join(dir, 'b.txt'), join(dir, 'link-file'))
      symlinkSync('./nope', join(dir, 'broken'))

      const res = await http(listUrl(dir))
      expect(res.status).toBe(200)
      expectJsonHeaders(res)
      const body = json(res) as {
        path: string
        entries: Array<{ name: string; kind: string; size: number; mtimeMs: number }>
        truncated: boolean
      }
      expect(body.path).toBe(dir)
      expect(body.entries.map((e) => e.name)).toEqual([
        '.hidden',
        'C.md',
        'a',
        'b.txt',
        'broken',
        'link-dir',
        'link-file'
      ])
      const byName = new Map(body.entries.map((e) => [e.name, e]))
      expect(byName.get('a')).toMatchObject({ kind: 'directory', size: 0 })
      expect(byName.get('b.txt')).toEqual({
        name: 'b.txt',
        kind: 'file',
        size: 3,
        mtimeMs: statSync(join(dir, 'b.txt')).mtimeMs
      })
      expect(byName.get('link-dir')).toMatchObject({ kind: 'directory', size: 0 })
      expect(byName.get('link-file')).toMatchObject({ kind: 'file', size: 3 })
      expect(byName.get('broken')).toEqual({ name: 'broken', kind: 'other', size: 0, mtimeMs: 0 })
      expect(body.truncated).toBe(false)
    }
  )

  it('WF-L2 空目录 → entries []', async () => {
    const dir = freshDir()
    const res = await http(listUrl(dir))
    expect(res.status).toBe(200)
    expect(json(res)).toEqual({ path: dir, entries: [], truncated: false })
  })

  it('WF-L3 `<dir>/a/../` → path 归一成 dir', async () => {
    const dir = freshDir()
    mkdirSync(join(dir, 'a'))
    const res = await http(listUrl(`${dir}/a/../`))
    expect(res.status).toBe(200)
    expect(json(res).path).toBe(dir)
  })

  it('WF-L4 `~` / `~/sub` → 家目录下', async () => {
    mkdirSync(join(fakeHome, 'sub'), { recursive: true })
    const home = await http(listUrl('~'))
    expect(home.status).toBe(200)
    expect(json(home).path).toBe(fakeHome)
    const sub = await http(listUrl('~/sub'))
    expect(sub.status).toBe(200)
    expect(json(sub).path).toBe(join(fakeHome, 'sub'))
  })

  it('WF-L5 LIMIT+1 条 → 截断；恰好 LIMIT 条 → 不截断', { timeout: 60_000 }, async () => {
    const dir = freshDir()
    const name = (i: number): string => `f${String(i).padStart(6, '0')}`
    for (let i = 0; i < WIDGET_LIST_LIMIT + 1; i++) writeFileSync(join(dir, name(i)), '')

    const over = json(await http(listUrl(dir))) as {
      entries: Array<{ name: string }>
      truncated: boolean
    }
    expect(over.entries).toHaveLength(WIDGET_LIST_LIMIT)
    expect(over.truncated).toBe(true)
    expect(over.entries.some((e) => e.name === name(WIDGET_LIST_LIMIT))).toBe(false)

    rmSync(join(dir, name(WIDGET_LIST_LIMIT)))
    const exact = json(await http(listUrl(dir))) as { entries: unknown[]; truncated: boolean }
    expect(exact.entries).toHaveLength(WIDGET_LIST_LIMIT)
    expect(exact.truncated).toBe(false)
  })

  it('WF-L6 错误 JSON：不在 → NOT_FOUND；是文件 → NOT_A_DIRECTORY；坏 path → BAD_PATH', async () => {
    const dir = freshDir()
    const missing = join(dir, 'nope')
    const res = await http(listUrl(missing))
    expect(res.status).toBe(404)
    expectJsonHeaders(res)
    const body = json(res)
    expect(body.code).toBe('NOT_FOUND')
    expect(String(body.message)).toContain(missing)

    const file = join(dir, 'f.txt')
    writeFileSync(file, 'x')
    const notDir = await http(listUrl(file))
    expect(notDir.status).toBe(404)
    expect(json(notDir).code).toBe('NOT_A_DIRECTORY')

    for (const url of [
      '/w/photo-wall/fs/list',
      '/w/photo-wall/fs/list?path=',
      '/w/photo-wall/fs/list?path=rel%2Fx',
      '/w/photo-wall/fs/list?path=%2Fa%00b',
      '/w/photo-wall/fs/list?path=~foo'
    ]) {
      const bad = await http(url)
      expect(bad.status, url).toBe(400)
      expectJsonHeaders(bad)
      expect(json(bad).code, url).toBe('BAD_PATH')
    }
  })

  it.runIf(posixNonRoot)('WF-L7 没权限 → 403 FORBIDDEN（readdir / stat）', async () => {
    const dir = freshDir()
    const closed = join(dir, 'closed')
    mkdirSync(closed)
    chmodSync(closed, 0o000)
    locked.push(closed)
    const unreadable = await http(listUrl(closed))
    expect(unreadable.status).toBe(403)
    expect(json(unreadable).code).toBe('FORBIDDEN')

    const parent = join(dir, 'locked')
    mkdirSync(join(parent, 'inner'), { recursive: true })
    chmodSync(parent, 0o000)
    locked.push(parent)
    const unreachable = await http(listUrl(join(parent, 'inner')))
    expect(unreachable.status).toBe(403)
    expect(json(unreachable).code).toBe('FORBIDDEN')
  })

  it('WF-L8 HEAD → 200，content-length 等于 GET 正文字节数，空正文', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, '中文.txt'), 'x')
    const get = await http(listUrl(dir))
    const head = await http(listUrl(dir), { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(get.body.length))
    expect(head.body.length).toBe(0)
  })

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])(
    'WF-L9 %s → 405 JSON METHOD_NOT_ALLOWED + allow: GET, HEAD',
    async (method) => {
      const dir = freshDir()
      const res = await http(listUrl(dir), { method })
      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe('GET, HEAD')
      expectJsonHeaders(res)
      expect(json(res).code).toBe('METHOD_NOT_ALLOWED')
    }
  )
})

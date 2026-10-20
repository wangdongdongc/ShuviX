/**
 * `frontend/network/fileRoutes.ts`（server mode phase D §D1）—— 网络服务的文件路由：`/files/media`、`/files/preview`、
 * `/files/download`、`/lib/<名字>`。真的 `createNetworkServer` 绑 127.0.0.1 的随机端口（与 server.integration.test.ts
 * 同一套起法），`fileRoutes: () => deps` 现取；deps 的路径解析 / 库读取 / logger.warn 是间谍，文件是临时目录里的真文件。
 * HTTP 用 `node:http`（`agent:false`，自定头，正文按字节收）。
 *
 *   FR-R1  fileRouteOf：四种路由；长得像的不是（`/files/media/`、大小写、`/lib`、`/libx/a`、`/w/x`、`/`）。
 *          networkMediaUrl / PreviewUrl / DownloadUrl 拼的地址 → pathname 落到对应路由，查询参数原样取回
 *   FR-R2  media 绝对路径的 a.png → 200 image/png、accept-ranges、content-length、no-cache、nosniff、没有
 *          content-disposition、字节一致；3 MB 的文件流完整
 *   FR-R3  Range：一段 → 206；到尾；落在外 → 416（content-range `bytes *` 斜杠总长、length 0、no-store、空正文）；
 *          多段 → 200 整个；HEAD 带 / 不带 Range 只回头。后缀范围按 RFC：`bytes=-4` → 最后 4 个字节
 *   FR-R4  空文件 → 200 length 0（不挂住）；`bytes=0-` → 416
 *   FR-R5  400 `Bad request.`（text/plain、nosniff、no-store），解析器一次都不调：缺 path / 空 / 相对 / 带 NUL；
 *          preview 缺 session / 空 session / 缺 path / 带 NUL
 *   FR-R6  404 `Not found.`：文件不在、是目录、preview 解析器抛、解析出目录 / 不在的文件；没有读权限 → 403
 *          `Forbidden.`（root / win32 跳过）
 *   FR-R7  preview：解析器恰调一次（解码后的参数）；MIME 按解析出来的路径；绝对路径也经解析器
 *   FR-R8  download：octet-stream、no-store、attachment（ASCII 回落名 + filename*）；Range 的 206 也带它
 *   FR-R9  attachmentDisposition（纯）：非 ASCII / 引号 / 反斜杠的回落；filename* 的百分号编码；不带 CR/LF；空名
 *   FR-R10 /lib/*（假读取）：名字解码后交读取；200 text/javascript；HEAD 只回头；读不到 → 404；名字里带 `/`
 *          （含编码的）→ 404 且不读；坏的百分号 → 400 且不读；读取抛 → 500 `Internal error.` + 一条带 lib 的 warn
 *   FR-R11 /lib/*（真的 readSandboxLib，libs 目录指向仓库）：两份库的字节；白名单之外（文件名、原型链上的名字、
 *          裸名）→ 404 且不碰磁盘
 *   FR-R12 POST / PUT / PATCH / DELETE / OPTIONS → 405 + allow: GET, HEAD；依赖都不调
 *   FR-R13 没给 fileRoutes / 它回 undefined → 落到静态文件（404，文件不出去）；fileRoutes() 每个请求现取
 *   FR-R14 坏 Host → 421 connection: close；依赖都不调、秘密文件不出去
 *   FR-R15 一个 20 MB 的下载读到第一块就断开 → 下一个请求照样很快 200
 *   FR-R16 能当文档跑脚本的 SVG 带 `Content-Security-Policy: sandbox`；png / pdf / octet-stream 不带 CSP 头
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  networkDownloadUrl,
  networkMediaUrl,
  networkPreviewUrl
} from '../../../../shared/networkRoutes'
import { createNetworkDispatcher } from '../dispatch'
import { attachmentDisposition, fileRouteOf, type FileRouteDeps } from '../fileRoutes'
import { createNetworkLinkHub } from '../networkLinks'
import { createNetworkServer, type NetworkServer, type NetworkServerDeps } from '../server'
import { createNetworkTransport } from '../transport'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `apps/desktop/src/main/frontend/network/__tests__` 往上七层 */
const REPO_ROOT = resolve(HERE, '../../../../../../..')
const LIBS_DIR = join(REPO_ROOT, 'apps/desktop/resources/sandbox-libs')

const fsState = vi.hoisted(() => ({ readFile: vi.fn() }))

// FR-R11 用真的 fileServing：它引 toolContext（会拉起数据库）、pathUtils、paths —— 照 customProtocols.test.ts 顶掉；
// readFile 包一层间谍（缺省走真实现），「碰没碰磁盘」看得见
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const readFile = (...args: unknown[]): unknown => fsState.readFile(...args)
  return { ...actual, default: { ...actual, readFile }, readFile }
})
vi.mock('../../../utils/paths', () => ({ getSandboxLibsDir: () => LIBS_DIR }))
vi.mock('../../../services/toolContext', () => ({ resolveProjectConfig: vi.fn() }))
vi.mock('../../../services/sessionService', () => ({ sessionService: { getById: vi.fn() } }))
vi.mock('../../../utils/toolUtils/pathUtils', () => ({ resolveReadPath: vi.fn() }))

const SECRET = 'TOP-SECRET-FILE-CONTENT'
/** 64 个可辨认的字节 */
const PAYLOAD = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256))
const N = PAYLOAD.length
const LIB_BODY = Buffer.from('/* fake chart.js */ window.Chart = function () {}\n')

let tmp: string
let rendererDir: string
let server: NetworkServer | undefined
let port: number

interface RouteSpies {
  resolvePreviewPath: ReturnType<typeof vi.fn<(sessionId: string, path: string) => string>>
  readSandboxLib: ReturnType<typeof vi.fn<(name: string) => Promise<Buffer | undefined>>>
  warn: ReturnType<typeof vi.fn<(message: string) => void>>
}
let spies: RouteSpies
let deps: FileRouteDeps

/** 临时目录里的一个文件 */
const at = (...parts: string[]): string => join(tmp, ...parts)

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  fsState.readFile.mockReset()
  fsState.readFile.mockImplementation((...args: unknown[]) =>
    (actual.readFile as (...a: unknown[]) => Promise<Buffer>)(...args)
  )
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-net-files-'))
  rendererDir = at('renderer')
  mkdirSync(rendererDir)
  writeFileSync(join(rendererDir, 'web.html'), '<p>web</p>')
  writeFileSync(at('a.png'), PAYLOAD)
  writeFileSync(at('secret.txt'), SECRET)
  writeFileSync(at('empty.bin'), Buffer.alloc(0))
  mkdirSync(at('sub'))
  writeFileSync(at('sub', 'b.png'), PAYLOAD.subarray(0, 10))
  writeFileSync(at('x.webp'), PAYLOAD.subarray(0, 12))
  writeFileSync(at('demo widget.zip'), PAYLOAD)
  writeFileSync(at('pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
  writeFileSync(at('doc.pdf'), '%PDF-1.4 fake')
  writeFileSync(at('blob.bin'), PAYLOAD.subarray(0, 8))

  spies = {
    resolvePreviewPath: vi.fn((_sessionId: string, path: string) => resolve(tmp, path)),
    readSandboxLib: vi.fn(async (name: string) => (name === 'chart.js' ? LIB_BODY : undefined)),
    warn: vi.fn()
  }
  deps = {
    resolvePreviewPath: spies.resolvePreviewPath,
    readSandboxLib: spies.readSandboxLib,
    logger: { warn: spies.warn }
  }
  server = undefined
})

afterEach(async () => {
  await server?.stop()
  // FR-R6 的 0 权限文件：先还原权限再删
  try {
    chmodSync(at('locked.png'), 0o644)
  } catch {
    /* 没建过 */
  }
  rmSync(tmp, { recursive: true, force: true })
})

async function boot(overrides: Partial<NetworkServerDeps> = {}): Promise<number> {
  const transport = createNetworkTransport()
  server = createNetworkServer({
    transport,
    dispatcher: createNetworkDispatcher({ definitionOf: transport.definitionOf }),
    links: createNetworkLinkHub({ accept: () => {} }),
    rendererDir: () => rendererDir,
    fileRoutes: () => deps,
    heartbeatMs: 60_000,
    ...overrides
  })
  port = await server.start(0, '127.0.0.1')
  return port
}

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

function http(
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<HttpResult> {
  return new Promise((resolvePromise, reject) => {
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
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

const media = (path: string): string => networkMediaUrl(path)
const preview = (session: string, path: string): string => networkPreviewUrl(session, path)
const download = (path: string): string => networkDownloadUrl(path)

/** 依赖一个都没被调 */
function expectNoDepCalled(): void {
  expect(spies.resolvePreviewPath).not.toHaveBeenCalled()
  expect(spies.readSandboxLib).not.toHaveBeenCalled()
}

/** 一条纯文本错误应答的形状 */
function expectPlain(res: HttpResult, status: number, text: string): void {
  expect(res.status).toBe(status)
  expect(res.body.toString('utf8')).toBe(text)
  expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
  expect(res.headers['x-content-type-options']).toBe('nosniff')
  expect(res.headers['cache-control']).toBe('no-store')
}

const canRestrictReads = process.platform !== 'win32' && process.getuid?.() !== 0

describe('FR-R1 fileRouteOf', () => {
  it('FR-R1 四种路由；长得像的不是', () => {
    expect(fileRouteOf('/files/media')).toBe('media')
    expect(fileRouteOf('/files/preview')).toBe('preview')
    expect(fileRouteOf('/files/download')).toBe('download')
    expect(fileRouteOf('/lib/x')).toBe('lib')
    expect(fileRouteOf('/lib/')).toBe('lib')
    for (const path of [
      '/files/media/',
      '/files/MEDIA',
      '/files/',
      '/files/other',
      '/lib',
      '/libx/a',
      '/w/x',
      '/'
    ]) {
      expect(fileRouteOf(path), path).toBeUndefined()
    }
  })

  it('FR-R1 三个拼地址的函数 → pathname 落到对应路由，参数原样取回', () => {
    const tricky = [
      '/x/a b.png',
      '/x/a&b=c#d?e+f.png',
      '/x/100%.png',
      '/x/%20literal.png',
      '/x/报告 1.png',
      'C:\\a b\\c.png'
    ]
    for (const path of tricky) {
      const m = new URL(networkMediaUrl(path), 'http://h')
      expect(fileRouteOf(m.pathname), path).toBe('media')
      expect(m.searchParams.get('path'), path).toBe(path)

      const d = new URL(networkDownloadUrl(path), 'http://h')
      expect(fileRouteOf(d.pathname), path).toBe('download')
      expect(d.searchParams.get('path'), path).toBe(path)

      const p = new URL(networkPreviewUrl(`s ${path}`, path), 'http://h')
      expect(fileRouteOf(p.pathname), path).toBe('preview')
      expect(p.searchParams.get('session'), path).toBe(`s ${path}`)
      expect(p.searchParams.get('path'), path).toBe(path)
    }
  })
})

describe('FR-R2..FR-R4 media 与 Range', () => {
  beforeEach(async () => {
    await boot()
  })

  it('FR-R2 绝对路径的 a.png → 200 与那几条头，字节一致，没有 content-disposition', async () => {
    const res = await http(media(at('a.png')))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(res.headers['content-length']).toBe(String(N))
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-disposition']).toBeUndefined()
    expect(res.body.equals(PAYLOAD)).toBe(true)
    expectNoDepCalled()
  })

  it('FR-R2 3 MB 的文件流完整', async () => {
    const big = randomBytes(3 * 1024 * 1024)
    writeFileSync(at('big.mp4'), big)
    const res = await http(media(at('big.mp4')))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('video/mp4')
    expect(res.headers['content-length']).toBe(String(big.length))
    expect(res.body.length).toBe(big.length)
    expect(res.body.equals(big)).toBe(true)
  })

  it('FR-R3 一段 → 206 + 切片；bytes=3- 到尾', async () => {
    const mid = await http(media(at('a.png')), { headers: { Range: 'bytes=2-5' } })
    expect(mid.status).toBe(206)
    expect(mid.headers['content-range']).toBe(`bytes 2-5/${N}`)
    expect(mid.headers['content-length']).toBe('4')
    expect(mid.headers['content-type']).toBe('image/png')
    expect(mid.headers['accept-ranges']).toBe('bytes')
    expect(mid.body.equals(PAYLOAD.subarray(2, 6))).toBe(true)

    const tail = await http(media(at('a.png')), { headers: { Range: 'bytes=3-' } })
    expect(tail.status).toBe(206)
    expect(tail.headers['content-range']).toBe(`bytes 3-${N - 1}/${N}`)
    expect(tail.headers['content-length']).toBe(String(N - 3))
    expect(tail.body.equals(PAYLOAD.subarray(3))).toBe(true)
  })

  it('FR-R3 后缀范围按 RFC：bytes=-4 → 最后 4 个字节', async () => {
    const res = await http(media(at('a.png')), { headers: { Range: 'bytes=-4' } })
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes ${N - 4}-${N - 1}/${N}`)
    expect(res.headers['content-length']).toBe('4')
    expect(res.body.equals(PAYLOAD.subarray(N - 4))).toBe(true)
  })

  it('FR-R3 落在外 → 416（bytes */N、length 0、no-store、空正文）；多段 → 200 整个', async () => {
    const out = await http(media(at('a.png')), { headers: { Range: `bytes=${N}-` } })
    expect(out.status).toBe(416)
    expect(out.headers['content-range']).toBe(`bytes */${N}`)
    expect(out.headers['content-length']).toBe('0')
    expect(out.headers['cache-control']).toBe('no-store')
    expect(out.body.length).toBe(0)

    const multi = await http(media(at('a.png')), { headers: { Range: 'bytes=0-1,3-4' } })
    expect(multi.status).toBe(200)
    expect(multi.headers['content-range']).toBeUndefined()
    expect(multi.body.equals(PAYLOAD)).toBe(true)
  })

  it('FR-R3 HEAD：带 Range → 206 只有头；不带 → 200 只有头', async () => {
    const ranged = await http(media(at('a.png')), {
      method: 'HEAD',
      headers: { Range: 'bytes=2-5' }
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-range']).toBe(`bytes 2-5/${N}`)
    expect(ranged.headers['content-length']).toBe('4')
    expect(ranged.body.length).toBe(0)

    const plain = await http(media(at('a.png')), { method: 'HEAD' })
    expect(plain.status).toBe(200)
    expect(plain.headers['content-length']).toBe(String(N))
    expect(plain.headers['content-type']).toBe('image/png')
    expect(plain.body.length).toBe(0)
  })

  it('FR-R4 空文件 → 200 length 0（应答结束、不挂住）；bytes=0- → 416 bytes */0', async () => {
    const res = await http(media(at('empty.bin')))
    expect(res.status).toBe(200)
    expect(res.headers['content-length']).toBe('0')
    expect(res.body.length).toBe(0)

    const ranged = await http(media(at('empty.bin')), { headers: { Range: 'bytes=0-' } })
    expect(ranged.status).toBe(416)
    expect(ranged.headers['content-range']).toBe('bytes */0')
  })
})

describe('FR-R5 / FR-R6 坏请求与读不到', () => {
  beforeEach(async () => {
    await boot()
  })

  it('FR-R5 media / download：缺 path、空、相对、带 NUL → 400，解析器不调', async () => {
    for (const route of ['/files/media', '/files/download']) {
      for (const query of [
        '',
        '?path=',
        '?path=a.png',
        `?path=${encodeURIComponent('/x\0.png')}`
      ]) {
        const res = await http(`${route}${query}`)
        expectPlain(res, 400, 'Bad request.')
      }
    }
    expectNoDepCalled()
  })

  it('FR-R5 preview：缺 session、空 session、缺 path、带 NUL → 400，解析器不调', async () => {
    for (const query of [
      '?path=a.png',
      '?session=&path=a.png',
      '?session=s1',
      '?session=s1&path=',
      `?session=s1&path=${encodeURIComponent('a\0.png')}`
    ]) {
      const res = await http(`/files/preview${query}`)
      expectPlain(res, 400, 'Bad request.')
    }
    expectNoDepCalled()
  })

  it('FR-R6 文件不在 / 是目录 → 404 Not found.', async () => {
    expectPlain(await http(media(at('missing.png'))), 404, 'Not found.')
    expectPlain(await http(media(at('sub'))), 404, 'Not found.')
    expectPlain(await http(download(at('sub'))), 404, 'Not found.')
  })

  it('FR-R6 preview：解析器抛 / 解析出目录 / 解析出不在的文件 → 404', async () => {
    spies.resolvePreviewPath.mockImplementationOnce(() => {
      throw new Error('no such session')
    })
    expectPlain(await http(preview('s1', 'a.png')), 404, 'Not found.')
    spies.resolvePreviewPath.mockImplementationOnce(() => at('sub'))
    expectPlain(await http(preview('s1', 'sub')), 404, 'Not found.')
    spies.resolvePreviewPath.mockImplementationOnce(() => at('gone.png'))
    expectPlain(await http(preview('s1', 'gone.png')), 404, 'Not found.')
    expect(spies.resolvePreviewPath).toHaveBeenCalledTimes(3)
  })

  it.skipIf(!canRestrictReads)(
    'FR-R6 没有读权限 → 403 Forbidden.（先打开文件再写头）',
    async () => {
      writeFileSync(at('locked.png'), PAYLOAD)
      chmodSync(at('locked.png'), 0o000)
      expectPlain(await http(media(at('locked.png'))), 403, 'Forbidden.')
      expectPlain(await http(download(at('locked.png'))), 403, 'Forbidden.')
    }
  )
})

describe('FR-R7 / FR-R8 preview 与 download', () => {
  beforeEach(async () => {
    await boot()
  })

  it('FR-R7 解析器恰调一次（解码后的参数），按解析结果回文件', async () => {
    const res = await http('/files/preview?session=s%201&path=sub%2Fb.png')
    expect(res.status).toBe(200)
    expect(spies.resolvePreviewPath).toHaveBeenCalledTimes(1)
    expect(spies.resolvePreviewPath).toHaveBeenCalledWith('s 1', 'sub/b.png')
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.body.equals(PAYLOAD.subarray(0, 10))).toBe(true)
  })

  it('FR-R7 MIME 按解析出来的路径（原样的 x → …/x.webp → image/webp）；绝对路径也经解析器', async () => {
    spies.resolvePreviewPath.mockImplementationOnce(() => at('x.webp'))
    const res = await http(preview('s1', 'x'))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/webp')
    expect(spies.resolvePreviewPath).toHaveBeenLastCalledWith('s1', 'x')

    const abs = at('a.png')
    const absolute = await http(preview('s1', abs))
    expect(absolute.status).toBe(200)
    expect(spies.resolvePreviewPath).toHaveBeenLastCalledWith('s1', abs)
    expect(spies.resolvePreviewPath).toHaveBeenCalledTimes(2)
    expect(absolute.body.equals(PAYLOAD)).toBe(true)
  })

  it('FR-R8 download：octet-stream、no-store、attachment；Range 的 206 也带它', async () => {
    const disposition = `attachment; filename="demo widget.zip"; filename*=UTF-8''demo%20widget.zip`
    const res = await http(download(at('demo widget.zip')))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['content-disposition']).toBe(disposition)
    expect(res.body.equals(PAYLOAD)).toBe(true)

    const ranged = await http(download(at('demo widget.zip')), {
      headers: { Range: 'bytes=0-3' }
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-disposition']).toBe(disposition)
    expect(ranged.body.equals(PAYLOAD.subarray(0, 4))).toBe(true)
    expectNoDepCalled()
  })
})

describe('FR-R9 attachmentDisposition', () => {
  it('FR-R9 ASCII 名照原样', () => {
    expect(attachmentDisposition('a.zip')).toBe(
      `attachment; filename="a.zip"; filename*=UTF-8''a.zip`
    )
  })

  it('FR-R9 非 ASCII → 回落名用 _，filename* 是 UTF-8 百分号编码', () => {
    expect(attachmentDisposition('报告.zip')).toBe(
      `attachment; filename="__.zip"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.zip`
    )
  })

  it('FR-R9 引号与反斜杠 → 回落名用 _，filename* 编码成 %22 / %5C', () => {
    const value = attachmentDisposition('a"b\\c.zip')
    expect(value).toContain('filename="a_b_c.zip"')
    expect(value).toContain(`filename*=UTF-8''a%22b%5Cc.zip`)
  })

  it("FR-R9 ' ( ) * 在 filename* 里也编码（RFC 5987 的 attr-char 没有它们）", () => {
    const value = attachmentDisposition("it's (1)*.zip")
    expect(value).toContain(`filename*=UTF-8''it%27s%20%281%29%2A.zip`)
  })

  it('FR-R9 CR / LF 进不了头的值', () => {
    const value = attachmentDisposition('a\r\nb.zip')
    expect(value).not.toMatch(/[\r\n]/)
    expect(value).toContain('filename="a__b.zip"')
  })

  it('FR-R9 空名 → filename="download"', () => {
    expect(attachmentDisposition('')).toContain('filename="download"')
  })
})

describe('FR-R10 /lib/*（假读取）', () => {
  beforeEach(async () => {
    await boot()
  })

  it('FR-R10 /lib/chart.js → 读取收到 chart.js；200 与那几条头；HEAD 同样的头、空正文', async () => {
    const res = await http('/lib/chart.js')
    expect(res.status).toBe(200)
    expect(spies.readSandboxLib).toHaveBeenCalledWith('chart.js')
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(res.headers['content-length']).toBe(String(LIB_BODY.length))
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.body.equals(LIB_BODY)).toBe(true)

    const head = await http('/lib/chart.js', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(head.headers['content-length']).toBe(String(LIB_BODY.length))
    expect(head.body.length).toBe(0)
  })

  it('FR-R10 名字先解码、查询串不算：/lib/chart%2Ejs 与 /lib/chart.js?v=1 → chart.js', async () => {
    for (const path of ['/lib/chart%2Ejs', '/lib/chart.js?v=1']) {
      spies.readSandboxLib.mockClear()
      const res = await http(path)
      expect(res.status, path).toBe(200)
      expect(spies.readSandboxLib, path).toHaveBeenCalledTimes(1)
      expect(spies.readSandboxLib, path).toHaveBeenCalledWith('chart.js')
    }
  })

  it('FR-R10 读不到 → 404', async () => {
    expectPlain(await http('/lib/jquery.js'), 404, 'Not found.')
    expect(spies.readSandboxLib).toHaveBeenCalledWith('jquery.js')
  })

  it('FR-R10 名字里带 /（含编码的）→ 404，不读', async () => {
    for (const path of ['/lib/chart.js/x', '/lib/%2e%2e%2fweb.html', '/lib/a%2Fb']) {
      expectPlain(await http(path), 404, 'Not found.')
    }
    expect(spies.readSandboxLib).not.toHaveBeenCalled()
  })

  it('FR-R10 坏的百分号 → 400，不读', async () => {
    expectPlain(await http('/lib/%E0%A4%A'), 400, 'Bad request.')
    expect(spies.readSandboxLib).not.toHaveBeenCalled()
  })

  it('FR-R10 读取抛 → 500 Internal error. + 一条带 lib 的 warn', async () => {
    spies.readSandboxLib.mockRejectedValueOnce(new Error('EIO: disk on fire'))
    const res = await http('/lib/chart.js')
    expectPlain(res, 500, 'Internal error.')
    expect(spies.warn).toHaveBeenCalledTimes(1)
    expect(spies.warn.mock.calls[0][0]).toContain('lib')
  })
})

describe('FR-R11 /lib/*（真的 readSandboxLib）', () => {
  it('FR-R11 两份库的字节就是随包那份；白名单之外 → 404 且不碰磁盘', async () => {
    vi.resetModules()
    const { readSandboxLib } = await import('../../../services/fileServing')
    deps = { ...deps, readSandboxLib }
    await boot()

    for (const [name, file] of [
      ['chart.js', 'chart.umd.min.js'],
      ['d3.js', 'd3.min.js']
    ]) {
      const res = await http(`/lib/${name}`)
      expect(res.status, name).toBe(200)
      expect(res.body.equals(readFileSync(join(LIBS_DIR, file))), name).toBe(true)
    }

    fsState.readFile.mockClear()
    for (const name of [
      'chart.umd.min.js',
      'jquery.js',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'chart'
    ]) {
      expectPlain(await http(`/lib/${name}`), 404, 'Not found.')
    }
    expect(fsState.readFile).not.toHaveBeenCalled()
  })
})

describe('FR-R12 方法', () => {
  it('FR-R12 POST / PUT / PATCH / DELETE / OPTIONS → 405 + allow: GET, HEAD；依赖都不调', async () => {
    await boot()
    const routes = [
      media(at('a.png')),
      preview('s1', 'a.png'),
      download(at('a.png')),
      '/lib/chart.js'
    ]
    for (const route of routes) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const res = await http(route, { method })
        expect(res.status, `${method} ${route}`).toBe(405)
        expect(res.headers.allow, `${method} ${route}`).toBe('GET, HEAD')
        expect(res.body.toString(), `${method} ${route}`).toBe('Method not allowed.')
      }
    }
    expectNoDepCalled()
  })
})

describe('FR-R13 没有文件路由', () => {
  it('FR-R13 没给 fileRoutes → 落到静态文件 404，文件不出去', async () => {
    await boot({ fileRoutes: undefined })
    for (const path of [media(at('secret.txt')), '/lib/chart.js']) {
      const res = await http(path)
      expect(res.status, path).toBe(404)
      expect(res.body.toString(), path).toBe('Not found.')
      expect(res.body.toString(), path).not.toContain(SECRET)
    }
    expectNoDepCalled()
  })

  it('FR-R13 fileRoutes() 每个请求现取：先回 undefined（404），换成依赖之后 200', async () => {
    const routes: { current?: FileRouteDeps } = {}
    await boot({ fileRoutes: () => routes.current })
    const before = await http(media(at('secret.txt')))
    expect(before.status).toBe(404)
    expect(before.body.toString()).not.toContain(SECRET)
    expect((await http('/lib/chart.js')).status).toBe(404)

    routes.current = deps
    const after = await http(media(at('secret.txt')))
    expect(after.status).toBe(200)
    expect(after.body.toString()).toBe(SECRET)
    expect((await http('/lib/chart.js')).status).toBe(200)
  })
})

describe('FR-R14 Host 那道门', () => {
  it('FR-R14 坏 Host → 421 connection: close；依赖不调，秘密不出去', async () => {
    await boot()
    for (const path of [media(at('secret.txt')), '/lib/chart.js', preview('s1', 'secret.txt')]) {
      const res = await http(path, { headers: { Host: `evil.example:${port}` } })
      expect(res.status, path).toBe(421)
      expect(res.headers.connection, path).toBe('close')
      expect(res.body.toString(), path).not.toContain(SECRET)
    }
    expectNoDepCalled()
  })
})

describe('FR-R15 中途断开', () => {
  it('FR-R15 20 MB 的文件读到第一块就断开 → 下一个请求照样很快 200', async () => {
    await boot()
    writeFileSync(at('huge.bin'), Buffer.alloc(20 * 1024 * 1024, 7))
    await new Promise<void>((resolvePromise, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: media(at('huge.bin')), agent: false },
        (res) => {
          expect(res.statusCode).toBe(200)
          res.once('data', () => {
            req.destroy()
            resolvePromise()
          })
        }
      )
      req.on('error', (error) => {
        // 自己断开的那一下不算
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error)
      })
      req.end()
    })
    const started = Date.now()
    const next = await http(media(at('a.png')))
    expect(next.status).toBe(200)
    expect(next.body.equals(PAYLOAD)).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('FR-R16 能当文档跑脚本的类型', () => {
  it('FR-R16 SVG 带 Content-Security-Policy: sandbox（media / preview / download 都是）', async () => {
    await boot()
    for (const path of [media(at('pic.svg')), preview('s1', 'pic.svg'), download(at('pic.svg'))]) {
      const res = await http(path)
      expect(res.status, path).toBe(200)
      expect(res.headers['content-type'], path).toBe('image/svg+xml')
      expect(res.headers['content-security-policy'], path).toBe('sandbox')
    }
  })

  it('FR-R16 png / pdf / octet-stream 不带 CSP 头', async () => {
    await boot()
    for (const [file, type] of [
      ['a.png', 'image/png'],
      ['doc.pdf', 'application/pdf'],
      ['blob.bin', 'application/octet-stream']
    ]) {
      const res = await http(media(at(file)))
      expect(res.status, file).toBe(200)
      expect(res.headers['content-type'], file).toBe(type)
      expect(res.headers['content-security-policy'], file).toBeUndefined()
    }
  })
})

/**
 * `shuvix-lib://<name>`（services/customProtocols.ts）—— 交互图沙箱里 `<script src>` 能加载的库。
 *
 * 它**不是一个文件服务器**，只是两份随包静态文件的固定地址：名字（URL 的 host）查
 * chat-protocol 的 SANDBOX_LIBS 白名单，命中就回随包文件；路径、查询串、端口一概不看。钉的是：
 *
 *  - CP-1…3 回的是哪份字节、`../` 与查询串改变不了读的文件、白名单之外（含原型链上的名字、
 *    表里的**文件名**而非库名、空 host）一律 404 且不碰磁盘；
 *  - CP-4…6 只认 GET、URL 解析不了回 400、读失败回 500 且**不缓存失败**；
 *  - CP-7 / 8 登记时**没有 bypassCSP** —— 放行写在策略里（渲染页 CSP 的 script-src 显式列了
 *    `shuvix-lib:`），而不是协议一句话绕过。页面 CSP 也不许出现 'unsafe-eval'。
 *
 * electron 整个换成假件（protocol 两个登记口是间谍）；libs 目录指向仓库里真实的
 * `apps/desktop/resources/sandbox-libs`（paths.ts 的未打包分支在 vitest 下落点不对，所以顶掉
 * getSandboxLibsDir，理由同 builtinAgentsDir.test.ts）；`fs/promises` 的 readFile 包一层间谍，
 * 默认走真实实现 —— 读了哪个路径、读没读都看得见。
 *
 * 读过的文件缓存在模块级 Map 里：每条用例 resetModules 后重新 import 一份（与 gate.test.ts 同策），
 * 否则「第一次读失败、第二次成功」这类用例会被前面用例的缓存吃掉。
 *
 * 注意 Node 的 URL 不会像 Chromium 那样把 standard scheme 的 host 转小写 / 规范化，所以这里不钉
 * `shuvix-lib://Chart.js` 或 `shuvix-lib:chart.js` 的行为 —— 那只能在真 Chromium 里看。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `apps/desktop/src/main/services/__tests__` 往上六层 */
const REPO_ROOT = resolve(HERE, '../../../../../..')

const state = vi.hoisted(() => ({
  libsDir: '',
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
  warn: vi.fn(),
  readFile: vi.fn()
}))

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: state.registerSchemesAsPrivileged,
    handle: state.handle
  },
  net: { fetch: vi.fn() }
}))
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const readFile = (...args: unknown[]): unknown => state.readFile(...args)
  return { ...actual, default: { ...actual, readFile }, readFile }
})
vi.mock('../../utils/paths', () => ({ getSandboxLibsDir: () => state.libsDir }))
vi.mock('../toolContext', () => ({ resolveProjectConfig: vi.fn() }))
vi.mock('../../utils/toolUtils/pathUtils', () => ({ resolveReadPath: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info() {}, warn: state.warn, error() {}, debug() {} })
}))

type Protocols = typeof import('../customProtocols')

/** 重新导入被测模块（库文件缓存全新） */
async function load(): Promise<Protocols> {
  vi.resetModules()
  return await import('../customProtocols')
}

const LIBS_DIR = join(REPO_ROOT, 'apps/desktop/resources/sandbox-libs')
const bytesOf = (file: string): Buffer => readFileSync(join(LIBS_DIR, file))

/** 处理器只读 url 与 method：给一个最小的请求形状 */
const req = (url: string, method = 'GET'): never => ({ url, method }) as never

async function body(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer())
}

/** readFile 被调用时收到的路径 */
const readPaths = (): string[] => state.readFile.mock.calls.map(([path]) => String(path))

beforeEach(async () => {
  state.libsDir = LIBS_DIR
  state.registerSchemesAsPrivileged.mockReset()
  state.handle.mockReset()
  state.warn.mockReset()
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  state.readFile.mockReset()
  state.readFile.mockImplementation((...args: unknown[]) =>
    (actual.readFile as (...a: unknown[]) => Promise<Buffer>)(...args)
  )
})

describe('shuvix-lib：按名字白名单回随包文件（CP-1…3）', () => {
  it('CP-1 chart.js / d3.js → 200、text/javascript; charset=utf-8、字节就是随包那份', async () => {
    const { handleSandboxLibRequest } = await load()
    for (const [name, file] of [
      ['chart.js', 'chart.umd.min.js'],
      ['d3.js', 'd3.min.js']
    ]) {
      const res = await handleSandboxLibRequest(req(`shuvix-lib://${name}`))
      expect(res.status, name).toBe(200)
      expect(res.headers.get('Content-Type'), name).toBe('text/javascript; charset=utf-8')
      const got = await body(res)
      expect(got.length, name).toBeGreaterThan(1000)
      expect(got.equals(bytesOf(file)), `${name} 的字节与随包文件不一致`).toBe(true)
    }
  })

  it('CP-2 路径、查询串、端口一概不看：../ 穿越、?x#y、:80 都还是 chart.js 那份；读的路径从不出 libs 目录', async () => {
    const { handleSandboxLibRequest } = await load()
    const chart = bytesOf('chart.umd.min.js')
    for (const url of [
      'shuvix-lib://chart.js/../../etc/passwd',
      'shuvix-lib://chart.js/x?y=1#z',
      'shuvix-lib://chart.js:80/'
    ]) {
      const res = await handleSandboxLibRequest(req(url))
      expect(res.status, url).toBe(200)
      expect((await body(res)).equals(chart), url).toBe(true)
    }
    expect(readPaths().length).toBeGreaterThan(0)
    for (const path of readPaths()) {
      expect(path.startsWith(LIBS_DIR + sep), `读到了 libs 目录之外：${path}`).toBe(true)
    }
  })

  it('CP-3 白名单之外一律 404 且不碰磁盘：未知库、裸名、表里的文件名、原型链上的名字、空 host', async () => {
    const { handleSandboxLibRequest } = await load()
    for (const url of [
      'shuvix-lib://jquery.js',
      'shuvix-lib://chart',
      // 表里的是**库名** → 文件名的映射；文件名本身不是可请求的名字
      'shuvix-lib://chart.umd.min.js',
      'shuvix-lib://__proto__',
      'shuvix-lib://constructor',
      'shuvix-lib://toString',
      'shuvix-lib://hasOwnProperty',
      'shuvix-lib:///chart.js'
    ]) {
      const res = await handleSandboxLibRequest(req(url))
      expect(res.status, url).toBe(404)
    }
    expect(state.readFile).not.toHaveBeenCalled()
  })
})

describe('shuvix-lib：方法、坏地址、读失败（CP-4…6）', () => {
  it('CP-4 只认 GET：POST / HEAD 到 chart.js → 404，不读文件', async () => {
    const { handleSandboxLibRequest } = await load()
    for (const method of ['POST', 'HEAD']) {
      expect((await handleSandboxLibRequest(req('shuvix-lib://chart.js', method))).status).toBe(404)
    }
    expect(state.readFile).not.toHaveBeenCalled()
  })

  it('CP-5 URL 解析不了 → 400', async () => {
    const { handleSandboxLibRequest } = await load()
    const res = await handleSandboxLibRequest(req('shuvix-lib://['))
    expect(res.status).toBe(400)
    expect(state.readFile).not.toHaveBeenCalled()
  })

  it('CP-6 读失败 → 500 并记一条 warn；失败不缓存：文件回来了下一次就 200', async () => {
    const { handleSandboxLibRequest } = await load()
    state.readFile.mockRejectedValueOnce(new Error('ENOENT: gone for a moment'))
    const failed = await handleSandboxLibRequest(req('shuvix-lib://d3.js'))
    expect(failed.status).toBe(500)
    expect(state.warn).toHaveBeenCalledTimes(1)
    expect(String(state.warn.mock.calls[0][0])).toContain('ENOENT')

    const ok = await handleSandboxLibRequest(req('shuvix-lib://d3.js'))
    expect(ok.status).toBe(200)
    expect((await body(ok)).equals(bytesOf('d3.min.js'))).toBe(true)
    expect(state.readFile).toHaveBeenCalledTimes(2)
  })
})

describe('shuvix-lib：登记与页面 CSP（CP-7 / 8）', () => {
  it('CP-7 登记为 standard + secure，**没有** bypassCSP；handler 就是 handleSandboxLibRequest', async () => {
    const mod = await load()
    mod.registerCustomProtocolSchemes()
    expect(state.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    const entries = state.registerSchemesAsPrivileged.mock.calls[0][0] as Array<{
      scheme: string
    }>
    const lib = entries.filter((e) => e.scheme === 'shuvix-lib')
    expect(lib).toHaveLength(1)
    expect(lib[0]).toStrictEqual({
      scheme: 'shuvix-lib',
      privileges: { standard: true, secure: true }
    })

    mod.registerCustomProtocolHandlers()
    const installed = state.handle.mock.calls.filter(([scheme]) => scheme === 'shuvix-lib')
    expect(installed).toHaveLength(1)
    expect(installed[0][1]).toBe(mod.handleSandboxLibRequest)
  })

  it("CP-8 渲染页 index.html 的 CSP：script-src 显式列了 shuvix-lib:（bypassCSP 关着就靠它），哪条指令都没有 'unsafe-eval'", () => {
    const html = readFileSync(join(REPO_ROOT, 'apps/desktop/src/renderer/index.html'), 'utf8')
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1]
    expect(csp, 'index.html 里找不到 meta CSP').toBeTruthy()
    const directives = new Map(
      csp!
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [name, ...tokens] = part.split(/\s+/)
          return [name, tokens] as const
        })
    )
    expect(directives.get('script-src')).toContain('shuvix-lib:')
    for (const [name, tokens] of directives) {
      expect(tokens, name).not.toContain("'unsafe-eval'")
    }
  })
})

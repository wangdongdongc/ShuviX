/**
 * markdownWindowService —— 从系统打开的 md 窗口：一个文件一个窗口、一条内存会话，关窗即删会话。
 *
 * 契约：
 *   - 没初始化之前什么都不开（回 false）；
 *   - 是不是 md 两头都认（给的路径 **或** 它的真实路径），之后的一切 —— 去重键、标题、notebookPath、
 *     工作目录、hash 里的路径 —— 都按**真实路径**；不是 md / 不存在 / 是目录 → false，不开窗、不建会话；
 *   - 开窗：内存会话（标题与 notebookPath 都是文件名，工作目录是文件所在目录）、窗口先不显示、装守卫、
 *     前端 `markdown-window:<sid>` 单独绑到这条会话、页面 hash 带 sessionId 与真实路径；
 *     ready-to-show 才显示 + 聚焦；页面自己的 <title> 盖不掉文件名；macOS 才设代理图标；
 *   - 同一个文件（按真实路径）只开一个窗口，再开就把它带到前面（最小化的先还原）；
 *   - 关窗：从表里拿掉、解绑前端、删会话（只删一次），用户的文件与目录不动；删除失败只记日志；
 *   - 协作编辑：开窗把这个窗口的 webContents 挂到会话上（agent 的 doc_* 请求发给它）；关窗先解绑 ——
 *     还在等这个窗口答复的请求立刻失败，而且在删会话之前（停 Agent 时工具已经收场，不等超时）。
 *
 * electron 换成一个记账的假 BrowserWindow；sessionService / externalOpen 是间谍；前端注册表用**真的**
 * （只替掉 frontend/core 这个入口，免得把网关那一整张依赖图拉进来）并在上面挂 spy。文件是真的临时文件。
 * 模块级状态（窗口表、deps）每条用例都要新的：beforeEach 里 resetModules 后重新导入。
 *
 *   MW-1  没初始化 → false，不开窗、不建会话
 *   MW-2  非 md / 不存在 / 叫 x.md 的目录 → false，不开窗、不建会话
 *   MW-3  开窗的全部接线（create 的两个参数、窗口选项、守卫、前端绑定、loadFile 的 hash）
 *   MW-4  文件名 `a b#c&d%e 中.md` 经 hash 的 URLSearchParams 原样读回
 *   MW-5  开发态（is.dev + ELECTRON_RENDERER_URL）→ loadURL(url#hash)，不 loadFile
 *   MW-6  任何平台都不 setRepresentedFilename（标题栏的代理图标就是 ShuviX 的应用图标，不要它）
 *   MW-7  page-title-updated → preventDefault；ready-to-show → show + focus（之前不显示）
 *   MW-8  经符号链接 / dir/../a.md /（大小写不敏感的盘上）大小写变体再开 → 只建一次会话、仍一个窗口；
 *         最小化的窗口被还原、显示、聚焦；回 true
 *   MW-8b `notes.md` → `notes.txt` 的链接能开：标题 / notebookPath 是 notes.txt，hash 里是真实路径；
 *         反过来 `link.txt` → `real.md` 也能开；两头都不是 md → false
 *   MW-9  两个文件 → 两个窗口，第二个相对第一个再错开一格
 *   MW-10 closed → 表里拿掉（再开是新会话）、前端解绑、delete(sid) 恰一次；文件与目录都还在
 *   MW-11 （白盒）旧窗口迟到的 closed：同一路径的新窗口已登记 → 新的那条不被拿掉
 *   MW-12 （白盒）delete 失败 → 记一条 warn，不抛、不留未处理的 rejection
 *   W1    开窗把 webContents 挂上：会话的 doc 请求经这个窗口的 send 发出（别的会话不经它）
 *   W2    closed → 在途的 doc 请求以「closed」失败，先于删会话；之后的请求「No document window」
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const fx = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  interface Bounds {
    x: number
    y: number
    width: number
    height: number
  }

  class FakeWindow {
    static all: FakeWindow[] = []
    static focused: FakeWindow | null = null
    static getFocusedWindow(): FakeWindow | null {
      return FakeWindow.focused
    }

    readonly options: Record<string, unknown>
    private readonly listeners = new Map<string, Listener[]>()
    destroyed = false
    minimized = false
    bounds: Bounds = { x: 0, y: 0, width: 960, height: 820 }
    readonly on = vi.fn((event: string, fn: Listener) => {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
      return this
    })
    readonly once = vi.fn((event: string, fn: Listener) => {
      const wrapped: Listener = (...args) => {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter((l) => l !== wrapped)
        )
        fn(...args)
      }
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), wrapped])
      return this
    })
    readonly loadFile = vi.fn(async (_file: string, _opts?: { hash?: string }) => {})
    readonly loadURL = vi.fn(async (_url: string) => {})
    readonly setRepresentedFilename = vi.fn()
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn(() => {
      this.minimized = false
    })
    /** 协作编辑的去程经它发（liveDocumentBridge.attachLiveDocument 挂的就是它） */
    readonly webContents = {
      send: vi.fn(),
      isDestroyed: (): boolean => this.destroyed
    }

    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeWindow.all.push(this)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }
    isMinimized(): boolean {
      return this.minimized
    }
    getBounds(): Bounds {
      return { ...this.bounds }
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args)
    }
  }

  return {
    FakeWindow,
    isDev: false,
    create: vi.fn(),
    delete: vi.fn<(id: string) => Promise<void>>(),
    guardAppWindow: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    /** 关窗时各步的先后（W2：解绑协作编辑 → 删会话） */
    order: [] as string[]
  }
})

vi.mock('electron', () => ({ BrowserWindow: fx.FakeWindow }))
vi.mock('@electron-toolkit/utils', () => ({
  is: {
    get dev() {
      return fx.isDev
    }
  }
}))
// 真的注册表：只替掉 frontend/core 这个入口（它的 index 还会把整条网关依赖图拉进来）
vi.mock('../../frontend/core', async () => ({
  chatFrontendRegistry: (await import('../../frontend/core/ChatFrontendRegistry'))
    .chatFrontendRegistry
}))
vi.mock('../sessionService', () => ({
  sessionService: { create: fx.create, delete: fx.delete }
}))
vi.mock('../externalOpen', () => ({ guardAppWindow: fx.guardAppWindow }))
// 桥是真的，只在 detach 上记一笔先后（W2）
vi.mock('../liveDocumentBridge', async (importOriginal) => {
  const real = await importOriginal<typeof import('../liveDocumentBridge')>()
  return {
    ...real,
    detachLiveDocument: (sessionId: string) => {
      fx.order.push(`detach:${sessionId}`)
      real.detachLiveDocument(sessionId)
    }
  }
})
vi.mock('../../logger', () => ({ createLogger: () => fx.log }))

type FakeWindow = InstanceType<typeof fx.FakeWindow>
type Service = typeof import('../markdownWindowService')
type Bridge = typeof import('../liveDocumentBridge')
type Registry = (typeof import('../../frontend/core/ChatFrontendRegistry'))['chatFrontendRegistry']

interface FakeFrontend {
  id: string
  window: unknown
}

/** 真实临时目录（realpath 过）与一份「未解开」的写法：macOS 的 tmpdir 在 /var → /private/var 链接下 */
let realRoot: string
let rawRoot: string
const REAL_PLATFORM = process.platform

beforeAll(() => {
  rawRoot = mkdtempSync(join(tmpdir(), 'shuvix-mdwin-'))
  realRoot = realpathSync.native(rawRoot)
  mkdirSync(join(realRoot, 'dir'))
  mkdirSync(join(realRoot, 'x.md'))
  writeFileSync(join(realRoot, 'dir', 'a.md'), '# a\n')
  writeFileSync(join(realRoot, 'dir', 'b.md'), '# b\n')
  writeFileSync(join(realRoot, 'dir', 'notes.txt'), 'plain text\n')
  writeFileSync(join(realRoot, 'dir', 'real.md'), '# real\n')
  writeFileSync(join(realRoot, 'dir', 'a b#c&d%e 中.md'), '# odd\n')
  symlinkSync(join(realRoot, 'dir', 'a.md'), join(realRoot, 'link-a.md'))
  symlinkSync(join(realRoot, 'dir', 'notes.txt'), join(realRoot, 'notes.md'))
  symlinkSync(join(realRoot, 'dir', 'real.md'), join(realRoot, 'link.txt'))
})

afterAll(() => {
  rmSync(realRoot, { recursive: true, force: true })
})

let sidSeq = 0
let service: Service
let bridge: Bridge
let registry: Registry
let frontends: FakeFrontend[]

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  fx.FakeWindow.all = []
  fx.FakeWindow.focused = null
  fx.isDev = false
  fx.order.length = 0
  frontends = []
  fx.create.mockImplementation(() => ({ id: `sid-${++sidSeq}` }))
  fx.delete.mockResolvedValue(undefined)
  service = await import('../markdownWindowService')
  // 与 markdownWindowService 同一份模块实例（resetModules 之后才导入）
  bridge = await import('../liveDocumentBridge')
  registry = (await import('../../frontend/core')).chatFrontendRegistry as Registry
  vi.spyOn(registry, 'bind')
  vi.spyOn(registry, 'unbind')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** 按 index.ts 的方式装配（前端工厂给一个记账的假前端） */
function init(): void {
  service.initMarkdownWindowService({
    getThemeBgColor: () => '#101010',
    getZoomFactor: () => 1.25,
    createFrontend: (window, id) => {
      const frontend = { id, window } as FakeFrontend
      frontends.push(frontend)
      return frontend as never
    }
  })
}

function windows(): FakeWindow[] {
  return fx.FakeWindow.all
}

function onlyWindow(): FakeWindow {
  expect(windows()).toHaveLength(1)
  return windows()[0]
}

/** loadFile 的 hash（没 loadFile 过则抛） */
function hashOf(win: FakeWindow): string {
  expect(win.loadFile).toHaveBeenCalledTimes(1)
  const hash = win.loadFile.mock.calls[0][1]?.hash
  if (typeof hash !== 'string') throw new Error('loadFile without a hash')
  return hash
}

/** hash 的查询串按渲染端（MarkdownWindowShell.parseHash）同样的方式解开 */
function hashParams(hash: string): {
  route: string
  sessionId: string | null
  path: string | null
} {
  const q = hash.indexOf('?')
  const params = new URLSearchParams(hash.slice(q + 1))
  return { route: hash.slice(0, q), sessionId: params.get('sessionId'), path: params.get('path') }
}

function stubPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

/** 这个临时盘大小写不敏感吗（macOS 缺省 APFS 是） */
function caseInsensitiveFs(): boolean {
  return existsSync(join(realRoot, 'DIR', 'A.MD'))
}

describe('MW-1 / MW-2 不开窗', () => {
  it('MW-1 没初始化 → false，不开窗、不建会话', () => {
    expect(service.openMarkdownFile(join(realRoot, 'dir', 'a.md'))).toBe(false)
    expect(windows()).toHaveLength(0)
    expect(fx.create).not.toHaveBeenCalled()
    expect(registry.bind).not.toHaveBeenCalled()
  })

  it.each([
    ['非 md 文件', 'dir/notes.txt'],
    ['不存在的 md', 'dir/missing.md'],
    ['叫 x.md 的目录', 'x.md']
  ])('MW-2 %s → false，不开窗、不建会话', (_label, rel) => {
    init()
    expect(service.openMarkdownFile(join(realRoot, rel))).toBe(false)
    expect(windows()).toHaveLength(0)
    expect(fx.create).not.toHaveBeenCalled()
    expect(fx.guardAppWindow).not.toHaveBeenCalled()
    expect(registry.bind).not.toHaveBeenCalled()
  })
})

describe('MW-3 ~ MW-7 开窗', () => {
  it('MW-3 内存会话 + 窗口选项 + 守卫 + 前端绑定 + hash（全按真实路径）', () => {
    init()
    // 经未解开的 tmpdir 写法打开：之后的一切都该是 realpath
    const given = join(rawRoot, 'dir', 'a.md')
    const real = join(realRoot, 'dir', 'a.md')
    expect(service.openMarkdownFile(given)).toBe(true)

    expect(fx.create.mock.calls).toEqual([
      [
        { title: 'a.md', notebookPath: 'a.md' },
        { ephemeral: true, workingDirectory: dirname(real), coEdit: true }
      ]
    ])
    const sid = fx.create.mock.results[0].value.id as string

    const win = onlyWindow()
    // 宽度 = 800 CSS 像素 × UI 缩放（1.25）
    expect(win.options).toMatchObject({
      title: 'a.md',
      show: false,
      backgroundColor: '#101010',
      width: 1000
    })
    expect(win.show).not.toHaveBeenCalled()
    expect(fx.guardAppWindow.mock.calls).toEqual([[win]])

    expect(frontends).toHaveLength(1)
    expect(frontends[0]).toMatchObject({ id: `markdown-window:${sid}`, window: win })
    expect(registry.bind).toHaveBeenCalledTimes(1)
    expect(registry.bind).toHaveBeenCalledWith(sid, frontends[0])
    expect(registry.getFrontends(sid)).toContain(frontends[0])

    expect(win.loadURL).not.toHaveBeenCalled()
    expect(win.loadFile.mock.calls[0][0]).toMatch(/renderer[\\/]index\.html$/)
    const params = hashParams(hashOf(win))
    expect(params).toEqual({ route: 'markdown-window', sessionId: sid, path: real })
  })

  it('MW-4 怪文件名经 hash 原样读回（空格 / # / & / % / 中文）', () => {
    init()
    const real = join(realRoot, 'dir', 'a b#c&d%e 中.md')
    expect(service.openMarkdownFile(real)).toBe(true)
    const win = onlyWindow()
    expect(win.options.title).toBe('a b#c&d%e 中.md')
    expect(fx.create.mock.calls[0][0]).toEqual({
      title: 'a b#c&d%e 中.md',
      notebookPath: 'a b#c&d%e 中.md'
    })
    const hash = hashOf(win)
    // hash 自己只能有一个 #（URL 的片段起点在 hash 之外）；查询串里不许有裸的 & / # 把参数劈开
    expect(hash).not.toContain('#')
    expect(hashParams(hash).path).toBe(real)
  })

  it('MW-5 开发态 → loadURL(ELECTRON_RENDERER_URL#hash)，不 loadFile', () => {
    fx.isDev = true
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    init()
    expect(service.openMarkdownFile(join(realRoot, 'dir', 'a.md'))).toBe(true)
    const win = onlyWindow()
    expect(win.loadFile).not.toHaveBeenCalled()
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    const url = win.loadURL.mock.calls[0][0]
    expect(url.startsWith('http://localhost:5173#markdown-window?')).toBe(true)
    const params = hashParams(url.slice(url.indexOf('#') + 1))
    expect(params.path).toBe(join(realRoot, 'dir', 'a.md'))
    expect(params.sessionId).toBe(fx.create.mock.results[0].value.id)
  })

  it('MW-5 对照：ELECTRON_RENDERER_URL 有值但不是开发态 → 仍 loadFile', () => {
    fx.isDev = false
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    init()
    service.openMarkdownFile(join(realRoot, 'dir', 'a.md'))
    const win = onlyWindow()
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(win.loadFile).toHaveBeenCalledTimes(1)
  })

  it.each(['darwin', 'linux', 'win32'])('MW-6 %s：不 setRepresentedFilename', (platform) => {
    stubPlatform(platform)
    init()
    service.openMarkdownFile(join(rawRoot, 'dir', 'a.md'))
    expect(onlyWindow().setRepresentedFilename).not.toHaveBeenCalled()
  })

  it('MW-7 page-title-updated → preventDefault；ready-to-show → show + focus', () => {
    init()
    service.openMarkdownFile(join(realRoot, 'dir', 'a.md'))
    const win = onlyWindow()

    const event = { preventDefault: vi.fn() }
    win.emit('page-title-updated', event, 'Page <title>')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)

    expect(win.show).not.toHaveBeenCalled()
    win.emit('ready-to-show')
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
    // once：第二次 ready-to-show（不该有，有也不重复弹）
    win.emit('ready-to-show')
    expect(win.show).toHaveBeenCalledTimes(1)
  })
})

describe('MW-8 / MW-8b / MW-9 同一个文件 / 链接 / 多个文件', () => {
  it('MW-8 链接、dir/../ 与大小写变体都落到同一个窗口；最小化的被还原、显示、聚焦', () => {
    init()
    const real = join(realRoot, 'dir', 'a.md')
    expect(service.openMarkdownFile(real)).toBe(true)
    const win = onlyWindow()
    win.emit('ready-to-show')
    win.show.mockClear()
    win.focus.mockClear()

    const spellings = [
      join(realRoot, 'link-a.md'),
      join(realRoot, 'dir', '..', 'dir', 'a.md'),
      join(rawRoot, 'dir', 'a.md')
    ]
    if (caseInsensitiveFs()) spellings.push(join(realRoot, 'DIR', 'A.MD'))

    for (const spelling of spellings) {
      win.minimized = true
      win.restore.mockClear()
      win.show.mockClear()
      win.focus.mockClear()
      expect(service.openMarkdownFile(spelling)).toBe(true)
      expect(win.restore).toHaveBeenCalledTimes(1)
      expect(win.show).toHaveBeenCalledTimes(1)
      expect(win.focus).toHaveBeenCalledTimes(1)
      expect(win.minimized).toBe(false)
    }

    // 没最小化的：不 restore，照样带到前面
    win.restore.mockClear()
    expect(service.openMarkdownFile(join(realRoot, 'link-a.md'))).toBe(true)
    expect(win.restore).not.toHaveBeenCalled()

    expect(fx.create).toHaveBeenCalledTimes(1)
    expect(windows()).toHaveLength(1)
    expect(registry.bind).toHaveBeenCalledTimes(1)
  })

  it('MW-8b notes.md → notes.txt 的链接能开：标题 / notebookPath 是 notes.txt，hash 里是真实路径', () => {
    init()
    expect(service.openMarkdownFile(join(realRoot, 'notes.md'))).toBe(true)
    const real = join(realRoot, 'dir', 'notes.txt')
    expect(fx.create.mock.calls).toEqual([
      [
        { title: 'notes.txt', notebookPath: 'notes.txt' },
        { ephemeral: true, workingDirectory: dirname(real), coEdit: true }
      ]
    ])
    const win = onlyWindow()
    expect(win.options.title).toBe('notes.txt')
    expect(hashParams(hashOf(win)).path).toBe(real)
  })

  it('MW-8b 反过来 link.txt → real.md 也能开；两头都不是 md → false', () => {
    init()
    expect(service.openMarkdownFile(join(realRoot, 'link.txt'))).toBe(true)
    expect(fx.create.mock.calls[0][0]).toEqual({ title: 'real.md', notebookPath: 'real.md' })

    expect(service.openMarkdownFile(join(realRoot, 'dir', 'notes.txt'))).toBe(false)
    expect(fx.create).toHaveBeenCalledTimes(1)
    expect(windows()).toHaveLength(1)
  })

  it('MW-9 两个文件 → 两个窗口、两条会话；相对有焦点的窗口逐个错开一格', () => {
    init()
    const anchor = new fx.FakeWindow({})
    anchor.bounds = { x: 100, y: 200, width: 800, height: 600 }
    fx.FakeWindow.focused = anchor

    expect(service.openMarkdownFile(join(realRoot, 'dir', 'a.md'))).toBe(true)
    expect(service.openMarkdownFile(join(realRoot, 'dir', 'b.md'))).toBe(true)
    const [, first, second] = windows()
    expect(fx.create).toHaveBeenCalledTimes(2)
    const sids = fx.create.mock.results.map((r) => r.value.id)
    expect(new Set(sids).size).toBe(2)
    expect(first.options).toMatchObject({ title: 'a.md', x: 124, y: 224 })
    expect(second.options).toMatchObject({ title: 'b.md', x: 148, y: 248 })
    expect(hashParams(hashOf(second)).path).toBe(join(realRoot, 'dir', 'b.md'))
  })

  it('MW-9 没有有焦点的窗口 → 不给坐标（交给系统摆）', () => {
    init()
    service.openMarkdownFile(join(realRoot, 'dir', 'a.md'))
    service.openMarkdownFile(join(realRoot, 'dir', 'b.md'))
    for (const win of windows()) {
      expect(win.options).not.toHaveProperty('x')
      expect(win.options).not.toHaveProperty('y')
    }
  })
})

describe('MW-10 ~ MW-12 关窗', () => {
  it('MW-10 closed → 拿掉、解绑、delete 恰一次；文件与目录都还在；再开是新会话', async () => {
    init()
    const real = join(realRoot, 'dir', 'a.md')
    const before = readFileSync(real, 'utf8')
    service.openMarkdownFile(real)
    const win = onlyWindow()
    const sid = fx.create.mock.results[0].value.id as string
    const frontend = frontends[0]

    win.destroyed = true
    win.emit('closed')
    await flush()

    expect(registry.unbind).toHaveBeenCalledWith(sid, frontend.id)
    expect(registry.getFrontends(sid)).not.toContain(frontend)
    expect(fx.delete.mock.calls).toEqual([[sid]])
    expect(fx.log.info.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining(`内存会话已删除 session=${sid}`)
    )
    expect(existsSync(real)).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe(before)
    expect(existsSync(dirname(real))).toBe(true)

    expect(service.openMarkdownFile(real)).toBe(true)
    expect(fx.create).toHaveBeenCalledTimes(2)
    const sid2 = fx.create.mock.results[1].value.id as string
    expect(sid2).not.toBe(sid)
    expect(windows()).toHaveLength(2)
    expect(hashParams(hashOf(windows()[1])).sessionId).toBe(sid2)
    // 新窗口的 closed 删的是新会话，旧会话不再被删第二次
    windows()[1].emit('closed')
    await flush()
    expect(fx.delete.mock.calls).toEqual([[sid], [sid2]])
  })

  it('MW-11 （白盒）旧窗口迟到的 closed 不拿掉同一路径已登记的新窗口', async () => {
    init()
    const real = join(realRoot, 'dir', 'a.md')
    service.openMarkdownFile(real)
    const old = onlyWindow()
    const oldSid = fx.create.mock.results[0].value.id as string

    // 旧窗口已销毁、closed 还没到：再开同一个文件 → 新窗口登记在同一个键上
    old.destroyed = true
    expect(service.openMarkdownFile(real)).toBe(true)
    expect(windows()).toHaveLength(2)
    const fresh = windows()[1]
    const freshSid = fx.create.mock.results[1].value.id as string

    old.emit('closed')
    await flush()
    expect(fx.delete.mock.calls).toEqual([[oldSid]])

    // 新窗口还在表里：再开 = 聚焦它，不建第三条会话
    fresh.focus.mockClear()
    expect(service.openMarkdownFile(real)).toBe(true)
    expect(fx.create).toHaveBeenCalledTimes(2)
    expect(fresh.focus).toHaveBeenCalledTimes(1)
    expect(registry.getFrontends(freshSid).map((f) => f.id)).toContain(
      `markdown-window:${freshSid}`
    )
  })

  it('MW-12 （白盒）delete 失败 → 记 warn，不抛', async () => {
    init()
    fx.delete.mockRejectedValueOnce(new Error('boom'))
    service.openMarkdownFile(join(realRoot, 'dir', 'a.md'))
    const win = onlyWindow()
    const sid = fx.create.mock.results[0].value.id as string

    expect(() => win.emit('closed')).not.toThrow()
    await flush()
    await flush()
    const warns = fx.log.warn.mock.calls.map((c) => String(c[0]))
    expect(warns).toContainEqual(expect.stringContaining(`session=${sid}`))
    expect(warns.some((w) => w.includes('boom'))).toBe(true)
    // 删除失败也不再记「已删除」
    expect(fx.log.info.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining('内存会话已删除')
    )
  })
})

describe('W1 / W2 协作编辑的窗口绑定', () => {
  /** 这个窗口收到的 liveDoc:request */
  const requestsOf = (win: FakeWindow): Array<{ requestId: string; sessionId: string }> =>
    win.webContents.send.mock.calls
      .filter((c) => c[0] === 'liveDoc:request')
      .map((c) => c[1] as { requestId: string; sessionId: string })

  it('W1 开窗把 webContents 挂到会话上：doc 请求经这个窗口发出，别的会话不经它', async () => {
    init()
    service.openMarkdownFile(join(realRoot, 'dir', 'a.md'))
    service.openMarkdownFile(join(realRoot, 'dir', 'b.md'))
    const [aWin, bWin] = windows()
    const [aSid, bSid] = fx.create.mock.results.map((r) => r.value.id as string)

    const pending = bridge.requestLiveDocument(aSid, { kind: 'read' })
    await flush()
    expect(requestsOf(aWin)).toEqual([
      { requestId: expect.any(String), sessionId: aSid, op: { kind: 'read' } }
    ])
    expect(requestsOf(bWin)).toEqual([])

    // 这个窗口作答 → 了结
    const result = {
      ok: true as const,
      kind: 'read' as const,
      text: '# a\n',
      user: { cursorLine: 1, visibleFromLine: 1, visibleToLine: 2, lastEditAgoMs: null }
    }
    bridge.resolveLiveDocumentResponse(
      aWin.webContents as never,
      requestsOf(aWin)[0].requestId,
      result
    )
    await expect(pending).resolves.toEqual(result)

    // b 的请求经 b 的窗口
    const other = bridge.requestLiveDocument(bSid, { kind: 'read' })
    await flush()
    expect(requestsOf(bWin)).toHaveLength(1)
    expect(requestsOf(aWin)).toHaveLength(1)
    bridge.detachLiveDocument(bSid)
    await expect(other).rejects.toThrow()
  })

  it('W2 closed → 在途请求以 closed 失败，先于删会话；之后的请求没有窗口可发', async () => {
    init()
    service.openMarkdownFile(join(realRoot, 'dir', 'a.md'))
    const win = onlyWindow()
    const sid = fx.create.mock.results[0].value.id as string

    // 删会话要等 Agent 停下来 —— 这里干脆永不了结：在途的请求也不能等它
    fx.delete.mockImplementation(() => {
      fx.order.push(`delete:${sid}`)
      return new Promise<void>(() => {})
    })
    const inFlight = bridge.requestLiveDocument(sid, {
      kind: 'edit',
      toolCallId: 'tc',
      find: 'a',
      replace: 'b'
    })
    await flush()
    expect(requestsOf(win)).toHaveLength(1)

    win.destroyed = true
    win.emit('closed')
    await expect(inFlight).rejects.toThrow('The document window was closed.')
    expect(fx.order).toEqual([`detach:${sid}`, `delete:${sid}`])
    // 关窗不往已销毁的窗口发撤回
    expect(win.webContents.send.mock.calls.filter((c) => c[0] === 'liveDoc:cancel')).toEqual([])

    await expect(bridge.requestLiveDocument(sid, { kind: 'read' })).rejects.toThrow(
      'No document window is open for this session.'
    )
    expect(requestsOf(win)).toHaveLength(1)
  })
})

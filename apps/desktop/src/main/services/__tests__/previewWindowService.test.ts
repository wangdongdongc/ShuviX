/**
 * previewWindowService —— 应用里「点开一个文件」：md 进协作编辑窗口，其余能预览的进只读预览窗口，
 * 不能预览的不响应。
 *
 * 契约：
 *   - md（给的路径**或**它的真实路径是 .md / .markdown，大小写不敏感）→ 交给 openMarkdownFile（参数是解析后的
 *     绝对路径），它的返回值原样回；这一条不需要本服务初始化；
 *   - 其余文件要先初始化，否则回 false、不开窗；
 *   - 相对路径按会话的工作目录解；会话没了（或没有工作目录）又给相对路径 → false；绝对路径照开；
 *   - 同一个文件（按真实路径）只开一个窗口：已开着就还原（最小化时）/ 显示 / 聚焦、回 true —— 这一步在分类
 *     **之前**，所以文件此刻读不了也照样把那扇窗带到前面；
 *   - 否则由 classifyPreviewFile 决定：可预览 → 新窗口（宽 round(900 × zoom)、先不显示、装守卫、hash 是
 *     `file-preview?sessionId&path=<真实路径>&openedBy`，ready-to-show 才显示 + 聚焦、页面 <title> 盖不掉文件名），
 *     不可预览（二进制 / 超限 / 目录 / 不存在）→ false、不开窗；
 *   - 新窗口相对聚焦窗口错开 24 × (已开窗口数 + 1)；没有聚焦窗口就不指定位置；
 *   - closed → 从表里拿掉；旧窗口迟到的 closed 不拿掉同一路径的新窗口。
 *
 * electron 换成记账的假 BrowserWindow；sessionService / externalOpen / markdownWindowService 是间谍；
 * 分类内核与文件都是真的（临时目录）。模块级状态每条用例重新导入。
 *
 *   W-1  没初始化 → 非 md 回 false、不开窗；md 照样交给 openMarkdownFile
 *   W-2  md 路由：大写扩展名、相对路径、不存在的 .md、false 原样回、`link.txt → real.md` 的链接
 *   W-3  每种可预览的文件都开窗（窗口选项、守卫、hash、ready-to-show、page-title-updated）
 *   W-4  不可预览（.zip、带 NUL 的无扩展名文件、超 2MB 的 txt、超 10MB 的 png、目录、不存在的 txt）→ false
 *   W-5  会话已删：相对路径 → false，绝对路径 → true
 *   W-6  一个真实路径一个窗口（直接 / 符号链接 / dir/../）；最小化的被还原、显示、聚焦
 *   W-7  closed 拿掉表项；旧窗口迟到的 closed 不拿掉新窗口
 *   W-8  openedBy=agent 原样进 hash
 *   W-9  错开：每个已开窗口 +24，锚在聚焦窗口；没有聚焦窗口不给 x/y
 *   W-10 已开窗口的文件之后被删了：再开仍聚焦那扇窗、回 true（查表先于分类）
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn(() => {
      this.minimized = false
    })
    readonly webContents = {
      send: vi.fn(),
      isDestroyed: (): boolean => this.destroyed,
      on: vi.fn()
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
    getById: vi.fn<(id: string) => { workingDirectory?: string } | undefined>(),
    openMarkdownFile: vi.fn<(path: string) => boolean>(() => true),
    guardAppWindow: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }
})

vi.mock('electron', () => ({ BrowserWindow: fx.FakeWindow }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../sessionService', () => ({ sessionService: { getById: fx.getById } }))
vi.mock('../markdownWindowService', () => ({ openMarkdownFile: fx.openMarkdownFile }))
vi.mock('../externalOpen', () => ({ guardAppWindow: fx.guardAppWindow }))
vi.mock('../../logger', () => ({ createLogger: () => fx.log }))

type FakeWindow = InstanceType<typeof fx.FakeWindow>
type Service = typeof import('../previewWindowService')

const LIVE = 'sid-live'
const GONE = 'sid-gone'
const ZOOM = 1.15

/** 最小 PNG 头（签名 + IHDR）—— 分类只看扩展名与大小，够了 */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

// 收集期就要用到路径（it.each 的参数表），所以目录在模块加载时建好；文件在 beforeAll 里铺
const rawRoot = mkdtempSync(join(tmpdir(), 'shuvix-prevwin-'))
const realRoot = realpathSync.native(rawRoot)
const p = (...rel: string[]): string => join(realRoot, ...rel)

beforeAll(() => {
  mkdirSync(p('dir'))
  mkdirSync(p('sub'))
  writeFileSync(p('dir', 'a.txt'), 'hello preview\n')
  writeFileSync(p('dir', 'code.ts'), 'export const x = 1\n')
  writeFileSync(p('dir', 'pic.png'), pngHeader(40, 24))
  writeFileSync(p('dir', 'fig.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(p('dir', 'doc.pdf'), '%PDF-1.4\n')
  writeFileSync(p('dir', 'clip.mp4'), Buffer.from([0, 0, 0, 0x18]))
  writeFileSync(p('dir', 'song.mp3'), Buffer.from([0x49, 0x44, 0x33, 0]))
  writeFileSync(p('dir', 'book.epub'), Buffer.from([0x50, 0x4b, 3, 4]))
  writeFileSync(p('dir', 'sheet.xlsx'), Buffer.from([0x50, 0x4b, 3, 4]))
  writeFileSync(p('dir', 'doc.md'), '# doc\n')
  writeFileSync(p('dir', 'real.md'), '# real\n')
  writeFileSync(p('dir', 'arch.zip'), Buffer.from([0x50, 0x4b, 3, 4]))
  writeFileSync(p('dir', 'noext'), Buffer.from([0x41, 0x00, 0x42]))
  // 可打印字节（稀疏文件全是 0，会先被嗅探判成二进制），比上限多一个字节
  writeFileSync(p('dir', 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
  // png 不嗅探，只看大小：稀疏文件就够
  writeFileSync(p('dir', 'huge.png'), '')
  truncateSync(p('dir', 'huge.png'), 10 * 1024 * 1024 + 1)
  symlinkSync(p('dir', 'a.txt'), p('link-a.txt'))
  symlinkSync(p('dir', 'real.md'), p('link.txt'))
})

afterAll(() => {
  rmSync(realRoot, { recursive: true, force: true })
})

let service: Service

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  fx.FakeWindow.all = []
  fx.FakeWindow.focused = null
  fx.getById.mockImplementation((id) => (id === LIVE ? { workingDirectory: realRoot } : undefined))
  fx.openMarkdownFile.mockReturnValue(true)
  service = await import('../previewWindowService')
})

afterEach(() => {
  vi.restoreAllMocks()
})

function init(): void {
  service.initPreviewWindowService({ getThemeBgColor: () => '#101010', getZoomFactor: () => ZOOM })
}

function windows(): FakeWindow[] {
  return fx.FakeWindow.all
}

function onlyWindow(): FakeWindow {
  expect(windows()).toHaveLength(1)
  return windows()[0]
}

/** loadFile 的 hash，按渲染端同样的方式解开 */
function hashOf(win: FakeWindow): {
  route: string
  sessionId: string | null
  path: string | null
  openedBy: string | null
} {
  expect(win.loadFile).toHaveBeenCalledTimes(1)
  const hash = win.loadFile.mock.calls[0][1]?.hash
  if (typeof hash !== 'string') throw new Error('loadFile without a hash')
  const q = hash.indexOf('?')
  const params = new URLSearchParams(hash.slice(q + 1))
  return {
    route: hash.slice(0, q),
    sessionId: params.get('sessionId'),
    path: params.get('path'),
    openedBy: params.get('openedBy')
  }
}

const open = (
  path: string,
  extra: { sessionId?: string; openedBy?: 'agent' | 'user' } = {}
): Promise<boolean> =>
  service.openFileInWindow({ sessionId: extra.sessionId ?? LIVE, path, openedBy: extra.openedBy })

describe('W-1 未初始化', () => {
  it('非 md → false、不开窗；md 照样交给 openMarkdownFile', async () => {
    expect(await open(p('dir', 'a.txt'))).toBe(false)
    expect(windows()).toHaveLength(0)
    expect(fx.guardAppWindow).not.toHaveBeenCalled()

    expect(await open(p('dir', 'doc.md'))).toBe(true)
    expect(fx.openMarkdownFile.mock.calls).toEqual([[p('dir', 'doc.md')]])
    expect(windows()).toHaveLength(0)
  })
})

describe('W-2 md 路由', () => {
  it.each([
    ['绝对路径', p('dir', 'doc.md'), p('dir', 'doc.md')],
    ['相对路径（按会话工作目录）', 'dir/doc.md', p('dir', 'doc.md')],
    ['大写扩展名', p('dir', 'NOTES.MD'), p('dir', 'NOTES.MD')],
    ['.markdown', p('dir', 'x.markdown'), p('dir', 'x.markdown')],
    ['不存在的 .md', p('dir', 'missing.md'), p('dir', 'missing.md')],
    ['link.txt → real.md 的链接（按给的路径交过去）', p('link.txt'), p('link.txt')]
  ])('%s → openMarkdownFile(绝对路径)，不开预览窗', async (_label, given, expected) => {
    init()
    expect(await open(given)).toBe(true)
    expect(fx.openMarkdownFile.mock.calls).toEqual([[expected]])
    expect(windows()).toHaveLength(0)
  })

  it('openMarkdownFile 回 false → 原样回 false', async () => {
    init()
    fx.openMarkdownFile.mockReturnValue(false)
    expect(await open(p('dir', 'missing.md'))).toBe(false)
    expect(windows()).toHaveLength(0)
  })
})

describe('W-3 可预览的文件开窗', () => {
  it.each([
    'a.txt',
    'code.ts',
    'pic.png',
    'fig.svg',
    'doc.pdf',
    'clip.mp4',
    'song.mp3',
    'book.epub',
    'sheet.xlsx'
  ])('%s → 新的预览窗口', async (name) => {
    init()
    // 经未解开的 tmpdir 写法给路径：hash 里该是真实路径
    expect(await open(join(rawRoot, 'dir', name))).toBe(true)
    expect(fx.openMarkdownFile).not.toHaveBeenCalled()

    const win = onlyWindow()
    expect(win.options).toMatchObject({
      width: Math.round(900 * ZOOM),
      show: false,
      title: name,
      backgroundColor: '#101010'
    })
    expect(fx.guardAppWindow.mock.calls).toEqual([[win]])
    expect(hashOf(win)).toEqual({
      route: 'file-preview',
      sessionId: LIVE,
      path: p('dir', name),
      openedBy: 'user'
    })

    expect(win.show).not.toHaveBeenCalled()
    win.emit('ready-to-show')
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)

    const event = { preventDefault: vi.fn() }
    win.emit('page-title-updated', event, 'page title')
    expect(event.preventDefault).toHaveBeenCalled()
  })
})

describe('W-4 不可预览 → 不响应', () => {
  it.each([
    ['已知二进制扩展名', 'dir/arch.zip'],
    ['带 NUL 的无扩展名文件', 'dir/noext'],
    ['超过 2MB 的 txt', 'dir/big.txt'],
    ['超过 10MB 的 png', 'dir/huge.png'],
    ['目录', 'sub'],
    ['不存在的 txt', 'dir/missing.txt']
  ])('%s → false、不开窗', async (_label, rel) => {
    init()
    expect(await open(p(rel))).toBe(false)
    expect(windows()).toHaveLength(0)
    expect(fx.guardAppWindow).not.toHaveBeenCalled()
    expect(fx.openMarkdownFile).not.toHaveBeenCalled()
  })
})

describe('W-5 会话已删', () => {
  it('相对路径 → false；绝对路径 → true，hash 里仍是借来的会话 id', async () => {
    init()
    expect(await open('dir/a.txt', { sessionId: GONE })).toBe(false)
    expect(windows()).toHaveLength(0)

    expect(await open(p('dir', 'a.txt'), { sessionId: GONE })).toBe(true)
    expect(hashOf(onlyWindow())).toMatchObject({ sessionId: GONE, path: p('dir', 'a.txt') })
  })
})

describe('W-6 一个真实路径一个窗口', () => {
  it('直接 / 相对 / 符号链接 / dir/../ 的写法都落到同一个窗口；最小化的被还原、显示、聚焦', async () => {
    init()
    expect(await open(p('dir', 'a.txt'))).toBe(true)
    const win = onlyWindow()
    win.emit('ready-to-show')
    vi.clearAllMocks()

    win.minimized = true
    for (const given of [
      p('dir', 'a.txt'),
      'dir/a.txt',
      p('link-a.txt'),
      join(realRoot, 'dir', '..', 'dir', 'a.txt'),
      join(rawRoot, 'dir', 'a.txt')
    ]) {
      expect(await open(given), given).toBe(true)
    }
    expect(windows()).toHaveLength(1)
    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.show).toHaveBeenCalledTimes(5)
    expect(win.focus).toHaveBeenCalledTimes(5)
    expect(fx.guardAppWindow).not.toHaveBeenCalled()
  })
})

describe('W-7 关窗', () => {
  it('closed → 表项拿掉，再开是新窗口', async () => {
    init()
    await open(p('dir', 'a.txt'))
    const first = onlyWindow()
    first.destroyed = true
    first.emit('closed')

    expect(await open(p('dir', 'a.txt'))).toBe(true)
    expect(windows()).toHaveLength(2)
  })

  it('旧窗口迟到的 closed 不拿掉同一路径的新窗口', async () => {
    init()
    await open(p('dir', 'a.txt'))
    const first = windows()[0]
    first.destroyed = true
    first.emit('closed')
    await open(p('dir', 'a.txt'))
    const second = windows()[1]

    first.emit('closed') // 迟到的那一下
    second.focus.mockClear()
    expect(await open(p('dir', 'a.txt'))).toBe(true)
    expect(windows()).toHaveLength(2)
    expect(second.focus).toHaveBeenCalledTimes(1)
  })
})

describe('W-8 openedBy', () => {
  it('agent 原样进 hash', async () => {
    init()
    expect(await open(p('dir', 'pic.png'), { openedBy: 'agent' })).toBe(true)
    expect(hashOf(onlyWindow()).openedBy).toBe('agent')
  })
})

describe('W-9 错开', () => {
  it('锚在聚焦窗口，每个已开的预览窗口再 +24', async () => {
    init()
    const anchor = new fx.FakeWindow({})
    anchor.bounds = { x: 100, y: 50, width: 1200, height: 800 }
    fx.FakeWindow.focused = anchor

    await open(p('dir', 'a.txt'))
    await open(p('dir', 'code.ts'))
    await open(p('dir', 'pic.png'))
    const [, w1, w2, w3] = windows()
    expect(w1.options).toMatchObject({ x: 124, y: 74 })
    expect(w2.options).toMatchObject({ x: 148, y: 98 })
    expect(w3.options).toMatchObject({ x: 172, y: 122 })
  })

  it('没有聚焦窗口 → 不指定位置', async () => {
    init()
    await open(p('dir', 'a.txt'))
    const win = onlyWindow()
    expect(win.options).not.toHaveProperty('x')
    expect(win.options).not.toHaveProperty('y')
  })
})

describe('W-10 查表先于分类', () => {
  it('已开窗口的文件之后被删了：再开仍聚焦那扇窗、回 true', async () => {
    init()
    const gone = p('dir', 'gone.txt')
    writeFileSync(gone, 'soon gone\n')
    expect(await open(gone)).toBe(true)
    const win = onlyWindow()
    unlinkSync(gone)

    win.focus.mockClear()
    expect(await open(gone)).toBe(true)
    expect(windows()).toHaveLength(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
  })
})

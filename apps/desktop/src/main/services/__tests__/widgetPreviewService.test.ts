/**
 * widgetPreviewService —— `shuvix widget preview <id>`：在从不显示的窗口里按 panel / window / phone 渲染、各截一张图。
 *
 * electron 换成自己的小假货（fakeElectron.ts 属于浏览器模块，没有 webContents.debugger / capturePage /
 * executeJavaScript）：窗口记下构造选项与 show / focus 一类的间谍，webContents 的每一步进一份共享的调用日志
 * （断先后用），行为由 `fx.hooks` 按用例改。widget 模块只给 validateId（真的 id 规则）与 startWidget /
 * lastBuildErrors 两个间谍；会话目录落在临时目录里。模块级状态（排队链、分区装没装）每条用例重新导入。
 * 计时器是假的（含 Date：挂载的截止时间按它算），800ms 的 settle 不拖慢用例。
 *
 *   U-PS-1…7  parsePreviewSizes：缺省全部、固定顺序、大小写与空白、去重、空段、认不得的值、不是字符串
 *   U-PT-1…3  parsePreviewTheme：缺省 undefined、light / dark、其余一律报错（含 'app' 与 ' '）
 *   U-PC-1    三种尺寸的数（技能 design.md「Check it」印的就是它们）
 *   U-PV-1…4  非法 id / 找不到 / 构建失败（含已注册但上一次构建失败，B2）/ 没有地址：不开窗
 *   U-PV-5…9  正常路径：窗口顺序、图片路径与内容、尺寸子集、CDP 顺序、没有会话的目录（B6）、高分屏缩回
 *   U-PV-10…15 某个尺寸失败别的照截、加载超时、收尾、console 与 did-fail-load、错误上限（B11）
 *   U-PV-16…19 导航守卫（B7）、分区、排队、挂载等待
 *   U-PV-20…23 每一步的超时（B3）、弹框（B4）、会话 id（B5）、窗口选项（不打扰用户，SIGSEGV 回归）
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'

type Size = 'panel' | 'window' | 'phone'

const fx = vi.hoisted(() => {
  type HSize = 'panel' | 'window' | 'phone'
  const SPEC: Record<HSize, { width: number; height: number }> = {
    panel: { width: 380, height: 760 },
    window: { width: 1280, height: 800 },
    phone: { width: 390, height: 780 }
  }
  const SIZE_BY_WIDTH: Record<number, HSize> = { 380: 'panel', 1280: 'window', 390: 'phone' }

  interface Entry {
    size?: HSize
    op: string
    arg?: unknown
  }
  /** 共享的调用日志（先后顺序按它断） */
  const log: Entry[] = []

  class FakeImage {
    static all: FakeImage[] = []
    readonly resize = vi.fn(
      (o: { width: number; height: number; quality?: string }) =>
        new FakeImage(o.width, o.height, `${this.tag}>resized`)
    )
    constructor(
      readonly width: number,
      readonly height: number,
      readonly tag: string,
      readonly empty = false
    ) {
      FakeImage.all.push(this)
    }
    isEmpty(): boolean {
      return this.empty
    }
    getSize(): { width: number; height: number } {
      return { width: this.width, height: this.height }
    }
    toPNG(): Buffer {
      return Buffer.from(`png ${this.tag} ${this.width}x${this.height}`)
    }
  }

  type Listener = (...args: unknown[]) => unknown

  interface Hooks {
    loadURL(wc: FakeWebContents, url: string): Promise<void>
    mount(wc: FakeWebContents, n: number): Promise<unknown>
    fonts(wc: FakeWebContents): Promise<unknown>
    capture(wc: FakeWebContents): Promise<FakeImage>
    cdp(wc: FakeWebContents, method: string, params: unknown): Promise<unknown>
    detach(wc: FakeWebContents): void
  }

  const defaultHooks = (): Hooks => ({
    loadURL: () => Promise.resolve(),
    mount: () => Promise.resolve(true),
    fonts: () => Promise.resolve(true),
    capture: (wc) => Promise.resolve(new FakeImage(wc.spec.width, wc.spec.height, wc.size)),
    cdp: () => Promise.resolve({}),
    detach: () => {}
  })
  const hooks: Hooks = defaultHooks()

  class FakeWebContents {
    readonly listeners = new Map<string, Listener[]>()
    openHandler: ((details: { url: string }) => unknown) | null = null
    attached = false
    mountProbes = 0
    readonly on = vi.fn((event: string, fn: Listener) => {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
      return this
    })
    readonly setWindowOpenHandler = vi.fn((fn: (details: { url: string }) => unknown) => {
      this.openHandler = fn
    })
    readonly loadURL = vi.fn((url: string) => {
      log.push({ size: this.size, op: 'loadURL', arg: url })
      return hooks.loadURL(this, url)
    })
    readonly executeJavaScript = vi.fn((code: string) => {
      if (code.includes('document.fonts')) {
        log.push({ size: this.size, op: 'fonts' })
        return hooks.fonts(this)
      }
      log.push({ size: this.size, op: 'mount' })
      return hooks.mount(this, ++this.mountProbes)
    })
    readonly capturePage = vi.fn(() => {
      log.push({ size: this.size, op: 'capturePage' })
      return hooks.capture(this)
    })
    readonly debugger = {
      attach: vi.fn((version: string) => {
        log.push({ size: this.size, op: 'attach', arg: version })
        this.attached = true
      }),
      detach: vi.fn(() => {
        log.push({ size: this.size, op: 'detach' })
        hooks.detach(this)
        this.attached = false
      }),
      isAttached: vi.fn(() => this.attached),
      sendCommand: vi.fn((method: string, params: unknown) => {
        log.push({ size: this.size, op: 'cdp', arg: { method, params } })
        return hooks.cdp(this, method, params)
      })
    }
    constructor(readonly win: FakeWindow) {}
    get size(): HSize {
      return this.win.size
    }
    get spec(): { width: number; height: number } {
      return SPEC[this.win.size]
    }
    fire(event: string, ...args: unknown[]): void {
      for (const fn of this.listeners.get(event) ?? []) fn(...args)
    }
  }

  class FakeWindow {
    static all: FakeWindow[] = []
    readonly size: HSize
    readonly webContents: FakeWebContents
    readonly show = vi.fn()
    readonly showInactive = vi.fn()
    readonly focus = vi.fn()
    readonly moveTop = vi.fn()
    readonly restore = vi.fn()
    readonly destroy = vi.fn(() => {
      log.push({ size: this.size, op: 'destroy' })
    })
    constructor(readonly opts: Record<string, unknown>) {
      this.size = SIZE_BY_WIDTH[opts.width as number]
      FakeWindow.all.push(this)
      log.push({ size: this.size, op: 'new' })
      this.webContents = new FakeWebContents(this)
    }
  }

  const fakeSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
    // widget 文件路由的补头钩子（widget/widgetFsKey.ts）装在预览分区上
    webRequest: { onBeforeSendHeaders: vi.fn() }
  }

  return {
    SPEC,
    log,
    hooks,
    defaultHooks,
    FakeImage,
    FakeWindow,
    fakeSession,
    session: { fromPartition: vi.fn((_name: string) => fakeSession) },
    shell: { openExternal: vi.fn() },
    startWidget: vi.fn<(id: string) => Promise<{ url: string; buildSuccess: boolean }>>(),
    lastBuildErrors: vi.fn<(id: string) => readonly string[] | undefined>(),
    tmpRoot: ''
  }
})

vi.mock('electron', () => ({
  BrowserWindow: fx.FakeWindow,
  session: fx.session,
  shell: fx.shell
}))
vi.mock('../widget', async () => {
  const { WIDGET_ID_REGEX } = await vi.importActual<typeof import('../widget/widgetRegistry')>(
    '../widget/widgetRegistry'
  )
  return {
    widgetService: {
      validateId: (id: string): void => {
        if (!WIDGET_ID_REGEX.test(id)) throw new Error(`Invalid widget id "${id}".`)
      },
      startWidget: fx.startWidget
    },
    widgetServer: { lastBuildErrors: fx.lastBuildErrors }
  }
})
vi.mock('../../utils/paths', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../utils/paths')>()
  const { mkdirSync } = await import('node:fs')
  const path = await import('node:path')
  return {
    getToolResultsDir: (sid: string): string => {
      const dir = path.join(fx.tmpRoot, 'tool_results', sid)
      mkdirSync(dir, { recursive: true })
      return dir
    },
    isSafeSessionId: real.isSafeSessionId
  }
})
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

type Svc = typeof import('../widgetPreviewService')
let svc: Svc

const ID = 'pv-x'
const PORT = 4567
const URL_OF = (id: string): string => `http://127.0.0.1:${PORT}/w/${id}/`
const ALL: Size[] = ['panel', 'window', 'phone']

const windows = (): InstanceType<typeof fx.FakeWindow>[] => fx.FakeWindow.all
const windowOf = (size: Size): InstanceType<typeof fx.FakeWindow> => {
  const w = windows().find((x) => x.size === size)
  if (!w) throw new Error(`no ${size} window`)
  return w
}
const previewDir = (sid: string): string => join(fx.tmpRoot, 'tool_results', sid, 'widget-preview')
const opsOf = (size: Size): string[] => fx.log.filter((e) => e.size === size).map((e) => e.op)
const never = <T>(): Promise<T> => new Promise<T>(() => {})
/** 没有会话时预览新建的系统临时目录（afterEach 收走） */
const madeTmpDirs: string[] = []

/** 把排队、超时、settle 的计时器都走完，再拿结果（被拒的照样抛出来） */
async function run<T>(p: Promise<T>): Promise<T> {
  let settled = false
  p.then(
    () => (settled = true),
    () => (settled = true)
  )
  await vi.runAllTimersAsync()
  for (let i = 0; i < 50 && !settled; i++) await vi.advanceTimersByTimeAsync(1_000)
  return p
}

/** 跑完一个期望被拒的预览（先挂上 catch，免得没人接的拒绝） */
async function runRejected(p: Promise<unknown>): Promise<Error> {
  const caught = p.then(
    () => {
      throw new Error('expected the preview to reject')
    },
    (e: Error) => e
  )
  await run(caught)
  return caught
}

beforeAll(() => {
  fx.tmpRoot = mkdtempSync(join(tmpdir(), 'sx-pv-unit-'))
})
afterAll(() => {
  rmSync(fx.tmpRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  rmSync(join(fx.tmpRoot, 'tool_results'), { recursive: true, force: true })
  fx.log.length = 0
  fx.FakeWindow.all = []
  fx.FakeImage.all = []
  Object.assign(fx.hooks, fx.defaultHooks())
  fx.session.fromPartition.mockClear()
  fx.fakeSession.setPermissionRequestHandler.mockClear()
  fx.fakeSession.setPermissionCheckHandler.mockClear()
  fx.fakeSession.on.mockClear()
  fx.shell.openExternal.mockClear()
  fx.startWidget.mockReset()
  fx.startWidget.mockImplementation(async (id: string) => {
    fx.log.push({ op: 'startWidget', arg: id })
    return { url: URL_OF(id), buildSuccess: true }
  })
  fx.lastBuildErrors.mockReset()
  fx.lastBuildErrors.mockReturnValue([])
  vi.resetModules()
  svc = await import('../widgetPreviewService')
})

afterEach(() => {
  vi.useRealTimers()
  // 没有会话时每次新建一个系统临时目录：用例自己记下、这里收走
  for (const dir of madeTmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  // 没人在看的窗口绝不交给系统打开任何东西
  expect(fx.shell.openExternal).not.toHaveBeenCalled()
})

// ─── 解析与常量 ─────────────────────────────────────────────

describe('parsePreviewSizes', () => {
  it.each([undefined, null, ''])('U-PS-1 %j → all three in fixed order', (raw) => {
    const out = svc.parsePreviewSizes(raw)
    expect(out).toEqual(['panel', 'window', 'phone'])
    out.push('panel')
    out.reverse()
    expect(svc.PREVIEW_SIZE_ORDER).toEqual(['panel', 'window', 'phone'])
    expect(svc.parsePreviewSizes(undefined)).toEqual(['panel', 'window', 'phone'])
  })

  it('U-PS-2 a subset comes back in the fixed order', () => {
    expect(svc.parsePreviewSizes('phone')).toEqual(['phone'])
    expect(svc.parsePreviewSizes('phone,panel')).toEqual(['panel', 'phone'])
    expect(svc.parsePreviewSizes('window,phone,panel')).toEqual(['panel', 'window', 'phone'])
  })

  it('U-PS-3 case and whitespace do not matter', () => {
    expect(svc.parsePreviewSizes('PHONE, Panel ')).toEqual(['panel', 'phone'])
  })

  it('U-PS-4 duplicates collapse', () => {
    expect(svc.parsePreviewSizes('phone,phone,PHONE')).toEqual(['phone'])
  })

  it('U-PS-5 empty parts are skipped; nothing left = all three', () => {
    for (const raw of [',,', ' , ', ' ']) {
      expect(svc.parsePreviewSizes(raw), JSON.stringify(raw)).toEqual(['panel', 'window', 'phone'])
    }
    expect(svc.parsePreviewSizes('panel,,window')).toEqual(['panel', 'window'])
  })

  it('U-PS-6 an unknown size throws, naming it (trimmed, original case), with nothing partial', () => {
    expect(() => svc.parsePreviewSizes('tablet')).toThrow(
      new Error('unknown size "tablet" (use panel, window, phone)')
    )
    expect(() => svc.parsePreviewSizes('phone, Tablet ')).toThrow(
      new Error('unknown size "Tablet" (use panel, window, phone)')
    )
    expect(() => svc.parsePreviewSizes('panel window')).toThrow(
      new Error('unknown size "panel window" (use panel, window, phone)')
    )
  })

  it.each([42, ['phone'], {}, true])('U-PS-7 non-string %j throws', (raw) => {
    expect(() => svc.parsePreviewSizes(raw)).toThrow(
      new Error('size must be a comma-separated list')
    )
  })
})

describe('parsePreviewTheme', () => {
  it.each([undefined, null, ''])('U-PT-1 %j → undefined (follow the app)', (raw) => {
    expect(svc.parsePreviewTheme(raw)).toBeUndefined()
  })

  it('U-PT-2 light / dark, case and whitespace ignored', () => {
    expect(svc.parsePreviewTheme('light')).toBe('light')
    expect(svc.parsePreviewTheme('dark')).toBe('dark')
    expect(svc.parsePreviewTheme(' DARK ')).toBe('dark')
  })

  it.each([
    ['sepia', 'sepia'],
    ['app', 'app'],
    [42, '42'],
    [true, 'true'],
    [' ', ' ']
  ])('U-PT-3 %j throws unknown theme', (raw, shown) => {
    expect(() => svc.parsePreviewTheme(raw)).toThrow(
      new Error(`unknown theme "${shown}" (use light or dark)`)
    )
  })
})

describe('constants', () => {
  it('U-PC-1 the three sizes and their order', () => {
    expect(svc.PREVIEW_SIZES).toStrictEqual({
      panel: { width: 380, height: 760, touch: false },
      window: { width: 1280, height: 800, touch: false },
      phone: { width: 390, height: 780, touch: true }
    })
    expect(svc.PREVIEW_SIZE_ORDER).toStrictEqual(['panel', 'window', 'phone'])
  })
})

// ─── previewWidget ─────────────────────────────────────────

describe('previewWidget: before any window', () => {
  it.each(['Foo_Bar', '../x', 'nodash'])(
    'U-PV-1 invalid id %j rejects; nothing starts, no window',
    async (id) => {
      const err = await runRejected(svc.previewWidget(id, { sessionId: 'sess-1' }))
      expect(err.message).toContain('Invalid widget id')
      expect(fx.startWidget).not.toHaveBeenCalled()
      expect(windows()).toHaveLength(0)
    }
  )

  it('U-PV-2 startWidget throwing rejects with that error; the queue survives it', async () => {
    fx.startWidget.mockImplementationOnce(async (id) => {
      throw new Error(`Widget "${id}" not found`)
    })
    const first = svc.previewWidget(ID, { sessionId: 'sess-1' })
    const second = svc.previewWidget('pv-y', { sizes: ['panel'], sessionId: 'sess-1' })

    const err = await runRejected(first)
    expect(err.message).toBe('Widget "pv-x" not found')
    const out = await run(second)
    expect(out.id).toBe('pv-y')
    expect(out.images.map((i) => i.size)).toEqual(['panel'])
    // 第一个没开过窗口：唯一的那扇是第二个的
    expect(windows()).toHaveLength(1)
  })

  it.each([undefined, 'dark' as const])(
    'U-PV-3 a widget that does not build (theme %j) → no images, the build error, no window, no files',
    async (theme) => {
      fx.startWidget.mockResolvedValueOnce({ url: '', buildSuccess: false })
      const out = await run(svc.previewWidget(ID, { theme, sessionId: 'sess-1' }))
      expect(out).toStrictEqual({
        id: ID,
        theme: theme ?? 'app',
        images: [],
        errors: ['the widget does not build: run `shuvix widget build pv-x` and fix buildErrors']
      })
      expect(windows()).toHaveLength(0)
      expect(existsSync(previewDir('sess-1'))).toBe(false)
    }
  )

  it('U-PV-3b (B2) registered, but its last build failed → same answer, no window, no files', async () => {
    // 已注册的不重新构建：startWidget 这时总说成功，失败要看服务器上那一项
    fx.startWidget.mockResolvedValueOnce({ url: URL_OF(ID), buildSuccess: true })
    fx.lastBuildErrors.mockReturnValue(['index.tsx:1:10: ERROR: Unexpected ";"'])
    const out = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))
    expect(out).toStrictEqual({
      id: ID,
      theme: 'app',
      images: [],
      errors: ['the widget does not build: run `shuvix widget build pv-x` and fix buildErrors']
    })
    expect(fx.lastBuildErrors).toHaveBeenCalledWith(ID)
    expect(windows()).toHaveLength(0)
    expect(existsSync(previewDir('sess-1'))).toBe(false)
  })

  it('U-PV-3c no build errors recorded (undefined or empty) → the preview runs', async () => {
    fx.lastBuildErrors.mockReturnValue(undefined)
    const a = await run(svc.previewWidget(ID, { sizes: ['panel'], sessionId: 'sess-1' }))
    expect(a.images).toHaveLength(1)
    fx.lastBuildErrors.mockReturnValue([])
    const b = await run(svc.previewWidget(ID, { sizes: ['panel'], sessionId: 'sess-1' }))
    expect(b.images).toHaveLength(1)
  })

  it('U-PV-4 built but no address → rejects, no window', async () => {
    fx.startWidget.mockResolvedValueOnce({ url: '', buildSuccess: true })
    const err = await runRejected(svc.previewWidget(ID, { sessionId: 'sess-1' }))
    expect(err.message).toBe('widget "pv-x" has no address')
    expect(windows()).toHaveLength(0)
  })
})

describe('previewWidget: the normal path', () => {
  it('U-PV-5 all sizes: windows in order, images with paths and the right bytes', async () => {
    const out = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))

    expect(windows().map((w) => w.size)).toEqual(ALL)
    const dir = previewDir('sess-1')
    expect(out).toStrictEqual({
      id: ID,
      theme: 'app',
      images: [
        { size: 'panel', width: 380, height: 760, path: join(dir, 'pv-x-panel.png') },
        { size: 'window', width: 1280, height: 800, path: join(dir, 'pv-x-window.png') },
        { size: 'phone', width: 390, height: 780, path: join(dir, 'pv-x-phone.png') }
      ],
      errors: []
    })
    for (const img of out.images) {
      const { width, height } = fx.SPEC[img.size]
      expect(readFileSync(img.path, 'utf8')).toBe(`png ${img.size} ${width}x${height}`)
    }
    expect(readdirSync(dir).sort()).toEqual(['pv-x-panel.png', 'pv-x-phone.png', 'pv-x-window.png'])
    // 一次一个窗口：上一扇销毁之后才建下一扇
    const order = fx.log.filter((e) => e.op === 'new' || e.op === 'destroy')
    expect(order.map((e) => `${e.op}:${e.size}`)).toEqual([
      'new:panel',
      'destroy:panel',
      'new:window',
      'destroy:window',
      'new:phone',
      'destroy:phone'
    ])
  })

  it('U-PV-5b the same size twice overwrites the same file', async () => {
    await run(svc.previewWidget(ID, { sizes: ['panel'], sessionId: 'sess-1' }))
    fx.hooks.capture = (wc) => Promise.resolve(new fx.FakeImage(380, 760, `${wc.size}-v2`))
    const out = await run(svc.previewWidget(ID, { sizes: ['panel'], sessionId: 'sess-1' }))
    expect(out.images[0].path).toBe(join(previewDir('sess-1'), 'pv-x-panel.png'))
    expect(readFileSync(out.images[0].path, 'utf8')).toBe('png panel-v2 380x760')
    expect(readdirSync(previewDir('sess-1'))).toEqual(['pv-x-panel.png'])
  })

  it('U-PV-6 a subset gives that many windows; [] and undefined mean all three', async () => {
    const one = await run(svc.previewWidget(ID, { sizes: ['phone'], sessionId: 'sess-1' }))
    expect(windows().map((w) => w.size)).toEqual(['phone'])
    expect(one.images.map((i) => i.size)).toEqual(['phone'])

    for (const sizes of [[], undefined]) {
      fx.FakeWindow.all = []
      const out = await run(svc.previewWidget(ID, { sizes, sessionId: 'sess-1' }))
      expect(windows().map((w) => w.size)).toEqual(ALL)
      expect(out.images.map((i) => i.size)).toEqual(ALL)
    }
  })

  it.each([undefined, 'light' as const, 'dark' as const])(
    'U-PV-7 the per-size sequence (theme %j): blank page, attach, CDP, then the widget, nothing after',
    async (theme) => {
      const out = await run(svc.previewWidget(ID, { theme, sessionId: 'sess-1' }))
      expect(out.theme).toBe(theme ?? 'app')

      for (const size of ALL) {
        const { width, height } = fx.SPEC[size]
        const touch = size === 'phone'
        const seq = fx.log
          .filter((e) => e.size === size && ['loadURL', 'attach', 'cdp'].includes(e.op))
          .map((e) => (e.op === 'cdp' ? (e.arg as { method: string; params: unknown }) : e))
        const expected: unknown[] = [
          { size, op: 'loadURL', arg: 'about:blank' },
          { size, op: 'attach', arg: '1.3' },
          {
            method: 'Page.addScriptToEvaluateOnNewDocument',
            params: { source: expect.stringContaining('window.alert') }
          },
          {
            method: 'Emulation.setDeviceMetricsOverride',
            params: { width, height, deviceScaleFactor: 1, mobile: touch }
          },
          ...(touch
            ? [
                {
                  method: 'Emulation.setTouchEmulationEnabled',
                  params: { enabled: true, maxTouchPoints: 5 }
                }
              ]
            : []),
          ...(theme
            ? [
                {
                  method: 'Emulation.setEmulatedMedia',
                  params: { features: [{ name: 'prefers-color-scheme', value: theme }] }
                }
              ]
            : []),
          { size, op: 'loadURL', arg: URL_OF(ID) }
        ]
        expect(seq, size).toEqual(expected)
        // 模拟设在 about:blank 上、随导航保留：载入 widget 之后不再发 CDP 命令
        const ops = opsOf(size)
        const widgetLoad = fx.log.findIndex(
          (e) => e.size === size && e.op === 'loadURL' && e.arg === URL_OF(ID)
        )
        expect(
          fx.log.slice(widgetLoad + 1).filter((e) => e.size === size && e.op === 'cdp'),
          size
        ).toEqual([])
        expect(ops.at(-1), size).toBe('destroy')
      }
    }
  )

  it('U-PV-8 (B6) no session: a fresh shuvix-widget-preview-* directory under the OS temp dir, per run', async () => {
    const a = await run(svc.previewWidget(ID, { sizes: ['panel'] }))
    const b = await run(svc.previewWidget(ID, { sizes: ['panel'] }))
    madeTmpDirs.push(dirname(a.images[0].path), dirname(b.images[0].path))

    for (const out of [a, b]) {
      const dir = dirname(out.images[0].path)
      expect(dirname(dir)).toBe(tmpdir())
      expect(dir.slice(dirname(dir).length + 1)).toMatch(/^shuvix-widget-preview-.+/)
      expect(out.images[0].path).toBe(join(dir, 'pv-x-panel.png'))
      expect(readFileSync(out.images[0].path, 'utf8')).toBe('png panel 380x760')
    }
    // 每次新建：固定路径在多用户的机器上能被别人预先占住
    expect(dirname(a.images[0].path)).not.toBe(dirname(b.images[0].path))
    // 不碰任何会话的 tool_results
    expect(existsSync(join(fx.tmpRoot, 'tool_results'))).toBe(false)
  })

  it('U-PV-9 HiDPI: a 2x capture is resized back to CSS pixels; a 1x capture is not resized', async () => {
    fx.hooks.capture = (wc) =>
      Promise.resolve(
        wc.size === 'panel'
          ? new fx.FakeImage(760, 1520, 'panel@2x')
          : new fx.FakeImage(wc.spec.width, wc.spec.height, wc.size)
      )
    const out = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))

    const twoX = fx.FakeImage.all.find((i) => i.tag === 'panel@2x')!
    expect(twoX.resize.mock.calls).toEqual([[{ width: 380, height: 760, quality: 'best' }]])
    expect(out.images[0]).toMatchObject({ size: 'panel', width: 380, height: 760 })
    expect(readFileSync(out.images[0].path, 'utf8')).toBe('png panel@2x>resized 380x760')
    for (const tag of ['window', 'phone']) {
      expect(fx.FakeImage.all.find((i) => i.tag === tag)!.resize, tag).not.toHaveBeenCalled()
    }
  })
})

describe('previewWidget: failures stay per size', () => {
  it('U-PV-10 an empty capture fails that size only; its window is still destroyed', async () => {
    fx.hooks.capture = (wc) =>
      Promise.resolve(
        new fx.FakeImage(wc.spec.width, wc.spec.height, wc.size, wc.size === 'window')
      )
    const out = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))

    expect(out.errors).toEqual(['[window] preview failed: the page rendered nothing to capture'])
    expect(out.images.map((i) => i.size)).toEqual(['panel', 'phone'])
    expect(windowOf('window').destroy).toHaveBeenCalledTimes(1)
    expect(existsSync(join(previewDir('sess-1'), 'pv-x-window.png'))).toBe(false)
  })

  it('U-PV-11 the widget never loading times out after 15s; that window is cleaned up, the rest continue', async () => {
    fx.hooks.loadURL = (wc, url) =>
      wc.size === 'panel' && url !== 'about:blank' ? never() : Promise.resolve()
    const out = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))

    expect(out.errors).toEqual([
      '[panel] preview failed: loading the widget timed out after 15000ms'
    ])
    expect(out.images.map((i) => i.size)).toEqual(['window', 'phone'])
    const panel = windowOf('panel')
    expect(panel.destroy).toHaveBeenCalledTimes(1)
    expect(panel.webContents.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('U-PV-11b the blank page never loading times out too (no debugger to detach)', async () => {
    fx.hooks.loadURL = (wc, url) =>
      wc.size === 'phone' && url === 'about:blank' ? never() : Promise.resolve()
    const out = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))

    expect(out.errors).toEqual([
      '[phone] preview failed: preparing the page timed out after 15000ms'
    ])
    expect(out.images.map((i) => i.size)).toEqual(['panel', 'window'])
    const phone = windowOf('phone')
    expect(phone.webContents.debugger.attach).not.toHaveBeenCalled()
    expect(phone.webContents.debugger.detach).not.toHaveBeenCalled()
    expect(phone.destroy).toHaveBeenCalledTimes(1)
  })

  it('U-PV-12 cleanup: every window destroyed exactly once, detached when attached, a throwing detach is harmless', async () => {
    // 成功路径
    await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))
    for (const w of windows()) {
      expect(w.destroy, w.size).toHaveBeenCalledTimes(1)
      expect(w.webContents.debugger.detach, w.size).toHaveBeenCalledTimes(1)
    }

    // 失败路径（about:blank 被拒：还没 attach）+ 抛错的 detach
    fx.FakeWindow.all = []
    fx.hooks.loadURL = (wc, url) =>
      wc.size === 'panel' && url === 'about:blank'
        ? Promise.reject(new Error('ERR_ABORTED'))
        : Promise.resolve()
    fx.hooks.detach = (wc) => {
      if (wc.size === 'window') throw new Error('Debugger is not attached')
    }
    const out = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))
    expect(out.errors).toEqual(['[panel] preview failed: ERR_ABORTED'])
    expect(out.images.map((i) => i.size)).toEqual(['window', 'phone'])
    for (const w of windows()) expect(w.destroy, w.size).toHaveBeenCalledTimes(1)
    expect(windowOf('panel').webContents.debugger.detach).not.toHaveBeenCalled()
    expect(windowOf('window').webContents.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('U-PV-13 console errors come back prefixed, cut to 500 chars, deduped per size', async () => {
    const long = 'x'.repeat(2_000)
    fx.hooks.loadURL = (wc, url) => {
      if (url !== 'about:blank') {
        const say = (level: string, message: string): void =>
          wc.fire('console-message', { level, message })
        if (wc.size === 'panel') {
          say('error', 'boom')
          say('error', 'boom')
          say('warning', 'just a warning')
          say('info', 'hello')
          say('debug', 'dbg')
          say('error', long)
        }
        if (wc.size === 'phone') say('error', 'boom')
      }
      return Promise.resolve()
    }
    const out = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))

    const cut = `[panel] ${long}`.slice(0, 500)
    expect(cut).toHaveLength(500)
    expect(out.errors).toEqual(['[panel] boom', cut, '[phone] boom'])
    expect(out.images).toHaveLength(3)
  })

  it('U-PV-14 a main-frame load failure is reported; a subframe failure is not', async () => {
    fx.hooks.loadURL = (wc, url) => {
      if (url !== 'about:blank' && wc.size === 'phone') {
        wc.fire('did-fail-load', {}, -2, 'ERR_FAILED', 'http://127.0.0.1:1/sub', false)
        wc.fire('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', URL_OF(ID), true)
      }
      return Promise.resolve()
    }
    const out = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))
    expect(out.errors).toEqual([
      `[phone] failed to load ${URL_OF(ID)}: ERR_NAME_NOT_RESOLVED (-105)`
    ])
  })

  it('U-PV-15 (B11) page errors are capped at 12; failure lines are always kept, first', async () => {
    fx.hooks.loadURL = (wc, url) => {
      if (url !== 'about:blank' && wc.size === 'panel') {
        for (let i = 0; i < 20; i++)
          wc.fire('console-message', { level: 'error', message: `e${i}` })
      }
      return Promise.resolve()
    }
    const capped = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))
    expect(capped.errors).toEqual(Array.from({ length: 12 }, (_, i) => `[panel] e${i}`))

    // 一个尺寸失败了：那一行不占 12 条的数、排在最前
    fx.hooks.capture = (wc) =>
      Promise.resolve(new fx.FakeImage(wc.spec.width, wc.spec.height, wc.size, wc.size === 'phone'))
    const withFailure = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))
    expect(withFailure.errors).toEqual([
      '[phone] preview failed: the page rendered nothing to capture',
      ...Array.from({ length: 12 }, (_, i) => `[panel] e${i}`)
    ])
  })
})

describe('previewWidget: the page is kept in', () => {
  it('U-PV-16 (B7) navigation only within the widget’s own /w/<id>/; popups denied; nothing handed to the system', async () => {
    await run(svc.previewWidget(ID, { sizes: ['panel'], sessionId: 'sess-1' }))
    const wc = windowOf('panel').webContents
    const navigate = (url: string): boolean => {
      const event = { preventDefault: vi.fn() }
      wc.fire('will-navigate', event, url)
      return event.preventDefault.mock.calls.length > 0
    }

    expect(navigate(`http://127.0.0.1:${PORT}/w/${ID}/x`)).toBe(false)
    expect(navigate(`http://127.0.0.1:${PORT}/w/${ID}/`)).toBe(false)
    expect(navigate(`http://127.0.0.1:${PORT}/w/${ID}/?q=1#h`)).toBe(false)
    for (const url of [
      'https://example.com/',
      `http://localhost:${PORT}/w/${ID}/`,
      `http://127.0.0.1:${PORT + 1}/w/${ID}/`,
      `http://127.0.0.1:${PORT}/w/other-widget/`,
      `http://127.0.0.1:${PORT}/w/${ID}y/`,
      `http://127.0.0.1:${PORT}/w/${ID}`,
      `http://127.0.0.1:${PORT}/`,
      'mailto:a@b.c',
      'file:///etc/hosts',
      'not a url'
    ]) {
      expect(navigate(url), url).toBe(true)
    }

    expect(wc.openHandler).toBeTypeOf('function')
    for (const url of ['https://example.com/', URL_OF(ID), 'mailto:a@b.c']) {
      expect(wc.openHandler!({ url }), url).toEqual({ action: 'deny' })
    }
    expect(fx.shell.openExternal).not.toHaveBeenCalled()
  })

  it('U-PV-17 an in-memory partition that refuses permissions and downloads, set up once', async () => {
    await run(svc.previewWidget(ID, { sizes: ['panel'], sessionId: 'sess-1' }))
    await run(svc.previewWidget(ID, { sizes: ['phone'], sessionId: 'sess-1' }))

    expect(fx.session.fromPartition.mock.calls.length).toBeGreaterThan(0)
    for (const call of fx.session.fromPartition.mock.calls) expect(call).toEqual(['widget-preview'])
    for (const w of windows()) {
      expect((w.opts.webPreferences as Record<string, unknown>).session).toBe(fx.fakeSession)
    }

    expect(fx.fakeSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(fx.fakeSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
    const downloads = fx.fakeSession.on.mock.calls.filter((c) => c[0] === 'will-download')
    expect(downloads).toHaveLength(1)

    const request = fx.fakeSession.setPermissionRequestHandler.mock.calls[0][0] as (
      wc: unknown,
      permission: string,
      cb: (granted: boolean) => void
    ) => void
    for (const permission of ['notifications', 'media', 'geolocation', 'openExternal']) {
      const cb = vi.fn()
      request({}, permission, cb)
      expect(cb.mock.calls, permission).toEqual([[false]])
    }
    const check = fx.fakeSession.setPermissionCheckHandler.mock.calls[0][0] as (
      ...a: unknown[]
    ) => boolean
    expect(check({}, 'notifications', URL_OF(ID), {})).toBe(false)
    const willDownload = downloads[0][1] as (event: { preventDefault: () => void }) => void
    const event = { preventDefault: vi.fn() }
    willDownload(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('U-PV-21 (B4) dialogs are disabled and alert / confirm / prompt / print become no-ops', async () => {
    await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))
    for (const w of windows()) {
      expect((w.opts.webPreferences as Record<string, unknown>).disableDialogs, w.size).toBe(true)
    }
    const scripts = fx.log
      .filter((e) => e.op === 'cdp')
      .map((e) => e.arg as { method: string; params: { source?: string } })
      .filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument')
    expect(scripts).toHaveLength(3)

    // 在一个假的 window 上真跑一遍那段脚本：四个都被换掉，且什么都不弹
    const original = {
      alert: vi.fn(),
      confirm: vi.fn(() => true),
      prompt: vi.fn(() => 'typed'),
      print: vi.fn()
    }
    const win: Record<string, (...a: unknown[]) => unknown> = { ...original }
    runInNewContext(scripts[0].params.source!, { window: win })
    expect(win.alert('hi')).toBeUndefined()
    expect(win.confirm('sure?')).toBe(false)
    expect(win.prompt('name?')).toBeNull()
    expect(win.print()).toBeUndefined()
    for (const fn of Object.values(original)) expect(fn).not.toHaveBeenCalled()
  })
})

describe('previewWidget: queue and waits', () => {
  it('U-PV-18 one preview at a time: the second starts only after the first has finished', async () => {
    let release!: (v: { url: string; buildSuccess: boolean }) => void
    fx.startWidget.mockImplementationOnce((id) => {
      fx.log.push({ op: 'startWidget', arg: id })
      return new Promise((r) => (release = r))
    })
    const first = svc.previewWidget('pv-one', { sizes: ['panel'], sessionId: 'sess-1' })
    const second = svc.previewWidget('pv-two', { sizes: ['phone'], sessionId: 'sess-1' })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(fx.startWidget.mock.calls).toEqual([['pv-one']])

    release({ url: URL_OF('pv-one'), buildSuccess: true })
    const [r1, r2] = await run(Promise.all([first, second]))
    expect(r1.id).toBe('pv-one')
    expect(r1.images.map((i) => [i.size, i.path])).toEqual([
      ['panel', join(previewDir('sess-1'), 'pv-one-panel.png')]
    ])
    expect(r2.id).toBe('pv-two')
    expect(r2.images.map((i) => [i.size, i.path])).toEqual([
      ['phone', join(previewDir('sess-1'), 'pv-two-phone.png')]
    ])
    // 第二个的 startWidget 在第一个的窗口销毁之后
    const panelGone = fx.log.findIndex((e) => e.size === 'panel' && e.op === 'destroy')
    const secondStart = fx.log.findIndex((e) => e.op === 'startWidget' && e.arg === 'pv-two')
    expect(panelGone).toBeGreaterThanOrEqual(0)
    expect(secondStart).toBeGreaterThan(panelGone)
  })

  it('U-PV-18b the first rejecting does not stop the second', async () => {
    let fail!: (e: Error) => void
    fx.startWidget.mockImplementationOnce(() => new Promise((_r, j) => (fail = j)))
    const first = svc.previewWidget('pv-one', { sessionId: 'sess-1' })
    const second = svc.previewWidget('pv-two', { sizes: ['panel'], sessionId: 'sess-1' })
    const firstErr = first.then(
      () => null,
      (e: Error) => e
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(fx.startWidget).toHaveBeenCalledTimes(1)

    fail(new Error('Widget "pv-one" not found'))
    expect((await run(firstErr))?.message).toBe('Widget "pv-one" not found')
    const out = await run(second)
    expect(out.id).toBe('pv-two')
    expect(out.images).toHaveLength(1)
  })

  it('U-PV-19 mount wait: proceeds once #root has content', async () => {
    fx.hooks.mount = (_wc, n) => Promise.resolve(n > 3)
    const out = await run(svc.previewWidget(ID, { sizes: ['panel'], sessionId: 'sess-1' }))
    expect(out.errors).toEqual([])
    expect(out.images).toHaveLength(1)
    expect(windowOf('panel').webContents.mountProbes).toBe(4)
  })

  it('U-PV-19b mount wait: never mounting still captures after ~5s, with no error', async () => {
    const at: Record<string, number> = {}
    fx.hooks.mount = () => Promise.resolve(false)
    fx.hooks.loadURL = (_wc, url) => {
      if (url !== 'about:blank') at.loaded = Date.now()
      return Promise.resolve()
    }
    fx.hooks.capture = (wc) => {
      at.captured = Date.now()
      return Promise.resolve(new fx.FakeImage(wc.spec.width, wc.spec.height, wc.size))
    }
    const out = await run(svc.previewWidget(ID, { sizes: ['panel'], sessionId: 'sess-1' }))
    expect(out.errors).toEqual([])
    expect(out.images).toHaveLength(1)
    // 5s 的挂载等待 + 800ms 的 settle；轮询间隔 100ms
    expect(at.captured - at.loaded).toBeGreaterThanOrEqual(5_000 + 800)
    expect(at.captured - at.loaded).toBeLessThan(5_000 + 800 + 500)
    const probes = windowOf('panel').webContents.mountProbes
    expect(probes).toBeGreaterThanOrEqual(40)
    expect(probes).toBeLessThanOrEqual(51)
  })

  it('U-PV-19c the fonts wait never resolving is bounded by 2s and is not an error', async () => {
    const at: Record<string, number> = {}
    fx.hooks.fonts = () => {
      at.fonts = Date.now()
      return never()
    }
    fx.hooks.capture = (wc) => {
      at.captured = Date.now()
      return Promise.resolve(new fx.FakeImage(wc.spec.width, wc.spec.height, wc.size))
    }
    const out = await run(svc.previewWidget(ID, { sizes: ['panel'], sessionId: 'sess-1' }))
    expect(out.errors).toEqual([])
    expect(out.images).toHaveLength(1)
    expect(at.captured - at.fonts).toBe(2_000 + 800)
  })
})

describe('previewWidget: every step is bounded (B3)', () => {
  it('U-PV-20 a page whose main thread never answers fails that size, is destroyed, and does not block the queue', async () => {
    fx.hooks.mount = (wc) => (wc.size === 'panel' ? never() : Promise.resolve(true))
    fx.hooks.fonts = (wc) => (wc.size === 'panel' ? never() : Promise.resolve(true))
    const first = svc.previewWidget(ID, { sessionId: 'sess-1' })
    const queued = svc.previewWidget('pv-y', { sizes: ['window'], sessionId: 'sess-1' })

    const out = await run(first)
    expect(out.errors).toEqual(['[panel] preview failed: checking the page timed out after 5000ms'])
    expect(out.images.map((i) => i.size)).toEqual(['window', 'phone'])
    const panel = windows().find((w) => w.size === 'panel')!
    expect(panel.destroy).toHaveBeenCalledTimes(1)
    expect(panel.webContents.debugger.detach).toHaveBeenCalledTimes(1)

    const next = await run(queued)
    expect(next.id).toBe('pv-y')
    expect(next.images.map((i) => i.size)).toEqual(['window'])
  })

  it.each([
    ['Page.addScriptToEvaluateOnNewDocument', 'panel'],
    ['Emulation.setDeviceMetricsOverride', 'window'],
    ['Emulation.setTouchEmulationEnabled', 'phone'],
    ['Emulation.setEmulatedMedia', 'phone']
  ] as Array<[string, Size]>)(
    'U-PV-20b a CDP command (%s on %s) that never answers times out after 5s',
    async (method, size) => {
      fx.hooks.cdp = (wc, m) => (wc.size === size && m === method ? never() : Promise.resolve({}))
      const out = await run(svc.previewWidget(ID, { theme: 'dark', sessionId: 'sess-1' }))
      expect(out.errors).toEqual([`[${size}] preview failed: ${method} timed out after 5000ms`])
      expect(out.images.map((i) => i.size)).toEqual(ALL.filter((s) => s !== size))
      expect(windowOf(size).destroy).toHaveBeenCalledTimes(1)
      // 卡住的那一扇没有往下载入 widget
      expect(
        fx.log.some((e) => e.size === size && e.op === 'loadURL' && e.arg === URL_OF(ID))
      ).toBe(false)
    }
  )

  it('U-PV-20c capturePage never answering times out after 5s', async () => {
    fx.hooks.capture = (wc) =>
      wc.size === 'window'
        ? never()
        : Promise.resolve(new fx.FakeImage(wc.spec.width, wc.spec.height, wc.size))
    const out = await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))
    expect(out.errors).toEqual([
      '[window] preview failed: capturing the page timed out after 5000ms'
    ])
    expect(out.images.map((i) => i.size)).toEqual(['panel', 'phone'])
    expect(windowOf('window').destroy).toHaveBeenCalledTimes(1)
  })
})

describe('previewWidget: session id and window options', () => {
  it.each(['../../evil', 'a/b', 'a\\b', '..'])(
    'U-PV-22 (B5) unsafe session id %j rejects before anything runs; nothing is written',
    async (sessionId) => {
      const err = await runRejected(svc.previewWidget(ID, { sessionId }))
      expect(err.message).toBe('invalid session id')
      expect(fx.startWidget).not.toHaveBeenCalled()
      expect(windows()).toHaveLength(0)
      expect(readdirSync(fx.tmpRoot)).toEqual([])
    }
  )

  it('U-PV-22b an invalid widget id is still reported first', async () => {
    const err = await runRejected(svc.previewWidget('Bad_Id', { sessionId: '../x' }))
    expect(err.message).toContain('Invalid widget id')
  })

  it('U-PV-23 hidden, unfocusable, no offscreen rendering; nothing is ever shown or focused', async () => {
    await run(svc.previewWidget(ID, { sessionId: 'sess-1' }))
    expect(windows()).toHaveLength(3)
    for (const w of windows()) {
      const { width, height } = fx.SPEC[w.size]
      expect(w.opts, w.size).toMatchObject({
        show: false,
        focusable: false,
        skipTaskbar: true,
        frame: false,
        paintWhenInitiallyHidden: true,
        useContentSize: true,
        width,
        height
      })
      expect('offscreen' in w.opts, w.size).toBe(false)
      const prefs = w.opts.webPreferences as Record<string, unknown>
      // 离屏渲染加 CDP 的设备模拟把主进程打崩过（SIGSEGV）
      expect('offscreen' in prefs, w.size).toBe(false)
      expect(prefs, w.size).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      })
      for (const spy of [w.show, w.showInactive, w.focus, w.moveTop, w.restore]) {
        expect(spy, w.size).not.toHaveBeenCalled()
      }
    }
  })
})

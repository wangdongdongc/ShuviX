/**
 * 浏览器模块单测共用的假 electron —— 窗口、WebContentsView、app / dialog / shell / session。
 *
 * 用法（mock 工厂里动态 import 本文件，测试文件自己静态 import 同一个单例）：
 *
 * ```ts
 * vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)
 * import { fakeElectron } from './fakeElectron'
 * const fx = fakeElectron()
 * beforeEach(() => { vi.resetModules(); fx.reset() })
 * ```
 *
 * 状态挂在 globalThis 的一个 symbol 上：`vi.resetModules()` 之后 mock 工厂再 import 到的是本文件
 * 的**另一份**模块实例，两份必须看见同一张窗口表 / 同一批间谍。
 *
 * 记录的东西：
 *  - 每个窗口的 show / showInactive / focus / restore / moveTop / hide / destroy / loadURL /
 *    loadFile 都是间谍；isVisible / isMinimized / isFocused / isDestroyed 读可写的字段（用例直接拨）；
 *  - `contentView.addChildView / removeChildView` 与 `destroy` 按发生顺序写进**同一条**调用日志
 *    `fx.log`（`staging.add(v0)`、`win1.remove(v1)`、`win1.destroy`），「先从 A 摘下再挂到 B」
 *    按日志里的先后断；
 *  - 一个 view 同时挂在两个活着的窗口上时记进 `fx.doubleParented`（应当永远为空）；
 *  - view 的 setVisible / setBounds / webContents.setZoomFactor / close / capturePage / print 都是间谍，
 *    `webContents.on()` 收下处理函数（`fire` 手工触发，返回各处理函数的返回值，好 await 异步的）；
 *  - view 的 `webContents.debugger` 是一个真能收发的假 debugger（`createFakeDebugger`）：on / once / off
 *    按 EventEmitter 的语义增删处理函数（都是间谍），`message(method, params)` 以 Electron 的形状
 *    `('message', event, method, params)` 派发一条 CDP 事件，sendCommand 是间谍（缺省回 `{}`）；
 *  - `dialog.showOpenDialog` 是间谍（缺省回「用户取消」）—— 断「没弹原生文件框」用；
 *  - 停放窗口 = 构造选项 `focusable: false` 的那个（`fx.staging()`）；浏览器窗口 = 加载了
 *    `#browser-window` 的那些（`fx.browserWindows()`）。
 */
import { vi, type Mock } from 'vitest'

export type Handler = (...args: unknown[]) => unknown

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** capturePage 回的假 NativeImage 的 PNG 字节（签名 + 一点尾巴） */
export const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

export interface FakeNativeImage {
  isEmpty(): boolean
  toPNG(): Buffer
  getSize(): { width: number; height: number }
  resize(opts: { width: number }): FakeNativeImage
  toDataURL(): string
}

function fakeImage(): FakeNativeImage {
  const img: FakeNativeImage = {
    isEmpty: () => false,
    toPNG: () => Buffer.from(FAKE_PNG),
    getSize: () => ({ width: 1280, height: 800 }),
    resize: () => img,
    toDataURL: () => `data:image/png;base64,${FAKE_PNG.toString('base64')}`
  }
  return img
}

/** 假 `webContents.debugger`：处理函数真的挂上 / 摘下，事件真的派发到挂着的处理函数 */
export interface FakeDebugger {
  attach: Mock<(version?: string) => void>
  detach: Mock<() => void>
  sendCommand: Mock<(method: string, params?: Record<string, unknown>) => Promise<unknown>>
  on: Mock<(event: string, fn: Handler) => FakeDebugger>
  once: Mock<(event: string, fn: Handler) => FakeDebugger>
  off: Mock<(event: string, fn: Handler) => FakeDebugger>
  /** 派发一个事件给此刻挂着的处理函数（once 的派发一次即摘） */
  emit(event: string, ...args: unknown[]): void
  /** 以 Electron 的形状派发一条 CDP 事件：`('message', event, method, params)` */
  message(method: string, params?: Record<string, unknown>): void
  /** 此刻挂在某个事件上的处理函数个数 */
  listenerCount(event: string): number
}

/** 一个独立的假 debugger（view 的 webContents 各带一个；单测也可以单拿来造假 webContents） */
export function createFakeDebugger(): FakeDebugger {
  const listeners = new Map<string, Array<{ fn: Handler; once: boolean }>>()
  const add = (event: string, fn: Handler, once: boolean): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), { fn, once }])
  }
  const dbg: FakeDebugger = {
    attach: vi.fn<(version?: string) => void>(),
    detach: vi.fn<() => void>(),
    sendCommand: vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({})),
    on: vi.fn((event: string, fn: Handler) => {
      add(event, fn, false)
      return dbg
    }),
    once: vi.fn((event: string, fn: Handler) => {
      add(event, fn, true)
      return dbg
    }),
    off: vi.fn((event: string, fn: Handler) => {
      // EventEmitter.off 摘掉最近挂上的那一个同名处理函数
      const list = listeners.get(event) ?? []
      const at = list.map((l) => l.fn).lastIndexOf(fn)
      if (at >= 0) listeners.set(event, [...list.slice(0, at), ...list.slice(at + 1)])
      return dbg
    }),
    emit(event, ...args) {
      const list = listeners.get(event) ?? []
      listeners.set(
        event,
        list.filter((l) => !l.once)
      )
      for (const l of list) l.fn(...args)
    },
    message(method, params = {}) {
      dbg.emit('message', {}, method, params)
    },
    listenerCount: (event) => listeners.get(event)?.length ?? 0
  }
  return dbg
}

export interface FakeViewWebContents {
  id: number
  url: string
  /** loadURL 收到过的地址，按顺序 */
  loaded: string[]
  zoom: number
  destroyed: boolean
  openHandler: ((details: { url: string }) => unknown) | undefined
  handlers: Map<string, Handler[]>
  setWindowOpenHandler(fn: (details: { url: string }) => unknown): void
  loadURL: Mock<(url: string) => Promise<void>>
  getURL(): string
  getTitle(): string
  isDestroyed(): boolean
  getZoomFactor: Mock<() => number>
  setZoomFactor: Mock<(zoom: number) => void>
  close: Mock<() => void>
  capturePage: Mock<(rect?: Rect) => Promise<FakeNativeImage>>
  /** 原生打印（会弹系统打印框）—— 断「没打印」用 */
  print: Mock<(opts: unknown, cb?: (success: boolean, reason: string) => void) => void>
  debugger: FakeDebugger
  on(event: string, fn: Handler): FakeViewWebContents
  /** 触发 on() 收下的处理函数，回各自的返回值 */
  fire(event: string, ...args: unknown[]): unknown[]
}

export interface FakeView {
  /** `v<序号>`（创建顺序，从 0 起） */
  label: string
  opts: { webPreferences: Record<string, unknown> }
  setVisible: Mock<(visible: boolean) => void>
  setBounds: Mock<(bounds: Rect) => void>
  webContents: FakeViewWebContents
}

export interface FakeWindow {
  /** 停放窗口是 `staging`，其余 `win<n>`（创建顺序，从 1 起） */
  label: string
  opts: Record<string, unknown>
  visible: boolean
  minimized: boolean
  focused: boolean
  destroyed: boolean
  /** 此刻挂在它 contentView 上的 view */
  children: FakeView[]
  webContents: {
    id: number
    zoom: number
    send: Mock<(channel: string, payload: unknown) => void>
    getZoomFactor(): number
    setWindowOpenHandler: Mock
    on: Mock
  }
  contentView: {
    addChildView: Mock<(view: FakeView) => void>
    removeChildView: Mock<(view: FakeView) => void>
  }
  show: Mock<() => void>
  showInactive: Mock<() => void>
  focus: Mock<() => void>
  restore: Mock<() => void>
  moveTop: Mock<() => void>
  hide: Mock<() => void>
  destroy: Mock<() => void>
  loadURL: Mock<(url: string) => Promise<void>>
  loadFile: Mock<(path: string, opts?: { hash?: string }) => Promise<void>>
  on(event: string, fn: Handler): FakeWindow
  emit(event: string, ...args: unknown[]): void
  handlerCount(event: string): number
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  isDestroyed(): boolean
  getBounds(): Rect
}

export interface FakeSession {
  handlers: Map<string, Handler[]>
  permissionHandler: Handler | undefined
  on(event: string, fn: Handler): FakeSession
  setPermissionRequestHandler(fn: Handler): void
}

/** 会把窗口弄到用户眼前的那几个动作 */
export const SURFACING = ['show', 'showInactive', 'focus', 'restore', 'moveTop'] as const

export interface FakeElectron {
  windows: FakeWindow[]
  views: FakeView[]
  /** 各窗口 contentView 的增删与 destroy，按发生顺序 */
  log: string[]
  /** 挂上去时已经挂在另一个活着的窗口上的 view（`<view>: <旧窗口> + <新窗口>`） */
  doubleParented: string[]
  appHandlers: Map<string, Handler[]>
  /** 假窗口 getBounds 的回答 */
  bounds: Rect
  session: FakeSession
  app: {
    on(event: string, fn: Handler): void
    focus: Mock<(opts?: unknown) => void>
    getLocale(): string
  }
  dialog: {
    showMessageBox: Mock<
      (win: unknown, opts: Record<string, unknown>) => Promise<{ response: number }>
    >
    showOpenDialog: Mock<
      (
        win: unknown,
        opts: Record<string, unknown>
      ) => Promise<{ canceled: boolean; filePaths: string[] }>
    >
  }
  shell: { openExternal: Mock<(url: string) => Promise<void>> }
  fromPartition: Mock<(partition: string) => FakeSession>
  /** vi.mock('electron') 要回的模块 */
  module: Record<string, unknown>
  reset(): void
  staging(): FakeWindow | undefined
  browserWindows(): FakeWindow[]
  emitApp(event: string, ...args: unknown[]): void
  /** 清掉全部窗口上的动作记录与调用日志（只看接下来发生什么） */
  clearCalls(): void
  /** 某个窗口收到过的「弄到眼前」动作，`show×1` 这样的形式；一个没有就是空数组 */
  surfacingOf(win: FakeWindow): string[]
  /** 全部窗口的「弄到眼前」动作 + app.focus；一个没有就是空数组 */
  allSurfacing(): string[]
  /** 调用过 setVisible 且参数不是 `true` 的 view（`v0(false)`） */
  hiddenViews(): string[]
}

const KEY = Symbol.for('shuvix.test.browser.fakeElectron')

function create(): FakeElectron {
  let nextWcId = 7
  let nextViewWcId = 100
  let winSeq = 0

  const fx = {
    windows: [] as FakeWindow[],
    views: [] as FakeView[],
    log: [] as string[],
    doubleParented: [] as string[],
    appHandlers: new Map<string, Handler[]>(),
    bounds: { x: 10, y: 20, width: 900, height: 700 } as Rect
  } as FakeElectron

  const pushHandler = (map: Map<string, Handler[]>, event: string, fn: Handler): void => {
    map.set(event, [...(map.get(event) ?? []), fn])
  }

  class FakeBrowserWindow implements FakeWindow {
    label: string
    opts: Record<string, unknown>
    visible = false
    minimized = false
    focused = false
    destroyed = false
    children: FakeView[] = []
    webContents = {
      id: 0,
      zoom: 1,
      send: vi.fn<(channel: string, payload: unknown) => void>(),
      getZoomFactor(): number {
        return this.zoom
      },
      setWindowOpenHandler: vi.fn(),
      on: vi.fn()
    }
    contentView = {
      addChildView: vi.fn((view: FakeView) => {
        fx.log.push(`${this.label}.add(${view.label})`)
        for (const other of fx.windows) {
          if (other !== this && !other.destroyed && other.children.includes(view)) {
            fx.doubleParented.push(`${view.label}: ${other.label} + ${this.label}`)
          }
        }
        this.children = [...this.children.filter((v) => v !== view), view]
      }),
      removeChildView: vi.fn((view: FakeView) => {
        fx.log.push(`${this.label}.remove(${view.label})`)
        this.children = this.children.filter((v) => v !== view)
      })
    }
    show = vi.fn(() => {
      this.visible = true
    })
    showInactive = vi.fn(() => {
      this.visible = true
    })
    focus = vi.fn(() => {
      this.focused = true
    })
    restore = vi.fn(() => {
      this.minimized = false
    })
    moveTop = vi.fn()
    hide = vi.fn(() => {
      this.visible = false
      this.focused = false
    })
    /** Electron：destroy 不发 close，但保证随后发 closed（这里同步发）；挂着的 view 随窗口脱落 */
    destroy = vi.fn(() => {
      if (this.destroyed) return
      fx.log.push(`${this.label}.destroy`)
      this.destroyed = true
      this.visible = false
      this.focused = false
      this.children = []
      this.emit('closed')
    })
    loadURL = vi.fn(async (_url: string) => {})
    loadFile = vi.fn(async (_path: string, _opts?: { hash?: string }) => {})
    private handlers = new Map<string, Handler[]>()

    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      this.label = opts.focusable === false ? 'staging' : `win${++winSeq}`
      this.webContents.id = nextWcId++
      fx.windows.push(this)
    }
    on(event: string, fn: Handler): this {
      pushHandler(this.handlers, event, fn)
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.handlers.get(event) ?? []) fn(...args)
    }
    handlerCount(event: string): number {
      return this.handlers.get(event)?.length ?? 0
    }
    isVisible(): boolean {
      return this.visible
    }
    isMinimized(): boolean {
      return this.minimized
    }
    isFocused(): boolean {
      return this.focused
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    getBounds(): Rect {
      return { ...fx.bounds }
    }
  }

  class FakeWebContentsView implements FakeView {
    label: string
    opts: { webPreferences: Record<string, unknown> }
    setVisible = vi.fn<(visible: boolean) => void>()
    setBounds = vi.fn<(bounds: Rect) => void>()
    webContents: FakeViewWebContents

    constructor(opts: { webPreferences: Record<string, unknown> }) {
      this.opts = opts
      this.label = `v${fx.views.length}`
      const handlers = new Map<string, Handler[]>()
      const wc: FakeViewWebContents = {
        id: nextViewWcId++,
        url: '',
        loaded: [],
        zoom: 1,
        destroyed: false,
        openHandler: undefined,
        handlers,
        setWindowOpenHandler(fn) {
          wc.openHandler = fn
        },
        loadURL: vi.fn(async (u: string) => {
          wc.url = u
          wc.loaded.push(u)
        }),
        getURL: () => wc.url,
        getTitle: () => '',
        isDestroyed: () => wc.destroyed,
        getZoomFactor: vi.fn(() => wc.zoom),
        setZoomFactor: vi.fn((z: number) => {
          wc.zoom = z
        }),
        close: vi.fn(() => {
          wc.destroyed = true
        }),
        capturePage: vi.fn(async (_rect?: Rect) => fakeImage()),
        print: vi.fn(),
        debugger: createFakeDebugger(),
        on(event, fn) {
          pushHandler(handlers, event, fn)
          return wc
        },
        fire(event, ...args) {
          return (handlers.get(event) ?? []).map((fn) => fn(...args))
        }
      }
      this.webContents = wc
      fx.views.push(this)
    }
  }

  const session: FakeSession = {
    handlers: new Map(),
    permissionHandler: undefined,
    on(event, fn) {
      pushHandler(session.handlers, event, fn)
      return session
    },
    setPermissionRequestHandler(fn) {
      session.permissionHandler = fn
    }
  }
  fx.session = session
  fx.fromPartition = vi.fn((_partition: string) => session)

  fx.app = {
    on: (event, fn) => pushHandler(fx.appHandlers, event, fn),
    focus: vi.fn(),
    getLocale: () => 'en-US'
  }
  fx.dialog = {
    showMessageBox: vi.fn(async () => ({ response: 1 })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] }))
  }
  fx.shell = { openExternal: vi.fn(async () => {}) }

  fx.module = {
    BrowserWindow: FakeBrowserWindow,
    WebContentsView: FakeWebContentsView,
    app: fx.app,
    dialog: fx.dialog,
    shell: fx.shell,
    session: { fromPartition: (partition: string) => fx.fromPartition(partition) }
  }

  fx.reset = () => {
    fx.windows.length = 0
    fx.views.length = 0
    fx.log.length = 0
    fx.doubleParented.length = 0
    fx.appHandlers.clear()
    fx.bounds = { x: 10, y: 20, width: 900, height: 700 }
    session.handlers.clear()
    session.permissionHandler = undefined
    fx.fromPartition.mockClear()
    fx.app.focus.mockReset()
    fx.dialog.showMessageBox.mockReset()
    fx.dialog.showMessageBox.mockImplementation(async () => ({ response: 1 }))
    fx.dialog.showOpenDialog.mockReset()
    fx.dialog.showOpenDialog.mockImplementation(async () => ({ canceled: true, filePaths: [] }))
    fx.shell.openExternal.mockReset()
    fx.shell.openExternal.mockImplementation(async () => {})
    nextWcId = 7
    nextViewWcId = 100
    winSeq = 0
  }
  fx.staging = () => fx.windows.find((w) => w.opts.focusable === false)
  fx.browserWindows = () =>
    fx.windows.filter(
      (w) =>
        w.loadFile.mock.calls.some(([, o]) => o?.hash === 'browser-window') ||
        w.loadURL.mock.calls.some(([u]) => u.endsWith('#browser-window'))
    )
  fx.emitApp = (event, ...args) => {
    for (const fn of fx.appHandlers.get(event) ?? []) fn(...args)
  }
  fx.clearCalls = () => {
    fx.log.length = 0
    for (const w of fx.windows) {
      for (const fn of [
        w.show,
        w.showInactive,
        w.focus,
        w.restore,
        w.moveTop,
        w.hide,
        w.destroy,
        w.contentView.addChildView,
        w.contentView.removeChildView
      ]) {
        fn.mockClear()
      }
    }
    for (const v of fx.views) {
      v.setBounds.mockClear()
      v.webContents.setZoomFactor.mockClear()
    }
    fx.app.focus.mockClear()
  }
  fx.surfacingOf = (win) =>
    SURFACING.filter((name) => win[name].mock.calls.length > 0).map(
      (name) => `${name}×${win[name].mock.calls.length}`
    )
  fx.allSurfacing = () => [
    ...fx.windows.flatMap((w) => fx.surfacingOf(w).map((s) => `${w.label}.${s}`)),
    ...(fx.app.focus.mock.calls.length > 0 ? [`app.focus×${fx.app.focus.mock.calls.length}`] : [])
  ]
  fx.hiddenViews = () =>
    fx.views.flatMap((v) =>
      v.setVisible.mock.calls
        .filter((args) => !(args.length === 1 && args[0] === true))
        .map((args) => `${v.label}(${args.map(String).join(', ')})`)
    )
  return fx
}

/** 本文件的单例（跨 `vi.resetModules()` 的多份模块实例共用） */
export function fakeElectron(): FakeElectron {
  const g = globalThis as unknown as Record<symbol, FakeElectron | undefined>
  return (g[KEY] ??= create())
}

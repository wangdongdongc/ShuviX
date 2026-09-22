/**
 * browserViewService 里 tab 弹窗的去向 —— 接线这一层。
 *
 * 每个 tab 的 setWindowOpenHandler 一律同步回 deny（面板从不真开新窗口），目标按
 * externalOpenDecision 分流：web 在面板新开并激活一个 tab；open 直接 shell.openExternal；ask 先弹
 * 原生询问框（默认按钮是取消，detail 首行是目标、后面是发起页面），点了「打开」才交给系统，一次
 * 只弹一个、拒绝后静默一阵；refuse 只记日志。initBrowserSession 的权限处理器是页面**导航**到外部
 * 协议的那道门，一律回 false。
 *
 * electron 整个换成假件：WebContentsView 记下构造选项、加载过的地址与 window.open handler，
 * dialog / shell / session 是间谍。externalOpen 与 i18n 用真的 —— 询问框里得是真的英文文案，才看得
 * 出 detail 是逐行拼出来的、没走插值（EO-51：地址里的 `{{page}}` 不能被换成发起页面）。
 *
 * 模块级状态（tab 表、宿主窗口、partition 初始化标记、询问节流的锁与静默期）每条用例都要新的：
 * 一个没答的询问框会把下一条用例的询问一直挡住，光换假时钟不够。所以 beforeEach 里 resetModules，
 * 用例里 load() 重新导入。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { clipUrl } from '../externalOpen'

/** dialog.showMessageBox 收到的选项里本文件关心的那几项 */
interface MessageBoxOptions {
  type: string
  buttons: string[]
  defaultId: number
  cancelId: number
  message: string
  detail: string
}

type OpenHandler = (details: { url: string }) => unknown

type PermissionHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: Record<string, unknown>
) => void

/** 假 WebContentsView（见下面 electron 的 mock） */
interface FakeView {
  opts: { webPreferences: Record<string, unknown> }
  webContents: {
    /** loadURL 收到过的地址，按顺序 */
    loaded: string[]
    openHandler: OpenHandler | undefined
  }
}

/** 假宿主窗口：isDestroyed 按用例拨，send 是间谍 */
interface FakeHost {
  destroyed: boolean
  isDestroyed(): boolean
  webContents: { send: Mock<(channel: string, payload: unknown) => void>; getZoomFactor(): number }
  contentView: { addChildView(): void; removeChildView(): void }
}

const state = vi.hoisted(() => {
  const s = {
    /** new WebContentsView 出来的假 view，按创建顺序 */
    views: [] as FakeView[],
    /** initBrowserSession 登记到 partition 上的权限处理器 */
    permissionHandler: undefined as PermissionHandler | undefined,
    showMessageBox:
      vi.fn<(win: unknown, opts: MessageBoxOptions) => Promise<{ response: number }>>(),
    openExternal: vi.fn<(url: string) => Promise<void>>(),
    fromPartition: vi.fn((_partition: string) => ({
      setPermissionRequestHandler(handler: PermissionHandler): void {
        s.permissionHandler = handler
      }
    })),
    host: undefined as unknown as FakeHost
  }
  return s
})

// mock 路径按**测试文件**解析：被测模块在 services/browser/，测试在其 __tests__/ 下
vi.mock('electron', () => ({
  WebContentsView: class {
    opts: unknown
    webContents = {
      url: '',
      loaded: [] as string[],
      openHandler: undefined as OpenHandler | undefined,
      setWindowOpenHandler(fn: OpenHandler) {
        this.openHandler = fn
      },
      loadURL(u: string) {
        this.url = u
        this.loaded.push(u)
        return Promise.resolve()
      },
      getURL() {
        return this.url
      },
      on() {},
      getTitle: () => '',
      isDestroyed: () => false,
      getZoomFactor: () => 1,
      setZoomFactor() {},
      close() {}
    }
    constructor(opts: unknown) {
      this.opts = opts
      state.views.push(this as never)
    }
    setVisible(): void {}
    setBounds(): void {}
  },
  BrowserWindow: class {},
  dialog: { showMessageBox: state.showMessageBox },
  session: { fromPartition: state.fromPartition },
  shell: { openExternal: state.openExternal },
  // 真的 i18n 模块 import 了它（initI18n 给了语言就不会去读）
  app: { getLocale: () => 'en-US' }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))
vi.mock('../../../dao/settingsDao', () => ({ settingsDao: { findByKey: () => undefined } }))
vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    handleExternalDetach: vi.fn(),
    cdpState: () => ({ attached: false, intercepting: false }),
    detachAll: vi.fn(async () => {})
  }
}))

type Service = typeof import('../browserViewService')

const OPENER = 'https://opener.example/page'
/** 假 Date 的起点（EO-45 / EO-47） */
const T = 1_800_000_000_000

function makeHost(): FakeHost {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    webContents: {
      send: vi.fn<(channel: string, payload: unknown) => void>(),
      getZoomFactor: () => 1
    },
    contentView: { addChildView() {}, removeChildView() {} }
  }
}

/** 重新导入被测模块（模块级状态全新），真 i18n 切到英文，登记宿主窗口 */
async function load(): Promise<Service> {
  const svc = await import('../browserViewService')
  const { initI18n } = await import('../../../i18n')
  initI18n('en')
  svc.initBrowserHost(state.host as never)
  return svc
}

/** 开一个 tab（loadURL 了 url，getURL 就报它），返回它的假 view */
function tabAt(svc: Service, url = OPENER): FakeView {
  svc.createTab(url)
  return state.views[state.views.length - 1]
}

/** 以这个 tab 的名义 window.open(url)：返回 handler 的**同步**返回值 */
function popup(view: FakeView, url: string): unknown {
  const handler = view.webContents.openHandler
  if (!handler) throw new Error('createTab 没有登记 setWindowOpenHandler')
  return handler({ url })
}

/** window.open(url)：handler 不抛，同步回 { action: 'deny' } */
function expectDeny(view: FakeView, url: string): void {
  let result: unknown
  expect(() => (result = popup(view, url))).not.toThrow()
  expect(result).toStrictEqual({ action: 'deny' })
}

/** 跑完已排队的微任务再过一轮宏任务：询问框答复 → confirm → then → openExternal */
function flush(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r))
}

/** 下一次询问框一直不答，返回作答函数（response 0 = Open，1 = Cancel） */
function holdNextDialog(): (response: number) => void {
  let answer: ((value: { response: number }) => void) | undefined
  state.showMessageBox.mockImplementationOnce(() => new Promise((r) => (answer = r)))
  return (response) => {
    if (!answer) throw new Error('询问框还没弹出来')
    answer({ response })
  }
}

/** 第 n 次（从 0 起）询问框的选项 */
function dialogAt(n = 0): MessageBoxOptions {
  const call = state.showMessageBox.mock.calls[n]
  if (!call) throw new Error(`第 ${n + 1} 次询问框没有弹`)
  return call[1]
}

/** 第 n 次询问框 detail 的各行 */
function detailLines(n = 0): string[] {
  return dialogAt(n).detail.split('\n')
}

/** 宿主窗口在某个频道上收到的 payload，按顺序 */
function sent(channel: string): unknown[] {
  return state.host.webContents.send.mock.calls.filter(([c]) => c === channel).map(([, p]) => p)
}

/** 用例期间进程级的未处理 rejection（vitest 自己也会让整轮失败，这里把它钉在用例上） */
function watchUnhandledRejections(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = []
  const onRejection = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on('unhandledRejection', onRejection)
  return { seen, stop: () => void process.off('unhandledRejection', onRejection) }
}

beforeEach(() => {
  vi.resetModules()
  state.views.length = 0
  state.permissionHandler = undefined
  state.showMessageBox.mockReset()
  state.showMessageBox.mockResolvedValue({ response: 1 })
  state.openExternal.mockReset()
  state.openExternal.mockResolvedValue(undefined)
  state.fromPartition.mockClear()
  state.host = makeHost()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('browserViewService：tab 弹窗的去向', () => {
  it.each([
    'https://example.com/',
    'mailto:x@y.z',
    'zoommtg://zoom.us/join?confno=1',
    'file:///Applications/',
    'about:blank',
    'not a url'
  ])('EO-32 handler 不抛、同步回 { action: deny }：%s', async (target) => {
    const svc = await load()
    const opener = tabAt(svc)
    holdNextDialog() // zoommtg 那一行的询问框一直不答
    expectDeny(opener, target)
  })

  it('EO-33 HTTP://EXAMPLE.com → 面板新开一个激活的 tab 加载规范化后的地址；不交给系统、不弹框', async () => {
    const svc = await load()
    const opener = tabAt(svc)
    expectDeny(opener, 'HTTP://EXAMPLE.com')

    expect(state.views).toHaveLength(2)
    const view = state.views[1]
    expect(view.opts.webPreferences.partition).toBe('persist:shuvix-browser')
    expect(view.opts.webPreferences.sandbox).toBe(true)
    expect(view.webContents.loaded).toEqual(['http://example.com/'])

    const created = sent('browser-view:tab-created')
    expect(created).toHaveLength(2)
    const { tabId } = created[1] as { tabId: string }
    expect(created[1]).toStrictEqual({ tabId, url: 'http://example.com/', active: true })
    expect(svc.getTabView(tabId)).toBe(view)
    expect(state.host.webContents.send).toHaveBeenCalledWith('browser-view:tab-activated', {
      tabId
    })
    expect(svc.getActiveView()).toBe(view)

    expect(state.openExternal).not.toHaveBeenCalled()
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it('EO-34 已开满 12 个 tab：http(s) 弹窗照样 deny、不抛，不开第 13 个，也不交给系统', async () => {
    const svc = await load()
    const opener = tabAt(svc)
    for (let i = 1; i < 12; i++) svc.createTab(`https://t${i}.example/`)
    expect(state.views).toHaveLength(12)

    expectDeny(opener, 'https://example.com/')
    expect(state.views).toHaveLength(12)
    expect(sent('browser-view:tab-created')).toHaveLength(12)
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('EO-35 MAILTO:x@y.z?subject=hi → 同步交给 shell.openExternal 一次（规范化后的地址）；不弹框、不开 tab', async () => {
    const svc = await load()
    const opener = tabAt(svc)
    expectDeny(opener, 'MAILTO:x@y.z?subject=hi')
    // handler 一返回就看，中间不 await：open 裁决不经过任何异步
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('mailto:x@y.z?subject=hi')
    expect(state.showMessageBox).not.toHaveBeenCalled()
    expect(state.views).toHaveLength(1)

    await flush()
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.showMessageBox).not.toHaveBeenCalled()
    expect(state.views).toHaveLength(1)
  })

  it('EO-36 询问框弹着时，mailto 照样立刻交给系统（不受询问节流）', async () => {
    const svc = await load()
    const opener = tabAt(svc)
    holdNextDialog()
    expectDeny(opener, 'zoommtg://zoom.us/join?confno=1')
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    expectDeny(opener, 'mailto:x@y.z')
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('mailto:x@y.z')
  })

  it('EO-36 刚点了取消（静默期内），mailto 也照样立刻交给系统', async () => {
    const svc = await load()
    const opener = tabAt(svc)
    const answer = holdNextDialog()
    expectDeny(opener, 'zoommtg://zoom.us/join?confno=1')
    answer(1)
    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()

    expectDeny(opener, 'mailto:x@y.z')
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('mailto:x@y.z')

    // 正控制组：确实在静默期里 —— 这时再来一个 ask 不会弹框
    expectDeny(opener, 'slack://open')
    await flush()
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('EO-37 自定义协议弹原生询问框：挂在宿主窗口上、警告、「Open / Cancel」默认与取消都是 Cancel；detail 首行是目标、后面有发起页面', async () => {
    const svc = await load()
    const opener = tabAt(svc)
    holdNextDialog()
    const target = 'zoommtg://zoom.us/join?confno=123'
    expectDeny(opener, target)

    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    const [win, opts] = state.showMessageBox.mock.calls[0]
    expect(win).toBe(state.host)
    expect(opts.type).toBe('warning')
    expect(opts.buttons).toEqual(['Open', 'Cancel'])
    expect(opts.buttons[opts.defaultId]).toBe('Cancel')
    expect(opts.buttons[opts.cancelId]).toBe('Cancel')
    expect(opts.message).toBe('Open this link in another app?')

    const lines = opts.detail.split('\n')
    expect(lines[0]).toBe(target)
    expect(lines.slice(1)).toContain(OPENER)
    expect(lines).toContain('Requested by the page in the browser panel:')
    expect(opts.detail).not.toContain('{{')

    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('EO-38 X-PROBE-CUSTOM://Upper：框里写的是规范化后的地址，点 Open 交给系统的也正是它', async () => {
    const svc = await load()
    const opener = tabAt(svc)
    const answer = holdNextDialog()
    expectDeny(opener, 'X-PROBE-CUSTOM://Upper')
    expect(detailLines()[0]).toBe('x-probe-custom://Upper')

    answer(0)
    await flush()
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('x-probe-custom://Upper')
  })

  it('EO-39 点 Cancel → 不交给系统', async () => {
    const svc = await load()
    const opener = tabAt(svc)
    const answer = holdNextDialog()
    expectDeny(opener, 'zoommtg://zoom.us/join?confno=123')
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    answer(1)
    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('EO-40 带 attach 的 mailto 不直接交出去而是先问；点 Open → 交给系统的是那个地址', async () => {
    const svc = await load()
    const opener = tabAt(svc)
    const answer = holdNextDialog()
    const target = 'mailto:x@y.z?attach=/etc/passwd'
    expectDeny(opener, target)
    expect(state.openExternal).not.toHaveBeenCalled()
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(detailLines()[0]).toBe(target)

    answer(0)
    await flush()
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith(target)
  })

  it('EO-40 带 attach 的 mailto，点 Cancel → 什么都不交出去', async () => {
    const svc = await load()
    const opener = tabAt(svc)
    const answer = holdNextDialog()
    const target = 'mailto:x@y.z?attach=/etc/passwd'
    expectDeny(opener, target)
    expect(state.openExternal).not.toHaveBeenCalled()
    expect(detailLines()[0]).toBe(target)

    answer(1)
    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it.each([
    ['file:///Users/me/index.html', 'file:///Applications/Calculator.app'],
    ['file:///Users/me/index.html', 'file:///Applications/'],
    [OPENER, 'c:/Windows/System32/calc.exe'],
    [OPENER, 'smb://host/share'],
    [OPENER, 'about:blank'],
    [OPENER, 'blob:http://127.0.0.1:5173/0b8f1f0e-3b8e-4d4a-9f0e-000000000000'],
    [OPENER, 'data:text/html,hi'],
    [OPENER, 'javascript:alert(1)'],
    [OPENER, 'not a url']
  ])(
    'EO-41 拒绝的目标：deny，不交给系统、不弹框、不开 tab（发起页 %s → %s）',
    async (openerUrl, target) => {
      const svc = await load()
      const opener = tabAt(svc, openerUrl)
      expectDeny(opener, target)
      await flush()
      expect(state.openExternal).not.toHaveBeenCalled()
      expect(state.showMessageBox).not.toHaveBeenCalled()
      expect(state.views).toHaveLength(1)
    }
  )

  it('EO-42 两个 tab：询问框里写的是真正发起的那个页面（B），不是别的 tab（A）', async () => {
    const svc = await load()
    tabAt(svc, 'https://a.example/one')
    const b = tabAt(svc, 'https://b.example/two')
    expectDeny(b, 'slack://open')

    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(detailLines()).toContain('https://b.example/two')
    expect(dialogAt().detail).not.toContain('a.example')
  })

  it('EO-43 超长的目标与发起页在框里都按 clipUrl 截断；点 Open 交出去的仍是完整的 5015 字地址', async () => {
    const target = 'zoommtg://x/?q=' + 'a'.repeat(5000)
    const openerUrl = 'https://opener.example/?' + 'b'.repeat(5000)
    const svc = await load()
    const opener = tabAt(svc, openerUrl)
    const answer = holdNextDialog()
    expectDeny(opener, target)

    const lines = detailLines()
    expect(lines[0]).toBe(clipUrl(target))
    expect(lines.slice(1)).toContain(clipUrl(openerUrl))

    answer(0)
    await flush()
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    const [opened] = state.openExternal.mock.calls[0]
    expect(opened).toHaveLength(5015)
    expect(opened).toBe(target)
  })

  it('EO-44 询问框弹着时别的 tab 再来问 → 不弹第二个；A 点 Open 只交出 A 的地址', async () => {
    const svc = await load()
    const a = tabAt(svc, 'https://a.example/one')
    const b = tabAt(svc, 'https://b.example/two')
    const answer = holdNextDialog()
    expectDeny(a, 'zoommtg://a')
    expectDeny(b, 'slack://open')
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    answer(0)
    await flush()
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('zoommtg://a')
    expect(state.openExternal.mock.calls.filter(([url]) => url.startsWith('slack:'))).toEqual([])
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('EO-45 点 Cancel 后 10 s 内（按 Date 计）哪个 tab 来问都不弹框；满 10 s 再弹', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T)
    const svc = await load()
    const a = tabAt(svc, 'https://a.example/one')
    const b = tabAt(svc, 'https://b.example/two')
    const answer = holdNextDialog()
    expectDeny(a, 'zoommtg://zoom.us/join?confno=1')
    answer(1)
    await flush()
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    vi.setSystemTime(T + 9999)
    expectDeny(b, 'slack://open')
    await flush()
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(state.openExternal).not.toHaveBeenCalled()

    vi.setSystemTime(T + 10_000)
    expectDeny(b, 'slack://open')
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('EO-46 点 Open 之后不静默：紧接着别的 tab 来问照样弹框', async () => {
    const svc = await load()
    const a = tabAt(svc, 'https://a.example/one')
    const b = tabAt(svc, 'https://b.example/two')
    const answer = holdNextDialog()
    expectDeny(a, 'zoommtg://a')
    answer(0)
    await flush()
    expect(state.openExternal).toHaveBeenCalledWith('zoommtg://a')

    expectDeny(b, 'slack://open')
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('EO-47 询问框本身失败（showMessageBox reject）：不交给系统、不留未处理的 rejection，按拒绝处理 —— 10 s 内不再弹', async () => {
    const unhandled = watchUnhandledRejections()
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(T)
      const svc = await load()
      const opener = tabAt(svc)
      state.showMessageBox.mockRejectedValueOnce(new Error('boom'))
      expectDeny(opener, 'zoommtg://zoom.us/join?confno=1')
      await flush()
      await flush()
      expect(state.showMessageBox).toHaveBeenCalledTimes(1)
      expect(state.openExternal).not.toHaveBeenCalled()

      vi.setSystemTime(T + 9999)
      expectDeny(opener, 'slack://open')
      await flush()
      expect(state.showMessageBox).toHaveBeenCalledTimes(1)

      vi.setSystemTime(T + 10_000)
      expectDeny(opener, 'slack://open')
      expect(state.showMessageBox).toHaveBeenCalledTimes(2)
      await flush()
      expect(state.openExternal).not.toHaveBeenCalled()
      expect(unhandled.seen).toEqual([])
    } finally {
      unhandled.stop()
    }
  })

  it('EO-48 宿主窗口已销毁：自定义协议不弹框、不交给系统；http(s) 也不开 tab —— 都照样 deny', async () => {
    const svc = await load()
    const opener = tabAt(svc)
    state.host.destroyed = true

    expectDeny(opener, 'zoommtg://x')
    await flush()
    expect(state.showMessageBox).not.toHaveBeenCalled()
    expect(state.openExternal).not.toHaveBeenCalled()

    expectDeny(opener, 'https://example.com/')
    expect(state.views).toHaveLength(1)
  })

  it('EO-49 shell.openExternal 失败（没有应用接）：mailto 与点了 Open 的询问两条路都不留未处理的 rejection', async () => {
    const unhandled = watchUnhandledRejections()
    try {
      const svc = await load()
      const opener = tabAt(svc)

      state.openExternal.mockRejectedValueOnce(new Error('no handler'))
      expectDeny(opener, 'mailto:x@y.z')
      expect(state.openExternal).toHaveBeenCalledTimes(1)
      await flush()
      await flush()

      state.openExternal.mockRejectedValueOnce(new Error('no handler'))
      const answer = holdNextDialog()
      expectDeny(opener, 'zoommtg://zoom.us/join?confno=1')
      answer(0)
      await flush()
      await flush()
      expect(state.openExternal).toHaveBeenCalledTimes(2)
      expect(state.openExternal).toHaveBeenLastCalledWith('zoommtg://zoom.us/join?confno=1')
      expect(unhandled.seen).toEqual([])
    } finally {
      unhandled.stop()
    }
  })

  it('EO-50 initBrowserSession：partition 只取一次；权限处理器对 openExternal（页面导航到外部协议）与 media 一律回 false', async () => {
    const svc = await load()
    svc.initBrowserSession()
    expect(state.fromPartition).toHaveBeenCalledTimes(1)
    expect(state.fromPartition).toHaveBeenCalledWith('persist:shuvix-browser')

    const handler = state.permissionHandler
    if (!handler) throw new Error('initBrowserSession 没有登记权限处理器')
    const fakeWc = { getURL: () => OPENER }

    const onExternal = vi.fn()
    handler(fakeWc, 'openExternal', onExternal, {
      externalURL: 'zoommtg://x',
      requestingUrl: OPENER
    })
    expect(onExternal).toHaveBeenCalledTimes(1)
    expect(onExternal).toHaveBeenCalledWith(false)
    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()

    const onMedia = vi.fn()
    handler(fakeWc, 'media', onMedia, { requestingUrl: OPENER })
    expect(onMedia).toHaveBeenCalledTimes(1)
    expect(onMedia).toHaveBeenCalledWith(false)

    svc.initBrowserSession()
    expect(state.fromPartition).toHaveBeenCalledTimes(1)
  })

  it('EO-51 地址里的 {{page}} 原样留在首行，不会被换成发起页面（detail 是逐行拼接，不走插值）', async () => {
    const svc = await load()
    const opener = tabAt(svc, 'https://evil.example/')

    for (const [n, target] of [
      'tel:{{page}}',
      'zoommtg://zoom.us/join?confno={{page}}'
    ].entries()) {
      const answer = holdNextDialog()
      expectDeny(opener, target)
      expect(state.showMessageBox).toHaveBeenCalledTimes(n + 1)

      const lines = detailLines(n)
      expect(lines[0]).toBe(target)
      expect(lines).toContain('https://evil.example/')
      expect(lines).not.toContain('{{page}}')

      // 点 Open：不起静默期，下一个目标照样弹框
      answer(0)
      await flush()
    }
  })
})

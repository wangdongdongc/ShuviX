/**
 * externalOpen/gate.ts —— 把裁决接到 electron 上的那一层：询问框、shell.openExternal、自有窗口的
 * 守卫、会话权限处理器。裁决表本身在 decision.test.ts（EO-1…18），这里只钉「接线」。
 *
 *  - AG-1…10  routeExternalUrl 的分流与**同一拍**契约：web / open / refuse 不经任何异步 ——
 *    弹窗 handler 里当场新开 tab、当场交给系统，只有 ask 进异步。这一档的断言刻意不 await。
 *  - AG-11…16 approveExternalUrl：只裁决、从不打开（权限处理器准了之后由 Electron 自己交给系统，
 *    这里再 openExternal 就是开两次）。
 *  - AG-17…23 approveOpenExternalPermission：没有 externalURL 直接拒，连窗口都不去找。
 *  - AG-24…30 询问框长什么样：挂在哪个窗口上、按钮、detail 逐行拼接（不走 i18next 插值 ——
 *    插值按首次出现替换占位符，地址里写一个 `{{…}}` 就能把框里显示的内容顶掉）、超长地址截断。
 *  - AG-31…38 两份询问节流（内容 / 用户亲手点）各自「一次一个」，内容那份拒绝后静默、用户那份不
 *    静默；两份互不相干，且都是进程级一份而不是按窗口各算各的。
 *  - AG-39…53 guardAppWindow：弹窗一律 deny 但照样过闸，顶层导航一律 preventDefault 后过闸，
 *    只有 dev 渲染端地址（按**源**比较，每次导航现读环境变量）放行。
 *
 * electron 整个换成假件：dialog / shell / BrowserWindow.fromWebContents 是间谍（gate.ts 只用到
 * BrowserWindow 这一个静态方法，其余都是类型），窗口是只有 isDestroyed 与 webContents 的假对象。
 * externalOpen 与 i18n 用真的 —— 框里得是真的英文文案，才看得出 detail 没走插值。
 *
 * 模块级状态（gate.ts 里那两份 createExternalOpenAsk 闭包的锁与静默期）每条用例都要新的：一个没答
 * 的询问框会把下一条用例的询问一直挡住，光换假时钟不够。所以 load() 里 resetModules 再重新导入，
 * 且走 barrel（'../index'）—— 顺带覆盖它的再导出。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { clipUrl } from '../decision'
import type { ExternalOpenSource } from '../index'

/** dialog.showMessageBox 收到的选项里本文件关心的那几项 */
interface MessageBoxOptions {
  type: string
  buttons: string[]
  defaultId: number
  cancelId: number
  message: string
  detail: string
}

type PopupHandler = (details: { url: string }) => unknown
type NavListener = (event: FakeNavEvent, url: string) => void

/** will-navigate 的假事件：只关心 preventDefault 有没有被调 */
interface FakeNavEvent {
  preventDefault: Mock<() => void>
}

/** 假窗口：isDestroyed 按用例拨，两个登记口是间谍 —— 守卫装的 handler 从这里取回来 */
interface FakeWindow {
  destroyed: boolean
  isDestroyed(): boolean
  webContents: {
    setWindowOpenHandler: Mock<(handler: PopupHandler) => void>
    on: Mock<(event: string, listener: NavListener) => void>
  }
}

const state = vi.hoisted(() => {
  const s = {
    showMessageBox:
      vi.fn<(win: unknown, opts: MessageBoxOptions) => Promise<{ response: number }>>(),
    openExternal: vi.fn<(url: string) => Promise<void>>(),
    fromWebContents: vi.fn<(webContents: unknown) => unknown>(),
    /** 默认窗口；fromWebContents 缺省就报它（AG-22 改成 null） */
    win: undefined as unknown as FakeWindow
  }
  return s
})

// mock 路径按**测试文件**解析：被测模块在 services/externalOpen/，测试在其 __tests__/ 下，
// 所以 gate.ts 里的 '../../logger' 在这里是三层
vi.mock('electron', () => ({
  dialog: { showMessageBox: state.showMessageBox },
  shell: { openExternal: state.openExternal },
  // gate.ts 只用到这一个静态方法，BrowserWindow 的其余出现都是类型
  BrowserWindow: { fromWebContents: state.fromWebContents },
  // 真的 i18n 模块 import 了它（initI18n 给了语言就不会去读）
  app: { getLocale: () => 'en-US' }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))

type Gate = typeof import('../index')

/** 真 en 文案（与 packages/chat-protocol/src/i18n/locales/en.json 一致） */
const TITLE = 'Open this link in another app?'
const HINT =
  'Your system will hand the link to whichever app handles it. Only open it if you expected this.'
const FROM_WIDGET = 'Requested by the widget:'

const WIDGET_SOURCE: ExternalOpenSource = {
  labelKey: 'externalOpen.fromWidget',
  value: 'My Widget'
}

/** 假 Date 的起点 */
const T = 1_800_000_000_000

/** dev 渲染端地址（AG-43 / 47…52） */
const DEV_URL = 'http://localhost:5173'

/** 重新导入被测模块（两份询问节流全新），真 i18n 切到英文 */
async function load(): Promise<Gate> {
  vi.resetModules()
  const { initI18n } = await import('../../../i18n')
  initI18n('en')
  return await import('../index')
}

function makeWindow(): FakeWindow {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    webContents: {
      setWindowOpenHandler: vi.fn<(handler: PopupHandler) => void>(),
      on: vi.fn<(event: string, listener: NavListener) => void>()
    }
  }
}

/** 假窗口按 BrowserWindow 交出去：gate.ts 只碰 isDestroyed 与 webContents 上那两个登记口 */
function asWin(win: FakeWindow): BrowserWindow {
  return win as never
}

/** 新开一个装好守卫的假窗口 */
function guarded(gate: Gate, source?: ExternalOpenSource): FakeWindow {
  const win = makeWindow()
  gate.guardAppWindow(asWin(win), source)
  return win
}

function popupHandler(win: FakeWindow): PopupHandler {
  const call = win.webContents.setWindowOpenHandler.mock.calls[0]
  if (!call) throw new Error('guardAppWindow 没有登记 setWindowOpenHandler')
  return call[0]
}

function navHandler(win: FakeWindow): NavListener {
  const call = win.webContents.on.mock.calls.find(([event]) => event === 'will-navigate')
  if (!call) throw new Error('guardAppWindow 没有登记 will-navigate')
  return call[1]
}

/** 以这个窗口的名义 window.open(url)：返回 handler 的**同步**返回值 */
function popup(win: FakeWindow, url: string): unknown {
  return popupHandler(win)({ url })
}

/** 这个窗口顶层导航到 url：返回那个假事件，看 preventDefault 有没有被调 */
function navigate(win: FakeWindow, url: string): FakeNavEvent {
  const event: FakeNavEvent = { preventDefault: vi.fn<() => void>() }
  navHandler(win)(event, url)
  return event
}

/** window.open(url)：handler 不抛，同步回 { action: 'deny' } */
function expectDeny(win: FakeWindow, url: string): void {
  let result: unknown
  expect(() => (result = popup(win, url))).not.toThrow()
  expect(result).toStrictEqual({ action: 'deny' })
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

/** 第 n 次询问框挂在哪个窗口上 */
function parentAt(n = 0): unknown {
  const call = state.showMessageBox.mock.calls[n]
  if (!call) throw new Error(`第 ${n + 1} 次询问框没有弹`)
  return call[0]
}

/** 第 n 次询问框 detail 的各行 */
function detailLines(n = 0): string[] {
  return dialogAt(n).detail.split('\n')
}

/** 跑完已排队的微任务再过一轮宏任务：询问框答复 → confirm → then → openExternal */
function flush(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r))
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

/** 一律拒绝（file / 盘符 / 网络共享 / 浏览器内部 / 解析不了）的一组目标 */
const REFUSED = [
  'file:///Applications/Calculator.app',
  'c:/Windows/System32/calc.exe',
  'smb://host/share',
  'about:blank',
  'data:text/html,hi',
  'not a url'
]

beforeEach(() => {
  state.showMessageBox.mockReset()
  state.showMessageBox.mockResolvedValue({ response: 1 })
  state.openExternal.mockReset()
  state.openExternal.mockResolvedValue(undefined)
  state.win = makeWindow()
  state.fromWebContents.mockReset()
  state.fromWebContents.mockImplementation(() => state.win)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('routeExternalUrl：过闸并执行', () => {
  it('AG-1 http(s) 有 onWeb 就交给它（规范化后的地址），不交给系统、不弹框', async () => {
    const gate = await load()
    const onWeb = vi.fn<(url: string) => void>()
    await expect(
      gate.routeExternalUrl('HTTP://EXAMPLE.com', { parent: asWin(state.win), onWeb })
    ).resolves.toBe(true)

    expect(onWeb).toHaveBeenCalledTimes(1)
    expect(onWeb).toHaveBeenCalledWith('http://example.com/')
    expect(state.openExternal).not.toHaveBeenCalled()
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it('AG-2 http(s) 没有 onWeb → 交给系统浏览器（规范化后的地址），不弹框', async () => {
    const gate = await load()
    await expect(
      gate.routeExternalUrl('HTTP://EXAMPLE.com', { parent: asWin(state.win) })
    ).resolves.toBe(true)

    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('http://example.com/')
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it('AG-3 mailto: 直接交给系统，不走 onWeb、不弹框', async () => {
    const gate = await load()
    const onWeb = vi.fn<(url: string) => void>()
    await expect(
      gate.routeExternalUrl('MAILTO:x@y.z?subject=hi', { parent: asWin(state.win), onWeb })
    ).resolves.toBe(true)

    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('mailto:x@y.z?subject=hi')
    expect(onWeb).not.toHaveBeenCalled()
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it.each(REFUSED)('AG-4 拒绝的目标：什么都不调，回 false：%s', async (target) => {
    const gate = await load()
    const onWeb = vi.fn<(url: string) => void>()
    await expect(gate.routeExternalUrl(target, { parent: asWin(state.win), onWeb })).resolves.toBe(
      false
    )

    expect(onWeb).not.toHaveBeenCalled()
    expect(state.openExternal).not.toHaveBeenCalled()
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it('AG-5 ask 点 Open → true，交给系统的正是框里那个规范化后的地址', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const asked = gate.routeExternalUrl('X-PROBE-CUSTOM://Upper', { parent: asWin(state.win) })

    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(detailLines()[0]).toBe('x-probe-custom://Upper')
    expect(state.openExternal).not.toHaveBeenCalled()

    answer(0)
    await expect(asked).resolves.toBe(true)
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('x-probe-custom://Upper')
  })

  it('AG-6 ask 点 Cancel → false，什么都不交出去', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const asked = gate.routeExternalUrl('X-PROBE-CUSTOM://Upper', { parent: asWin(state.win) })
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    answer(1)
    await expect(asked).resolves.toBe(false)
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('AG-7 ask 那一档从不走 onWeb：点了 Open 也是交给系统', async () => {
    const gate = await load()
    const onWeb = vi.fn<(url: string) => void>()
    const answer = holdNextDialog()
    const asked = gate.routeExternalUrl('zoommtg://zoom.us/join?confno=1', {
      parent: asWin(state.win),
      onWeb
    })
    expect(onWeb).not.toHaveBeenCalled()

    answer(0)
    await expect(asked).resolves.toBe(true)
    expect(onWeb).not.toHaveBeenCalled()
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('zoommtg://zoom.us/join?confno=1')
  })

  it('AG-8 同一拍：web / open / refuse 不经任何异步，ask 的框也是同一拍弹出来的', async () => {
    const gate = await load()
    const onWeb = vi.fn<(url: string) => void>()
    const answer = holdNextDialog()

    // 下面每一段调用与断言之间都**不** await —— 这一条要钉的就是「不经异步」
    const web = gate.routeExternalUrl('HTTP://EXAMPLE.com', { parent: asWin(state.win), onWeb })
    expect(onWeb).toHaveBeenCalledTimes(1)
    expect(onWeb).toHaveBeenCalledWith('http://example.com/')
    expect(state.openExternal).not.toHaveBeenCalled()

    const open = gate.routeExternalUrl('mailto:x@y.z', { parent: asWin(state.win) })
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('mailto:x@y.z')

    const refuse = gate.routeExternalUrl('file:///Applications/Calculator.app', {
      parent: asWin(state.win),
      onWeb
    })
    expect(onWeb).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.showMessageBox).not.toHaveBeenCalled()

    const ask = gate.routeExternalUrl('zoommtg://x', { parent: asWin(state.win) })
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledTimes(1)

    await expect(web).resolves.toBe(true)
    await expect(open).resolves.toBe(true)
    await expect(refuse).resolves.toBe(false)
    answer(1)
    await expect(ask).resolves.toBe(false)
  })

  it('AG-9 shell.openExternal 失败（没有应用接）：open 与点了 Open 的 ask 都不留未处理的 rejection，照样回 true', async () => {
    const unhandled = watchUnhandledRejections()
    try {
      const gate = await load()

      state.openExternal.mockRejectedValueOnce(new Error('no handler'))
      await expect(
        gate.routeExternalUrl('mailto:x@y.z', { parent: asWin(state.win) })
      ).resolves.toBe(true)
      await flush()
      await flush()

      state.openExternal.mockRejectedValueOnce(new Error('no handler'))
      const answer = holdNextDialog()
      const asked = gate.routeExternalUrl('zoommtg://zoom.us/join?confno=1', {
        parent: asWin(state.win)
      })
      answer(0)
      await expect(asked).resolves.toBe(true)
      await flush()
      await flush()

      expect(state.openExternal).toHaveBeenCalledTimes(2)
      expect(state.openExternal).toHaveBeenLastCalledWith('zoommtg://zoom.us/join?confno=1')
      expect(unhandled.seen).toEqual([])
    } finally {
      unhandled.stop()
    }
  })

  it('AG-10 询问框弹着时，mailto 照样同一拍交给系统并回 true（不受询问节流）', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const asked = gate.routeExternalUrl('zoommtg://x', { parent: asWin(state.win) })
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    const opened = gate.routeExternalUrl('mailto:x@y.z', { parent: asWin(state.win) })
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('mailto:x@y.z')
    await expect(opened).resolves.toBe(true)

    answer(1)
    await expect(asked).resolves.toBe(false)
  })
})

describe('approveExternalUrl：只裁决，从不打开', () => {
  it('AG-11 http(s) → true，既不交给系统也不弹框', async () => {
    const gate = await load()
    await expect(
      gate.approveExternalUrl('https://example.com/', { parent: asWin(state.win) })
    ).resolves.toBe(true)

    expect(state.openExternal).not.toHaveBeenCalled()
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it('AG-12 mailto: → true，既不交给系统也不弹框', async () => {
    const gate = await load()
    await expect(
      gate.approveExternalUrl('mailto:x@y.z', { parent: asWin(state.win) })
    ).resolves.toBe(true)

    expect(state.openExternal).not.toHaveBeenCalled()
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it.each([
    'file:///Applications/Calculator.app',
    'c:/Windows/System32/calc.exe',
    'smb://host/share',
    'javascript:alert(1)',
    'not a url'
  ])('AG-13 拒绝的目标 → false，不弹框、不交给系统：%s', async (target) => {
    const gate = await load()
    await expect(gate.approveExternalUrl(target, { parent: asWin(state.win) })).resolves.toBe(false)

    expect(state.showMessageBox).not.toHaveBeenCalled()
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('AG-14 ask 点 Open → true，但**不**交给系统（放行之后由 Electron 自己去开）', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const asked = gate.approveExternalUrl('zoommtg://zoom.us/join?confno=1', {
      parent: asWin(state.win)
    })
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    answer(0)
    await expect(asked).resolves.toBe(true)
    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('AG-15 ask 点 Cancel → false，也不交给系统', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const asked = gate.approveExternalUrl('zoommtg://zoom.us/join?confno=1', {
      parent: asWin(state.win)
    })

    answer(1)
    await expect(asked).resolves.toBe(false)
    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('AG-16 source 会进框：挂在 opts.parent 上，detail 里有译好的标签与发起者', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const asked = gate.approveExternalUrl('zoommtg://zoom.us/join?confno=1', {
      parent: asWin(state.win),
      source: WIDGET_SOURCE
    })

    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(parentAt()).toBe(state.win)
    expect(detailLines()).toContain(FROM_WIDGET)
    expect(detailLines()).toContain('My Widget')

    answer(1)
    await expect(asked).resolves.toBe(false)
  })
})

describe('approveOpenExternalPermission：页面导航到非网页协议时的权限分支', () => {
  const wc = {} as WebContents

  it.each([
    ['没有 externalURL', {} as { externalURL?: string }],
    ['externalURL 是空串', { externalURL: '' }]
  ])('AG-17/18 %s → false，连窗口都不去找', async (_label, details) => {
    const gate = await load()
    await expect(gate.approveOpenExternalPermission(wc, details)).resolves.toBe(false)

    expect(state.showMessageBox).not.toHaveBeenCalled()
    expect(state.openExternal).not.toHaveBeenCalled()
    expect(state.fromWebContents).not.toHaveBeenCalled()
  })

  it('AG-19 ask：框挂在 fromWebContents 找到的那个窗口上；点 Open → true 且不交给系统，点 Cancel → false', async () => {
    const gate = await load()

    const accept = holdNextDialog()
    const accepted = gate.approveOpenExternalPermission(wc, { externalURL: 'zoommtg://x' })
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(parentAt()).toBe(state.win)
    accept(0)
    await expect(accepted).resolves.toBe(true)
    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()

    // 点了 Open 不起静默期，下一次照样弹
    const decline = holdNextDialog()
    const declined = gate.approveOpenExternalPermission(wc, { externalURL: 'zoommtg://x' })
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)
    decline(1)
    await expect(declined).resolves.toBe(false)
    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('AG-20 指向文件的 → false，不弹框、不交给系统', async () => {
    const gate = await load()
    await expect(
      gate.approveOpenExternalPermission(wc, {
        externalURL: 'file:///Applications/Calculator.app'
      })
    ).resolves.toBe(false)

    expect(state.showMessageBox).not.toHaveBeenCalled()
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('AG-21 http(s) → true，不弹框、不交给系统', async () => {
    const gate = await load()
    await expect(
      gate.approveOpenExternalPermission(wc, { externalURL: 'https://example.com/' })
    ).resolves.toBe(true)

    expect(state.showMessageBox).not.toHaveBeenCalled()
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('AG-22 找不到窗口：ask 问不成按拒绝处理，mailto 不需要窗口照样 true', async () => {
    const gate = await load()
    state.fromWebContents.mockImplementation(() => null)

    await expect(
      gate.approveOpenExternalPermission(wc, { externalURL: 'zoommtg://x' })
    ).resolves.toBe(false)
    expect(state.showMessageBox).not.toHaveBeenCalled()

    await expect(
      gate.approveOpenExternalPermission(wc, { externalURL: 'mailto:x@y.z' })
    ).resolves.toBe(true)
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it('AG-23 第三个参数（source）原样传下去，译好的标签与发起者都进 detail', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const asked = gate.approveOpenExternalPermission(
      wc,
      { externalURL: 'zoommtg://x' },
      { labelKey: 'externalOpen.fromWidget', value: 'W' }
    )

    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(detailLines()).toContain(FROM_WIDGET)
    expect(detailLines()).toContain('W')

    answer(1)
    await expect(asked).resolves.toBe(false)
  })
})

describe('询问框', () => {
  it('AG-24 选项：挂在 opts.parent 上、warning、「Open / Cancel」默认与取消都是 Cancel、message 是真英文标题', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const asked = gate.routeExternalUrl('zoommtg://zoom.us/join?confno=1', {
      parent: asWin(state.win)
    })

    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(parentAt()).toBe(state.win)
    const opts = dialogAt()
    expect(opts.type).toBe('warning')
    expect(opts.buttons).toEqual(['Open', 'Cancel'])
    expect(opts.buttons[opts.defaultId]).toBe('Cancel')
    expect(opts.buttons[opts.cancelId]).toBe('Cancel')
    expect(opts.message).toBe(TITLE)

    answer(1)
    await expect(asked).resolves.toBe(false)
  })

  it('AG-25 带 source 的 detail 正好六行：地址、空行、标签、发起者、空行、提示', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const target = 'zoommtg://zoom.us/join?confno=1'
    const asked = gate.routeExternalUrl(target, { parent: asWin(state.win), source: WIDGET_SOURCE })

    expect(detailLines()).toEqual([target, '', FROM_WIDGET, 'My Widget', '', HINT])

    answer(1)
    await expect(asked).resolves.toBe(false)
  })

  it('AG-26 不带 source 的 detail 正好三行：地址、空行、提示', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const target = 'zoommtg://zoom.us/join?confno=1'
    const asked = gate.routeExternalUrl(target, { parent: asWin(state.win) })

    expect(detailLines()).toEqual([target, '', HINT])

    answer(1)
    await expect(asked).resolves.toBe(false)
  })

  it('AG-27 超长的地址与发起者在框里都按 clipUrl 截断；点 Open 交出去的仍是完整的 5015 字地址', async () => {
    const target = 'zoommtg://x/?q=' + 'a'.repeat(5000)
    const value = 'w'.repeat(5015)
    expect(target).toHaveLength(5015)

    const gate = await load()
    const answer = holdNextDialog()
    const asked = gate.routeExternalUrl(target, {
      parent: asWin(state.win),
      source: { labelKey: 'externalOpen.fromWidget', value }
    })

    const lines = detailLines()
    expect(lines[0]).toBe(clipUrl(target))
    expect(lines[0]).toHaveLength(301)
    expect(lines[0].endsWith('…')).toBe(true)
    expect(lines[3]).toBe(clipUrl(value))

    answer(0)
    await expect(asked).resolves.toBe(true)
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    const [opened] = state.openExternal.mock.calls[0]
    expect(opened).toHaveLength(5015)
    expect(opened).toBe(target)
  })

  it('AG-28 detail 是逐行拼接、不走 i18next 插值：地址与发起者里的 {{…}} 原样留着，提示只出现一次', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const target = 'zoommtg://x/?a={{url}}&b={{hint}}&c={{label}}'
    const asked = gate.routeExternalUrl(target, {
      parent: asWin(state.win),
      source: { labelKey: 'externalOpen.fromWidget', value: '{{url}}' }
    })

    const lines = detailLines()
    expect(lines[0]).toBe(target)
    expect(lines[3]).toBe('{{url}}')
    // 占位符没有被任何一行顶掉：地址只在首行出现一次，提示也只有一份
    expect(dialogAt().detail.split(target)).toHaveLength(2)
    expect(dialogAt().detail.split(HINT)).toHaveLength(2)

    answer(1)
    await expect(asked).resolves.toBe(false)
  })

  it.each([
    ['没传 parent', undefined],
    ['parent 是 null', null]
  ])('AG-29 %s → false，问不成就不问：不弹框、不交给系统', async (_label, parent) => {
    const gate = await load()
    await expect(gate.routeExternalUrl('zoommtg://x', { parent })).resolves.toBe(false)

    expect(state.showMessageBox).not.toHaveBeenCalled()
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('AG-30 parent 已销毁 → false、不弹框、不交给系统，且没动节流：换个活窗口立刻还能弹', async () => {
    const gate = await load()
    state.win.destroyed = true
    await expect(gate.routeExternalUrl('zoommtg://x', { parent: asWin(state.win) })).resolves.toBe(
      false
    )

    expect(state.showMessageBox).not.toHaveBeenCalled()
    expect(state.openExternal).not.toHaveBeenCalled()

    const live = makeWindow()
    const answer = holdNextDialog()
    const asked = gate.routeExternalUrl('zoommtg://x', { parent: asWin(live) })
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    answer(1)
    await expect(asked).resolves.toBe(false)
  })
})

describe('两份询问节流：内容触发 / 用户亲手点', () => {
  it('AG-31 内容那一档一次一个：弹着时第二个直接 false，答了第一个只交出第一个地址', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const first = gate.routeExternalUrl('zoommtg://a', { parent: asWin(state.win) })
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    await expect(gate.routeExternalUrl('slack://open', { parent: asWin(state.win) })).resolves.toBe(
      false
    )
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    answer(0)
    await expect(first).resolves.toBe(true)
    await flush()
    expect(state.openExternal.mock.calls).toEqual([['zoommtg://a']])
  })

  it('AG-32 内容那一档点 Cancel 后静默 10 s（按 Date 计），满 10 s 再弹', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T)
    const gate = await load()
    const answer = holdNextDialog()
    const declined = gate.routeExternalUrl('zoommtg://a', { parent: asWin(state.win) })
    answer(1)
    await expect(declined).resolves.toBe(false)
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    vi.setSystemTime(T + 9_999)
    await expect(gate.routeExternalUrl('slack://open', { parent: asWin(state.win) })).resolves.toBe(
      false
    )
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    vi.setSystemTime(T + 10_000)
    const again = gate.routeExternalUrl('slack://open', { parent: asWin(state.win) })
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)
    await expect(again).resolves.toBe(false)
  })

  it('AG-33 用户亲手点的那一档不静默：拒绝后同一毫秒里再点照样弹框', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T)
    const gate = await load()
    const answer = holdNextDialog()
    const declined = gate.routeExternalUrl('zoommtg://a', {
      parent: asWin(state.win),
      byUser: true
    })
    answer(1)
    await expect(declined).resolves.toBe(false)
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    const again = gate.routeExternalUrl('slack://open', {
      parent: asWin(state.win),
      byUser: true
    })
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)
    await expect(again).resolves.toBe(false)
  })

  it('AG-34 用户那一档照样一次一个：框弹着时第二次点击直接 false，不弹第二个框', async () => {
    const gate = await load()
    const answer = holdNextDialog()
    const first = gate.routeExternalUrl('zoommtg://a', {
      parent: asWin(state.win),
      byUser: true
    })
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    await expect(
      gate.routeExternalUrl('slack://open', { parent: asWin(state.win), byUser: true })
    ).resolves.toBe(false)
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    answer(1)
    await expect(first).resolves.toBe(false)
  })

  it('AG-35 两份各算各的：内容那份刚被拒，用户那份同一毫秒里照样弹框', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T)
    const gate = await load()
    const answer = holdNextDialog()
    const declined = gate.routeExternalUrl('zoommtg://a', { parent: asWin(state.win) })
    answer(1)
    await expect(declined).resolves.toBe(false)
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    const byUser = gate.routeExternalUrl('slack://open', {
      parent: asWin(state.win),
      byUser: true
    })
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)
    await expect(byUser).resolves.toBe(false)
  })

  it('AG-36 反过来也一样：用户那份刚被拒，内容那份同一毫秒里照样弹框', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T)
    const gate = await load()
    const answer = holdNextDialog()
    const declined = gate.routeExternalUrl('zoommtg://a', {
      parent: asWin(state.win),
      byUser: true
    })
    answer(1)
    await expect(declined).resolves.toBe(false)
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    const fromContent = gate.routeExternalUrl('slack://open', { parent: asWin(state.win) })
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)
    await expect(fromContent).resolves.toBe(false)
  })

  it('AG-37 内容的框还开着时用户又点了一个链接 → 两个框；这是裁决过的、刻意如此', async () => {
    // 两档各有各的锁是设计如此：用户那一档要真的点一下才有，循环弹窗造不出来；把它并进内容那份的
    // 锁里，代价是「内容的框还开着，用户自己点的链接就静默失效」—— 那才像界面坏了
    const gate = await load()
    const answerContent = holdNextDialog()
    const fromContent = gate.routeExternalUrl('zoommtg://a', { parent: asWin(state.win) })
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    const answerUser = holdNextDialog()
    const byUser = gate.routeExternalUrl('slack://open', {
      parent: asWin(state.win),
      byUser: true
    })
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)

    answerUser(1)
    await expect(byUser).resolves.toBe(false)
    answerContent(1)
    await expect(fromContent).resolves.toBe(false)
  })

  it('AG-38 节流是进程级一份，不是按窗口各算各的：A 的框弹着时 B 来问不弹框', async () => {
    const gate = await load()
    const windowA = makeWindow()
    const windowB = makeWindow()
    const answer = holdNextDialog()
    const onA = gate.routeExternalUrl('zoommtg://a', { parent: asWin(windowA) })
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(parentAt()).toBe(windowA)

    await expect(gate.routeExternalUrl('slack://open', { parent: asWin(windowB) })).resolves.toBe(
      false
    )
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)

    answer(1)
    await expect(onA).resolves.toBe(false)
  })
})

describe('guardAppWindow：自有窗口的弹窗与顶层导航', () => {
  it('AG-39 两条路都装上：setWindowOpenHandler 恰好一次，webContents 上恰好一个 will-navigate 监听', async () => {
    const gate = await load()
    gate.guardAppWindow(asWin(state.win))

    expect(state.win.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    expect(state.win.webContents.on.mock.calls.map(([event]) => event)).toEqual(['will-navigate'])
  })

  it.each([
    'https://example.com/',
    'mailto:x@y.z',
    'zoommtg://x',
    'file:///Applications/',
    'about:blank',
    'not a url'
  ])('AG-40 弹窗一律同步回 { action: deny }、不抛：%s', async (target) => {
    const gate = await load()
    const win = guarded(gate)
    holdNextDialog() // zoommtg 那一行的框一直不答
    expectDeny(win, target)
  })

  it('AG-41 弹窗到 http(s)：自有窗口没有 onWeb，交给系统浏览器（规范化后的地址），不弹框', async () => {
    const gate = await load()
    const win = guarded(gate)
    expectDeny(win, 'HTTP://EXAMPLE.com')

    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('http://example.com/')
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it('AG-42 弹窗到 ask：框挂在这个窗口上、带着装守卫时给的 source；点 Open 交出规范化后的地址', async () => {
    const gate = await load()
    const win = guarded(gate, WIDGET_SOURCE)
    const answer = holdNextDialog()
    expectDeny(win, 'X-PROBE-CUSTOM://Upper')

    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(parentAt()).toBe(win)
    expect(detailLines()).toContain(FROM_WIDGET)
    expect(detailLines()).toContain('My Widget')

    answer(0)
    await flush()
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('x-probe-custom://Upper')
  })

  it('AG-43 dev 例外只管导航：命中 ELECTRON_RENDERER_URL 的弹窗照样 deny，也照样过闸', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', DEV_URL)
    const gate = await load()
    const win = guarded(gate)
    expectDeny(win, `${DEV_URL}/index.html`)

    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith(`${DEV_URL}/index.html`)
  })

  it('AG-44 顶层导航到外部 http(s)：preventDefault 一次，交给系统浏览器（规范化后的地址）', async () => {
    const gate = await load()
    const win = guarded(gate)
    const event = navigate(win, 'HTTP://EXAMPLE.com')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('http://example.com/')
  })

  it('AG-45 顶层导航到 ask：preventDefault + 弹框；点 Open 才交给系统', async () => {
    const gate = await load()
    const win = guarded(gate)
    const answer = holdNextDialog()
    const event = navigate(win, 'zoommtg://zoom.us/join?confno=1')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(state.openExternal).not.toHaveBeenCalled()

    answer(0)
    await flush()
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('zoommtg://zoom.us/join?confno=1')
  })

  it('AG-46 顶层导航到 file:：照样 preventDefault，但什么都不交出去、也不问', async () => {
    const gate = await load()
    const win = guarded(gate)
    const event = navigate(win, 'file:///Users/me/x.html')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it.each([
    `${DEV_URL}/index.html#widget-window?widgetId=w1`,
    `${DEV_URL}#pinned-chat?sessionId=s1`
  ])('AG-47 dev 渲染端地址放行：不 preventDefault、不过闸：%s', async (target) => {
    vi.stubEnv('ELECTRON_RENDERER_URL', DEV_URL)
    const gate = await load()
    const win = guarded(gate)
    const event = navigate(win, target)

    expect(event.preventDefault).not.toHaveBeenCalled()
    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it('AG-48 dev 地址设着，但导航去的是别处：照样 preventDefault + 过闸', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', DEV_URL)
    const gate = await load()
    const win = guarded(gate)
    const event = navigate(win, 'https://example.com/')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it.each([
    // 比的是**源**不是前缀。第一个连 URL 都解析不了（`5173.evil.example` 不是合法端口），
    // 所以过闸之后是 refuse unparsable —— 要钉的是它没被 dev 例外放行
    ['http://localhost:5173.evil.example/', undefined],
    ['http://localhost:51739/', 'http://localhost:51739/'],
    ['https://localhost:5173/', 'https://localhost:5173/']
  ] as Array<[target: string, opened: string | undefined]>)(
    'AG-49 长得像 dev 地址但源不同 → 照样 preventDefault + 过闸：%s',
    async (target, opened) => {
      vi.stubEnv('ELECTRON_RENDERER_URL', DEV_URL)
      const gate = await load()
      const win = guarded(gate)
      const event = navigate(win, target)

      expect(event.preventDefault).toHaveBeenCalledTimes(1)
      await flush()
      expect(state.openExternal.mock.calls).toEqual(opened ? [[opened]] : [])
      expect(state.showMessageBox).not.toHaveBeenCalled()
    }
  )

  it('AG-50 没有 ELECTRON_RENDERER_URL：一律 preventDefault，http(s) 交给系统、file: 什么都不交', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined)
    const gate = await load()
    const win = guarded(gate)

    const web = navigate(win, 'https://example.com/')
    expect(web.preventDefault).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('https://example.com/')

    const file = navigate(win, 'file:///x')
    expect(file.preventDefault).toHaveBeenCalledTimes(1)
    await flush()
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it('AG-51 ELECTRON_RENDERER_URL 是空串：同没设一样 —— preventDefault + 过闸', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    const gate = await load()
    const win = guarded(gate)
    const event = navigate(win, 'https://example.com/')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    expect(state.openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('AG-52 环境变量每次导航现读，不是装守卫时读一次（装守卫与 dev 服务器起来没有固定先后）', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined)
    const gate = await load()
    const win = guarded(gate)

    vi.stubEnv('ELECTRON_RENDERER_URL', DEV_URL)
    const event = navigate(win, `${DEV_URL}/index.html`)

    expect(event.preventDefault).not.toHaveBeenCalled()
    await flush()
    expect(state.openExternal).not.toHaveBeenCalled()
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })

  it('AG-53 没给 source 的窗口：detail 正好三行；两个窗口各自的框挂在触发的那个上', async () => {
    const gate = await load()
    const windowA = guarded(gate)
    const windowB = guarded(gate)

    const answerA = holdNextDialog()
    expectDeny(windowA, 'zoommtg://a')
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
    expect(parentAt(0)).toBe(windowA)
    expect(detailLines(0)).toEqual(['zoommtg://a', '', HINT])

    // 点 Open 不起静默期，B 接着问得到自己的框
    answerA(0)
    await flush()

    const answerB = holdNextDialog()
    expectDeny(windowB, 'slack://open')
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)
    expect(parentAt(1)).toBe(windowB)
    expect(detailLines(1)).toEqual(['slack://open', '', HINT])

    answerB(1)
    await flush()
  })
})

/**
 * 桌面 CDP 传输（browserCdpService）的 attach 生命周期：从不翻动后台节流；每次 attach 都装好
 * 「别打扰用户」的防护（agentGuards），每条断开的路都把它摘掉。
 *
 *   U8     attach → 用 → 主动 detach → 再 attach（debugger 报 Already attached 也照常）→ 外部断开
 *          （debugger 的 detach 事件）→ 再 attach → detachAll：webContents.setBackgroundThrottling
 *          一次都没被调，debugger.attach 每轮都调了。
 *   NG-U7  (a) 防护的四条安装命令（Page.enable → Runtime.enable → Runtime.addBinding →
 *              Page.addScriptToEvaluateOnNewDocument）都在 `browserCdpManager.session()` resolve 之前
 *              发出 —— Page.enable 迟迟不回，session 就一直不 resolve；
 *          (b) Page.enable 失败：session 照样拿到（防护装不上不能让 agent 连页面都操作不了）；
 *          (c) 每次 attach 挂两个 debugger message 处理函数（传输一个、防护一个）；
 *          (d) 主动 detach / 外部断开 / detachAll 都 off 掉防护的那个处理函数；断开之后的
 *              Page.fileChooserOpened 不引出任何 setInterceptFileChooserDialog，之后的动作也不再拦；
 *          全程仍然没有 setBackgroundThrottling。
 *
 * 为什么钉节流：浏览器窗口懒创建、以隐藏态起步，agent 完全可能在它第一次露面之前就 attach。
 * 那时候运行期调 setBackgroundThrottling 会永久弄坏该 webContents 的 capturePage（截图工具与
 * 卡片快照全部失败）；节流改在 createTab 构造 view 时就关掉（U7）。旧实现正是在 attach 里调它的。
 *
 * browserViewService 换成一个假 tab：webContents 带 ./fakeElectron.ts 的假 debugger（处理函数真挂、
 * 事件真派发，attach / on / once / off / detach / sendCommand 都是间谍，sendCommand 缺省回 {}）与
 * setBackgroundThrottling 间谍；browserWindowInFront 回 null（用户没在看浏览器窗口）。
 * CdpAttachManager 与 agentGuards 都是真的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDebugger, type FakeDebugger, type Handler } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

interface FakeTab {
  webContents: {
    debugger: FakeDebugger
    setBackgroundThrottling: ReturnType<typeof vi.fn<(allowed: boolean) => void>>
    isDestroyed(): boolean
  }
}

const state = vi.hoisted(() => ({
  view: null as unknown,
  host: {
    isDestroyed: () => false,
    webContents: { send: vi.fn<(channel: string, payload: unknown) => void>() }
  }
}))

// mock 路径按**测试文件**解析：被测模块在 services/browser/，测试在其 __tests__/ 下
vi.mock('../browserViewService', () => ({
  getTabView: (id: string) => (id === 't' ? state.view : null),
  getBrowserHostWindow: () => state.host,
  browserWindowInFront: () => null
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))

import { browserCdpManager } from '../browserCdpService'
import { hasAgentGuards, PRINT_OVERRIDE_SOURCE, withAgentGuards } from '../agentGuards'

const GUARD_INSTALL = [
  'Page.enable',
  'Runtime.enable',
  'Runtime.addBinding',
  'Page.addScriptToEvaluateOnNewDocument'
]
const INTERCEPT = 'Page.setInterceptFileChooserDialog'

let tab: FakeTab
let dbg: FakeDebugger

function newTab(): FakeTab {
  return {
    webContents: {
      debugger: createFakeDebugger(),
      setBackgroundThrottling: vi.fn<(allowed: boolean) => void>(),
      isDestroyed: () => false
    }
  }
}

const methods = (): string[] => dbg.sendCommand.mock.calls.map(([m]) => m)

/** 第 n 次（从 0 起）attach 挂上的防护 message 处理函数 —— 每次 attach 的第二个 message 处理函数 */
function guardHandler(attachIndex: number): Handler {
  const messageOns = dbg.on.mock.calls.filter(([event]) => event === 'message')
  const fn = messageOns[attachIndex * 2 + 1]?.[1]
  if (!fn) throw new Error(`attach #${attachIndex} 没有挂防护的 message 处理函数`)
  return fn
}

const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

beforeEach(() => {
  tab = newTab()
  dbg = tab.webContents.debugger
  state.view = tab
  state.host.webContents.send.mockClear()
})

afterEach(async () => {
  await browserCdpManager.detachAll()
  expect(tab.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
})

describe('browserCdpService：attach 不碰后台节流', () => {
  it('U8 attach / 主动 detach / 再 attach（含 Already attached）/ 外部断开 / detachAll 全程：setBackgroundThrottling 0 次，debugger.attach 每轮都调', async () => {
    const throttle = tab.webContents.setBackgroundThrottling

    // 第一轮：attach 并真用一下（发命令、开对话框处理）
    const first = await browserCdpManager.session('t')
    await first.send('Runtime.evaluate', { expression: '1' })
    await first.enableDialogHandling()
    expect(dbg.attach).toHaveBeenCalledTimes(1)
    expect(dbg.attach).toHaveBeenCalledWith('1.3')
    expect(dbg.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', { expression: '1' })
    expect(browserCdpManager.cdpState('t').attached).toBe(true)
    // 状态推给了宿主窗口（卡片上的 AI 标识）
    expect(state.host.webContents.send).toHaveBeenCalledWith('browser-view:tab-cdp-state', {
      tabId: 't',
      cdpAttached: true,
      cdpIntercepting: false
    })

    // 主动 detach
    await browserCdpManager.detach('t')
    expect(dbg.detach).toHaveBeenCalledTimes(1)
    expect(browserCdpManager.isAttached('t')).toBe(false)

    // 第二轮：debugger 说已经 attach 过了 —— 照常拿到会话
    dbg.attach.mockImplementationOnce(() => {
      throw new Error('Debugger is already attached to the target (Already attached)')
    })
    const second = await browserCdpManager.session('t')
    expect(second).not.toBe(first)
    expect(dbg.attach).toHaveBeenCalledTimes(2)
    await second.send('Page.enable')

    // 外部断开（页面崩溃 / 用户开了 DevTools）：只清本地状态，不调 detach
    dbg.emit('detach', {}, 'target closed')
    expect(browserCdpManager.isAttached('t')).toBe(false)
    expect(dbg.detach).toHaveBeenCalledTimes(1)

    // 第三轮，然后全部释放
    await browserCdpManager.session('t')
    expect(dbg.attach).toHaveBeenCalledTimes(3)
    await browserCdpManager.detachAll()
    expect(dbg.detach).toHaveBeenCalledTimes(2)
    expect(browserCdpManager.isAttached('t')).toBe(false)

    expect(throttle).not.toHaveBeenCalled()
  })
})

describe('browserCdpService：每次 attach 都装好防护，每条断开的路都摘掉（NG-U7）', () => {
  it('NG-U7 四条安装命令都在 session() resolve 之前发出：Page.enable 不回，session 就一直等着', async () => {
    let releaseEnable: ((v: unknown) => void) | undefined
    dbg.sendCommand.mockImplementation((method: string) =>
      method === 'Page.enable' && !releaseEnable
        ? new Promise((r) => (releaseEnable = r))
        : Promise.resolve({})
    )
    let sentWhenResolved: string[] | null = null
    const pending = browserCdpManager.session('t').then((s) => {
      sentWhenResolved = methods()
      return s
    })
    await flush()
    await flush()
    expect(sentWhenResolved).toBeNull()
    expect(methods()).toEqual(['Page.enable'])

    releaseEnable!({})
    await pending
    expect(sentWhenResolved).toEqual(GUARD_INSTALL)
    expect(dbg.sendCommand.mock.calls.map(([m, p]) => [m, p])).toEqual([
      ['Page.enable', undefined],
      ['Runtime.enable', undefined],
      ['Runtime.addBinding', { name: '__shuvixPrintRequest' }],
      ['Page.addScriptToEvaluateOnNewDocument', { source: PRINT_OVERRIDE_SOURCE }]
    ])
    expect(methods()).not.toContain(INTERCEPT)
    expect(hasAgentGuards('t')).toBe(true)
  })

  it('NG-U7 Page.enable 失败：session 照样拿到', async () => {
    dbg.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.enable') throw new Error('Target closed')
      return {}
    })
    const session = await browserCdpManager.session('t')
    expect(session).toBeDefined()
    expect(browserCdpManager.isAttached('t')).toBe(true)
  })

  it('NG-U7 每次 attach 挂两个 message 处理函数；主动 detach 把两个都摘掉，防护的那个按原函数 off', async () => {
    await browserCdpManager.session('t')
    expect(dbg.on.mock.calls.filter(([e]) => e === 'message')).toHaveLength(2)
    expect(dbg.listenerCount('message')).toBe(2)
    const guard = guardHandler(0)

    await browserCdpManager.detach('t')
    expect(dbg.off).toHaveBeenCalledWith('message', guard)
    expect(dbg.listenerCount('message')).toBe(0)
    expect(hasAgentGuards('t')).toBe(false)
  })

  it('NG-U7 外部断开（debugger 的 detach 事件）：防护的处理函数被 off，hasAgentGuards 变 false', async () => {
    await browserCdpManager.session('t')
    const guard = guardHandler(0)
    dbg.emit('detach', {}, 'Render process gone.')
    expect(dbg.off).toHaveBeenCalledWith('message', guard)
    expect(hasAgentGuards('t')).toBe(false)
    expect(dbg.listenerCount('message')).toBe(0)
    expect(dbg.detach).not.toHaveBeenCalled()
  })

  it('NG-U7 detachAll：防护的处理函数被 off', async () => {
    await browserCdpManager.session('t')
    const guard = guardHandler(0)
    await browserCdpManager.detachAll()
    expect(dbg.off).toHaveBeenCalledWith('message', guard)
    expect(hasAgentGuards('t')).toBe(false)
  })

  it('NG-U7 重新 attach 又装一份（又是两个 message 处理函数），不叠加旧的', async () => {
    await browserCdpManager.session('t')
    await browserCdpManager.detach('t')
    await browserCdpManager.session('t')
    expect(dbg.on.mock.calls.filter(([e]) => e === 'message')).toHaveLength(4)
    expect(dbg.listenerCount('message')).toBe(2)
    expect(methods().filter((m) => m === 'Runtime.addBinding')).toHaveLength(2)
  })

  it.each([
    ['主动 detach', async () => browserCdpManager.detach('t')],
    ['外部断开', async () => dbg.emit('detach', {}, 'target closed')],
    ['detachAll', async () => browserCdpManager.detachAll()]
  ])(
    'NG-U7 %s 之后：页面再报 Page.fileChooserOpened 也不引出 setInterceptFileChooserDialog；之后的动作不再拦',
    async (_label, disconnect) => {
      await browserCdpManager.session('t')
      await disconnect()
      dbg.sendCommand.mockClear()

      dbg.message('Page.fileChooserOpened', {
        frameId: 'F',
        mode: 'selectSingle',
        backendNodeId: 1
      })
      await flush()
      const out = await withAgentGuards('t', async () => 'ran')
      expect(out).toEqual({ result: 'ran', suppressed: [] })
      expect(methods()).not.toContain(INTERCEPT)
      expect(methods()).not.toContain('DOM.setFileInputFiles')
    }
  )
})

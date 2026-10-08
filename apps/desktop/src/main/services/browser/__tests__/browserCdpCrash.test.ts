/**
 * 桌面 CDP 传输（browserCdpService）接管一个**渲染进程已经崩了**的 tab（CR-U14）。
 *
 * 防护（agentGuards）的四条安装命令在崩溃页上会一直挂着（Page.enable 之类发给已经没了的渲染进程），
 * 所以 attach 不能等它们：页面崩着时防护推迟到页面回来（Inspector.targetReloadedAfterCrash）再装。
 *
 *   CR-U14  (a) 崩着的 tab：session() 照常拿到 —— 只发了 Inspector.enable（对面借它补报崩溃，会话算崩着），
 *              防护没装；
 *           (b) 页面回来：四条安装命令按序发出、防护装上、会话不再算崩着，等页面回来的那个监听摘掉；
 *              再来一次「回来了」什么都不发；
 *           (c) 回来之后防护还没装完（Page.enable 迟迟不回）时的动作先等它装完、打开拦截，再开始；
 *           (d) 页面回来之前主动 detach / 调试目标没了（debugger 的 detach 事件，`target closed`）：
 *              等页面回来的那个监听一并摘掉，之后页面回来也什么都不装。
 *
 * browserViewService 换成一个假 tab：webContents 带 ./fakeElectron.ts 的假 debugger 与可拨的 isCrashed；
 * 假 debugger 像真的崩溃页那样回命令 —— Inspector.enable 先补报 Inspector.targetCrashed 再回包，
 * 别的命令在崩着的时候一直挂着。CdpAttachManager 与 agentGuards 都是真的（同 browserCdpThrottling.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDebugger, type FakeDebugger, type Handler } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

const state = vi.hoisted(() => ({
  view: null as unknown,
  host: {
    isDestroyed: () => false,
    webContents: { send: (_channel: string, _payload: unknown): void => {} }
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
const RELOADED = 'Inspector.targetReloadedAfterCrash'

let dbg: FakeDebugger
let crashed = true
/** 页面回来之后的 Page.enable 扣住不回（null = 立即回） */
let heldPageEnable: Promise<unknown> | null = null

function newTab(): unknown {
  return {
    webContents: {
      debugger: dbg,
      setBackgroundThrottling: vi.fn(),
      isDestroyed: () => false,
      isCrashed: () => crashed
    }
  }
}

const methods = (): string[] => dbg.sendCommand.mock.calls.map(([m]) => m)

/** 这次 attach 挂上的 message 处理函数（按挂上的顺序：传输的、等页面回来的、防护的……） */
const messageHandlers = (): Handler[] =>
  dbg.on.mock.calls.filter(([event]) => event === 'message').map(([, fn]) => fn)

const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

/** 接管一个崩着的 tab：session() 照常拿到，只发了 Inspector.enable，防护没装 */
async function attachCrashed(): Promise<Awaited<ReturnType<typeof browserCdpManager.session>>> {
  const pending = browserCdpManager.session('t')
  let settled = false
  pending.then(
    () => (settled = true),
    () => (settled = true)
  )
  await flush()
  await flush()
  expect(settled, 'session() should not wait for the guards on a crashed page').toBe(true)
  const session = await pending
  expect(methods()).toEqual(['Inspector.enable'])
  expect(hasAgentGuards('t')).toBe(false)
  expect(session.crashed).toBe(true)
  // 传输的 + 等页面回来的；防护的还没挂
  expect(messageHandlers()).toHaveLength(2)
  return session
}

beforeEach(() => {
  dbg = createFakeDebugger()
  crashed = true
  heldPageEnable = null
  dbg.sendCommand.mockImplementation((method: string) => {
    if (method === 'Inspector.enable') {
      // 对着一个已经崩了的目标 Inspector.enable：先补报崩溃，再回包（实测）
      if (crashed) dbg.message('Inspector.targetCrashed')
      return Promise.resolve({})
    }
    if (crashed) return new Promise(() => {})
    if (method === 'Page.enable' && heldPageEnable) return heldPageEnable
    return Promise.resolve({})
  })
  state.view = newTab()
})

afterEach(async () => {
  await browserCdpManager.detachAll()
})

describe('接管一个渲染进程已经崩了的 tab：防护等页面回来再装（CR-U14）', () => {
  it('CR-U14 (a)(b) 崩着时只发 Inspector.enable、不装防护；页面回来：四条安装命令按序发出、防护装上、会话不算崩着、那个监听摘掉；再「回来」一次什么都不发', async () => {
    const session = await attachCrashed()
    const recovery = messageHandlers()[1]

    // 别的事件不算「回来了」
    dbg.message('Page.lifecycleEvent', { name: 'init' })
    await flush()
    expect(methods()).toEqual(['Inspector.enable'])

    crashed = false
    dbg.message(RELOADED)
    await flush()
    await flush()
    expect(methods()).toEqual(['Inspector.enable', ...GUARD_INSTALL])
    expect(dbg.sendCommand.mock.calls.slice(1).map(([m, p]) => [m, p])).toEqual([
      ['Page.enable', undefined],
      ['Runtime.enable', undefined],
      ['Runtime.addBinding', { name: '__shuvixPrintRequest' }],
      ['Page.addScriptToEvaluateOnNewDocument', { source: PRINT_OVERRIDE_SOURCE }]
    ])
    expect(hasAgentGuards('t')).toBe(true)
    expect(session.crashed).toBe(false)
    expect(dbg.off).toHaveBeenCalledWith('message', recovery)
    expect(methods()).not.toContain(INTERCEPT)

    dbg.message(RELOADED)
    await flush()
    await flush()
    expect(methods()).toEqual(['Inspector.enable', ...GUARD_INSTALL])
  })

  it('CR-U14 (c) 页面回来之后防护还没装完（Page.enable 迟迟不回）：这时的动作先等它装完、打开拦截，再开始', async () => {
    await attachCrashed()
    let releaseEnable!: (v: unknown) => void
    heldPageEnable = new Promise((r) => (releaseEnable = r))

    crashed = false
    dbg.message(RELOADED)
    await flush()
    expect(methods()).toEqual(['Inspector.enable', 'Page.enable'])
    expect(hasAgentGuards('t')).toBe(true)

    const timeline: string[] = []
    const ran = withAgentGuards('t', async () => {
      timeline.push(`op after ${methods().join(',')}`)
      return 'ok'
    })
    await flush()
    await flush()
    expect(timeline).toEqual([])
    expect(methods()).not.toContain(INTERCEPT)

    releaseEnable({})
    await expect(ran).resolves.toEqual({ result: 'ok', suppressed: [] })
    expect(timeline).toEqual([
      `op after ${['Inspector.enable', ...GUARD_INSTALL, INTERCEPT].join(',')}`
    ])
    expect(dbg.sendCommand.mock.calls.filter(([m]) => m === INTERCEPT).map(([, p]) => p)).toEqual([
      { enabled: true }
    ])
  })

  it.each([
    ['主动 detach', async () => browserCdpManager.detach('t')],
    [
      '调试目标没了（detach 事件，target closed）',
      async () => dbg.emit('detach', {}, 'target closed')
    ]
  ])(
    'CR-U14 (d) 页面回来之前%s：等页面回来的那个监听一并摘掉，之后页面回来什么都不装',
    async (_label, disconnect) => {
      const session = await attachCrashed()
      const recovery = messageHandlers()[1]

      await disconnect()
      expect(dbg.off).toHaveBeenCalledWith('message', recovery)
      expect(browserCdpManager.isAttached('t')).toBe(false)
      expect(dbg.listenerCount('message')).toBe(0)
      dbg.sendCommand.mockClear()

      crashed = false
      dbg.message(RELOADED)
      await flush()
      await flush()
      expect(methods()).toEqual([])
      expect(hasAgentGuards('t')).toBe(false)
      expect(session.ended).not.toBeNull()
    }
  )
})

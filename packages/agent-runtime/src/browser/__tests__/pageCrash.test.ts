/**
 * 页面的渲染进程崩了 —— 真的 CdpAttachManager / TabCdpSession / CdpController 配真的配方
 * （cdpOps），只有 transport 是假的：它像真的崩溃页那样，把发给页面的命令一直挂着不回。
 *
 *   CR-U10  接管中的 tab 崩了：navigate 的 reload / goto / back 把它救回来 —— 回「导航了」、没有 error、
 *           一秒内落定；崩着的时候发出去的只有导航与 Inspector（别的命令被会话当场拦下，一条都没
 *           发出去挂着）；之后会话不再算崩着，快照照常。
 *   CR-U11  接管之前就崩了的 tab：attach 那句 Inspector.enable 让对面补报崩溃 —— session() 照常拿到，
 *           快照 50ms 内以那句话失败、AX 树一次都没要；wait_for 当场收手；reload 把它救回来之后快照照常。
 *
 * 假 transport 的页面：一个主框架 F，地址 / readyState / 是否仍是打过记号的那个文档；崩着时的导航
 * 当场回包，约 20ms 后报 Inspector.targetReloadedAfterCrash 并换成目标地址上一个加载完的新文档。
 */
import { describe, expect, it } from 'vitest'
import { CdpAttachManager, PAGE_CRASHED_MESSAGE, type CdpTabTransport } from '../attachManager'
import { navigateOp, snapshotOp, waitForOp } from '../cdpOps'
import type { NavKind } from '../backend'

type Params = Record<string, unknown>

/** 崩溃页上照样能回的命令（与产品的 CRASH_SAFE_METHODS 相同） */
const CRASH_SAFE = new Set([
  'Page.reload',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Page.getNavigationHistory',
  'Inspector.enable',
  'Inspector.disable'
])

/** 救回来的页面多久之后才报 targetReloadedAfterCrash（导航的回包总是先到） */
const RECOVERY_MS = 20

const HISTORY = {
  currentIndex: 1,
  entries: [
    { id: 1, url: 'https://a.test/prev' },
    { id: 2, url: 'https://a.test/page' }
  ]
}

/** 一棵够拍快照的 AX 树：根 + 一个按钮 */
const AX_TREE = {
  nodes: [
    {
      nodeId: '1',
      role: { type: 'role', value: 'RootWebArea' },
      name: { type: 'computedString', value: 'Page' },
      childIds: ['2']
    },
    {
      nodeId: '2',
      backendDOMNodeId: 5,
      role: { type: 'role', value: 'button' },
      name: { type: 'computedString', value: 'Go' },
      childIds: []
    }
  ]
}

interface CrashableTransport {
  transport: CdpTabTransport
  page: { url: string; readyState: string; marked: boolean }
  /** 崩着的时候发出去的命令（方法名，按顺序） */
  sentWhileCrashed: string[]
  /** 全部发出去的命令（方法名，按顺序） */
  sent: string[]
  crashed(): boolean
  /** 渲染进程崩了：之后发给页面的命令一直挂着；报 Inspector.targetCrashed */
  crash(): void
}

function crashableTransport(opts: { startCrashed?: boolean } = {}): CrashableTransport {
  let crashed = opts.startCrashed ?? false
  let listener: ((method: string, params: Params) => void) | null = null
  const page = { url: 'https://a.test/page', readyState: 'complete', marked: false }
  const sent: string[] = []
  const sentWhileCrashed: string[] = []
  const emit = (method: string, params: Params = {}): void => listener?.(method, params)

  /** 崩溃页被导航救回来：回包之后约 20ms，换成 url 上一个加载完的新文档 */
  const recoverTo = (url: string): void => {
    setTimeout(() => {
      crashed = false
      Object.assign(page, { url, readyState: 'complete', marked: false })
      emit('Inspector.targetReloadedAfterCrash')
    }, RECOVERY_MS)
  }

  const evaluate = (expression: string): unknown => {
    if (expression.includes('__shuvixQuiet')) return { result: { value: 1000 } }
    if (expression.includes('defineProperty(window')) {
      page.marked = true
      return { result: { value: page.url } }
    }
    if (expression.includes('readyState')) return { result: { value: { ...page } } }
    if (expression.includes('innerText.includes')) return { result: { value: false } }
    return { result: { value: null } }
  }

  const transport: CdpTabTransport = {
    sendCommand: <T>(method: string, params?: Params): Promise<T> => {
      sent.push(method)
      if (crashed) {
        sentWhileCrashed.push(method)
        if (!CRASH_SAFE.has(method)) return new Promise<T>(() => {})
        if (method === 'Inspector.enable') emit('Inspector.targetCrashed')
        if (method === 'Page.reload') recoverTo(page.url)
        if (method === 'Page.navigate') recoverTo(String(params?.url))
        if (method === 'Page.navigateToHistoryEntry') {
          const entry = HISTORY.entries.find((e) => e.id === params?.entryId)
          recoverTo(entry?.url ?? page.url)
        }
      }
      let reply: unknown = {}
      if (method === 'Page.getFrameTree') reply = { frameTree: { frame: { id: 'F' } } }
      else if (method === 'Page.getNavigationHistory') reply = HISTORY
      else if (method === 'Page.navigate') reply = { frameId: 'F', loaderId: 'L2' }
      else if (method === 'Accessibility.getFullAXTree') reply = AX_TREE
      else if (method === 'Runtime.evaluate') reply = evaluate(String(params?.expression))
      return Promise.resolve(reply as T)
    },
    onEvent: (fn) => {
      listener = fn
      return () => {
        listener = null
      }
    },
    detach: async () => {}
  }

  return {
    transport,
    page,
    sent,
    sentWhileCrashed,
    crashed: () => crashed,
    crash: () => {
      crashed = true
      emit('Inspector.targetCrashed')
    }
  }
}

/** 一个 promise 在 ms 毫秒内落定了没有（真计时器） */
async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<boolean> {
  let settled = false
  work.then(
    () => (settled = true),
    () => (settled = true)
  )
  await new Promise((r) => setTimeout(r, ms))
  return settled
}

describe('接管中的 tab 崩了，navigate 把它救回来（CR-U10）', () => {
  it.each<[string, NavKind, string | undefined, string]>([
    [
      'reload',
      'reload',
      undefined,
      'Reloaded https://a.test/page. Take a snapshot before interacting.'
    ],
    [
      'goto',
      'goto',
      'https://a.test/other',
      'Navigated to https://a.test/other. Take a snapshot before interacting.'
    ],
    [
      'back',
      'back',
      undefined,
      'Navigated back to https://a.test/prev. Take a snapshot before interacting.'
    ]
  ])(
    'CR-U10 %s → 「导航了」、没有 error、一秒内落定；崩着时发出去的只有导航与 Inspector；之后不算崩着、快照照常',
    async (_label, nav, url, text) => {
      const page = crashableTransport()
      const manager = new CdpAttachManager({ attach: async () => page.transport })
      const session = await manager.session('t1')
      expect(session.crashed).toBe(false)

      page.crash()
      expect(session.crashed).toBe(true)

      const t0 = Date.now()
      const out = await navigateOp(session, nav, url)
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(out.text).toBe(text)
      expect(out.details?.error).toBeUndefined()
      expect(page.sentWhileCrashed.length).toBeGreaterThan(0)
      expect(page.sentWhileCrashed.filter((m) => !CRASH_SAFE.has(m))).toEqual([])

      expect(session.crashed).toBe(false)
      const snap = await snapshotOp(session, page.page.url)
      expect(snap.text).toContain('button "Go"')
    }
  )
})

describe('接管之前就崩了的 tab（CR-U11）', () => {
  it('CR-U11 session() 照常拿到；快照 50ms 内以那句话失败、AX 树一次都没要；wait_for 当场收手；reload 救回来之后快照照常', async () => {
    const page = crashableTransport({ startCrashed: true })
    const manager = new CdpAttachManager({ attach: async () => page.transport })
    const session = await manager.session('t1')
    expect(manager.isAttached('t1')).toBe(true)
    expect(session.crashed).toBe(true)

    const snap = snapshotOp(session, page.page.url)
    snap.catch(() => {})
    expect(await settlesWithin(snap, 50)).toBe(true)
    await expect(snap).rejects.toThrow(PAGE_CRASHED_MESSAGE)
    expect(page.sent).not.toContain('Accessibility.getFullAXTree')

    const t0 = Date.now()
    const waited = await waitForOp(session, 'x', 5000)
    expect(Date.now() - t0).toBeLessThan(100)
    expect(waited.text).toBe(`Error: stopped waiting for text "x": ${PAGE_CRASHED_MESSAGE}`)
    expect(page.sent).not.toContain('Runtime.evaluate')

    const reloaded = await navigateOp(session, 'reload')
    expect(reloaded.text).toBe('Reloaded https://a.test/page. Take a snapshot before interacting.')
    expect(reloaded.details?.error).toBeUndefined()
    expect(session.crashed).toBe(false)
    expect(page.sentWhileCrashed.filter((m) => !CRASH_SAFE.has(m))).toEqual([])

    const after = await snapshotOp(session, page.page.url)
    expect(after.text).toContain('button "Go"')
    expect(page.sent).toContain('Accessibility.getFullAXTree')
  })
})

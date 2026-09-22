/**
 * 每个已连接浏览器一份的状态（browserState.ts）—— CDP 接管的记账、事件路由、调试租约、标签组、
 * 模块在桥上挂的三个钩子，以及旁听 ChatEvent 的 `observeChromeTabRun`。
 *
 *   CBST-1…2   按 installId 懒建、常驻；现有状态查询不建；取连接 / 没连着的原话；
 *   CBST-3…5   CDP 传输：并发 attach 只一次、命令每次现取连接（重连后换对象不重新接管）、
 *              没连着时 attach 失败且下一次重试；
 *   CBST-6…8   事件：只进被接管的那个 tab；模块的扩展事件钩子只到那个浏览器、不建状态；
 *              外部断开 / 标签页关了只清本地记账，不发 detach，下一次操作重新接管；
 *   CBST-9…10  租约：整个浏览器没有在跑的轮次才释放全部调试；resetDebuggers 只忘接管、不动轮次；
 *   CBST-11    钩子：当前连接断开 / 新连接就绪才归零；被顶替的旧连接迟到的断开不动新连接的记账；
 *   CBST-12    forgetSession：标签组、轮次、站点授权、还在路上的并组一并作废；
 *   CBST-13    没连着时的 detach 安静地结束（包括 detach 请求本身失败）；
 *   JG-1…4     joinGroup：同一会话串行、ensure 拿到当前组 id、失败只拒那一次、不同会话互不等待；
 *   OR-1…4     observeChromeTabRun：只看 agent_start / agent_end，只认有效的标签页会话绑定。
 *
 * 桥用**真的**单例（模块的钩子挂在它上面），只把 `connectionFor` 换成查本文件的连接表；
 * 连接是假的（`request` 一个 vi.fn，按方法名回答）。状态表与授权表是进程级的 ——
 * 每个用例用自己的 installId / 会话 id。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BridgeHello } from '@shuvix/chat-protocol/chromeBridge'
import type { ChatEvent } from '@shuvix/chat-protocol/events'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

/** 会话 → 它的 settings.chromeTab（原样交给 chromeTabOf，可以是不合法的形状） */
const db = vi.hoisted(() => ({ bindings: {} as Record<string, unknown> }))

vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: {
    pickSettings: vi.fn((sid: string) =>
      sid in db.bindings ? { chromeTab: db.bindings[sid] } : undefined
    )
  }
}))

import { sessionDao } from '../../../dao/sessionDao'
import { chromeBridge, type BridgeConnection } from '../server'
import {
  CHROME_NOT_CONNECTED,
  chromeBrowserState,
  existingChromeBrowserState,
  observeChromeTabRun,
  requireConnection
} from '../browserState'
import { grantSite, isSiteGranted } from '../siteGrants'

// ─── 假连接 ─────────────────────────────────────────────────────────────

type Answer = (params: Record<string, unknown>) => unknown
type RequestMock = Mock<
  (method: string, params?: Record<string, unknown>, opts?: unknown) => Promise<unknown>
>

interface FakeConn {
  id: string
  ready: boolean
  info?: {
    installId: string
    runId: string
    browser: string
    extensionVersion: string
    connectedAt: number
  }
  request: RequestMock
}

let seq = 0
const iid = (): string => `bs-install-${++seq}`
const sid = (): string => `bs-session-${++seq}`

/** 一条就绪的假连接；没写回答的方法回 null（attach / detach / Page.enable 都是这样） */
function fakeConn(installId: string, answers: Record<string, Answer> = {}): FakeConn {
  return {
    id: `bs-conn-${++seq}`,
    ready: true,
    info: {
      installId,
      runId: 'run-1',
      browser: 'Chrome 140',
      extensionVersion: '1.0.0',
      connectedAt: 1
    },
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      const answer = answers[method]
      return answer ? answer(params ?? {}) : null
    }) as RequestMock
  }
}

/** installId → 此刻「连着」的那条（桥的 connectionFor 查这里） */
const conns = new Map<string, FakeConn>()

const asConn = (c: FakeConn): BridgeConnection => c as unknown as BridgeConnection

vi.spyOn(chromeBridge, 'connectionFor').mockImplementation(
  (installId: string) => conns.get(installId) as unknown as BridgeConnection | undefined
)

/** 连上一个浏览器：登记连接并回它 */
function connect(installId: string, answers?: Record<string, Answer>): FakeConn {
  const conn = fakeConn(installId, answers)
  conns.set(installId, conn)
  return conn
}

/** 某方法被请求过的参数（按顺序） */
const paramsOf = (c: FakeConn, method: string): unknown[] =>
  c.request.mock.calls.filter(([m]) => m === method).map(([, p]) => p)

/** 让排上的回调都跑完（detachAll 是 void 出去的）—— 「没有发生」的断言之前用 */
async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r))
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 抓住一次同步抛出的原话 */
function thrownBy(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('expected a throw')
}

function helloOf(conn: FakeConn): BridgeHello {
  return {
    type: 'hello',
    protocol: 1,
    extensionVersion: '1.0.0',
    installId: conn.info!.installId,
    runId: conn.info!.runId,
    browser: 'Chrome 140',
    openTabIds: []
  }
}

const pick = sessionDao.pickSettings as unknown as Mock<(sid: string, keys: string[]) => unknown>

beforeEach(() => {
  conns.clear()
  pick.mockClear()
})

afterEach(() => {
  for (const key of Object.keys(db.bindings)) delete db.bindings[key]
})

// ─── 按浏览器的状态 / 取连接 ────────────────────────────────────────────

describe('chromeBrowserState / requireConnection', () => {
  it('CBST-1 同一个 installId 同一份（懒建、常驻）；existing… 之前是 undefined 且从不建', () => {
    const id = iid()
    expect(existingChromeBrowserState(id)).toBeUndefined()
    expect(existingChromeBrowserState(id)).toBeUndefined()
    const state = chromeBrowserState(id)
    expect(state.installId).toBe(id)
    expect(chromeBrowserState(id)).toBe(state)
    expect(existingChromeBrowserState(id)).toBe(state)
    expect(chromeBrowserState(iid())).not.toBe(state)
  })

  it('CBST-2 没连着 → 抛 CHROME_NOT_CONNECTED 原话；连着 → 回那条连接', () => {
    const id = iid()
    expect(thrownBy(() => requireConnection(id))).toBe(CHROME_NOT_CONNECTED)
    const conn = connect(id)
    expect(requireConnection(id)).toBe(conn)
  })
})

// ─── CDP 传输 ────────────────────────────────────────────────────────────

describe('CDP 传输（经桥的 debugger 转发）', () => {
  it('CBST-3 同一 tab 并发两次 session() → 只 attach 一次（参数是数字 tabId），两边拿到同一个会话', async () => {
    const id = iid()
    const attach = deferred<null>()
    const conn = connect(id, { 'debugger.attach': () => attach.promise })
    const state = chromeBrowserState(id)

    const one = state.cdp.session('7')
    const two = state.cdp.session('7')
    await settle()
    attach.resolve(null)
    const [s1, s2] = await Promise.all([one, two])
    expect(s1).toBe(s2)
    expect(paramsOf(conn, 'debugger.attach')).toEqual([{ tabId: 7 }])
    expect(state.cdp.isAttached('7')).toBe(true)
  })

  it('CBST-4 命令走 debugger.send {tabId, method, params} 并回结果；换了连接对象（重连）之后发到新连接、不重新接管', async () => {
    const id = iid()
    const first = connect(id, { 'debugger.send': (p) => ({ echo: p.method }) })
    const state = chromeBrowserState(id)
    const session = await state.cdp.session('7')

    expect(await session.send('DOM.getDocument', { depth: 1 })).toEqual({
      echo: 'DOM.getDocument'
    })
    expect(paramsOf(first, 'debugger.send')).toEqual([
      { tabId: 7, method: 'DOM.getDocument', params: { depth: 1 } }
    ])

    const second = connect(id, { 'debugger.send': () => 'from-second' })
    expect(await session.send('Runtime.evaluate', { expression: '1' })).toBe('from-second')
    expect(paramsOf(second, 'debugger.send')).toEqual([
      { tabId: 7, method: 'Runtime.evaluate', params: { expression: '1' } }
    ])
    expect(paramsOf(second, 'debugger.attach')).toEqual([])
    expect(paramsOf(first, 'debugger.send')).toHaveLength(1)
  })

  it('CBST-5 没连着时 attach → 以 CHROME_NOT_CONNECTED 失败、不记接管；连上之后下一次操作重试', async () => {
    const id = iid()
    const state = chromeBrowserState(id)
    await expect(state.cdp.session('7')).rejects.toThrow(CHROME_NOT_CONNECTED)
    expect(state.cdp.isAttached('7')).toBe(false)

    const conn = connect(id)
    await state.cdp.session('7')
    expect(paramsOf(conn, 'debugger.attach')).toEqual([{ tabId: 7 }])
    expect(state.cdp.isAttached('7')).toBe(true)
  })

  it('CBST-5 attach 请求本身失败 → 这次失败，下一次重新 attach', async () => {
    const id = iid()
    let fail = true
    const conn = connect(id, {
      'debugger.attach': () => {
        if (fail) throw new Error('Another debugger is already attached to the tab.')
        return null
      }
    })
    const state = chromeBrowserState(id)
    await expect(state.cdp.session('7')).rejects.toThrow(
      'Another debugger is already attached to the tab.'
    )
    fail = false
    await state.cdp.session('7')
    expect(paramsOf(conn, 'debugger.attach')).toEqual([{ tabId: 7 }, { tabId: 7 }])
  })
})

// ─── 事件 ────────────────────────────────────────────────────────────────

describe('CDP 事件与外部断开', () => {
  it('CBST-6 deliver：事件只进被接管的那个 tab 的缓冲；params 缺席存成 {}', async () => {
    const id = iid()
    connect(id)
    const state = chromeBrowserState(id)
    const seven = await state.cdp.session('7')

    state.deliver({ tabId: 7, method: 'Log.entryAdded', params: { entry: { text: 'hi' } } })
    state.deliver({ tabId: 8, method: 'Log.somethingElse', params: { n: 1 } })
    state.deliver({
      tabId: 7,
      method: 'Page.loadEventFired',
      params: undefined as unknown as Record<string, unknown>
    })

    const { entries } = seven.getEvents({})
    expect(entries.map((e) => [e.method, e.params])).toEqual([
      ['Log.entryAdded', { entry: { text: 'hi' } }],
      ['Page.loadEventFired', {}]
    ])
  })

  it('CBST-7 模块的扩展事件钩子：只到那个浏览器；没握手的连接、没有状态的 installId 什么都不做，也不建状态', async () => {
    const x = iid()
    const y = iid()
    const connX = connect(x)
    connect(y)
    const sx = await chromeBrowserState(x).cdp.session('7')
    const sy = await chromeBrowserState(y).cdp.session('7')

    chromeBridge.dispatchEvent(asConn(connX), 'debugger.event', {
      tabId: 7,
      method: 'Log.entryAdded',
      params: { n: 1 }
    })
    expect(sx.getEvents({}).entries.map((e) => e.method)).toEqual(['Log.entryAdded'])
    expect(sy.getEvents({}).entries).toEqual([])

    // 没握手的连接（没有 info）
    const bare = { ...fakeConn(x), info: undefined }
    expect(() =>
      chromeBridge.dispatchEvent(asConn(bare), 'debugger.event', {
        tabId: 7,
        method: 'Log.x',
        params: {}
      })
    ).not.toThrow()
    expect(sx.getEvents({}).entries).toHaveLength(1)

    // 一个从没建过状态的浏览器
    const z = iid()
    chromeBridge.dispatchEvent(asConn(fakeConn(z)), 'debugger.event', {
      tabId: 7,
      method: 'Log.x',
      params: {}
    })
    chromeBridge.dispatchEvent(asConn(fakeConn(z)), 'tabs.removed', { tabId: 7 })
    expect(existingChromeBrowserState(z)).toBeUndefined()
  })

  it.each<[string, Record<string, unknown>]>([
    ['debugger.detached', { tabId: 7, reason: 'canceled_by_user' }],
    ['tabs.removed', { tabId: 7 }]
  ])(
    'CBST-8 %s → 只清本地记账（不发 detach），别的 tab 不动；下一次操作重新 attach',
    async (name, params) => {
      const id = iid()
      const conn = connect(id)
      const state = chromeBrowserState(id)
      await state.cdp.session('7')
      await state.cdp.session('8')

      chromeBridge.dispatchEvent(asConn(conn), name, params)
      expect(state.cdp.isAttached('7')).toBe(false)
      expect(state.cdp.isAttached('8')).toBe(true)
      await settle()
      expect(paramsOf(conn, 'debugger.detach')).toEqual([])

      await state.cdp.session('7')
      expect(paramsOf(conn, 'debugger.attach')).toEqual([{ tabId: 7 }, { tabId: 8 }, { tabId: 7 }])
    }
  )
})

// ─── 调试租约 ────────────────────────────────────────────────────────────

describe('调试租约（按会话记的轮次）', () => {
  it('CBST-9 两条会话在跑：先结束的不释放，后结束的那一刻 detach 全部；再结束一次不重复', async () => {
    const id = iid()
    const conn = connect(id)
    const state = chromeBrowserState(id)
    const [a, b] = [sid(), sid()]

    state.beginRun(a)
    state.beginRun(b)
    await state.cdp.session('7')

    state.endRun(a)
    await settle()
    expect(paramsOf(conn, 'debugger.detach')).toEqual([])
    expect(state.cdp.isAttached('7')).toBe(true)

    state.endRun(b)
    await settle()
    expect(paramsOf(conn, 'debugger.detach')).toEqual([{ tabId: 7 }])
    expect(state.cdp.isAttached('7')).toBe(false)

    state.endRun(b)
    await settle()
    expect(paramsOf(conn, 'debugger.detach')).toHaveLength(1)
  })

  it('CBST-9 什么都没接管时一轮结束 → 一个请求都不发', async () => {
    const id = iid()
    const conn = connect(id)
    const state = chromeBrowserState(id)
    const a = sid()
    state.beginRun(a)
    state.endRun(a)
    await settle()
    expect(conn.request).not.toHaveBeenCalled()
  })

  it('CBST-9 释放之后下一轮的操作重新接管', async () => {
    const id = iid()
    const conn = connect(id)
    const state = chromeBrowserState(id)
    const a = sid()
    state.beginRun(a)
    await state.cdp.session('7')
    state.endRun(a)
    await settle()
    state.beginRun(a)
    await state.cdp.session('7')
    expect(paramsOf(conn, 'debugger.attach')).toEqual([{ tabId: 7 }, { tabId: 7 }])
  })

  it('CBST-10 resetDebuggers 忘掉接管（不发 detach）但不动轮次：A 还在跑时 B 结束不释放，A 结束才释放', async () => {
    const id = iid()
    const conn = connect(id)
    const state = chromeBrowserState(id)
    const [a, b] = [sid(), sid()]

    state.beginRun(a)
    await state.cdp.session('7')
    state.resetDebuggers()
    expect(state.cdp.isAttached('7')).toBe(false)
    await settle()
    expect(paramsOf(conn, 'debugger.detach')).toEqual([])

    state.beginRun(b)
    await state.cdp.session('7')
    expect(paramsOf(conn, 'debugger.attach')).toEqual([{ tabId: 7 }, { tabId: 7 }])

    state.endRun(b)
    await settle()
    expect(paramsOf(conn, 'debugger.detach')).toEqual([])

    state.endRun(a)
    await settle()
    expect(paramsOf(conn, 'debugger.detach')).toEqual([{ tabId: 7 }])
  })
})

// ─── 模块挂在桥上的连接钩子 ──────────────────────────────────────────────

describe('连接钩子：什么时候把接管记账归零', () => {
  it('CBST-11 当前连接断开 → 那个浏览器的接管全部忘掉（不发 detach）；别的浏览器不动', async () => {
    const x = iid()
    const y = iid()
    const connX = connect(x)
    const connY = connect(y)
    const sx = chromeBrowserState(x)
    const sy = chromeBrowserState(y)
    await sx.cdp.session('7')
    await sy.cdp.session('7')

    // 桥先把它从登记表里摘掉，再回调钩子（release 的顺序）
    conns.delete(x)
    chromeBridge.release(asConn(connX), true)

    expect(sx.cdp.isAttached('7')).toBe(false)
    expect(sy.cdp.isAttached('7')).toBe(true)
    await settle()
    expect(paramsOf(connX, 'debugger.detach')).toEqual([])
    expect(paramsOf(connY, 'debugger.detach')).toEqual([])
  })

  it('CBST-11 被顶替的旧连接迟到的断开 → 新连接的接管记账原样保留', async () => {
    const x = iid()
    const old = connect(x)
    const state = chromeBrowserState(x)
    const fresh = connect(x)
    await state.cdp.session('7')

    chromeBridge.release(asConn(old), true)
    expect(state.cdp.isAttached('7')).toBe(true)

    // 新连接上的命令照常：没有重新接管
    await state.cdp.session('7')
    expect(paramsOf(fresh, 'debugger.attach')).toEqual([{ tabId: 7 }])
  })

  it('CBST-11 没握手的连接断开、没有状态的浏览器断开：什么都不做，也不建状态', () => {
    const z = iid()
    expect(() =>
      chromeBridge.release(asConn({ ...fakeConn(z), info: undefined }), false)
    ).not.toThrow()
    chromeBridge.release(asConn(fakeConn(z)), true)
    expect(existingChromeBrowserState(z)).toBeUndefined()
  })

  it('CBST-11 新连接就绪 → 那个浏览器的接管归零（扩展那边已是一份新的接管状态）；别的浏览器不动', async () => {
    const x = iid()
    const y = iid()
    const oldX = connect(x)
    connect(y)
    const sx = chromeBrowserState(x)
    const sy = chromeBrowserState(y)
    await sx.cdp.session('7')
    await sy.cdp.session('7')

    const freshX = connect(x)
    chromeBridge.announceReady(asConn(freshX), helloOf(freshX))

    expect(sx.cdp.isAttached('7')).toBe(false)
    expect(sy.cdp.isAttached('7')).toBe(true)
    await settle()
    expect(paramsOf(oldX, 'debugger.detach')).toEqual([])
    expect(paramsOf(freshX, 'debugger.detach')).toEqual([])

    // 下一次操作在新连接上重新接管
    await sx.cdp.session('7')
    expect(paramsOf(freshX, 'debugger.attach')).toEqual([{ tabId: 7 }])
  })

  it('CBST-11 一个从没建过状态的浏览器就绪 → 不建状态', () => {
    const z = iid()
    const conn = connect(z)
    chromeBridge.announceReady(asConn(conn), helloOf(conn))
    expect(existingChromeBrowserState(z)).toBeUndefined()
  })
})

// ─── forgetSession ──────────────────────────────────────────────────────

describe('forgetSession：会话没了', () => {
  it('CBST-12 标签组记录删掉；别的会话的不动', () => {
    const state = chromeBrowserState(iid())
    const [a, b] = [sid(), sid()]
    state.groups.set(a, 42)
    state.groups.set(b, 43)
    state.forgetSession(a)
    expect(state.groups.has(a)).toBe(false)
    expect(state.groups.get(b)).toBe(43)
  })

  it('CBST-12 它不再算在跑：唯一在跑的会话被忘掉 → 释放调试；还有别的会话在跑 → 不释放', async () => {
    const id = iid()
    const conn = connect(id)
    const state = chromeBrowserState(id)
    const [a, b] = [sid(), sid()]

    state.beginRun(a)
    state.beginRun(b)
    await state.cdp.session('7')
    state.forgetSession(a)
    await settle()
    expect(paramsOf(conn, 'debugger.detach')).toEqual([])

    state.forgetSession(b)
    await settle()
    expect(paramsOf(conn, 'debugger.detach')).toEqual([{ tabId: 7 }])
  })

  it('CBST-12 它的站点授权随之清掉；别的会话的授权不动', () => {
    const state = chromeBrowserState(iid())
    const [a, b] = [sid(), sid()]
    grantSite(a, 'bank.example')
    grantSite(b, 'bank.example')
    state.forgetSession(a)
    expect(isSiteGranted(a, 'bank.example')).toBe(false)
    expect(isSiteGranted(b, 'bank.example')).toBe(true)
  })

  it('CBST-12 还在路上的并组：会话被忘掉之后才回来的组 id 不再为它记下（那次调用照常结束）', async () => {
    const state = chromeBrowserState(iid())
    const a = sid()
    const ensure = deferred<number>()
    const joining = state.joinGroup(a, () => ensure.promise)
    await settle()
    state.forgetSession(a)
    ensure.resolve(42)
    await expect(joining).resolves.toBeUndefined()
    expect(state.groups.has(a)).toBe(false)

    // 之后同一个会话 id 再并组：从「还没有组」开始，记得下
    const ensure2 = vi.fn(async (current: number | undefined) => (current === undefined ? 7 : -1))
    await state.joinGroup(a, ensure2)
    expect(ensure2).toHaveBeenCalledWith(undefined)
    expect(state.groups.get(a)).toBe(7)
  })
})

// ─── 没连着时的 detach ───────────────────────────────────────────────────

describe('detach 的收尾', () => {
  it('CBST-13 接管之后断了线：主动 detach 安静地结束，请求不发到任何地方', async () => {
    const id = iid()
    const conn = connect(id)
    const state = chromeBrowserState(id)
    await state.cdp.session('7')
    conns.delete(id)
    await expect(state.cdp.detach('7')).resolves.toBeUndefined()
    expect(state.cdp.isAttached('7')).toBe(false)
    expect(paramsOf(conn, 'debugger.detach')).toEqual([])
  })

  it('CBST-13 detach 请求本身失败（Chrome 那边早已断开）→ 吞掉，没有未处理的拒绝', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const id = iid()
      const conn = connect(id, {
        'debugger.detach': () => {
          throw new Error('Debugger is not attached to the tab with id: 7.')
        }
      })
      const state = chromeBrowserState(id)
      const a = sid()
      state.beginRun(a)
      await state.cdp.session('7')
      state.endRun(a)
      await settle(10)
      expect(paramsOf(conn, 'debugger.detach')).toEqual([{ tabId: 7 }])
      expect(state.cdp.isAttached('7')).toBe(false)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

// ─── joinGroup ──────────────────────────────────────────────────────────

describe('joinGroup：把新开的页并进会话的标签组', () => {
  it('JG-1 同一会话一次一个：前一次的 ensure 落定之前，后一次不开始；后一次拿到前一次回的组 id', async () => {
    const state = chromeBrowserState(iid())
    const a = sid()
    const first = deferred<number>()
    const ensure1 = vi.fn(() => first.promise)
    const ensure2 = vi.fn(async (current: number | undefined) => (current ?? 0) + 1)

    const j1 = state.joinGroup(a, ensure1)
    const j2 = state.joinGroup(a, ensure2)
    await settle()
    expect(ensure1).toHaveBeenCalledWith(undefined)
    expect(ensure2).not.toHaveBeenCalled()

    first.resolve(42)
    await j1
    await j2
    expect(ensure2).toHaveBeenCalledWith(42)
    expect(state.groups.get(a)).toBe(43)
  })

  it('JG-2 ensure 拿到当前的组 id（第一次 undefined），回的 id 记下、替换旧的', async () => {
    const state = chromeBrowserState(iid())
    const a = sid()
    const seen: Array<number | undefined> = []
    const ensure = async (current: number | undefined): Promise<number> => {
      seen.push(current)
      return seen.length === 1 ? 10 : 20
    }
    await state.joinGroup(a, ensure)
    expect(state.groups.get(a)).toBe(10)
    await state.joinGroup(a, ensure)
    expect(seen).toEqual([undefined, 10])
    expect(state.groups.get(a)).toBe(20)
  })

  it('JG-3 一次 ensure 失败只拒绝那一次：组不记、下一次照跑（从「还没有组」开始）', async () => {
    const state = chromeBrowserState(iid())
    const a = sid()
    const ensure2 = vi.fn(async () => 7)
    const j1 = state.joinGroup(a, async () => {
      throw new Error('No group with id: 3.')
    })
    const j2 = state.joinGroup(a, ensure2)
    await expect(j1).rejects.toThrow('No group with id: 3.')
    await expect(j2).resolves.toBeUndefined()
    expect(ensure2).toHaveBeenCalledWith(undefined)
    expect(state.groups.get(a)).toBe(7)
  })

  it('JG-4 不同会话互不等待，各记各的组', async () => {
    const state = chromeBrowserState(iid())
    const [a, b] = [sid(), sid()]
    const held = deferred<number>()
    const ja = state.joinGroup(a, () => held.promise)
    await state.joinGroup(b, async () => 5)
    expect(state.groups.get(b)).toBe(5)
    expect(state.groups.has(a)).toBe(false)
    held.resolve(9)
    await ja
    expect(state.groups.get(a)).toBe(9)
  })
})

// ─── observeChromeTabRun ────────────────────────────────────────────────

const ev = (type: 'agent_start' | 'agent_end', sessionId: string): ChatEvent =>
  ({ type, sessionId }) as ChatEvent

describe('observeChromeTabRun：旁听 ChatEvent 记一轮的起止', () => {
  it('OR-1 标签页会话的 agent_start / agent_end → 那个浏览器的 beginRun / endRun（按绑定里的 installId）', () => {
    const id = iid()
    const s = sid()
    db.bindings[s] = { installId: id, runId: 'run-1', tabId: 5 }
    const state = chromeBrowserState(id)
    const begin = vi.spyOn(state, 'beginRun')
    const end = vi.spyOn(state, 'endRun')

    observeChromeTabRun(ev('agent_start', s))
    expect(begin.mock.calls).toEqual([[s]])
    expect(end).not.toHaveBeenCalled()
    expect(pick).toHaveBeenCalledWith(s, ['chromeTab'])

    observeChromeTabRun(ev('agent_end', s))
    expect(end.mock.calls).toEqual([[s]])
  })

  it('OR-2 别的事件一律不看：不查库、不建状态', () => {
    const id = iid()
    const s = sid()
    db.bindings[s] = { installId: id, runId: 'run-1', tabId: 5 }
    const others = [
      { type: 'text_delta', sessionId: s, delta: 'x' },
      { type: 'tool_start', sessionId: s, toolCallId: 't', toolName: 'mcp__chrome__click' },
      { type: 'error', sessionId: s, error: 'boom' },
      { type: 'agent_created', sessionId: s },
      { type: 'token_usage', sessionId: s, promptTokens: 1 }
    ] as unknown as ChatEvent[]
    for (const event of others) observeChromeTabRun(event)
    expect(pick).not.toHaveBeenCalled()
    expect(existingChromeBrowserState(id)).toBeUndefined()
  })

  it.each<[string, ((installId: string) => unknown) | undefined]>([
    ['没有这条会话（派生 agent 的事件带的是它自己的 id）', undefined],
    ['不是标签页会话', () => null],
    ['tabId 是字符串', (installId) => ({ installId, runId: 'r', tabId: '5' })],
    ['tabId 是负数', (installId) => ({ installId, runId: 'r', tabId: -1 })],
    ['缺 runId', (installId) => ({ installId, tabId: 5 })],
    ['installId 为空串', () => ({ installId: '', runId: 'r', tabId: 5 })]
  ])('OR-3 %s → 什么都不做（不建状态）', (_l, bindingOf) => {
    const id = iid()
    const s = sid()
    if (bindingOf) db.bindings[s] = bindingOf(id)
    observeChromeTabRun(ev('agent_start', s))
    observeChromeTabRun(ev('agent_end', s))
    expect(pick).toHaveBeenCalledWith(s, ['chromeTab'])
    expect(existingChromeBrowserState(id)).toBeUndefined()
    expect(existingChromeBrowserState('')).toBeUndefined()
  })

  it('OR-4 端到端：一轮开始 → 操作接管了 tab → 一轮结束 → detach；另一条会话还在跑时不释放', async () => {
    const id = iid()
    const conn = connect(id)
    const [a, b] = [sid(), sid()]
    db.bindings[a] = { installId: id, runId: 'run-1', tabId: 5 }
    db.bindings[b] = { installId: id, runId: 'run-1', tabId: 6 }

    observeChromeTabRun(ev('agent_start', a))
    observeChromeTabRun(ev('agent_start', b))
    await chromeBrowserState(id).cdp.session('7')

    observeChromeTabRun(ev('agent_end', a))
    await settle()
    expect(paramsOf(conn, 'debugger.detach')).toEqual([])

    observeChromeTabRun(ev('agent_end', b))
    await settle()
    expect(paramsOf(conn, 'debugger.detach')).toEqual([{ tabId: 7 }])
  })
})

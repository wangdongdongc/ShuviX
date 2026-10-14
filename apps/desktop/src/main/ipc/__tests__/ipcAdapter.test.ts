/**
 * `ipc/ipcAdapter.ts` —— 通道注册表的 IPC 传输（server mode phase A §3）：定义登记到 ipcMain、由 IPC 事件构造
 * `ClientContext`、按调用方找回 webContents / 窗口、推回 / 盯生死 / 广播。
 * 每条用例 `vi.resetModules()` 后重新导入 `../registry` 与 `../ipcAdapter`（两者都有模块级状态）。
 *
 * electron 是替身：`ipcMain.{handle,on}` spy、`BrowserWindow.{getAllWindows,fromWebContents}`、`webContents.fromId`
 * （缺省回 undefined）。假 ipcMain 记下（种类，通道，监听器）；webContents 用视图同步夹具的 `FakeWebContents`
 * （EventEmitter + id + `send` 记进 `sent` + `isDestroyed()` + `destroy()` 发 'destroyed'）。
 *
 *   IA-1  handle：`defineHandler('c', fn)` + `attachIpcAdapter(fake)` → `fake.handle('c', L)` 恰一次；`L({ sender: wc7 }, a, b)`
 *         调 `fn(ctx, a, b)`，ctx 严格等于 `{ client: { kind: 'window', id: 'ipc:7', webContentsId: 7 }, transport: 'ipc' }`
 *         （恰这些键、不漏 sender、能 JSON 往返；id === clientIdOf(event)）；L 原样交回 fn 的值 / Promise；
 *         同步抛错从 L 里抛出来，拒绝的 Promise 原样交回
 *   IA-2  listen：`defineListener` → `fake.on('c', L)`；`L({ sender: wc7 }, x)` 调 `fn(ctx, x)`（同形 ctx）；L 回 undefined
 *   IA-3  挂之前的定义与挂之后的定义都按顺序登记到 ipcMain；不传参数的 `attachIpcAdapter()` 登记到（替身）electron 的
 *         ipcMain；第二次 `attachIpcAdapter` 抛错
 *   IA-4  认人按对象：`webContentsOf(ctx) === wc7`，即使 `webContents.fromId(7)` 回的是别的对象；调用返回之后（存下来的
 *         ctx.client 稍后再用）照样；wc7 的两次调用 → 两个不同的 ctx.client，id 相同，都认回 wc7
 *   IA-5  手搓的 ClientRef `{ kind: 'window', id: 'ipc:9', webContentsId: 9 }`：退回 `webContents.fromId(9)`；
 *         fromId 回 undefined / null → undefined
 *   IA-6  `windowOf(ctx)` → `BrowserWindow.fromWebContents(sender)`；回 null → undefined；没有 webContents 时不调 fromWebContents
 *   IA-7  没有 sender 的事件（`{}` / `{ sender: undefined }`）：fn 照样被调，client = `{ kind: 'window', id: 'ipc:-1',
 *         webContentsId: -1 }`；webContentsOf / windowOf → undefined，从不 fromId(-1)；pushTo 什么也不做；
 *         isClientAlive false；onClientGone 回无操作的注销函数、永不触发
 *   IA-8  `pushTo(ctx.client, 'ch', p1, p2)` → `wc7.send('ch', p1, p2)`；没有载荷 → `send('ch')`；wc7 已销毁 → 不发、不抛；
 *         手搓的 ref → 发给 fromId 找到的那个；fromId 回 undefined → 什么也不做
 *   IA-9  `isClientAlive`：活着 true，`destroy()` 之后 false
 *   IA-10 `onClientGone`：'destroyed' 时恰触发一次（再发一次不再触发）；销毁前撤掉 → 永不触发、'destroyed' 的监听数回到原样；
 *         销毁后再撤 → 不抛、不对已销毁的 webContents 调 removeListener
 *   IA-11 `broadcastToClients('ch', p)` → `getAllWindows()` 里每个没销毁的窗口 `webContents.send('ch', p)`；已销毁的跳过；
 *         没有窗口 → 什么也不做
 *   NH-12 网络客户端（server mode phase B）：webContentsOf / windowOf → undefined，不调 fromId / fromWebContents；IPC 传输不认它 ——
 *         只挂了 IPC 时 pushTo 不发给任何 webContents、isClientAlive false、onClientGone 永不触发
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clientIdOf } from '../../frontend/sync/clientIdentity'
import { FakeWebContents } from '../../frontend/sync/__tests__/support/ipcLinkRig'
import type * as RegistryModule from '../registry'
import type * as AdapterModule from '../ipcAdapter'
import type { ClientContext, ClientRef } from '../registry'

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  getAllWindows: vi.fn((): unknown[] => []),
  fromWebContents: vi.fn((_contents: unknown): unknown => undefined),
  fromId: vi.fn((_id: number): unknown => undefined)
}))

vi.mock('electron', () => ({
  ipcMain: electron.ipcMain,
  BrowserWindow: {
    getAllWindows: electron.getAllWindows,
    fromWebContents: electron.fromWebContents
  },
  webContents: { fromId: electron.fromId }
}))

type IpcListener = (event: unknown, ...args: unknown[]) => unknown

/** 假 ipcMain：按顺序记下（种类，通道，监听器） */
class RecordingIpcMain {
  readonly registrations: Array<{ kind: 'handle' | 'on'; channel: string; listener: IpcListener }> =
    []
  handle(channel: string, listener: IpcListener): void {
    this.registrations.push({ kind: 'handle', channel, listener })
  }
  on(channel: string, listener: IpcListener): void {
    this.registrations.push({ kind: 'on', channel, listener })
  }
  listener(channel: string): IpcListener {
    const hits = this.registrations.filter((r) => r.channel === channel)
    if (hits.length !== 1) throw new Error(`${hits.length} registrations for ${channel}`)
    return hits[0].listener
  }
}

let registry: typeof RegistryModule
let adapter: typeof AdapterModule
let ipc: RecordingIpcMain

beforeEach(async () => {
  vi.resetModules()
  electron.ipcMain.handle.mockReset()
  electron.ipcMain.on.mockReset()
  electron.getAllWindows.mockReset().mockImplementation(() => [])
  electron.fromWebContents.mockReset().mockImplementation(() => undefined)
  electron.fromId.mockReset().mockImplementation(() => undefined)
  registry = await import('../registry')
  adapter = await import('../ipcAdapter')
  ipc = new RecordingIpcMain()
})

const asIpc = (fake: RecordingIpcMain): Parameters<typeof AdapterModule.attachIpcAdapter>[0] =>
  fake as never

/** 定义一个 handler 记下每次的 ctx，挂上适配器，回 ipcMain 上的监听器 */
function captureContexts(channel = 'cap:ctx'): { L: IpcListener; contexts: ClientContext[] } {
  const contexts: ClientContext[] = []
  registry.defineHandler(channel, (ctx) => {
    contexts.push(ctx)
    return 'ok'
  })
  adapter.attachIpcAdapter(asIpc(ipc))
  return { L: ipc.listener(channel), contexts }
}

const EXPECTED_CTX_7 = {
  client: { kind: 'window', id: 'ipc:7', webContentsId: 7 },
  transport: 'ipc'
}

describe('IA-1 handle 路径', () => {
  it('IA-1 fake.handle 恰一次；fn(ctx, a, b)，ctx 恰是 { client, transport }、能 JSON 往返、id === clientIdOf(event)', () => {
    const fn = vi.fn((_ctx: ClientContext, ..._args: unknown[]) => 'value')
    registry.defineHandler('c', fn)
    adapter.attachIpcAdapter(asIpc(ipc))
    expect(ipc.registrations.map((r) => [r.kind, r.channel])).toEqual([['handle', 'c']])

    const wc7 = new FakeWebContents(7)
    const event = { sender: wc7 }
    const a = { a: 1 }
    const b = { b: 2 }
    expect(ipc.listener('c')(event, a, b)).toBe('value')
    expect(fn).toHaveBeenCalledTimes(1)
    const [ctx, ...rest] = fn.mock.calls[0]
    expect(rest).toHaveLength(2)
    expect(rest[0]).toBe(a)
    expect(rest[1]).toBe(b)
    expect(ctx).toStrictEqual(EXPECTED_CTX_7)
    expect(Object.keys(ctx).sort()).toEqual(['client', 'transport'])
    expect(Object.keys(ctx.client).sort()).toEqual(['id', 'kind', 'webContentsId'])
    expect(JSON.parse(JSON.stringify(ctx))).toStrictEqual(EXPECTED_CTX_7)
    expect(Object.values(ctx.client)).not.toContain(wc7)
    expect(ctx.client.id).toBe(clientIdOf(event))
  })

  it('IA-1 L 原样交回 fn 的值 / Promise；同步抛错从 L 抛出；拒绝的 Promise 原样交回', async () => {
    const promise = Promise.resolve({ success: true })
    const err = new Error('sync boom')
    const rejected = Promise.reject(new Error('async boom'))
    rejected.catch(() => {})
    registry.defineHandler('ret:value', () => 42)
    registry.defineHandler('ret:promise', () => promise)
    registry.defineHandler('ret:throw', () => {
      throw err
    })
    registry.defineHandler('ret:reject', () => rejected)
    adapter.attachIpcAdapter(asIpc(ipc))
    const event = { sender: new FakeWebContents(7) }
    expect(ipc.listener('ret:value')(event)).toBe(42)
    expect(ipc.listener('ret:promise')(event)).toBe(promise)
    expect(() => ipc.listener('ret:throw')(event)).toThrow(err)
    const got = ipc.listener('ret:reject')(event)
    expect(got).toBe(rejected)
    await expect(got).rejects.toThrow('async boom')
  })
})

describe('IA-2 listen 路径', () => {
  it('IA-2 fake.on("c", L)；L(event, x) 调 fn(ctx, x)，同形 ctx；L 回 undefined', () => {
    const fn = vi.fn((_ctx: ClientContext, ..._args: unknown[]) => 'ignored')
    registry.defineListener('c', fn)
    adapter.attachIpcAdapter(asIpc(ipc))
    expect(ipc.registrations.map((r) => [r.kind, r.channel])).toEqual([['on', 'c']])
    const x = { x: 1 }
    expect(ipc.listener('c')({ sender: new FakeWebContents(7) }, x)).toBeUndefined()
    expect(fn).toHaveBeenCalledTimes(1)
    const [ctx, ...rest] = fn.mock.calls[0]
    expect(rest).toEqual([x])
    expect(rest[0]).toBe(x)
    expect(ctx).toStrictEqual(EXPECTED_CTX_7)
  })
})

describe('IA-3 登记时机与一次性', () => {
  it('IA-3 挂之前与挂之后的定义都按顺序登记到 ipcMain', () => {
    registry.defineHandler('before:h', () => 1)
    registry.defineListener('before:l', () => {})
    adapter.attachIpcAdapter(asIpc(ipc))
    registry.defineListener('after:l', () => {})
    registry.defineHandler('after:h', () => 2)
    expect(ipc.registrations.map((r) => [r.kind, r.channel])).toEqual([
      ['handle', 'before:h'],
      ['on', 'before:l'],
      ['on', 'after:l'],
      ['handle', 'after:h']
    ])
  })

  it('IA-3 不传参数 → 登记到 electron 的 ipcMain；第二次 attachIpcAdapter 抛错', () => {
    registry.defineHandler('real:h', () => 1)
    registry.defineListener('real:l', () => {})
    adapter.attachIpcAdapter()
    expect(electron.ipcMain.handle.mock.calls.map(([channel]) => channel)).toEqual(['real:h'])
    expect(electron.ipcMain.on.mock.calls.map(([channel]) => channel)).toEqual(['real:l'])
    expect(() => adapter.attachIpcAdapter(asIpc(ipc))).toThrow()
    expect(() => adapter.attachIpcAdapter()).toThrow()
    expect(ipc.registrations).toEqual([])
  })
})

describe('IA-4 认人按对象', () => {
  it('IA-4 webContentsOf(ctx) === wc7，即使 fromId(7) 回别的对象；调用返回之后照样', async () => {
    const wc7 = new FakeWebContents(7)
    const impostor = new FakeWebContents(7)
    electron.fromId.mockImplementation(() => impostor)
    const { L, contexts } = captureContexts()
    L({ sender: wc7 })
    await Promise.resolve()
    const stored = contexts[0]
    expect(adapter.webContentsOf(stored)).toBe(wc7)
    // 存下来的 ctx.client 稍后再用
    expect(adapter.webContentsOf({ client: stored.client, transport: 'ipc' })).toBe(wc7)
    expect(electron.fromId).not.toHaveBeenCalled()
  })

  it('IA-4 wc7 的两次调用 → 两个不同的 ctx.client，id 相同，都认回 wc7', () => {
    const wc7 = new FakeWebContents(7)
    const { L, contexts } = captureContexts()
    L({ sender: wc7 })
    L({ sender: wc7 })
    expect(contexts).toHaveLength(2)
    expect(contexts[0].client).not.toBe(contexts[1].client)
    expect(contexts[0].client.id).toBe(contexts[1].client.id)
    expect(adapter.webContentsOf(contexts[0])).toBe(wc7)
    expect(adapter.webContentsOf(contexts[1])).toBe(wc7)
  })
})

describe('IA-5 手搓的 ClientRef', () => {
  const handMade: ClientContext = {
    client: { kind: 'window', id: 'ipc:9', webContentsId: 9 },
    transport: 'ipc'
  }

  it('IA-5 退回 webContents.fromId(9)', () => {
    const wc9 = new FakeWebContents(9)
    electron.fromId.mockImplementation((id) => (id === 9 ? wc9 : undefined))
    expect(adapter.webContentsOf(handMade)).toBe(wc9)
    expect(electron.fromId).toHaveBeenCalledWith(9)
  })

  it('IA-5 fromId 回 undefined / null → undefined', () => {
    electron.fromId.mockImplementation(() => undefined)
    expect(adapter.webContentsOf(handMade)).toBeUndefined()
    electron.fromId.mockImplementation(() => null)
    expect(adapter.webContentsOf(handMade)).toBeUndefined()
  })
})

describe('IA-6 windowOf', () => {
  it('IA-6 → BrowserWindow.fromWebContents(sender)；回 null → undefined', () => {
    const wc7 = new FakeWebContents(7)
    const win = { id: 'win-7' }
    const { L, contexts } = captureContexts()
    L({ sender: wc7 })
    electron.fromWebContents.mockImplementation((contents) => (contents === wc7 ? win : null))
    expect(adapter.windowOf(contexts[0])).toBe(win)
    expect(electron.fromWebContents.mock.calls.map(([c]) => c)).toEqual([wc7])
    electron.fromWebContents.mockImplementation(() => null)
    expect(adapter.windowOf(contexts[0])).toBeUndefined()
  })

  it('IA-6 没有 webContents（手搓的 ref 且 fromId 找不到）→ undefined，不调 fromWebContents', () => {
    const handMade: ClientContext = {
      client: { kind: 'window', id: 'ipc:9', webContentsId: 9 },
      transport: 'ipc'
    }
    expect(adapter.windowOf(handMade)).toBeUndefined()
    expect(electron.fromWebContents).not.toHaveBeenCalled()
  })
})

describe('IA-7 没有 sender 的事件', () => {
  it.each([[{}], [{ sender: undefined }]])(
    'IA-7 %j：fn 照样被调（client ipc:-1）；认不回 webContents / 窗口；推送、生死、离开都无操作',
    (event) => {
      // 诱饵：要是有人按 id 去找，就会找到这个
      const decoy = new FakeWebContents(-1)
      electron.fromId.mockImplementation(() => decoy)
      electron.fromWebContents.mockImplementation(() => ({ id: 'decoy-window' }))
      const { L, contexts } = captureContexts()
      expect(L(event)).toBe('ok')
      expect(contexts).toHaveLength(1)
      const ctx = contexts[0]
      expect(ctx).toStrictEqual({
        client: { kind: 'window', id: 'ipc:-1', webContentsId: -1 },
        transport: 'ipc'
      })
      expect(adapter.webContentsOf(ctx)).toBeUndefined()
      expect(adapter.windowOf(ctx)).toBeUndefined()
      expect(() => registry.pushTo(ctx.client, 'ch', 1)).not.toThrow()
      expect(decoy.sent).toEqual([])
      expect(registry.isClientAlive(ctx.client)).toBe(false)
      const cb = vi.fn()
      const dispose = registry.onClientGone(ctx.client, cb)
      expect(typeof dispose).toBe('function')
      expect(() => dispose()).not.toThrow()
      decoy.destroy()
      expect(cb).not.toHaveBeenCalled()
      expect(electron.fromId).not.toHaveBeenCalled()
      expect(electron.fromWebContents).not.toHaveBeenCalled()
    }
  )
})

describe('IA-8 pushTo', () => {
  it("IA-8 pushTo(ctx.client, 'ch', p1, p2) → wc7.send('ch', p1, p2)；没有载荷 → send('ch')", () => {
    const wc7 = new FakeWebContents(7)
    const send = vi.spyOn(wc7, 'send')
    const { L, contexts } = captureContexts()
    L({ sender: wc7 })
    const p1 = { p: 1 }
    const p2 = { p: 2 }
    registry.pushTo(contexts[0].client, 'ch', p1, p2)
    registry.pushTo(contexts[0].client, 'ch')
    expect(send.mock.calls).toEqual([['ch', p1, p2], ['ch']])
    expect(send.mock.calls[0][1]).toBe(p1)
  })

  it('IA-8 wc7 已销毁 → 不发、不抛', () => {
    const wc7 = new FakeWebContents(7)
    wc7.throwOnSend = true // 万一发了也看得出来
    const { L, contexts } = captureContexts()
    L({ sender: wc7 })
    wc7.destroy()
    expect(() => registry.pushTo(contexts[0].client, 'ch', 1)).not.toThrow()
    expect(wc7.sent).toEqual([])
  })

  it('IA-8 手搓的 ref → 发给 fromId 找到的那个；fromId 回 undefined → 什么也不做', () => {
    const wc9 = new FakeWebContents(9)
    const ref: ClientRef = { kind: 'window', id: 'ipc:9', webContentsId: 9 }
    adapter.attachIpcAdapter(asIpc(ipc))
    electron.fromId.mockImplementation((id) => (id === 9 ? wc9 : undefined))
    registry.pushTo(ref, 'ch', 'x')
    expect(wc9.sent).toEqual([['ch', 'x']])
    electron.fromId.mockImplementation(() => undefined)
    expect(() => registry.pushTo(ref, 'ch', 'y')).not.toThrow()
    expect(wc9.sent).toEqual([['ch', 'x']])
  })
})

describe('IA-9 isClientAlive', () => {
  it('IA-9 活着 true，destroy() 之后 false', () => {
    const wc7 = new FakeWebContents(7)
    const { L, contexts } = captureContexts()
    L({ sender: wc7 })
    expect(registry.isClientAlive(contexts[0].client)).toBe(true)
    wc7.destroy()
    expect(registry.isClientAlive(contexts[0].client)).toBe(false)
  })
})

describe('IA-10 onClientGone', () => {
  it("IA-10 'destroyed' 时恰触发一次，再发一次不再触发", () => {
    const wc7 = new FakeWebContents(7)
    const { L, contexts } = captureContexts()
    L({ sender: wc7 })
    const cb = vi.fn()
    registry.onClientGone(contexts[0].client, cb)
    expect(cb).not.toHaveBeenCalled()
    wc7.destroy()
    expect(cb).toHaveBeenCalledTimes(1)
    wc7.emit('destroyed')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it("IA-10 销毁前撤掉 → 永不触发，'destroyed' 的监听数回到原样", () => {
    const wc7 = new FakeWebContents(7)
    const { L, contexts } = captureContexts()
    L({ sender: wc7 })
    const baseline = wc7.listenerCount('destroyed')
    const cb = vi.fn()
    const dispose = registry.onClientGone(contexts[0].client, cb)
    expect(wc7.listenerCount('destroyed')).toBe(baseline + 1)
    dispose()
    expect(wc7.listenerCount('destroyed')).toBe(baseline)
    wc7.destroy()
    expect(cb).not.toHaveBeenCalled()
  })

  it('IA-10 销毁后再撤 → 不抛，不对已销毁的 webContents 调 removeListener', () => {
    const wc7 = new FakeWebContents(7)
    const { L, contexts } = captureContexts()
    L({ sender: wc7 })
    const cb = vi.fn()
    const dispose = registry.onClientGone(contexts[0].client, cb)
    wc7.destroy()
    expect(cb).toHaveBeenCalledTimes(1)
    const removeListener = vi.spyOn(wc7, 'removeListener')
    expect(() => dispose()).not.toThrow()
    expect(removeListener).not.toHaveBeenCalled()
  })
})

describe('IA-11 broadcastToClients', () => {
  const windowOn = (wc: FakeWebContents, destroyed = false): unknown => ({
    isDestroyed: () => destroyed,
    webContents: wc
  })

  it("IA-11 每个没销毁的窗口都收到 send('ch', p)；已销毁的跳过", () => {
    adapter.attachIpcAdapter(asIpc(ipc))
    const a = new FakeWebContents(1)
    const b = new FakeWebContents(2)
    const gone = new FakeWebContents(3)
    gone.throwOnSend = true
    electron.getAllWindows.mockImplementation(() => [
      windowOn(a),
      windowOn(gone, true),
      windowOn(b)
    ])
    const p = { p: 1 }
    expect(() => registry.broadcastToClients('ch', p)).not.toThrow()
    expect(a.sent).toEqual([['ch', p]])
    expect(b.sent).toEqual([['ch', p]])
    expect(gone.sent).toEqual([])
    expect(a.sent[0][1]).toBe(p)
  })

  it('IA-11 没有窗口 → 什么也不做', () => {
    adapter.attachIpcAdapter(asIpc(ipc))
    electron.getAllWindows.mockImplementation(() => [])
    expect(() => registry.broadcastToClients('ch', 1)).not.toThrow()
    expect(electron.getAllWindows).toHaveBeenCalledTimes(1)
  })
})

describe('NH-12 网络客户端不归 IPC 传输管', () => {
  const netCtx: ClientContext = {
    client: { kind: 'network', id: 'ws:1', remoteAddress: '192.168.1.20', userAgent: 'UA/1' },
    transport: 'network'
  }

  it('NH-12 webContentsOf / windowOf → undefined，不调 fromId / fromWebContents', () => {
    adapter.attachIpcAdapter(asIpc(ipc))
    expect(adapter.webContentsOf(netCtx)).toBeUndefined()
    expect(adapter.windowOf(netCtx)).toBeUndefined()
    expect(electron.fromId).not.toHaveBeenCalled()
    expect(electron.fromWebContents).not.toHaveBeenCalled()
  })

  it('NH-12 只挂了 IPC：pushTo 不发、isClientAlive false、onClientGone 永不触发', async () => {
    adapter.attachIpcAdapter(asIpc(ipc))
    const wc = new FakeWebContents(1)
    electron.fromId.mockImplementation(() => wc)
    electron.getAllWindows.mockImplementation(() => [{ isDestroyed: () => false, webContents: wc }])
    registry.pushTo(netCtx.client, 'ch', 1)
    expect(wc.sent).toEqual([])
    expect(registry.isClientAlive(netCtx.client)).toBe(false)
    const cb = vi.fn()
    const dispose = registry.onClientGone(netCtx.client, cb)
    wc.destroy()
    await Promise.resolve()
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
    expect(() => dispose()).not.toThrow()
    expect(electron.fromId).not.toHaveBeenCalled()
  })
})

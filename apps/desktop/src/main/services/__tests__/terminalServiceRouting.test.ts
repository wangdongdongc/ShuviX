/**
 * 终端输出回送给**开终端的那个客户端**（server mode phase A §3：terminal:create 改成按 `ctx.client` 推回）。
 * 经真的 IPC 适配器与真的 `terminal:create` 处理器调用（假 ipcMain、以某个 webContents 的身份）；node-pty 是替身，
 * pty 的 onData / onExit 由用例触发。每条用例 `vi.resetModules()` 后重新导入（注册表与终端表都是模块级状态）。
 *
 *   CH-4 (a) wc7 开的终端：invoke 返回**之后** pty 的输出 / 退出 → `wc7.send('terminal:data' | 'terminal:exit', …)`，
 *            别的窗口什么也收不到
 *        (b) wc7 销毁之后：输出 / 退出都不再发、不抛
 *        (c) `destroyTerminalsByWindow(7)` 只杀 client.webContentsId 为 7 的终端；别的窗口的终端照旧回送
 *   NH-13 网络客户端（server mode phase B；网络传输挂在注册表上，连接是假的）开的终端：
 *        (a) 输出 / 退出 → 那条连接收到 `{t:'push', channel:'terminal:data' | 'terminal:exit', args:[…]}`
 *        (b) 连接关了 → 那个 pty 恰 kill 一次，之后 terminal:write 到不了它
 *        (c) 窗口开的终端不受网络连接关闭的影响
 *        (d) 开终端时客户端已经没了 → 一个微任务之后 kill 掉
 *        (e) 终端退出 / 销毁时撤掉「客户端没了就收掉」的监听（连接上挂着的关闭回调回到原数）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebContents } from '../../frontend/sync/__tests__/support/ipcLinkRig'
/* eslint-disable boundaries/dependencies -- 网络客户端那一半：真的网络传输 + 假连接（产品里是 frontend 引服务，不是反过来） */
import { createNetworkTransport, type NetworkTransport } from '../../frontend/network/transport'
import {
  fakeConnection,
  netClient,
  netCtx
} from '../../frontend/network/__tests__/support/fakeNetworkConnection'
/* eslint-enable boundaries/dependencies */
import type { ChannelDefinition, ClientContext } from '../../ipc/registry'

interface FakePty {
  data?: (chunk: string) => void
  exit?: (e: { exitCode: number }) => void
  kill: ReturnType<typeof vi.fn>
  write?: ReturnType<typeof vi.fn>
}

const state = vi.hoisted(() => ({
  ptys: [] as Array<{
    data?: (chunk: string) => void
    exit?: (e: { exitCode: number }) => void
    kill: ReturnType<typeof vi.fn>
    write?: ReturnType<typeof vi.fn>
  }>,
  fromId: vi.fn((_id: number): unknown => undefined)
}))

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const p: FakePty = { kill: vi.fn(), write: vi.fn() }
    state.ptys.push(p)
    return {
      onData: (cb: (chunk: string) => void) => {
        p.data = cb
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        p.exit = cb
      },
      kill: p.kill,
      write: p.write,
      resize: vi.fn()
    }
  })
}))
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []), fromWebContents: vi.fn(() => null) },
  webContents: { fromId: state.fromId }
}))

type IpcListener = (event: unknown, ...args: unknown[]) => unknown

let handled: Map<string, IpcListener>
let destroyTerminalsByWindow: (windowId: number) => void
let networkTransport: NetworkTransport
let definitions: () => readonly ChannelDefinition[]

beforeEach(async () => {
  vi.resetModules()
  state.ptys.length = 0
  handled = new Map()
  /* eslint-disable boundaries/dependencies -- 用例有意从服务这一侧经真的 IPC 适配器与 terminal:create 处理器开终端（产品里是 ipc 引服务，不是反过来） */
  const { attachIpcAdapter } = await import('../../ipc/ipcAdapter')
  const { registerTerminalHandlers } = await import('../../ipc/terminalHandlers')
  /* eslint-enable boundaries/dependencies */
  const registry = await import('../../ipc/registry')
  networkTransport = createNetworkTransport()
  registry.attachTransport(networkTransport)
  definitions = registry.listDefinitions
  ;({ destroyTerminalsByWindow } = await import('../terminalService'))
  attachIpcAdapter({
    handle: (channel: string, listener: IpcListener) => {
      handled.set(channel, listener)
    },
    on: () => {}
  } as never)
  registerTerminalHandlers()
  // 按 id 找会找到一个冒名的：回送应当认的是开终端的那个对象
  state.fromId.mockImplementation(() => new FakeWebContents(-99))
})

function createFrom(sender: FakeWebContents): { terminalId: string; pty: FakePty } {
  const listener = handled.get('terminal:create')
  if (!listener) throw new Error('terminal:create not registered')
  const before = state.ptys.length
  const result = listener({ sender }, { cwd: '/tmp', cols: 80, rows: 24 }) as { terminalId: string }
  expect(state.ptys.length).toBe(before + 1)
  return { terminalId: result.terminalId, pty: state.ptys[before] }
}

describe('CH-4 终端输出回送给开它的客户端', () => {
  it('CH-4 (a) invoke 返回之后的输出 / 退出 → wc7.send，别的窗口什么也收不到', () => {
    const wc7 = new FakeWebContents(7)
    const wc8 = new FakeWebContents(8)
    const { terminalId, pty } = createFrom(wc7)
    expect(typeof terminalId).toBe('string')
    expect(wc7.sent).toEqual([])

    pty.data!('hello')
    pty.data!('world')
    pty.exit!({ exitCode: 3 })
    expect(wc7.sent).toEqual([
      ['terminal:data', { terminalId, data: 'hello' }],
      ['terminal:data', { terminalId, data: 'world' }],
      ['terminal:exit', { terminalId, exitCode: 3 }]
    ])
    expect(wc8.sent).toEqual([])
  })

  it('CH-4 (b) wc7 销毁之后：输出 / 退出都不再发、不抛', () => {
    const wc7 = new FakeWebContents(7)
    const { terminalId, pty } = createFrom(wc7)
    pty.data!('before')
    wc7.destroy()
    wc7.throwOnSend = true
    expect(() => pty.data!('after')).not.toThrow()
    expect(() => pty.exit!({ exitCode: 0 })).not.toThrow()
    expect(wc7.sent).toEqual([['terminal:data', { terminalId, data: 'before' }]])
  })

  it('CH-4 (c) destroyTerminalsByWindow(7) 只杀 wc7 开的终端；wc8 的照旧回送', () => {
    const wc7 = new FakeWebContents(7)
    const wc8 = new FakeWebContents(8)
    const a = createFrom(wc7)
    const b = createFrom(wc7)
    const c = createFrom(wc8)

    destroyTerminalsByWindow(7)
    expect(a.pty.kill).toHaveBeenCalledTimes(1)
    expect(b.pty.kill).toHaveBeenCalledTimes(1)
    expect(c.pty.kill).not.toHaveBeenCalled()

    // 已经摘掉了：再来一次不再杀
    destroyTerminalsByWindow(7)
    expect(a.pty.kill).toHaveBeenCalledTimes(1)
    expect(b.pty.kill).toHaveBeenCalledTimes(1)

    // 没开过终端的窗口 id：什么也不杀
    destroyTerminalsByWindow(9)
    expect(c.pty.kill).not.toHaveBeenCalled()

    c.pty.data!('still here')
    expect(wc8.sent).toEqual([['terminal:data', { terminalId: c.terminalId, data: 'still here' }]])
    expect(wc7.sent).toEqual([])
  })
})

describe('NH-13 网络客户端开的终端', () => {
  const call = (ctx: ClientContext, channel: string, ...args: unknown[]): unknown => {
    const definition = definitions().find((d) => d.channel === channel)
    if (!definition) throw new Error(`no definition for ${channel}`)
    return definition.fn(ctx, ...args)
  }

  function createFromNet(): { terminalId: string; pty: FakePty } {
    const before = state.ptys.length
    const result = call(netCtx(1), 'terminal:create', { cwd: '/tmp', cols: 80, rows: 24 }) as {
      terminalId: string
    }
    expect(state.ptys.length).toBe(before + 1)
    return { terminalId: result.terminalId, pty: state.ptys[before] }
  }

  it('NH-13 (a) 输出 / 退出 → 那条连接收到推送', () => {
    const conn = fakeConnection(netClient(1))
    networkTransport.add(conn)
    const { terminalId, pty } = createFromNet()
    pty.data!('hello')
    pty.exit!({ exitCode: 2 })
    expect(conn.sent).toStrictEqual([
      { t: 'push', channel: 'terminal:data', args: [{ terminalId, data: 'hello' }] },
      { t: 'push', channel: 'terminal:exit', args: [{ terminalId, exitCode: 2 }] }
    ])
  })

  it('NH-13 (b) 连接关了 → pty 恰 kill 一次；之后 terminal:write 到不了它', () => {
    const conn = fakeConnection(netClient(1))
    networkTransport.add(conn)
    const { terminalId, pty } = createFromNet()
    call(netCtx(1), 'terminal:write', { terminalId, data: 'ls\n' })
    expect(pty.write).toHaveBeenCalledTimes(1)
    conn.close(1001, 'gone')
    expect(pty.kill).toHaveBeenCalledTimes(1)
    call(netCtx(1), 'terminal:write', { terminalId, data: 'pwd\n' })
    expect(pty.write).toHaveBeenCalledTimes(1)
    expect(() => pty.data!('late')).not.toThrow()
    expect(conn.sent).toStrictEqual([])
  })

  it('NH-13 (c) 窗口开的终端不受网络连接关闭的影响', () => {
    const conn = fakeConnection(netClient(1))
    networkTransport.add(conn)
    const wc7 = new FakeWebContents(7)
    const win = createFrom(wc7)
    const net = createFromNet()
    conn.close(1001, 'gone')
    expect(net.pty.kill).toHaveBeenCalledTimes(1)
    expect(win.pty.kill).not.toHaveBeenCalled()
    win.pty.data!('still')
    expect(wc7.sent).toEqual([['terminal:data', { terminalId: win.terminalId, data: 'still' }]])
  })

  it('NH-13 (d) 开终端时客户端已经没了 → 一个微任务之后 kill', async () => {
    const { pty } = createFromNet()
    expect(pty.kill).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(pty.kill).toHaveBeenCalledTimes(1)
  })

  it('NH-13 (e) 退出 / 销毁时撤掉连接上的关闭回调', () => {
    const conn = fakeConnection(netClient(1))
    networkTransport.add(conn)
    const baseline = conn.closeHandlerCount()
    const exited = createFromNet()
    expect(conn.closeHandlerCount()).toBe(baseline + 1)
    exited.pty.exit!({ exitCode: 0 })
    expect(conn.closeHandlerCount()).toBe(baseline)

    const destroyed = createFromNet()
    expect(conn.closeHandlerCount()).toBe(baseline + 1)
    expect(call(netCtx(1), 'terminal:destroy', destroyed.terminalId)).toEqual({ success: true })
    expect(destroyed.pty.kill).toHaveBeenCalledTimes(1)
    expect(conn.closeHandlerCount()).toBe(baseline)

    conn.close(1000, 'bye')
    expect(exited.pty.kill).not.toHaveBeenCalled()
    expect(destroyed.pty.kill).toHaveBeenCalledTimes(1)
  })
})

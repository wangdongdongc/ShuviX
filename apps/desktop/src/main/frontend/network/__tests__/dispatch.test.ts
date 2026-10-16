/**
 * `frontend/network/dispatch.ts` —— 网络客户端的请求分发（server mode phase B §B2）：只分发通道表里的请求通道、种类要对上；
 * `sync:frame` 不经这里；桌面专属通道回 `desktop_only`、处理函数不执行；处理函数的结果 / 错误编成一条结果，从不拒绝。
 * 定义由 `definitionOf` spy 交出（`defs` 表），logger 是 spy。
 *
 *   ND-1 networkChannelVerdict：表里种类对得上的 invoke / send（含 override 通道、网络设置）→ ok；种类不对、推送通道、
 *        sync:frame、表外（含原型链上的名字）→ unknown；每个桌面专属键 invoke → desktop_only、send → unknown；
 *        NETWORK_EXCLUDED_CHANNELS 恰是 {sync:frame}
 *   DO-5 （与 shared 的 DESKTOP_ONLY_CHANNELS 交叉核对）每个键 `(key,'invoke')` → desktop_only、`(key,'send')` → unknown
 *   ND-2 OK：fn 恰被调一次，参数恰是 (ctx, undefined, {p:1})（同一个 ctx 对象）；回 {t:'result', id, ok:true, value}
 *   ND-3 fn 回 undefined（同步 / 异步）→ 结果没有 value 键；null → value:null
 *   ND-4 失败从不拒绝：同步抛 → handler_error；拒绝带字符串 code → 那个 code；数字 code → handler_error；拒绝字符串 → message
 *   ND-5 表外通道 → unknown_channel（消息里带通道名），不调 definitionOf
 *   ND-6 表里但没定义 / 定义是 listen / invoke 推送通道 → unknown_channel；listen 的 fn 不调
 *   ND-7 桌面专属（app:open-folder 有定义）→ desktop_only，spy 与 definitionOf 都不调
 *   ND-8 sync:frame：send 不调 listen spy；invoke → unknown_channel
 *   ND-9 send：交给 listen 定义 (ctx, params)，回 undefined；listen 抛 → logger.warn 一次（带通道与客户端 id），不外抛；
 *        send 到 invoke 通道 / 桌面专属 / 表外 / handle 定义 → 不调任何定义、不抛
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_ONLY_CHANNELS } from '../../../../shared/apiTable'
import type { ClientMessage } from '../../../../shared/networkEnvelope'
import type { ChannelDefinition, ClientContext } from '../../../ipc/registry'
import {
  createNetworkDispatcher,
  NETWORK_EXCLUDED_CHANNELS,
  networkChannelVerdict,
  type NetworkDispatcher
} from '../dispatch'
import { netCtx } from './support/fakeNetworkConnection'

type Invoke = Extract<ClientMessage, { t: 'invoke' }>
type Send = Extract<ClientMessage, { t: 'send' }>

const DESKTOP_ONLY_KEYS = Object.keys(DESKTOP_ONLY_CHANNELS)

let defs: Map<string, ChannelDefinition>
let definitionOf: ReturnType<typeof vi.fn<(channel: string) => ChannelDefinition | undefined>>
let logger: { warn: ReturnType<typeof vi.fn<(message: string) => void>> }
let dispatcher: NetworkDispatcher
let ctx: ClientContext

beforeEach(() => {
  defs = new Map()
  definitionOf = vi.fn((channel: string) => defs.get(channel))
  logger = { warn: vi.fn() }
  dispatcher = createNetworkDispatcher({ definitionOf, logger })
  ctx = netCtx(1)
})

const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
  defs.set(channel, { kind: 'handle', channel, fn })
}
const listen = (channel: string, fn: (...args: any[]) => void): void => {
  defs.set(channel, { kind: 'listen', channel, fn })
}
const invoke = (id: number, channel: string, args: unknown[] = []): Invoke => ({
  t: 'invoke',
  id,
  channel,
  args
})
const send = (channel: string, args: unknown[] = []): Send => ({ t: 'send', channel, args })

describe('ND-1 networkChannelVerdict', () => {
  it('ND-1 ok：种类对得上的表通道 / override 通道 / 网络设置', () => {
    expect(networkChannelVerdict('app:version', 'invoke')).toBe('ok')
    expect(networkChannelVerdict('app:window-ready', 'send')).toBe('ok')
    expect(networkChannelVerdict('liveDoc:respond', 'invoke')).toBe('ok')
    // 编辑器的挂接 / 摘下：网络客户端也能调到处理器（处理器自己答 success: false —— 它没有 webContents）
    expect(networkChannelVerdict('liveDoc:attach', 'invoke')).toBe('ok')
    expect(networkChannelVerdict('liveDoc:detach', 'invoke')).toBe('ok')
    expect(networkChannelVerdict('knowledge:baseOptions', 'invoke')).toBe('ok')
    expect(networkChannelVerdict('network:status', 'invoke')).toBe('ok')
  })

  it('ND-1 unknown：种类不对 / 推送通道 / sync:frame / 表外', () => {
    expect(networkChannelVerdict('app:version', 'send')).toBe('unknown')
    expect(networkChannelVerdict('app:window-ready', 'invoke')).toBe('unknown')
    expect(networkChannelVerdict('agent:event', 'invoke')).toBe('unknown')
    expect(networkChannelVerdict('app:event', 'invoke')).toBe('unknown')
    expect(networkChannelVerdict('sync:frame', 'send')).toBe('unknown')
    for (const channel of ['nope:x', '__proto__', 'constructor', 'toString']) {
      expect(networkChannelVerdict(channel, 'invoke'), channel).toBe('unknown')
    }
  })

  it('ND-1 NETWORK_EXCLUDED_CHANNELS 恰是 {sync:frame}', () => {
    expect([...NETWORK_EXCLUDED_CHANNELS]).toEqual(['sync:frame'])
  })
})

describe('DO-5 桌面专属表与分发器交叉核对', () => {
  it('DO-5 每个键：invoke → desktop_only，send → unknown', () => {
    expect(DESKTOP_ONLY_KEYS.length).toBe(20)
    for (const key of DESKTOP_ONLY_KEYS) {
      expect(networkChannelVerdict(key, 'invoke'), key).toBe('desktop_only')
      expect(networkChannelVerdict(key, 'send'), key).toBe('unknown')
    }
  })
})

describe('ND-2 OK 路径', () => {
  it('ND-2 fn(ctx, undefined, {p:1}) 恰一次；回 {t:result, id, ok, value}', async () => {
    const fn = vi.fn((..._args: unknown[]) => ({ n: 1 }))
    handle('tools:list', fn)
    const result = await dispatcher.invoke(ctx, invoke(3, 'tools:list', [undefined, { p: 1 }]))
    expect(result).toStrictEqual({ t: 'result', id: 3, ok: true, value: { n: 1 } })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0].length).toBe(3)
    expect(fn.mock.calls[0][0]).toBe(ctx)
    expect(fn.mock.calls[0][1]).toBeUndefined()
    expect(fn.mock.calls[0][2]).toStrictEqual({ p: 1 })
  })
})

describe('ND-3 undefined / null', () => {
  it('ND-3 fn 回 undefined（同步 / 异步）→ 没有 value 键；null → value:null', async () => {
    handle('tools:list', () => undefined)
    const syncResult = await dispatcher.invoke(ctx, invoke(1, 'tools:list'))
    expect(syncResult).toStrictEqual({ t: 'result', id: 1, ok: true })
    expect('value' in syncResult).toBe(false)

    handle('tools:list', async () => undefined)
    const asyncResult = await dispatcher.invoke(ctx, invoke(2, 'tools:list'))
    expect('value' in asyncResult).toBe(false)

    handle('tools:list', () => null)
    expect(await dispatcher.invoke(ctx, invoke(3, 'tools:list'))).toStrictEqual({
      t: 'result',
      id: 3,
      ok: true,
      value: null
    })
  })
})

describe('ND-4 失败从不拒绝', () => {
  it('ND-4 同步抛 → handler_error', async () => {
    handle('tools:list', () => {
      throw new Error('boom')
    })
    await expect(dispatcher.invoke(ctx, invoke(1, 'tools:list'))).resolves.toStrictEqual({
      t: 'result',
      id: 1,
      ok: false,
      error: { message: 'boom', code: 'handler_error' }
    })
  })

  it('ND-4 拒绝带字符串 code → 那个 code；数字 code → handler_error；拒绝字符串 → message', async () => {
    handle('tools:list', async () => {
      throw Object.assign(new Error('nope'), { code: 'EPERM' })
    })
    expect(await dispatcher.invoke(ctx, invoke(1, 'tools:list'))).toStrictEqual({
      t: 'result',
      id: 1,
      ok: false,
      error: { message: 'nope', code: 'EPERM' }
    })

    handle('tools:list', async () => {
      throw Object.assign(new Error('num'), { code: 42 })
    })
    expect(await dispatcher.invoke(ctx, invoke(2, 'tools:list'))).toStrictEqual({
      t: 'result',
      id: 2,
      ok: false,
      error: { message: 'num', code: 'handler_error' }
    })

    handle('tools:list', () => Promise.reject('bad'))
    expect(await dispatcher.invoke(ctx, invoke(3, 'tools:list'))).toStrictEqual({
      t: 'result',
      id: 3,
      ok: false,
      error: { message: 'bad', code: 'handler_error' }
    })
  })
})

describe('ND-5 表外通道', () => {
  it('ND-5 → unknown_channel，不调 definitionOf', async () => {
    expect(await dispatcher.invoke(ctx, invoke(5, 'nope:x'))).toStrictEqual({
      t: 'result',
      id: 5,
      ok: false,
      error: { message: 'No handler registered for "nope:x"', code: 'unknown_channel' }
    })
    expect(definitionOf).not.toHaveBeenCalled()
  })
})

describe('ND-6 别的 unknown', () => {
  it('ND-6 表里但没定义 → unknown_channel', async () => {
    const result = await dispatcher.invoke(ctx, invoke(1, 'tools:list'))
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown_channel' } })
  })

  it('ND-6 invoke 通道的定义是 listen → unknown_channel，fn 不调', async () => {
    const fn = vi.fn()
    listen('tools:list', fn)
    const result = await dispatcher.invoke(ctx, invoke(1, 'tools:list'))
    expect(result).toStrictEqual({
      t: 'result',
      id: 1,
      ok: false,
      error: { message: 'No handler registered for "tools:list"', code: 'unknown_channel' }
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it('ND-6 invoke 推送通道 agent:event → unknown_channel', async () => {
    const fn = vi.fn()
    handle('agent:event', fn)
    const result = await dispatcher.invoke(ctx, invoke(1, 'agent:event'))
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown_channel' } })
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('ND-7 桌面专属', () => {
  it('ND-7 app:open-folder → desktop_only，spy 与 definitionOf 都不调', async () => {
    const spy = vi.fn()
    handle('app:open-folder', spy)
    expect(await dispatcher.invoke(ctx, invoke(7, 'app:open-folder', ['/x']))).toStrictEqual({
      t: 'result',
      id: 7,
      ok: false,
      error: {
        message: '"app:open-folder" is only available in the desktop app for now',
        code: 'desktop_only'
      }
    })
    expect(spy).not.toHaveBeenCalled()
    expect(definitionOf).not.toHaveBeenCalled()
  })
})

describe('ND-8 sync:frame 不经分发器', () => {
  it('ND-8 send 不调 listen spy；invoke → unknown_channel', async () => {
    const spy = vi.fn()
    listen('sync:frame', spy)
    dispatcher.send(ctx, send('sync:frame', ['L1', {}]))
    expect(spy).not.toHaveBeenCalled()
    const result = await dispatcher.invoke(ctx, invoke(1, 'sync:frame'))
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown_channel' } })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('ND-9 send', () => {
  it('ND-9 交给 listen 定义 (ctx, params)；回 undefined', () => {
    const spy = vi.fn()
    listen('terminal:write', spy)
    const params = { terminalId: 't', data: 'x' }
    expect(dispatcher.send(ctx, send('terminal:write', [params]))).toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]).toHaveLength(2)
    expect(spy.mock.calls[0][0]).toBe(ctx)
    expect(spy.mock.calls[0][1]).toStrictEqual(params)
  })

  it('ND-9 listen 抛 → logger.warn 一次（带通道与客户端 id），不外抛', () => {
    listen('terminal:write', () => {
      throw new Error('kaput')
    })
    expect(() => dispatcher.send(ctx, send('terminal:write', [{}]))).not.toThrow()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toContain('terminal:write')
    expect(logger.warn.mock.calls[0][0]).toContain('ws:1')
  })

  it('ND-9 send 到 invoke 通道 / 桌面专属 / 表外 / handle 定义 → 不调任何定义、不抛', () => {
    const toolsList = vi.fn()
    const openFolder = vi.fn()
    const nope = vi.fn()
    const windowReady = vi.fn()
    listen('tools:list', toolsList)
    listen('app:open-folder', openFolder)
    listen('nope:x', nope)
    handle('app:window-ready', windowReady)
    expect(() => {
      dispatcher.send(ctx, send('tools:list'))
      dispatcher.send(ctx, send('app:open-folder', ['/x']))
      dispatcher.send(ctx, send('nope:x'))
      dispatcher.send(ctx, send('app:window-ready'))
    }).not.toThrow()
    expect(toolsList).not.toHaveBeenCalled()
    expect(openFolder).not.toHaveBeenCalled()
    expect(nope).not.toHaveBeenCalled()
    expect(windowReady).not.toHaveBeenCalled()
  })
})

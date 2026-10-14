/**
 * `shared/networkEnvelope.ts` —— 网络传输的线协议（server mode phase B §B2）：纯 JSON 编解码，`undefined` 的位置经 `u`
 * 保住，解码对不合形状的输入回 undefined、从不抛。
 *
 *   NE-1  packArgs：没有 undefined → 不带 `u`；undefined 的位置记进 `u`、数组里写成 null；不改输入
 *   NE-2  unpackArgs：回一份拷贝；`u` 的位置换回 undefined；重复下标无害；形状不对（args 不是数组、u 不是数组、
 *         越界 / 负数 / 小数 / 字符串 / NaN 下标）→ undefined
 *   NE-3  invoke 往返：线上 `args:[null,…]` + `u:[0]`，解出来与原消息严格相等；`[null]` 原样、不带 `u`
 *   NE-4  send 往返同上；零参数 → 不带 `u`，解出 `args:[]`
 *   NE-5  sync 往返：frame 原样（null 也保住），线上没有 args / u
 *   NE-6  JSON 的已知限度：嵌套数组里的 undefined → null；对象里值为 undefined 的键丢掉
 *   NE-7  结果：ok + undefined → 线上与解出来都没有 `value` 键；null / 0 / false / '' 原样；
 *         失败带 code → `error:{message,code}`，不带 → 没有 `code` 键
 *   NE-8  push：`u` 照记；`args:[]` → `[]`
 *   NE-9  decodeClientMessage 对各种坏输入回 undefined、从不抛（非字符串、非 JSON、非对象、错的 t、坏 id、
 *         坏 channel（200 字符可以、201 不行）、坏 args / u、坏 link、缺 frame；frame:null 可以）
 *   NE-10 decodeServerMessage 对客户端消息、坏 id、坏 ok、坏 error、坏 push / sync 回 undefined；
 *         非字符串 message → 'request failed'，非字符串 code → 没有 code 键
 *   NE-11 envelopeErrorOf：message 取 Error.message / String(x)；code 只取字符串，否则用 fallback（没有就不带）
 *   NE-12 常量：`/ws`、200、200；通道表与 override 里每条通道都不超过上限
 *   NE-13 malformedInvokeId：只对「t 是 invoke、id 合法、但解不开」的帧回 id；合法 invoke、别的 t、坏 id、非 JSON → undefined
 */
import { describe, expect, it } from 'vitest'
import { API_OVERRIDE_CHANNELS, API_TABLE } from '../apiTable'
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  envelopeErrorOf,
  malformedInvokeId,
  MAX_ENVELOPE_CHANNEL_CHARS,
  MAX_ENVELOPE_LINK_CHARS,
  NETWORK_WS_PATH,
  packArgs,
  unpackArgs,
  type ClientMessage,
  type ServerMessage
} from '../networkEnvelope'

const raw = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>

describe('NE-1 packArgs', () => {
  it('NE-1 没有 undefined → 不带 u', () => {
    expect(packArgs([])).toStrictEqual({ args: [] })
    expect('u' in packArgs([])).toBe(false)
    expect(packArgs([1, 'a', null])).toStrictEqual({ args: [1, 'a', null] })
    expect('u' in packArgs([1, 'a', null])).toBe(false)
  })

  it('NE-1 undefined 的位置记进 u，数组里写成 null', () => {
    expect(packArgs([undefined, { p: 1 }])).toStrictEqual({ args: [null, { p: 1 }], u: [0] })
    expect(packArgs([1, undefined, undefined])).toStrictEqual({ args: [1, null, null], u: [1, 2] })
  })

  it('NE-1 不改输入', () => {
    const input = [undefined, 1]
    packArgs(input)
    expect(input).toStrictEqual([undefined, 1])
    expect(input.length).toBe(2)
  })
})

describe('NE-2 unpackArgs', () => {
  it('NE-2 没有 u → 一份拷贝', () => {
    const args = ['a']
    const out = unpackArgs(args, undefined)
    expect(out).toStrictEqual(['a'])
    expect(out).not.toBe(args)
  })

  it('NE-2 u 的位置换回 undefined；空 u / 重复下标无害', () => {
    const out = unpackArgs([null, 1], [0])!
    expect(out).toStrictEqual([undefined, 1])
    expect(0 in out).toBe(true)
    expect(unpackArgs([null], [])).toStrictEqual([null])
    expect(unpackArgs([null, 2], [0, 0])).toStrictEqual([undefined, 2])
  })

  it('NE-2 形状不对 → undefined', () => {
    for (const args of ['x', {}, null, undefined]) {
      expect(unpackArgs(args, undefined)).toBeUndefined()
    }
    expect(unpackArgs([1], '0')).toBeUndefined()
    expect(unpackArgs([1], {})).toBeUndefined()
    for (const u of [[1], [-1], [0.5], ['0'], [NaN]]) {
      expect(unpackArgs([1], u)).toBeUndefined()
    }
  })
})

describe('NE-3 invoke 往返', () => {
  it('NE-3 线上 args:[null,…] + u:[0]；解出来严格相等，undefined 位置在', () => {
    const message: ClientMessage = {
      t: 'invoke',
      id: 7,
      channel: 'tools:list',
      args: [undefined, { profile: 'chat' }]
    }
    const text = encodeClientMessage(message)
    const wire = raw(text)
    expect(wire.args).toStrictEqual([null, { profile: 'chat' }])
    expect(wire.u).toStrictEqual([0])
    const decoded = decodeClientMessage(text)
    expect(decoded).toStrictEqual(message)
    const args = (decoded as Extract<ClientMessage, { t: 'invoke' }>).args
    expect(args.length).toBe(2)
    expect(args[0]).toBeUndefined()
  })

  it('NE-3 [undefined, undefined] → 长度 2、都是 undefined', () => {
    const decoded = decodeClientMessage(
      encodeClientMessage({ t: 'invoke', id: 1, channel: 'c', args: [undefined, undefined] })
    ) as Extract<ClientMessage, { t: 'invoke' }>
    expect(decoded.args.length).toBe(2)
    expect(decoded.args).toStrictEqual([undefined, undefined])
  })

  it('NE-3 [null] 原样，线上没有 u', () => {
    const text = encodeClientMessage({ t: 'invoke', id: 2, channel: 'c', args: [null] })
    expect('u' in raw(text)).toBe(false)
    expect(decodeClientMessage(text)).toStrictEqual({
      t: 'invoke',
      id: 2,
      channel: 'c',
      args: [null]
    })
  })
})

describe('NE-4 send 往返', () => {
  it('NE-4 undefined 的位置保住；零参数 → 没有 u、解出 args:[]', () => {
    const message: ClientMessage = { t: 'send', channel: 'terminal:write', args: [undefined, 'x'] }
    const text = encodeClientMessage(message)
    expect(raw(text).u).toStrictEqual([0])
    expect(decodeClientMessage(text)).toStrictEqual(message)

    const empty = encodeClientMessage({ t: 'send', channel: 'app:window-ready', args: [] })
    expect('u' in raw(empty)).toBe(false)
    expect(decodeClientMessage(empty)).toStrictEqual({
      t: 'send',
      channel: 'app:window-ready',
      args: []
    })
  })
})

describe('NE-5 sync 往返', () => {
  it('NE-5 frame 原样（null 也保住），线上没有 args / u', () => {
    const message: ClientMessage = { t: 'sync', link: 'L1', frame: { t: 'hello', n: 1 } }
    const text = encodeClientMessage(message)
    expect(decodeClientMessage(text)).toStrictEqual(message)
    expect('args' in raw(text)).toBe(false)
    expect('u' in raw(text)).toBe(false)

    const nullFrame = encodeClientMessage({ t: 'sync', link: 'L1', frame: null })
    expect(decodeClientMessage(nullFrame)).toStrictEqual({ t: 'sync', link: 'L1', frame: null })
  })
})

describe('NE-6 JSON 的已知限度（钉住）', () => {
  it('NE-6 嵌套数组里的 undefined → null；对象里值为 undefined 的键丢掉', () => {
    const nested = decodeClientMessage(
      encodeClientMessage({ t: 'invoke', id: 1, channel: 'c', args: [[1, undefined]] })
    ) as Extract<ClientMessage, { t: 'invoke' }>
    expect(nested.args).toStrictEqual([[1, null]])

    const object = decodeClientMessage(
      encodeClientMessage({ t: 'invoke', id: 1, channel: 'c', args: [{ a: undefined, b: 1 }] })
    ) as Extract<ClientMessage, { t: 'invoke' }>
    expect(object.args).toStrictEqual([{ b: 1 }])
    expect('a' in (object.args[0] as object)).toBe(false)
  })
})

describe('NE-7 结果的编解码', () => {
  it('NE-7 ok + undefined → 线上与解出来都没有 value 键', () => {
    const text = encodeServerMessage({ t: 'result', id: 1, ok: true, value: undefined })
    expect('value' in raw(text)).toBe(false)
    const decoded = decodeServerMessage(text)!
    expect(decoded).toStrictEqual({ t: 'result', id: 1, ok: true })
    expect('value' in decoded).toBe(false)
  })

  it('NE-7 null / 0 / false / "" 原样', () => {
    for (const value of [null, 0, false, '']) {
      const decoded = decodeServerMessage(
        encodeServerMessage({ t: 'result', id: 3, ok: true, value })
      ) as Extract<ServerMessage, { ok: true }>
      expect('value' in decoded).toBe(true)
      expect(decoded.value).toBe(value)
    }
  })

  it('NE-7 失败：带 code → error:{message,code}；不带 → 没有 code 键', () => {
    const withCode = encodeServerMessage({
      t: 'result',
      id: 4,
      ok: false,
      error: { message: 'boom', code: 'X' }
    })
    expect(raw(withCode).error).toStrictEqual({ message: 'boom', code: 'X' })
    expect(decodeServerMessage(withCode)).toStrictEqual({
      t: 'result',
      id: 4,
      ok: false,
      error: { message: 'boom', code: 'X' }
    })

    const noCode = encodeServerMessage({ t: 'result', id: 5, ok: false, error: { message: 'm' } })
    expect(raw(noCode).error).toStrictEqual({ message: 'm' })
    const decoded = decodeServerMessage(noCode) as Extract<ServerMessage, { ok: false }>
    expect(decoded.error).toStrictEqual({ message: 'm' })
    expect('code' in decoded.error).toBe(false)
  })
})

describe('NE-8 push', () => {
  it('NE-8 u 照记；args:[] → []', () => {
    const text = encodeServerMessage({
      t: 'push',
      channel: 'agent:event',
      args: [{ x: 1 }, undefined]
    })
    expect(raw(text).u).toStrictEqual([1])
    expect(decodeServerMessage(text)).toStrictEqual({
      t: 'push',
      channel: 'agent:event',
      args: [{ x: 1 }, undefined]
    })
    expect(
      decodeServerMessage(encodeServerMessage({ t: 'push', channel: 'agent:event', args: [] }))
    ).toStrictEqual({ t: 'push', channel: 'agent:event', args: [] })
  })
})

const json = (value: unknown): string => JSON.stringify(value)

describe('NE-9 decodeClientMessage 的坏输入', () => {
  const bad = (input: unknown): void => {
    expect(() => decodeClientMessage(input)).not.toThrow()
    expect(decodeClientMessage(input)).toBeUndefined()
  }

  it('NE-9 非字符串 / 非 JSON / 不是对象', () => {
    for (const input of [undefined, 42, Buffer.from('{}'), { t: 'invoke' }]) bad(input)
    for (const input of ['not json', '', '[]', '"x"', 'null', '1']) bad(input)
  })

  it('NE-9 t 是 result / push / x', () => {
    for (const t of ['result', 'push', 'x']) bad(json({ t, id: 1, channel: 'c', args: [] }))
  })

  it('NE-9 坏的 invoke id', () => {
    for (const id of [-1, 1.5, '1', 2 ** 53, null]) {
      bad(json({ t: 'invoke', id, channel: 'c', args: [] }))
    }
    bad(json({ t: 'invoke', channel: 'c', args: [] }))
  })

  it('NE-9 坏的 channel（200 字符可以，201 不行）', () => {
    for (const channel of ['', 'c'.repeat(201), 5]) {
      bad(json({ t: 'invoke', id: 1, channel, args: [] }))
      bad(json({ t: 'send', channel, args: [] }))
    }
    bad(json({ t: 'invoke', id: 1, args: [] }))
    const long = 'c'.repeat(200)
    expect(decodeClientMessage(json({ t: 'invoke', id: 1, channel: long, args: [] }))).toEqual({
      t: 'invoke',
      id: 1,
      channel: long,
      args: []
    })
  })

  it('NE-9 坏的 args / u', () => {
    for (const t of ['invoke', 'send']) {
      bad(json({ t, id: 1, channel: 'c' }))
      bad(json({ t, id: 1, channel: 'c', args: {} }))
      bad(json({ t, id: 1, channel: 'c', args: 'abc' }))
      bad(json({ t, id: 1, channel: 'c', args: [1], u: '0' }))
      bad(json({ t, id: 1, channel: 'c', args: [1], u: {} }))
      for (const u of [[1], [-1], [0.5], ['0']]) bad(json({ t, id: 1, channel: 'c', args: [1], u }))
    }
  })

  it('NE-9 坏的 sync link / 缺 frame；frame:null 可以', () => {
    for (const link of ['', 'l'.repeat(201), 5]) bad(json({ t: 'sync', link, frame: {} }))
    bad(json({ t: 'sync', link: 'L1' }))
    expect(decodeClientMessage(json({ t: 'sync', link: 'L1', frame: null }))).toEqual({
      t: 'sync',
      link: 'L1',
      frame: null
    })
  })
})

describe('NE-10 decodeServerMessage 的坏输入与归一', () => {
  const bad = (input: unknown): void => {
    expect(() => decodeServerMessage(input)).not.toThrow()
    expect(decodeServerMessage(input)).toBeUndefined()
  }

  it('NE-10 客户端消息', () => {
    bad(encodeClientMessage({ t: 'invoke', id: 1, channel: 'c', args: [] }))
    bad(encodeClientMessage({ t: 'send', channel: 'c', args: [] }))
  })

  it('NE-10 坏 id / 坏 ok', () => {
    for (const id of [-1, 1.5, '1', null]) bad(json({ t: 'result', id, ok: true }))
    bad(json({ t: 'result', ok: true }))
    for (const ok of ['true', 1]) bad(json({ t: 'result', id: 1, ok }))
    bad(json({ t: 'result', id: 1 }))
  })

  it('NE-10 ok:false 的 error 缺失 / 是字符串 / 是数组', () => {
    bad(json({ t: 'result', id: 1, ok: false }))
    bad(json({ t: 'result', id: 1, ok: false, error: 'boom' }))
    bad(json({ t: 'result', id: 1, ok: false, error: ['boom'] }))
  })

  it('NE-10 坏 push / 坏 sync', () => {
    bad(json({ t: 'push', channel: '', args: [] }))
    bad(json({ t: 'push', channel: 'c'.repeat(201), args: [] }))
    bad(json({ t: 'push', channel: 'c', args: {} }))
    bad(json({ t: 'push', channel: 'c', args: [1], u: [5] }))
    bad(json({ t: 'sync', link: '', frame: {} }))
    bad(json({ t: 'sync', link: 'L1' }))
  })

  it("NE-10 非字符串 message → 'request failed'；非字符串 code → 没有 code 键", () => {
    expect(
      decodeServerMessage(json({ t: 'result', id: 1, ok: false, error: { message: 5, code: 'X' } }))
    ).toStrictEqual({
      t: 'result',
      id: 1,
      ok: false,
      error: { message: 'request failed', code: 'X' }
    })
    const decoded = decodeServerMessage(
      json({ t: 'result', id: 1, ok: false, error: { message: 'm', code: 5 } })
    ) as Extract<ServerMessage, { ok: false }>
    expect(decoded.error).toStrictEqual({ message: 'm' })
    expect('code' in decoded.error).toBe(false)
  })
})

describe('NE-11 envelopeErrorOf', () => {
  it('NE-11 Error → message；code 只取字符串，否则 fallback', () => {
    const plainErr = envelopeErrorOf(new Error('boom'))
    expect(plainErr).toStrictEqual({ message: 'boom' })
    expect('code' in plainErr).toBe(false)
    expect(envelopeErrorOf(new Error('boom'), 'handler_error')).toStrictEqual({
      message: 'boom',
      code: 'handler_error'
    })
    expect(
      envelopeErrorOf(Object.assign(new Error('x'), { code: 'ENOENT' }), 'handler_error')
    ).toStrictEqual({ message: 'x', code: 'ENOENT' })
    expect(envelopeErrorOf(Object.assign(new Error('x'), { code: 42 }), 'fb')).toStrictEqual({
      message: 'x',
      code: 'fb'
    })
    const numericNoFallback = envelopeErrorOf(Object.assign(new Error('x'), { code: 42 }))
    expect(numericNoFallback).toStrictEqual({ message: 'x' })
    expect('code' in numericNoFallback).toBe(false)
  })

  it('NE-11 非 Error：String(x)', () => {
    expect(envelopeErrorOf('plain')).toStrictEqual({ message: 'plain' })
    expect(envelopeErrorOf({ code: 'E' })).toStrictEqual({
      message: '[object Object]',
      code: 'E'
    })
    expect(envelopeErrorOf(null)).toStrictEqual({ message: 'null' })
  })
})

describe('NE-12 常量与通道表', () => {
  it('NE-12 /ws、200、200', () => {
    expect(NETWORK_WS_PATH).toBe('/ws')
    expect(MAX_ENVELOPE_CHANNEL_CHARS).toBe(200)
    expect(MAX_ENVELOPE_LINK_CHARS).toBe(200)
  })

  it('NE-12 通道表与 override 里每条通道都不超过上限', () => {
    const channels: string[] = []
    for (const members of Object.values(API_TABLE)) {
      for (const member of Object.values(members)) channels.push(member.channel)
    }
    for (const members of Object.values(API_OVERRIDE_CHANNELS)) {
      for (const member of Object.values(members)) {
        if (member !== null) channels.push(member.channel)
      }
    }
    expect(channels.length).toBeGreaterThan(100)
    for (const channel of channels) {
      expect(channel.length, channel).toBeLessThanOrEqual(MAX_ENVELOPE_CHANNEL_CHARS)
    }
  })
})

describe('NE-13 malformedInvokeId', () => {
  it('NE-13 t 是 invoke、id 合法、但解不开 → 那个 id', () => {
    expect(malformedInvokeId(json({ t: 'invoke', id: 9, channel: '', args: [] }))).toBe(9)
    expect(malformedInvokeId(json({ t: 'invoke', id: 0, channel: 'c' }))).toBe(0)
    expect(malformedInvokeId(json({ t: 'invoke', id: 3, channel: 'c', args: [1], u: [7] }))).toBe(3)
    expect(malformedInvokeId(json({ t: 'invoke', id: 4, args: [] }))).toBe(4)
  })

  it('NE-13 合法 invoke、别的 t、坏 id、非 JSON → undefined', () => {
    expect(
      malformedInvokeId(encodeClientMessage({ t: 'invoke', id: 1, channel: 'c', args: [] }))
    ).toBeUndefined()
    expect(malformedInvokeId(json({ t: 'send', channel: '', args: [] }))).toBeUndefined()
    expect(malformedInvokeId(json({ t: 'sync', id: 1, link: '' }))).toBeUndefined()
    for (const id of [-1, 1.5, '1', null]) {
      expect(malformedInvokeId(json({ t: 'invoke', id, channel: '', args: [] }))).toBeUndefined()
    }
    expect(malformedInvokeId(json({ t: 'invoke', channel: '' }))).toBeUndefined()
    for (const input of ['not json', '', undefined, 42, '[]']) {
      expect(malformedInvokeId(input)).toBeUndefined()
    }
  })
})

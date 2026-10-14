/**
 * `shared/buildApi.ts` —— 由通道表建 `window.api` 的纯逻辑（server mode phase A），不碰 electron。
 * 传输是记录型替身：`invoke` 回一个哨兵 Promise、`send` 回一个哨兵值、`on` 记下（通道，监听器）并回一个 spy 注销函数。
 *
 *   BA-1  invoke 恰好转发 `args` 个参数（多给的丢、少给的补 undefined），原样交回传输的 Promise
 *   BA-2  send 同样的转发规则走 `transport.send`；成员本身回 undefined（传输回什么都不管）
 *   BA-3  event 交给回调的载荷个数：0 → `callback()`；1 → 只给第一个（没载荷 → `callback(undefined)`，
 *         arguments.length === 1）；2 → 前两个。成员原样交回传输的注销函数；每次订阅恰调一次 `transport.on`
 *   BA-4  override 合并：只在 override 里的命名空间出现；override 成员与表成员并存于同一命名空间；
 *         非函数值原样保留；函数 override 保持同一引用
 *   BA-5  override 成员与表条目同名 → 抛错，消息里带 `api.<ns>.<name>`
 *   BA-6  不改表、结果是纯对象：同一张表 + override 建两次，两份都能用且互不相同；表与建之前的快照深相等；
 *         每个命名空间都是纯对象，成员都是自有数据属性（函数；非函数值只来自 override）
 *   BA-7  `events.subscribe` 扇出（createCommonOverrides）：创建时不挂监听；第一次订阅恰挂一个 `on('app:event')`，
 *         之后不再挂；推送只把第一个载荷交给每个回调；抛错的回调不挡别人；派发中退订后面的回调不影响本轮；
 *         派发中新加的回调下一次推送才收到；退订后不再收到且可重复退订；同一函数订阅两次只收一次、退订一次就没了；
 *         订阅者全走光也不调底下的注销函数，再订阅也不挂第二个监听
 *   BA-8  扇出状态按实例：两个 createCommonOverrides(t) 各挂各的一个监听，只派发给自己的订阅者
 *   BA-9  `liveDoc.respond('r1', res)` → `invoke('liveDoc:respond', { requestId: 'r1', result: res })`，恰一个参数，原样交回
 *   BA-10 `knowledge.baseOptions()` / `(undefined)` / `(null)` → `invoke('knowledge:baseOptions', {})`；
 *         `baseOptions(p)` → p 原样；多给的参数丢掉；通道之后永远恰一个参数
 */
import { describe, expect, it, vi } from 'vitest'
import { buildApi, createCommonOverrides, type ApiTransport } from '../../shared/buildApi'
import type { ApiMember, ApiTable } from '../../shared/apiTable'

type Listener = (...payload: unknown[]) => void

interface RecordingTransport extends ApiTransport {
  readonly invokeCalls: unknown[][]
  readonly sendCalls: unknown[][]
  readonly onCalls: Array<{
    channel: string
    listener: Listener
    dispose: ReturnType<typeof vi.fn>
  }>
  /** 以通道上第 i 个监听器的身份推一次 */
  push(channel: string, index: number, ...payload: unknown[]): void
}

const INVOKE_RESULT = Promise.resolve('invoke-sentinel')
const SEND_RESULT = { sendSentinel: true }

function recordingTransport(): RecordingTransport {
  const invokeCalls: unknown[][] = []
  const sendCalls: unknown[][] = []
  const onCalls: RecordingTransport['onCalls'] = []
  return {
    invokeCalls,
    sendCalls,
    onCalls,
    invoke(...args: unknown[]): Promise<unknown> {
      invokeCalls.push(args)
      return INVOKE_RESULT
    },
    send(...args: unknown[]): void {
      sendCalls.push(args)
      // 传输回了个值：成员不该把它交出去
      return SEND_RESULT as unknown as void
    },
    on(channel: string, listener: Listener): () => void {
      const dispose = vi.fn()
      onCalls.push({ channel, listener, dispose })
      return dispose
    },
    push(channel, index, ...payload) {
      const hits = onCalls.filter((c) => c.channel === channel)
      const hit = hits[index]
      if (!hit) throw new Error(`no listener #${index} on ${channel}`)
      hit.listener(...payload)
    }
  }
}

const entry = (kind: ApiMember['kind'], channel: string, args: 0 | 1 | 2): ApiMember => ({
  kind,
  channel,
  args
})

type AnyApi = Record<string, Record<string, any>>

function build(table: ApiTable, transport: ApiTransport, overrides: object = {}): AnyApi {
  return buildApi(table, transport, overrides as Record<string, object>) as unknown as AnyApi
}

/** 记录回调每次收到的实参（含 arguments.length） */
function recorder(): { fn: (...args: unknown[]) => void; calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    fn: function (...args: unknown[]) {
      calls.push(args)
    }
  }
}

describe('BA-1 invoke 恰好转发 args 个参数', () => {
  const table = {
    x: {
      a: entry('invoke', 'c:a', 0),
      b: entry('invoke', 'c:b', 1),
      c: entry('invoke', 'c:c', 2)
    }
  }

  it('BA-1 args 0：多给的丢掉，通道之后没有参数', () => {
    const t = recordingTransport()
    const api = build(table, t)
    expect(api.x.a('extra')).toBe(INVOKE_RESULT)
    expect(t.invokeCalls).toEqual([['c:a']])
    expect(t.invokeCalls[0]).toHaveLength(1)
  })

  it('BA-1 args 1：不给 → 补一个 undefined；给两个 → 只转第一个', () => {
    const t = recordingTransport()
    const api = build(table, t)
    expect(api.x.b()).toBe(INVOKE_RESULT)
    expect(api.x.b(1, 2)).toBe(INVOKE_RESULT)
    expect(t.invokeCalls).toEqual([
      ['c:b', undefined],
      ['c:b', 1]
    ])
    expect(t.invokeCalls[0]).toHaveLength(2)
    expect(t.invokeCalls[1]).toHaveLength(2)
  })

  it('BA-1 args 2：只给一个 → 第二个补 undefined', () => {
    const t = recordingTransport()
    const api = build(table, t)
    expect(api.x.c(1)).toBe(INVOKE_RESULT)
    expect(t.invokeCalls).toEqual([['c:c', 1, undefined]])
    expect(t.invokeCalls[0]).toHaveLength(3)
    expect(t.sendCalls).toEqual([])
    expect(t.onCalls).toEqual([])
  })
})

describe('BA-2 send 同样的转发规则，成员回 undefined', () => {
  const table = {
    x: {
      a: entry('send', 's:a', 0),
      b: entry('send', 's:b', 1),
      c: entry('send', 's:c', 2)
    }
  }

  it('BA-2 0 / 1 / 2 个参数各按 args 截断或补齐；传输回了值，成员仍回 undefined', () => {
    const t = recordingTransport()
    const api = build(table, t)
    expect(api.x.a('extra')).toBeUndefined()
    expect(api.x.b()).toBeUndefined()
    expect(api.x.b(1, 2)).toBeUndefined()
    expect(api.x.c(1)).toBeUndefined()
    expect(t.sendCalls).toEqual([['s:a'], ['s:b', undefined], ['s:b', 1], ['s:c', 1, undefined]])
    expect(t.sendCalls.map((c) => c.length)).toEqual([1, 2, 2, 3])
    expect(t.invokeCalls).toEqual([])
    expect(t.onCalls).toEqual([])
  })
})

describe('BA-3 event 交给回调的载荷个数', () => {
  const table = {
    x: {
      zero: entry('event', 'e:zero', 0),
      one: entry('event', 'e:one', 1),
      two: entry('event', 'e:two', 2)
    }
  }

  it('BA-3 args 0：推送带了载荷，回调也是零个实参', () => {
    const t = recordingTransport()
    const api = build(table, t)
    const rec = recorder()
    api.x.zero(rec.fn)
    t.push('e:zero', 0, 'p1', 'p2')
    t.push('e:zero', 0)
    expect(rec.calls).toEqual([[], []])
  })

  it('BA-3 args 1：只给第一个载荷；没有载荷 → callback(undefined)，arguments.length === 1', () => {
    const t = recordingTransport()
    const api = build(table, t)
    const lengths: number[] = []
    const seen: unknown[][] = []
    api.x.one(function (...args: unknown[]) {
      lengths.push(arguments.length)
      seen.push(args)
    })
    t.push('e:one', 0, 'p1', 'p2')
    t.push('e:one', 0)
    expect(seen).toEqual([['p1'], [undefined]])
    expect(lengths).toEqual([1, 1])
  })

  it('BA-3 args 2：给前两个（多的丢、少的补 undefined）', () => {
    const t = recordingTransport()
    const api = build(table, t)
    const rec = recorder()
    api.x.two(rec.fn)
    t.push('e:two', 0, 'p1', 'p2', 'p3')
    t.push('e:two', 0, 'p1')
    expect(rec.calls).toEqual([
      ['p1', 'p2'],
      ['p1', undefined]
    ])
  })

  it('BA-3 每次订阅恰调一次 transport.on（表里的通道），成员原样交回传输的注销函数', () => {
    const t = recordingTransport()
    const api = build(table, t)
    expect(t.onCalls).toEqual([])
    const d1 = api.x.one(() => {})
    expect(t.onCalls.map((c) => c.channel)).toEqual(['e:one'])
    expect(d1).toBe(t.onCalls[0].dispose)
    const d2 = api.x.one(() => {})
    expect(t.onCalls.map((c) => c.channel)).toEqual(['e:one', 'e:one'])
    expect(d2).toBe(t.onCalls[1].dispose)
    expect(d2).not.toBe(d1)
    const d3 = api.x.zero(() => {})
    expect(t.onCalls.map((c) => c.channel)).toEqual(['e:one', 'e:one', 'e:zero'])
    expect(d3).toBe(t.onCalls[2].dispose)
    // 交回之前没被调过
    expect(t.onCalls.every((c) => c.dispose.mock.calls.length === 0)).toBe(true)
    expect(t.invokeCalls).toEqual([])
    expect(t.sendCalls).toEqual([])
  })
})

describe('BA-4 override 合并', () => {
  it('BA-4 只在 override 里的命名空间出现；override 成员与表成员并存；非函数值原样；函数保持同一引用', () => {
    const t = recordingTransport()
    const extra = (): string => 'extra'
    const onlyFn = (): string => 'only'
    const api = build({ x: { a: entry('invoke', 'c:a', 0) } }, t, {
      x: { extra, flag: 'value', count: 3 },
      only: { fn: onlyFn, platform: 'darwin' }
    })
    expect(Object.keys(api).sort()).toEqual(['only', 'x'])
    expect(Object.keys(api.x).sort()).toEqual(['a', 'count', 'extra', 'flag'])
    expect(typeof api.x.a).toBe('function')
    expect(api.x.extra).toBe(extra)
    expect(api.x.flag).toBe('value')
    expect(api.x.count).toBe(3)
    expect(Object.keys(api.only).sort()).toEqual(['fn', 'platform'])
    expect(api.only.fn).toBe(onlyFn)
    expect(api.only.platform).toBe('darwin')
    // 表成员照旧走传输
    api.x.a()
    expect(t.invokeCalls).toEqual([['c:a']])
  })
})

describe('BA-5 override 与表条目同名', () => {
  it('BA-5 抛错，消息里带 api.<ns>.<name>', () => {
    const t = recordingTransport()
    expect(() =>
      build({ ns1: { dup: entry('invoke', 'c:dup', 1) } }, t, { ns1: { dup: () => 1 } })
    ).toThrow('api.ns1.dup')
  })
})

describe('BA-6 不改表、结果是纯对象', () => {
  it('BA-6 建两次：两份都能用、互不相同；表与快照深相等；命名空间纯对象、成员是自有数据属性', () => {
    const table: ApiTable = {
      x: { a: entry('invoke', 'c:a', 1), s: entry('send', 's:s', 1) },
      y: { e: entry('event', 'e:e', 1) }
    }
    const snapshot = structuredClone(table)
    const sub = (): void => {}
    const overrides = { x: { extra: sub }, z: { platform: 'linux', fn: sub } }
    const overrideKeysBefore = Object.fromEntries(
      Object.entries(overrides).map(([ns, m]) => [ns, Object.keys(m).sort()])
    )

    const t1 = recordingTransport()
    const t2 = recordingTransport()
    const api1 = build(table, t1, overrides)
    const api2 = build(table, t2, overrides)

    expect(api1).not.toBe(api2)
    for (const ns of ['x', 'y', 'z']) expect(api1[ns]).not.toBe(api2[ns])
    expect(api1.x.a).not.toBe(api2.x.a)

    api1.x.a(1)
    api2.x.a(2)
    api2.x.s('v')
    expect(t1.invokeCalls).toEqual([['c:a', 1]])
    expect(t2.invokeCalls).toEqual([['c:a', 2]])
    expect(t2.sendCalls).toEqual([['s:s', 'v']])
    expect(t1.sendCalls).toEqual([])

    expect(table).toEqual(snapshot)
    expect(
      Object.fromEntries(Object.entries(overrides).map(([ns, m]) => [ns, Object.keys(m).sort()]))
    ).toEqual(overrideKeysBefore)

    const overrideValues = new Map<string, Set<string>>([
      ['x', new Set(['extra'])],
      ['z', new Set(['platform', 'fn'])]
    ])
    for (const api of [api1, api2]) {
      expect(Object.getPrototypeOf(api)).toBe(Object.prototype)
      for (const ns of Object.keys(api)) {
        const nsDesc = Object.getOwnPropertyDescriptor(api, ns)!
        expect('value' in nsDesc && nsDesc.get === undefined).toBe(true)
        const members = api[ns]
        expect(Object.getPrototypeOf(members)).toBe(Object.prototype)
        for (const name of Object.keys(members)) {
          const desc = Object.getOwnPropertyDescriptor(members, name)!
          expect(desc.get, `${ns}.${name}`).toBeUndefined()
          expect(desc.set, `${ns}.${name}`).toBeUndefined()
          expect('value' in desc, `${ns}.${name}`).toBe(true)
          if (typeof desc.value !== 'function') {
            expect(overrideValues.get(ns)?.has(name), `${ns}.${name} non-function`).toBe(true)
          }
        }
      }
    }
  })
})

describe('BA-7 events.subscribe 扇出', () => {
  it('BA-7 创建时不挂监听；第一次订阅恰挂一个 on("app:event")，之后不再挂', () => {
    const t = recordingTransport()
    const common = createCommonOverrides(t)
    expect(t.onCalls).toEqual([])
    common.events.subscribe(() => {})
    expect(t.onCalls.map((c) => c.channel)).toEqual(['app:event'])
    common.events.subscribe(() => {})
    common.events.subscribe(() => {})
    expect(t.onCalls.map((c) => c.channel)).toEqual(['app:event'])
    expect(t.invokeCalls).toEqual([])
    expect(t.sendCalls).toEqual([])
  })

  it('BA-7 推送只把第一个载荷交给每个回调', () => {
    const t = recordingTransport()
    const common = createCommonOverrides(t)
    const a = recorder()
    const b = recorder()
    common.events.subscribe(a.fn as never)
    common.events.subscribe(b.fn as never)
    t.push('app:event', 0, { type: 'x' }, 'second')
    expect(a.calls).toEqual([[{ type: 'x' }]])
    expect(b.calls).toEqual([[{ type: 'x' }]])
  })

  it('BA-7 抛错的回调不挡其它回调（前后都收到）', () => {
    const t = recordingTransport()
    const common = createCommonOverrides(t)
    const before = recorder()
    const after = recorder()
    common.events.subscribe(before.fn as never)
    common.events.subscribe(() => {
      throw new Error('boom')
    })
    common.events.subscribe(after.fn as never)
    expect(() => t.push('app:event', 0, 'ev')).not.toThrow()
    expect(before.calls).toEqual([['ev']])
    expect(after.calls).toEqual([['ev']])
  })

  it('BA-7 派发中退订后面的回调：本轮它照样收到，下一轮不再收到', () => {
    const t = recordingTransport()
    const common = createCommonOverrides(t)
    const later = recorder()
    let unsubscribeLater: () => void = () => {}
    common.events.subscribe(() => unsubscribeLater())
    unsubscribeLater = common.events.subscribe(later.fn as never)
    t.push('app:event', 0, 'first')
    expect(later.calls).toEqual([['first']])
    t.push('app:event', 0, 'second')
    expect(later.calls).toEqual([['first']])
  })

  it('BA-7 派发中新加的回调：本轮不跑，下一次推送才收到', () => {
    const t = recordingTransport()
    const common = createCommonOverrides(t)
    const added = recorder()
    let addedOnce = false
    common.events.subscribe(() => {
      if (addedOnce) return
      addedOnce = true
      common.events.subscribe(added.fn as never)
    })
    t.push('app:event', 0, 'first')
    expect(added.calls).toEqual([])
    t.push('app:event', 0, 'second')
    expect(added.calls).toEqual([['second']])
  })

  it('BA-7 退订后不再收到；重复退订无事', () => {
    const t = recordingTransport()
    const common = createCommonOverrides(t)
    const a = recorder()
    const b = recorder()
    const unsubA = common.events.subscribe(a.fn as never)
    common.events.subscribe(b.fn as never)
    t.push('app:event', 0, 'one')
    unsubA()
    expect(() => unsubA()).not.toThrow()
    t.push('app:event', 0, 'two')
    expect(a.calls).toEqual([['one']])
    expect(b.calls).toEqual([['one'], ['two']])
  })

  it('BA-7 同一函数订阅两次只收一次；退订一次就没了', () => {
    const t = recordingTransport()
    const common = createCommonOverrides(t)
    const a = recorder()
    const unsub1 = common.events.subscribe(a.fn as never)
    common.events.subscribe(a.fn as never)
    t.push('app:event', 0, 'one')
    expect(a.calls).toEqual([['one']])
    unsub1()
    t.push('app:event', 0, 'two')
    expect(a.calls).toEqual([['one']])
  })

  it('BA-7 订阅者全走光：不调底下的注销函数；再订阅也不挂第二个监听，照样收到', () => {
    const t = recordingTransport()
    const common = createCommonOverrides(t)
    const u1 = common.events.subscribe(() => {})
    const u2 = common.events.subscribe(() => {})
    u1()
    u2()
    expect(t.onCalls).toHaveLength(1)
    expect(t.onCalls[0].dispose).not.toHaveBeenCalled()
    const again = recorder()
    common.events.subscribe(again.fn as never)
    expect(t.onCalls).toHaveLength(1)
    t.push('app:event', 0, 'back')
    expect(again.calls).toEqual([['back']])
    expect(t.onCalls[0].dispose).not.toHaveBeenCalled()
  })
})

describe('BA-8 扇出状态按实例', () => {
  it('BA-8 两个实例各挂各的一个监听，只派发给自己的订阅者', () => {
    const t = recordingTransport()
    const first = createCommonOverrides(t)
    const second = createCommonOverrides(t)
    const a = recorder()
    const b = recorder()
    first.events.subscribe(a.fn as never)
    expect(t.onCalls).toHaveLength(1)
    second.events.subscribe(b.fn as never)
    expect(t.onCalls.map((c) => c.channel)).toEqual(['app:event', 'app:event'])
    first.events.subscribe(() => {})
    second.events.subscribe(() => {})
    expect(t.onCalls).toHaveLength(2)

    t.push('app:event', 0, 'to-first')
    expect(a.calls).toEqual([['to-first']])
    expect(b.calls).toEqual([])
    t.push('app:event', 1, 'to-second')
    expect(a.calls).toEqual([['to-first']])
    expect(b.calls).toEqual([['to-second']])
  })
})

describe('BA-9 liveDoc.respond 打包', () => {
  it("BA-9 respond('r1', res) → invoke('liveDoc:respond', { requestId: 'r1', result: res })，恰一个参数，原样交回", () => {
    const t = recordingTransport()
    const common = createCommonOverrides(t)
    const res = { ok: true, text: 'x' } as never
    const returned = common.liveDoc.respond('r1', res)
    expect(returned).toBe(INVOKE_RESULT)
    expect(t.invokeCalls).toEqual([['liveDoc:respond', { requestId: 'r1', result: res }]])
    expect(t.invokeCalls[0]).toHaveLength(2)
    expect((t.invokeCalls[0][1] as { result: unknown }).result).toBe(res)
  })
})

describe('BA-10 knowledge.baseOptions 缺省', () => {
  it('BA-10 不给 / undefined / null → {}；给了 → 原样；多给的丢掉；通道之后永远恰一个参数', () => {
    const t = recordingTransport()
    const common = createCommonOverrides(t)
    const baseOptions = common.knowledge.baseOptions as (...args: unknown[]) => unknown
    const p = { sessionId: 's1' }
    expect(baseOptions()).toBe(INVOKE_RESULT)
    expect(baseOptions(undefined)).toBe(INVOKE_RESULT)
    expect(baseOptions(null)).toBe(INVOKE_RESULT)
    expect(baseOptions(p)).toBe(INVOKE_RESULT)
    expect(baseOptions(p, 'extra')).toBe(INVOKE_RESULT)
    expect(t.invokeCalls).toEqual([
      ['knowledge:baseOptions', {}],
      ['knowledge:baseOptions', {}],
      ['knowledge:baseOptions', {}],
      ['knowledge:baseOptions', p],
      ['knowledge:baseOptions', p]
    ])
    expect(t.invokeCalls.map((c) => c.length)).toEqual([2, 2, 2, 2, 2])
    expect(t.invokeCalls[3][1]).toBe(p)
    expect(t.invokeCalls[4][1]).toBe(p)
  })
})

/**
 * 真的 preload（`src/preload/index.ts`）建出来的 `window.api` 与通道表（`shared/apiTable.ts`）逐条对得上 ——
 * 运行时把表走一遍（server mode phase A §5「The built window.api matches the table」）。
 *
 * electron 是替身：`contextBridge.exposeInMainWorld` 收进 Map，`ipcRenderer.{invoke,send,on,removeListener}` 是 spy
 * （`invoke` 每次回一个新的哨兵 Promise）。导入时 `process.contextIsolated = true`，导完复原。
 *
 *   PT-1 暴露：`exposeInMainWorld` 恰调一次、键是 'api'（没有 'electron'）；导入本身不碰 ipcRenderer
 *   PT-2 形状：命名空间 = 表的键 ∪ override 的键；每个命名空间的成员 = 表成员 ∪ override 成员，不多不少；
 *        成员都是函数，只有 `app.platform` 是值且 === process.platform（对照两张常量表，不写死个数）
 *   PT-3 表里每一条都接上了：invoke —— 多给一个参数时 `ipcRenderer.invoke(通道, …前 args 个)` 恰一次、回的就是那个
 *        Promise；不给参数时补 args 个 undefined。send —— 同样走 `ipcRenderer.send`，回 undefined。event —— 订阅恰挂一个
 *        `ipcRenderer.on(通道, h)`；`h(假 IPC 事件, p1, p2)` 交给回调 [] 或 [p1]（不带 IPC 事件）；注销函数
 *        `removeListener(通道, 同一个 h)`；两次订阅挂两个不同的 h，注销一个另一个照样收
 *   PT-4 override 经真的传输：`liveDoc.respond` 打包；`knowledge.baseOptions()` 传 {}；`events.subscribe` 两次只挂一个
 *        `ipcRenderer.on('app:event')`，推送 (ev, payload) 两个回调都收到 payload；`sync.send` → `send('sync:frame', …)`
 *   PT-5 表里通道不重复（纯数据）：请求通道（表 invoke/send + 非 null 的 override invoke/send）没有重复；推送通道
 *        （表 event + override event）没有重复（`sync:frame` 可以既是 send 又是 event）；没有成员名同时在表与 override 里
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  API_OVERRIDE_CHANNELS,
  API_TABLE,
  type ApiMember,
  type ApiOverrideChannel
} from '../../shared/apiTable'

type IpcHandler = (event: unknown, ...payload: unknown[]) => void

const state = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  exposeCalls: [] as string[],
  invoke: vi.fn((..._args: unknown[]) => new Promise<never>(() => {})),
  send: vi.fn((..._args: unknown[]) => {}),
  on: vi.fn((_channel: string, _handler: (event: unknown, ...payload: unknown[]) => void) => {}),
  removeListener: vi.fn(
    (_channel: string, _handler: (event: unknown, ...payload: unknown[]) => void) => {}
  )
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      state.exposeCalls.push(key)
      state.exposed.set(key, value)
    }
  },
  ipcRenderer: {
    invoke: state.invoke,
    send: state.send,
    on: state.on,
    removeListener: state.removeListener
  }
}))

type AnyApi = Record<string, Record<string, any>>

let api: AnyApi
/** 导入刚结束那一刻各 ipcRenderer spy 的调用次数 */
let callsAtImport: Record<string, number>

const FAKE_IPC_EVENT = { sender: 'ipc-renderer-event' }

beforeAll(async () => {
  const proc = process as unknown as { contextIsolated?: boolean }
  const previous = proc.contextIsolated
  proc.contextIsolated = true
  try {
    await import('../index')
  } finally {
    proc.contextIsolated = previous
  }
  callsAtImport = {
    invoke: state.invoke.mock.calls.length,
    send: state.send.mock.calls.length,
    on: state.on.mock.calls.length,
    removeListener: state.removeListener.mock.calls.length
  }
  api = state.exposed.get('api') as AnyApi
})

function clearIpc(): void {
  state.invoke.mockClear()
  state.send.mockClear()
  state.on.mockClear()
  state.removeListener.mockClear()
}

/** 表里的每一条：[命名空间, 成员名, 条目] */
const tableEntries: Array<[string, string, ApiMember]> = Object.entries(API_TABLE).flatMap(
  ([ns, members]) =>
    Object.entries(members).map(
      ([name, member]) => [ns, name, member] as [string, string, ApiMember]
    )
)

/** override 的每一条：[命名空间, 成员名, 通道（null = 不走通道）] */
const overrideEntries: Array<[string, string, ApiOverrideChannel | null]> = Object.entries(
  API_OVERRIDE_CHANNELS
).flatMap(([ns, members]) =>
  Object.entries(members).map(
    ([name, ch]) =>
      [ns, name, ch as ApiOverrideChannel | null] as [string, string, ApiOverrideChannel | null]
  )
)

const sentinels = (n: number): Array<{ sentinel: number }> =>
  Array.from({ length: n }, (_, i) => ({ sentinel: i }))

describe('PT-1 暴露', () => {
  it("PT-1 exposeInMainWorld 恰一次、键是 'api'；导入本身零次 ipcRenderer 调用", () => {
    expect(state.exposeCalls).toEqual(['api'])
    expect(state.exposed.has('electron')).toBe(false)
    expect(callsAtImport).toEqual({ invoke: 0, send: 0, on: 0, removeListener: 0 })
  })
})

describe('PT-2 形状', () => {
  it('PT-2 命名空间 = 表 ∪ override', () => {
    const expected = new Set([...Object.keys(API_TABLE), ...Object.keys(API_OVERRIDE_CHANNELS)])
    expect(Object.keys(api).sort()).toEqual([...expected].sort())
  })

  it('PT-2 每个命名空间的成员 = 表成员 ∪ override 成员，不多不少', () => {
    const table = API_TABLE as unknown as Record<string, Record<string, unknown>>
    const overrides = API_OVERRIDE_CHANNELS as unknown as Record<string, Record<string, unknown>>
    for (const ns of Object.keys(api)) {
      const expected = new Set([
        ...Object.keys(table[ns] ?? {}),
        ...Object.keys(overrides[ns] ?? {})
      ])
      expect(Object.keys(api[ns]).sort(), ns).toEqual([...expected].sort())
    }
  })

  it('PT-2 成员都是函数，只有 app.platform 是值且 === process.platform', () => {
    const nonFunctions: string[] = []
    for (const [ns, members] of Object.entries(api)) {
      for (const [name, value] of Object.entries(members)) {
        if (typeof value !== 'function') nonFunctions.push(`${ns}.${name}`)
      }
    }
    expect(nonFunctions).toEqual(['app.platform'])
    expect(api.app.platform).toBe(process.platform)
  })
})

describe('PT-3 表里每一条都接到 ipcRenderer 上', () => {
  beforeEach(clearIpc)

  it('PT-3 表不是空的（三种都有）', () => {
    const kinds = new Set(tableEntries.map(([, , m]) => m.kind))
    expect([...kinds].sort()).toEqual(['event', 'invoke', 'send'])
  })

  it.each(tableEntries.filter(([, , m]) => m.kind === 'invoke'))(
    'PT-3 invoke %s.%s',
    (ns, name, member) => {
      clearIpc()
      const given = sentinels(member.args + 1)
      const returned = api[ns][name](...given)
      expect(state.invoke.mock.calls).toEqual([[member.channel, ...given.slice(0, member.args)]])
      expect(returned).toBe(state.invoke.mock.results[0].value)

      clearIpc()
      api[ns][name]()
      expect(state.invoke.mock.calls).toEqual([
        [member.channel, ...Array.from({ length: member.args }, () => undefined)]
      ])
      expect(state.invoke.mock.calls[0]).toHaveLength(1 + member.args)
      expect(state.send).not.toHaveBeenCalled()
      expect(state.on).not.toHaveBeenCalled()
    }
  )

  it.each(tableEntries.filter(([, , m]) => m.kind === 'send'))(
    'PT-3 send %s.%s',
    (ns, name, member) => {
      clearIpc()
      const given = sentinels(member.args + 1)
      expect(api[ns][name](...given)).toBeUndefined()
      expect(state.send.mock.calls).toEqual([[member.channel, ...given.slice(0, member.args)]])

      clearIpc()
      expect(api[ns][name]()).toBeUndefined()
      expect(state.send.mock.calls).toEqual([
        [member.channel, ...Array.from({ length: member.args }, () => undefined)]
      ])
      expect(state.send.mock.calls[0]).toHaveLength(1 + member.args)
      expect(state.invoke).not.toHaveBeenCalled()
      expect(state.on).not.toHaveBeenCalled()
    }
  )

  it.each(tableEntries.filter(([, , m]) => m.kind === 'event'))(
    'PT-3 event %s.%s',
    (ns, name, member) => {
      clearIpc()
      const got1: unknown[][] = []
      const got2: unknown[][] = []
      const dispose1 = api[ns][name]((...args: unknown[]) => got1.push(args))
      expect(state.on).toHaveBeenCalledTimes(1)
      const [channel1, h1] = state.on.mock.calls[0] as [string, IpcHandler]
      expect(channel1).toBe(member.channel)
      expect(typeof dispose1).toBe('function')

      const p1 = { p: 1 }
      const p2 = { p: 2 }
      h1(FAKE_IPC_EVENT, p1, p2)
      expect(got1).toEqual([[p1, p2].slice(0, member.args)])
      if (member.args > 0) expect(got1[0][0]).toBe(p1)
      expect(got1.flat()).not.toContain(FAKE_IPC_EVENT)

      const dispose2 = api[ns][name]((...args: unknown[]) => got2.push(args))
      expect(state.on).toHaveBeenCalledTimes(2)
      const [channel2, h2] = state.on.mock.calls[1] as [string, IpcHandler]
      expect(channel2).toBe(member.channel)
      expect(h2).not.toBe(h1)

      expect(state.removeListener).not.toHaveBeenCalled()
      dispose1()
      expect(state.removeListener.mock.calls).toEqual([[member.channel, h1]])
      expect(state.removeListener.mock.calls[0][1]).toBe(h1)

      h2(FAKE_IPC_EVENT, p1, p2)
      expect(got2).toEqual([[p1, p2].slice(0, member.args)])
      expect(got1).toHaveLength(1)

      dispose2()
      expect(state.removeListener.mock.calls).toEqual([
        [member.channel, h1],
        [member.channel, h2]
      ])
      expect(state.invoke).not.toHaveBeenCalled()
      expect(state.send).not.toHaveBeenCalled()
    }
  )
})

describe('PT-4 override 经真的传输', () => {
  beforeEach(clearIpc)

  it("PT-4 liveDoc.respond('r', x) → invoke('liveDoc:respond', { requestId: 'r', result: x })", () => {
    const x = { anything: true }
    const returned = api.liveDoc.respond('r', x)
    expect(state.invoke.mock.calls).toEqual([['liveDoc:respond', { requestId: 'r', result: x }]])
    expect(returned).toBe(state.invoke.mock.results[0].value)
  })

  it("PT-4 knowledge.baseOptions() → invoke('knowledge:baseOptions', {})", () => {
    api.knowledge.baseOptions()
    expect(state.invoke.mock.calls).toEqual([['knowledge:baseOptions', {}]])
  })

  it("PT-4 events.subscribe 两次 → 只挂一个 ipcRenderer.on('app:event')；推送 (ev, payload) 两个回调都收到 payload", () => {
    const a: unknown[][] = []
    const b: unknown[][] = []
    api.events.subscribe((...args: unknown[]) => a.push(args))
    api.events.subscribe((...args: unknown[]) => b.push(args))
    expect(state.on.mock.calls.map(([channel]) => channel)).toEqual(['app:event'])
    const handler = state.on.mock.calls[0][1] as IpcHandler
    const payload = { type: 'session.changed' }
    handler(FAKE_IPC_EVENT, payload)
    expect(a).toEqual([[payload]])
    expect(b).toEqual([[payload]])
  })

  it("PT-4 sync.send('L', f) → ipcRenderer.send('sync:frame', 'L', f)", () => {
    const f = { frame: 1 }
    api.sync.send('L', f)
    expect(state.send.mock.calls).toEqual([['sync:frame', 'L', f]])
  })
})

describe('PT-5 表里通道不重复', () => {
  it('PT-5 请求通道（表 invoke/send + override invoke/send）没有重复', () => {
    const request = [
      ...tableEntries.filter(([, , m]) => m.kind !== 'event').map(([, , m]) => m.channel),
      ...overrideEntries
        .filter(([, , ch]) => ch !== null && ch.kind !== 'event')
        .map(([, , ch]) => ch!.channel)
    ]
    expect(request.length).toBeGreaterThan(0)
    const dupes = request.filter((ch, i) => request.indexOf(ch) !== i)
    expect(dupes).toEqual([])
  })

  it('PT-5 推送通道（表 event + override event）没有重复', () => {
    const events = [
      ...tableEntries.filter(([, , m]) => m.kind === 'event').map(([, , m]) => m.channel),
      ...overrideEntries
        .filter(([, , ch]) => ch !== null && ch.kind === 'event')
        .map(([, , ch]) => ch!.channel)
    ]
    expect(events).toEqual(expect.arrayContaining(['app:event', 'sync:frame']))
    const dupes = events.filter((ch, i) => events.indexOf(ch) !== i)
    expect(dupes).toEqual([])
  })

  it('PT-5 没有成员名同时在 API_TABLE[ns] 与 API_OVERRIDE_CHANNELS[ns] 里', () => {
    const table = API_TABLE as unknown as Record<string, Record<string, unknown>>
    const both = overrideEntries
      .filter(([ns, name]) => table[ns] !== undefined && name in table[ns])
      .map(([ns, name]) => `${ns}.${name}`)
    expect(both).toEqual([])
  })
})

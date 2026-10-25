/**
 * `createClientContext`（server mode phase A §3：handler 的操作上下文改由 `ctx` 派生）—— IPC 调用打的来源标签与
 * 改造前的 `createElectronContext` 一样。
 *
 *   CH-5 `createClientContext({ client, transport: 'ipc' }, 's1')` → `source { type: 'electron' }`、`sessionId 's1'`、
 *        每次一个新的 `requestId` 字符串、数字 `timestamp`；与 `createElectronContext` 同形（同样的键）；
 *        不给 sessionId → undefined（与 createElectronContext 一致）
 *   OC-1 网络客户端（server mode phase B）→ `source { type: 'network', clientId, remoteAddress, userAgent }`（User-Agent
 *        是空串就不带这个键）、sessionId、每次一个新的 requestId、数字 timestamp；恰这四个键；不给 sessionId → undefined
 *   OC-2 标签跟着 `client.kind` 走：窗口客户端经 `transport: 'network'` 来也是 `{ type: 'electron' }`
 *   OC-5 输入来源（`InputOrigin`，2026-10-21）：`humanOriginOf` 按操作来源逐种映射（electron → local、network → remote
 *        带 userAgent、空 UA / 空 installId 不带那个键、telegram 三个 id）；`currentInputOrigin()` 只在 `run` 之内有值
 *        （await 之后还在、嵌套时里层的赢、出来之后又是 undefined）；`inputOriginOfClient` 按调用方直接取，不看 ALS
 *   OC-6 采纳提议（`suggest` 工具，2026-10-25）：上下文带 `suggestion` → `currentInputOrigin()` 是连接的章再加上那份
 *        引用（local / remote 都是），引用是拷贝（改上下文里的那份不影响已交出的，交出的两次也不是同一个对象）；
 *        不带 → 与之前一字不差（没有 suggestion 键）；`inputOriginOfClient` 从不带它
 */
import { describe, expect, it } from 'vitest'
import {
  createChromeContext,
  createClientContext,
  createElectronContext,
  createTelegramContext,
  currentInputOrigin,
  humanOriginOf,
  inputOriginOfClient,
  operationContext,
  type OperationSource
} from '../operationContext'
import type { HumanOrigin, SuggestionRef } from '@shuvix/chat-protocol/types/inputOrigin'
import type { ClientContext } from '../../ipc/registry'

const ctx: ClientContext = {
  client: { kind: 'window', id: 'ipc:7', webContentsId: 7 },
  transport: 'ipc'
}

describe('CH-5 createClientContext', () => {
  it("CH-5 IPC → source { type: 'electron' }、sessionId、新的 requestId、数字 timestamp", () => {
    const before = Date.now()
    const a = createClientContext(ctx, 's1')
    const b = createClientContext(ctx, 's1')
    const after = Date.now()
    expect(a.source).toEqual({ type: 'electron' })
    expect(a.sessionId).toBe('s1')
    expect(typeof a.requestId).toBe('string')
    expect(a.requestId.length).toBeGreaterThan(0)
    expect(b.requestId).not.toBe(a.requestId)
    expect(typeof a.timestamp).toBe('number')
    expect(a.timestamp).toBeGreaterThanOrEqual(before)
    expect(a.timestamp).toBeLessThanOrEqual(after)
  })

  it('CH-5 与 createElectronContext 同形；不给 sessionId → undefined', () => {
    const fromClient = createClientContext(ctx, 's1')
    const electron = createElectronContext('s1')
    expect(Object.keys(fromClient).sort()).toEqual(Object.keys(electron).sort())
    expect({ ...fromClient, requestId: '', timestamp: 0 }).toEqual({
      ...electron,
      requestId: '',
      timestamp: 0
    })
    expect(createClientContext(ctx).sessionId).toBeUndefined()
    // 上下文里不带调用方本身（不漏 client / transport）
    expect(Object.keys(fromClient).sort()).toEqual([
      'requestId',
      'sessionId',
      'source',
      'timestamp'
    ])
  })
})

const netCtx: ClientContext = {
  client: { kind: 'network', id: 'ws:4', remoteAddress: '192.168.1.20', userAgent: 'UA' },
  transport: 'network'
}

describe('OC-1 / OC-2 网络客户端的来源标签', () => {
  it("OC-1 → source { type: 'network', clientId, remoteAddress, userAgent }、恰四个键、新的 requestId", () => {
    const before = Date.now()
    const a = createClientContext(netCtx, 's1')
    const b = createClientContext(netCtx, 's1')
    const after = Date.now()
    expect(a.source).toStrictEqual({
      type: 'network',
      clientId: 'ws:4',
      remoteAddress: '192.168.1.20',
      userAgent: 'UA'
    })
    expect(a.sessionId).toBe('s1')
    expect(typeof a.requestId).toBe('string')
    expect(a.requestId.length).toBeGreaterThan(0)
    expect(b.requestId).not.toBe(a.requestId)
    expect(typeof a.timestamp).toBe('number')
    expect(a.timestamp).toBeGreaterThanOrEqual(before)
    expect(a.timestamp).toBeLessThanOrEqual(after)
    expect(Object.keys(a).sort()).toEqual(['requestId', 'sessionId', 'source', 'timestamp'])
    expect(createClientContext(netCtx).sessionId).toBeUndefined()
  })

  it("OC-2 窗口客户端经 transport 'network' 来 → { type: 'electron' }", () => {
    const odd: ClientContext = { client: ctx.client, transport: 'network' }
    expect(createClientContext(odd, 's1').source).toStrictEqual({ type: 'electron' })
  })
})

describe('OC-5 输入来源（InputOrigin）：宿主按这次操作的连接盖章', () => {
  const LOCAL: HumanOrigin = { kind: 'local' }
  const REMOTE: HumanOrigin = {
    kind: 'remote',
    clientId: 'ws:4',
    address: '192.168.1.20',
    userAgent: 'UA'
  }
  const CHROME: HumanOrigin = { kind: 'chrome', installId: 'inst-1' }
  const TELEGRAM: HumanOrigin = { kind: 'telegram', botId: 'b1', userId: 'u1', chatId: 'c1' }
  const noUaCtx: ClientContext = {
    client: { kind: 'network', id: 'ws:5', remoteAddress: '10.0.0.7', userAgent: '' },
    transport: 'network'
  }

  it.each<[string, OperationSource, HumanOrigin]>([
    ['electron', createElectronContext('s1').source, LOCAL],
    ['network（带 UA）', createClientContext(netCtx, 's1').source, REMOTE],
    [
      'network（UA 是空串）',
      createClientContext(noUaCtx, 's1').source,
      { kind: 'remote', clientId: 'ws:5', address: '10.0.0.7' }
    ],
    ["chrome 'i'", createChromeContext('i', 's1').source, { kind: 'chrome', installId: 'i' }],
    ["chrome ''", createChromeContext('', 's1').source, { kind: 'chrome' }],
    ['telegram', createTelegramContext('b1', 'u1', 'c1', 's1').source, TELEGRAM]
  ])('OC-5 humanOriginOf(%s) → 恰好那几个键', (_label, source, expected) => {
    expect(humanOriginOf(source)).toStrictEqual(expected)
  })

  it('OC-5 网络客户端的 User-Agent 是空串：操作来源与输入来源都没有 userAgent 键', () => {
    const source = createClientContext(noUaCtx, 's1').source
    expect(source).toStrictEqual({ type: 'network', clientId: 'ws:5', remoteAddress: '10.0.0.7' })
    expect(source).not.toHaveProperty('userAgent')
    const origin = humanOriginOf(source)
    expect(origin).not.toHaveProperty('userAgent')
    expect(inputOriginOfClient(noUaCtx)).not.toHaveProperty('userAgent')
  })

  it('OC-5 currentInputOrigin()：run 之外 undefined；run 之内是这次操作的来源，await 之后还在；嵌套时里层的赢；出来之后又是 undefined', async () => {
    expect(currentInputOrigin()).toBeUndefined()
    const seen: Array<HumanOrigin | undefined> = []
    await operationContext.run(createClientContext(netCtx, 's1'), async () => {
      seen.push(currentInputOrigin())
      await new Promise((resolve) => setTimeout(resolve, 0))
      seen.push(currentInputOrigin())
      await operationContext.run(createChromeContext('inst-1', 's1'), async () => {
        await Promise.resolve()
        seen.push(currentInputOrigin())
      })
      seen.push(currentInputOrigin())
      operationContext.run(createTelegramContext('b1', 'u1', 'c1'), () => {
        seen.push(currentInputOrigin())
      })
      seen.push(currentInputOrigin())
    })
    expect(seen).toStrictEqual([REMOTE, REMOTE, CHROME, REMOTE, TELEGRAM, REMOTE])
    expect(currentInputOrigin()).toBeUndefined()
    // 每次读都是新对象：调用方改了它也不影响下一次
    operationContext.run(createElectronContext(), () => {
      const first = currentInputOrigin()
      expect(first).toStrictEqual(LOCAL)
      expect(currentInputOrigin()).not.toBe(first)
    })
    expect(currentInputOrigin()).toBeUndefined()
  })

  it('OC-5 inputOriginOfClient：窗口 → local，网络客户端 → remote（带 UA）；按调用方取，不看此刻的 ALS', () => {
    expect(inputOriginOfClient(ctx)).toStrictEqual(LOCAL)
    expect(inputOriginOfClient(netCtx)).toStrictEqual(REMOTE)
    // 在另一种操作的上下文里调，照样按传进来的调用方
    operationContext.run(createTelegramContext('b1', 'u1', 'c1'), () => {
      expect(inputOriginOfClient(ctx)).toStrictEqual(LOCAL)
      expect(inputOriginOfClient(netCtx)).toStrictEqual(REMOTE)
    })
    expect(inputOriginOfClient({ client: ctx.client, transport: 'network' })).toStrictEqual(LOCAL)
  })
})

describe('OC-6 采纳提议：上下文里的提议引用盖进输入来源', () => {
  const REF: SuggestionRef = { messageId: 'a1', toolCallId: 'call_0', index: 2 }

  it('OC-6 本机窗口 + suggestion → { kind: local, suggestion }', () => {
    operationContext.run({ ...createClientContext(ctx, 's1'), suggestion: REF }, () => {
      expect(currentInputOrigin()).toStrictEqual({ kind: 'local', suggestion: REF })
    })
  })

  it('OC-6 网络客户端 + suggestion → remote 的四键再加 suggestion', () => {
    operationContext.run({ ...createClientContext(netCtx, 's1'), suggestion: REF }, () => {
      expect(currentInputOrigin()).toStrictEqual({
        kind: 'remote',
        clientId: 'ws:4',
        address: '192.168.1.20',
        userAgent: 'UA',
        suggestion: REF
      })
    })
  })

  it('OC-6 引用是拷贝：交出的不是上下文里那个对象，之后改上下文里的那份也不影响已交出的', () => {
    const ref: SuggestionRef = { ...REF }
    operationContext.run({ ...createClientContext(ctx, 's1'), suggestion: ref }, () => {
      const first = currentInputOrigin()
      const got = first && 'suggestion' in first ? first.suggestion : undefined
      expect(got).toStrictEqual(REF)
      expect(got).not.toBe(ref)
      ref.index = 9
      expect(got?.index).toBe(2)
      const second = currentInputOrigin()
      expect(second && 'suggestion' in second ? second.suggestion : undefined).not.toBe(got)
    })
  })

  it('OC-6 不带 suggestion → 与之前一样（没有 suggestion 键）；inputOriginOfClient 从不带它', () => {
    operationContext.run(createClientContext(ctx, 's1'), () => {
      const origin = currentInputOrigin()
      expect(origin).toStrictEqual({ kind: 'local' })
      expect(origin).not.toHaveProperty('suggestion')
    })
    operationContext.run({ ...createClientContext(netCtx, 's1'), suggestion: REF }, () => {
      expect(inputOriginOfClient(netCtx)).not.toHaveProperty('suggestion')
    })
    expect(currentInputOrigin()).toBeUndefined()
  })
})

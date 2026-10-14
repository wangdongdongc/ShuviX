/**
 * `createClientContext`（server mode phase A §3：handler 的操作上下文改由 `ctx` 派生）—— IPC 调用打的来源标签与
 * 改造前的 `createElectronContext` 一样。
 *
 *   CH-5 `createClientContext({ client, transport: 'ipc' }, 's1')` → `source { type: 'electron' }`、`sessionId 's1'`、
 *        每次一个新的 `requestId` 字符串、数字 `timestamp`；与 `createElectronContext` 同形（同样的键）；
 *        不给 sessionId → undefined（与 createElectronContext 一致）
 *   OC-1 网络客户端（server mode phase B）→ `source { type: 'network', clientId, remoteAddress }`（不带 userAgent）、sessionId、
 *        每次一个新的 requestId、数字 timestamp；恰这四个键；不给 sessionId → undefined
 *   OC-2 标签跟着 `client.kind` 走：窗口客户端经 `transport: 'network'` 来也是 `{ type: 'electron' }`
 */
import { describe, expect, it } from 'vitest'
import { createClientContext, createElectronContext } from '../operationContext'
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
  it("OC-1 → source { type: 'network', clientId, remoteAddress }、恰四个键、新的 requestId", () => {
    const before = Date.now()
    const a = createClientContext(netCtx, 's1')
    const b = createClientContext(netCtx, 's1')
    const after = Date.now()
    expect(a.source).toStrictEqual({
      type: 'network',
      clientId: 'ws:4',
      remoteAddress: '192.168.1.20'
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

/**
 * BuiltinMcpRegistry —— 「名字 → 工厂」这一层的全部职责。
 *
 * 它刻意薄：造一对 `InMemoryTransport`、把 server side 交给工厂、把 client side 交回
 * McpManager，**自己不持有任何实例**。这条「不持有」是整套内置能力服务器的记账前提 ——
 * 一份实例的寿命等于它那条连接的寿命，全记在 McpManager 里，于是「会话结束 → 关连接 →
 * 释放资源」只有一条路径。注册表这边只要多留一个 `Map<name, instance>`，就会多出一条
 * 谁也关不掉的引用，而它在 UI 上完全看不见。
 *
 * 所以这里钉四件事：没注册的名字**当场抛**（装配期就该暴露的配置问题，不是运行期回空）、
 * 工厂拿到的是会话上下文与 server side、交回的是**同一对**的另一端、以及注册表的门面上
 * 根本没有取实例的入口。
 */
import { describe, expect, it, vi } from 'vitest'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { BuiltinMcpRegistry, type BuiltinMcpFactory } from '../builtinMcpRegistry'

/** 记下工厂收到的 (scope, serverTransport) */
function recordingFactory(): {
  factory: BuiltinMcpFactory
  calls: Array<{ sessionId: string; transport: Transport }>
} {
  const calls: Array<{ sessionId: string; transport: Transport }> = []
  return {
    factory: vi.fn((scope, transport) => {
      calls.push({ sessionId: scope.sessionId, transport })
    }),
    calls
  }
}

describe('BuiltinMcpRegistry', () => {
  it('BMR-U-36: 名字没注册 = 当场抛（配置里有 inproc 行却没有实现）', async () => {
    const reg = new BuiltinMcpRegistry()

    // 回一个空 transport 只会让「这台内置能力凭空少了工具」推迟到下一次对话才被发现
    await expect(reg.createClientTransport('ssh', { sessionId: 's1' })).rejects.toThrow(
      'No builtin MCP server registered under "ssh"'
    )
    expect(reg.has('ssh')).toBe(false)
    expect(reg.names()).toEqual([])
  })

  it('BMR-U-37: 工厂拿到会话上下文与 server side，交回的是同一对的另一端', async () => {
    const reg = new BuiltinMcpRegistry()
    const { factory, calls } = recordingFactory()
    reg.register('ssh', factory)

    const clientTransport = await reg.createClientTransport('ssh', { sessionId: 's1' })

    expect(factory).toHaveBeenCalledTimes(1)
    expect(calls[0].sessionId).toBe('s1')
    expect(calls[0].transport).not.toBe(clientTransport)

    // 「同一对」不是身份问题而是连通性问题：server side 发出去的必须落在交回的这一端
    const received: JSONRPCMessage[] = []
    clientTransport.onmessage = (m): void => void received.push(m)
    await calls[0].transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }])
  })

  it('BMR-U-38: 同名后注册的覆盖先注册的（测试替身靠这一条），名字只留一份', async () => {
    const reg = new BuiltinMcpRegistry()
    const first = recordingFactory()
    const second = recordingFactory()
    reg.register('ssh', first.factory)
    reg.register('ssh', second.factory)

    await reg.createClientTransport('ssh', { sessionId: 's1' })

    expect(first.factory).not.toHaveBeenCalled()
    expect(second.factory).toHaveBeenCalledTimes(1)
    expect(reg.names()).toEqual(['ssh'])
  })

  it('BMR-U-39: 工厂自己抛出的错误原样冒出来（同步抛与异步拒绝都是）', async () => {
    const reg = new BuiltinMcpRegistry()
    reg.register('boom', () => {
      throw new Error('factory exploded')
    })
    reg.register('boom-async', async () => {
      throw new Error('async factory exploded')
    })

    await expect(reg.createClientTransport('boom', { sessionId: 's1' })).rejects.toThrow(
      'factory exploded'
    )
    await expect(reg.createClientTransport('boom-async', { sessionId: 's1' })).rejects.toThrow(
      'async factory exploded'
    )
  })

  it('BMR-U-40: 注册表不持有实例 —— 每次 create 都是新的一份，门面上也没有取它的入口', async () => {
    const reg = new BuiltinMcpRegistry()
    const { factory, calls } = recordingFactory()
    reg.register('ssh', factory)

    const a = await reg.createClientTransport('ssh', { sessionId: 's1' })
    const b = await reg.createClientTransport('ssh', { sessionId: 's1' })

    // 同一条会话问两次也造两份：去重是 McpManager 按连接键做的，不是这里
    expect(factory).toHaveBeenCalledTimes(2)
    expect(a).not.toBe(b)
    expect(calls[0].transport).not.toBe(calls[1].transport)

    // 门面上多一个 `get(name)` 就等于多一条谁也关不掉的引用
    expect(Object.getOwnPropertyNames(BuiltinMcpRegistry.prototype).sort()).toEqual([
      'constructor',
      'createClientTransport',
      'has',
      'names',
      'register'
    ])
  })
})

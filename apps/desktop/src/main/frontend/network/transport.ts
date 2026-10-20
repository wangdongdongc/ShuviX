/**
 * 通道注册表的网络传输（server mode phase B，docs/server/phase-bc-network-and-web.md §B2）—— 与 `ipc/ipcAdapter.ts`
 * 并列的第二条 `ClientTransport`：
 *
 *  - `serve(definition)`：把注册表的定义收进自己的表（分发器据此找处理函数，见 `dispatch.ts`）；
 *  - `owns(client)`：`kind === 'network'` 的客户端都归它；
 *  - `pushTo(client, …)` → 那条连接上发一条 `{t:'push', channel, args}`（连接已经没了 → 什么也不做）；
 *  - `isClientAlive` / `onClientGone` 看连接的生死（连接关了 = 客户端没了）；
 *  - `broadcast(…)` → 每条开着的连接。
 *
 * 连接（`NetworkConnection`）由服务端（`server.ts`）在 WebSocket 升级成功后建出来、`add` 进来；它关掉时自己从表里
 * 摘掉。本模块不碰 `ws` 与 Node 的网络对象 —— 单测给假的连接。
 */
import type { NetworkCallFacts } from '../../../shared/network'
import type { ServerMessage } from '../../../shared/networkEnvelope'
import type {
  ChannelDefinition,
  ClientRef,
  ClientTransport,
  NetworkClientRef
} from '../../ipc/registry'

/** 一条网络连接（一个浏览器页面的一条 WebSocket） */
export interface NetworkConnection {
  readonly client: NetworkClientRef
  /** 连上的时刻（毫秒时间戳） */
  readonly connectedAt: number
  /** 升级那一刻的事实（对端地址、请求头 …）：每条 RPC 的策略判定、策略变了之后的重判都按它（单测的假连接可以没有） */
  readonly facts?: NetworkCallFacts
  /** 还开着吗 */
  isOpen(): boolean
  /** 发一条消息（已经关了 → 什么也不做，从不抛） */
  send(message: ServerMessage): void
  /** 关掉（已经关了 → 什么也不做） */
  close(code: number, reason: string): void
  /** 关掉时回调一次（已经关了 → 下一个微任务里回调）；返回撤掉监听的函数 */
  onClose(callback: () => void): () => void
}

export interface NetworkTransport extends ClientTransport {
  /** 收下一条新连接（同 id 的旧连接若还在，先关掉它）；连接关掉时自己摘掉 */
  add(connection: NetworkConnection): void
  /** 此刻开着的连接（按连上的先后） */
  connections(): NetworkConnection[]
  /** 某个客户端 id 的连接 */
  connection(clientId: string): NetworkConnection | undefined
  /** 注册表里某条通道的定义（`serve` 收下的那一份） */
  definitionOf(channel: string): ChannelDefinition | undefined
  /** 关掉每一条连接（关网络访问 / 换端口 / 退出） */
  closeAll(code: number, reason: string): void
}

export const NETWORK_TRANSPORT_NAME = 'network'

export function createNetworkTransport(): NetworkTransport {
  const definitions = new Map<string, ChannelDefinition>()
  const live = new Map<string, NetworkConnection>()

  const connectionOf = (client: ClientRef): NetworkConnection | undefined => {
    if (client.kind !== 'network') return undefined
    const connection = live.get(client.id)
    return connection !== undefined && connection.isOpen() ? connection : undefined
  }

  return {
    name: NETWORK_TRANSPORT_NAME,

    serve(definition) {
      definitions.set(definition.channel, definition)
    },

    owns: (client) => client.kind === 'network',

    pushTo(client, channel, payload) {
      connectionOf(client)?.send({ t: 'push', channel, args: [...payload] })
    },

    isClientAlive: (client) => connectionOf(client) !== undefined,

    onClientGone(client, callback) {
      if (client.kind !== 'network') return () => {}
      const connection = live.get(client.id)
      if (connection === undefined || !connection.isOpen()) {
        // 已经没了（异步处理函数在连接断开之后才来登记）：照样回调一次，免得它挂着的资源（终端、登录）没人收
        let cancelled = false
        queueMicrotask(() => {
          if (!cancelled) callback()
        })
        return () => {
          cancelled = true
        }
      }
      return connection.onClose(callback)
    },

    broadcast(channel, payload) {
      for (const connection of [...live.values()]) {
        if (connection.isOpen()) connection.send({ t: 'push', channel, args: [...payload] })
      }
    },

    add(connection) {
      const id = connection.client.id
      const previous = live.get(id)
      if (previous !== undefined && previous !== connection) previous.close(1001, 'replaced')
      live.set(id, connection)
      connection.onClose(() => {
        if (live.get(id) === connection) live.delete(id)
      })
    },

    connections: () => [...live.values()].filter((c) => c.isOpen()),

    connection: (clientId) => live.get(clientId),

    definitionOf: (channel) => definitions.get(channel),

    closeAll(code, reason) {
      for (const connection of [...live.values()]) connection.close(code, reason)
    }
  }
}

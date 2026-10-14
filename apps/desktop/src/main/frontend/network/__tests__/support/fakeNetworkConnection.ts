/**
 * 网络传输用例的夹具：假的 `NetworkConnection`（`transport.ts` 的接口）与几个上下文 / 客户端构造器。
 *
 *  - `sent`：开着时 `send` 收到的每条 `ServerMessage`（关了之后的 `send` 不记）；
 *  - `closes`：开着时 `close(code, reason)` 的每次调用 —— 记下、标成关掉、同步跑一遍 onClose 回调（恰一次）；
 *  - `drop()`：标成关掉、跑回调，但不记 close（对面自己走了）；
 *  - `onClose(cb)`：已经关了 → 下一个微任务里回调；返回撤销函数。`closeHandlerCount()` 数还挂着的回调。
 */
import type { ClientContext, NetworkClientRef } from '../../../../ipc/registry'
import type { ServerMessage } from '../../../../../shared/networkEnvelope'
import type { NetworkConnection } from '../../transport'

export const netClient = (n = 1, remoteAddress = '192.168.1.20'): NetworkClientRef => ({
  kind: 'network',
  id: `ws:${n}`,
  remoteAddress,
  userAgent: 'UA/1'
})

export const netCtx = (n = 1): ClientContext => ({ client: netClient(n), transport: 'network' })

export const winCtx = (): ClientContext => ({
  client: { kind: 'window', id: 'ipc:7', webContentsId: 7 },
  transport: 'ipc'
})

export interface FakeNetworkConnection extends NetworkConnection {
  readonly sent: ServerMessage[]
  readonly closes: Array<[number, string]>
  /** 对面走了：关掉、跑回调，不记 close */
  drop(): void
  /** 还挂着的 onClose 回调数 */
  closeHandlerCount(): number
  /** `send` 时额外做的事（如把消息交给假的 socket） */
  onSend?: (message: ServerMessage) => void
}

export function fakeConnection(
  client: NetworkClientRef = netClient(1),
  connectedAt = 1000
): FakeNetworkConnection {
  let open = true
  const handlers = new Set<() => void>()
  const finish = (): void => {
    open = false
    for (const handler of [...handlers]) handler()
    handlers.clear()
  }
  const connection: FakeNetworkConnection = {
    client,
    connectedAt,
    sent: [],
    closes: [],
    isOpen: () => open,
    send(message) {
      if (!open) return
      connection.sent.push(message)
      connection.onSend?.(message)
    },
    close(code, reason) {
      if (!open) return
      connection.closes.push([code, reason])
      finish()
    },
    drop() {
      if (!open) return
      finish()
    },
    onClose(callback) {
      if (!open) {
        let cancelled = false
        queueMicrotask(() => {
          if (!cancelled) callback()
        })
        return () => {
          cancelled = true
        }
      }
      const entry = (): void => callback()
      handlers.add(entry)
      return () => {
        handlers.delete(entry)
      }
    },
    closeHandlerCount: () => handlers.size
  }
  return connection
}

/**
 * 视图同步的 Chrome 传输（phase 3，P3-09；plan §C「Chrome bridge」）—— SyncHub 的帧经桥推给扩展。
 *
 * 客户端 id 是 `chrome:<connId>`：一条桥连接（一个浏览器的这一轮运行）是一个客户端，它上面的每个侧边栏
 * 各自用不撞的订阅 id（chat-ui syncClient 的 `idPrefix`，P3-09-12）。
 *
 *  - **send**：帧装进桥事件 `sync.frame {sessionId, frame}`。`sessionId` 是帧所属的会话 —— 会话目标就是它
 *    本身；派生 agent 目标是 agent 的根会话（帧的目标里只有 agentId，SW 认不出该送给哪个侧边栏）。根会话在
 *    `channel.call('sync.invoke')` 核对归属时记下（{@link rememberAgentRoot}），这里只查表：订阅总是先过
 *    那道核对，帧不会先于它。超过原生消息上限的帧由连接自己分片（`BridgeConnection.send`）。
 *    连接不在 / 没就绪 / 认不出根会话：帧丢掉、记一笔，从不抛（hub 的 publish 在投影的 `state.change` 里）。
 *  - **onClientGone**：连接断开（含被同一个 installId 的新 hello 顶替 —— 旧连接会被关掉）→ 回调一次，
 *    hub 随之撤掉这个客户端的全部订阅、松开钉住。登记时连接已经不在 / 没就绪 → 回调在之后的微任务里调一次
 *    （绝不在 `onClientGone` 里同步调：hub 此刻还在登记这个客户端）。
 *
 * 本模块不碰会话层，也不引桥服务的单例：连接表由调用方注入（产品里是 `chromeBridge`，见 frontend/chrome/index）。
 */
import type { SyncServerTransport, SyncWireFrame } from '@shuvix/agent-runtime'
import { parseClientId } from '../sync/clientIdentity'
import type { SyncTransportLogger } from '../sync/ipcSyncTransport'

/** Chrome 侧边栏连接的客户端前缀 */
export const CHROME_CLIENT_PREFIX = 'chrome'

/** 某条桥连接的客户端 id */
export function chromeClientId(connId: string): string {
  return `${CHROME_CLIENT_PREFIX}:${connId}`
}

/** `chrome:<connId>` → connId；不是 Chrome 客户端 → undefined */
export function chromeConnIdOf(clientId: string): string | undefined {
  const parsed = parseClientId(clientId)
  return parsed !== undefined && parsed.prefix === CHROME_CLIENT_PREFIX ? parsed.rest : undefined
}

/** 传输要的那一点桥连接（`BridgeConnection` 满足它） */
export interface ChromeSyncConnection {
  readonly id: string
  readonly ready: boolean
  emit(name: 'sync.frame', params: { sessionId: string; frame: unknown }): void
}

/** 连接表：按 id 找连接、订阅连接断开（产品里是 `chromeBridge`） */
export interface ChromeSyncConnections<C extends ChromeSyncConnection = ChromeSyncConnection> {
  byId(connId: string): C | undefined
  onClosed(listener: (conn: C) => void): () => void
}

// ─── 派生 agent → 根会话（按连接记） ─────────────────────────

const agentRoots = new Map<string, Map<string, string>>()

/** `sync.invoke` 核对过归属的 agent 目标：记下它的根会话，推帧时按它路由 */
export function rememberAgentRoot(connId: string, agentId: string, sessionId: string): void {
  let roots = agentRoots.get(connId)
  if (roots === undefined) {
    roots = new Map()
    agentRoots.set(connId, roots)
  }
  roots.set(agentId, sessionId)
}

/** 这条连接订过的某个 agent 的根会话；没订过 → undefined */
export function agentRootOf(connId: string, agentId: string): string | undefined {
  return agentRoots.get(connId)?.get(agentId)
}

/** 连接没了：它记下的 agent 根会话一并丢掉 */
export function forgetAgentRoots(connId: string): void {
  agentRoots.delete(connId)
}

// ─── 传输 ───────────────────────────────────────────────

const silent: SyncTransportLogger = { warn: () => {}, error: () => {} }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 回调在之后的微任务里调一次；注销得早就不调 */
function goneLater(callback: () => void): () => void {
  let cancelled = false
  queueMicrotask(() => {
    if (!cancelled) callback()
  })
  return () => {
    cancelled = true
  }
}

export interface ChromeSyncTransportDeps<C extends ChromeSyncConnection> {
  readonly connections: ChromeSyncConnections<C>
  readonly logger?: SyncTransportLogger
}

export function createChromeSyncTransport<C extends ChromeSyncConnection>(
  deps: ChromeSyncTransportDeps<C>
): SyncServerTransport {
  const logger = deps.logger ?? silent

  const connectionOf = (clientId: string): C | undefined => {
    const connId = chromeConnIdOf(clientId)
    if (connId === undefined) return undefined
    try {
      return deps.connections.byId(connId)
    } catch (error) {
      logger.warn(`sync chrome: lookup failed client=${clientId}: ${errorText(error)}`)
      return undefined
    }
  }

  /** 帧所属的会话：会话目标 = 它本身；agent 目标 = 核对归属时记下的根会话 */
  const sessionOf = (connId: string, frame: SyncWireFrame): string | undefined => {
    const target = frame?.target
    if (target?.kind === 'session') return target.sessionId
    if (target?.kind === 'agent') return agentRootOf(connId, target.agentId)
    return undefined
  }

  return {
    send(clientId: string, frame: SyncWireFrame): void {
      const conn = connectionOf(clientId)
      if (conn === undefined || !conn.ready) {
        logger.warn(`sync chrome: no ready connection for client=${clientId}, frame dropped`)
        return
      }
      const sessionId = sessionOf(conn.id, frame)
      if (sessionId === undefined) {
        logger.warn(`sync chrome: no session for a frame to client=${clientId}, frame dropped`)
        return
      }
      try {
        conn.emit('sync.frame', { sessionId, frame })
      } catch (error) {
        logger.error(`sync chrome: send failed client=${clientId}: ${errorText(error)}`)
      }
    },

    onClientGone(clientId: string, callback: () => void): () => void {
      const conn = connectionOf(clientId)
      if (conn === undefined || !conn.ready) {
        const connId = chromeConnIdOf(clientId)
        return goneLater(() => {
          if (connId !== undefined) forgetAgentRoots(connId)
          callback()
        })
      }
      let done = false
      let unregister: (() => void) | undefined
      const detach = (): void => {
        const stop = unregister
        unregister = undefined
        stop?.()
      }
      unregister = deps.connections.onClosed((closed) => {
        if (closed !== conn || done) return
        done = true
        detach()
        forgetAgentRoots(conn.id)
        callback()
      })
      return () => {
        if (done) return
        done = true
        detach()
      }
    }
  }
}

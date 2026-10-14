/**
 * 网络客户端的视图同步链路（server mode phase B，docs/server/phase-bc-network-and-web.md §B2）—— 与桌面窗口的
 * `frontend/sync/ipcLink.ts` 同一套规矩，只是传输换成 WebSocket 上的 `{t:'sync', link, frame}` 消息：
 *
 *  - **建链路**：一条链路 id 的第一帧必须是 chord 的 `hello`，否则丢掉（多半是一条已经收掉的链路的迟到帧）；同一个
 *    id 再来一个 `hello`（客户端重新开始了）→ 旧的那条收掉、建新的。每条连接的链路数有上限。
 *  - **主体**：`{kind:'network', clientId, remoteAddress}`，由这里盖章（取自连接，客户端自己说了不算）；能看什么由
 *    `registerViewAuthorizer('network', …)` 决定（这一轮按裁决没有认证：什么都能看，与桌面窗口一样）。
 *  - **收链路**：连接关掉 → 它上面的链路全部结束（不发 bye：对面已经不在了），chord 随之放掉经它们的全部持有。
 *  - 发帧时连接已经关了 → 链路以 `transport error` 结束（不抛给 chord）。
 */
import { FrameLink, type ViewPrincipal } from '@shuvix/agent-runtime'
import type { Link } from '@earendil-works/chord'
import { MAX_ENVELOPE_LINK_CHARS } from '../../../shared/networkEnvelope'

/** 网络客户端链路主体的 kind */
export const NETWORK_PRINCIPAL_KIND = 'network'

/** 一条连接最多同时开几条链路（页面正常只有一条；多出来的是重连途中） */
export const MAX_LINKS_PER_NETWORK_CONNECTION = 16

/** 链路要的那一点连接 */
export interface NetworkLinkConnection {
  /** `ws:<n>` */
  readonly id: string
  readonly remoteAddress: string
  isOpen(): boolean
  /** 发一帧（连接已经关了时可以抛：链路据此结束） */
  sendSync(link: string, frame: unknown): void
}

export interface NetworkLinkLogger {
  warn(message: string): void
}

export interface NetworkLinkHub {
  /** 客户端发来的一帧 */
  receive(connection: NetworkLinkConnection, linkId: unknown, frame: unknown): void
  /** 连接关掉：它上面的链路全部结束 */
  closeConnection(connectionId: string, reason?: string): void
  /** 此刻开着的链路数（某条连接的 / 全部） */
  linkCount(connectionId?: string): number
}

export interface NetworkLinkHubDeps {
  /** 把一条新链路交给视图服务端 */
  readonly accept: (link: Link, principal: ViewPrincipal) => void
  readonly logger?: NetworkLinkLogger
  readonly maxLinksPerConnection?: number
}

const isFrameObject = (value: unknown): value is { t?: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function createNetworkLinkHub(deps: NetworkLinkHubDeps): NetworkLinkHub {
  const logger = deps.logger ?? { warn: () => {} }
  const max = deps.maxLinksPerConnection ?? MAX_LINKS_PER_NETWORK_CONNECTION
  const byConnection = new Map<string, Map<string, FrameLink>>()

  function open(connection: NetworkLinkConnection, linkId: string): FrameLink | undefined {
    let links = byConnection.get(connection.id)
    if (links === undefined) {
      links = new Map()
      byConnection.set(connection.id, links)
    }
    if (links.size >= max) {
      logger.warn(
        `view sync: network client ${connection.id} already has ${links.size} links; refused ${linkId}`
      )
      return undefined
    }
    const owned = links
    const link = new FrameLink(
      (frame) => {
        if (!connection.isOpen()) throw new Error('network client disconnected')
        connection.sendSync(linkId, frame)
      },
      () => {
        if (owned.get(linkId) === link) owned.delete(linkId)
        if (owned.size === 0 && byConnection.get(connection.id) === owned) {
          byConnection.delete(connection.id)
        }
      }
    )
    owned.set(linkId, link)
    deps.accept(link, {
      kind: NETWORK_PRINCIPAL_KIND,
      clientId: connection.id,
      remoteAddress: connection.remoteAddress
    })
    return link
  }

  return {
    receive(connection, linkId, frame) {
      if (
        typeof linkId !== 'string' ||
        linkId.length === 0 ||
        linkId.length > MAX_ENVELOPE_LINK_CHARS
      ) {
        return
      }
      if (!isFrameObject(frame) || !connection.isOpen()) return
      let link = byConnection.get(connection.id)?.get(linkId)
      if (frame.t === 'hello') {
        // 同一个 id 再来一个 hello：客户端重新开始了 —— 旧的那条收掉（不发 bye：对面就是新的这条）
        link?.ended('superseded by a new hello')
        link = open(connection, linkId)
      }
      // 没有 hello 打头的帧：一条已经收掉的链路的迟到帧，丢掉
      link?.deliver(frame)
    },

    closeConnection(connectionId, reason = 'network client disconnected') {
      const links = byConnection.get(connectionId)
      if (links === undefined) return
      byConnection.delete(connectionId)
      for (const link of [...links.values()]) link.ended(reason)
      links.clear()
    },

    linkCount(connectionId) {
      if (connectionId !== undefined) return byConnection.get(connectionId)?.size ?? 0
      let total = 0
      for (const links of byConnection.values()) total += links.size
      return total
    }
  }
}

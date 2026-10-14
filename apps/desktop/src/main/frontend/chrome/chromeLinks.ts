/**
 * Chrome 侧边栏的视图同步链路（pi 1.2 / chord2）—— **每个侧边栏一条（或先后几条）链路**：一条桥连接上有好几个
 * 侧边栏，帧又是不透明的（SW 不解析），所以链路不能整条连接共用。帧是两个方向的桥事件
 * `sync.link {panelId, link, frame}`（`panelId` = 侧边栏端口名 `panel:<tabId>`，SW 按它把桌面的帧送回那个侧边栏；
 * `link` = 侧边栏为这条链路现取的 id）。
 *
 *  - **建链路**：一条链路 id 的第一帧必须是 chord 的 `hello`，否则丢掉；同一个 id 再来一个 `hello` → 旧的收掉、建新的。
 *    主体 `{kind:'chrome', installId, runId, connId, tabId}` 由这里盖章（取自握手过的连接，侧边栏自己说了不算）；
 *    能看什么由 Chrome 前端登记的核对决定（`index.ts`：只能看这个浏览器这一轮的标签页会话）。
 *  - **收链路**：侧边栏端口断开时 SW 替它在它用过的每条链路上补一帧 `bye`（chord 的 FrameLink 收到即结束）；
 *    桥连接断开 → 这条连接上的链路全部结束（`closeConnection`，不发 bye：对面已经不在了）。
 *  - **分片**：桌面发往扩展的帧超过原生消息上限时由桥连接自己分片（`BridgeConnection.send`），这里不管。
 *  - 发帧时连接不在 / 没就绪 → 链路以 `transport error` 结束（不抛给 chord）。每条连接的链路数有上限。
 */
import { FrameLink, type ViewPrincipal } from '@shuvix/agent-runtime'
import type { Link } from '@earendil-works/chord'
import {
  chromePanelTabId,
  type DesktopEventMap,
  type SyncLinkEvent
} from '@shuvix/chat-protocol/chromeBridge'

/** 一条桥连接最多同时开几条链路（每个侧边栏正常一条） */
export const MAX_LINKS_PER_CONNECTION = 256

/** 链路 id 的长度上限 */
const MAX_LINK_ID_CHARS = 200

/** 链路要的那一点桥连接（`BridgeConnection` 满足它） */
export interface ChromeLinkConnection {
  readonly id: string
  readonly ready: boolean
  readonly info?: { readonly installId: string; readonly runId: string }
  emit<N extends keyof DesktopEventMap>(name: N, params: DesktopEventMap[N]): void
}

export interface ChromeLinkLogger {
  warn(message: string): void
}

export interface ChromeLinkHub {
  /** 扩展发来的一条 `sync.link` 事件 */
  receive(conn: ChromeLinkConnection, params: unknown): void
  /** 桥连接断开：它上面的链路全部结束 */
  closeConnection(connId: string): void
  /** 此刻开着的链路数（某条连接的 / 全部） */
  linkCount(connId?: string): number
}

export interface ChromeLinkHubDeps {
  readonly accept: (link: Link, principal: ViewPrincipal) => void
  readonly logger?: ChromeLinkLogger
  readonly maxLinksPerConnection?: number
}

const isFrameObject = (value: unknown): value is { t?: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function createChromeLinkHub(deps: ChromeLinkHubDeps): ChromeLinkHub {
  const logger = deps.logger ?? { warn: () => {} }
  const max = deps.maxLinksPerConnection ?? MAX_LINKS_PER_CONNECTION
  /**
   * 连接 id → （侧边栏 + 链路 id）→ 链路。键里带上侧边栏：一条连接上的几个侧边栏各自只能寻址自己的链路，
   * 不能往别的侧边栏的链路里塞帧或替它发 bye
   */
  const byConnection = new Map<string, Map<string, FrameLink>>()
  const linkKey = (panelId: string, linkId: string): string => `${panelId}\u0000${linkId}`

  function open(
    conn: ChromeLinkConnection,
    links: Map<string, FrameLink>,
    panelId: string,
    tabId: number,
    linkId: string
  ): FrameLink | undefined {
    const info = conn.info
    if (info === undefined) return undefined
    if (links.size >= max) {
      logger.warn(`view sync: connection ${conn.id} already has ${links.size} links; refused one`)
      return undefined
    }
    const link = new FrameLink(
      (frame) => {
        if (!conn.ready) throw new Error('Chrome is not connected')
        const event: SyncLinkEvent = { panelId, link: linkId, frame }
        conn.emit('sync.link', event)
      },
      () => {
        if (links.get(linkKey(panelId, linkId)) === link) links.delete(linkKey(panelId, linkId))
      }
    )
    links.set(linkKey(panelId, linkId), link)
    deps.accept(link, {
      kind: 'chrome',
      installId: info.installId,
      runId: info.runId,
      connId: conn.id,
      tabId
    })
    return link
  }

  return {
    receive(conn, params) {
      const p = (params ?? {}) as { panelId?: unknown; link?: unknown; frame?: unknown }
      const tabId = chromePanelTabId(p.panelId)
      const linkId = p.link
      if (tabId === undefined || typeof p.panelId !== 'string') return
      if (typeof linkId !== 'string' || linkId.length === 0 || linkId.length > MAX_LINK_ID_CHARS) {
        return
      }
      if (!isFrameObject(p.frame) || !conn.ready || conn.info === undefined) return
      let link = byConnection.get(conn.id)?.get(linkKey(p.panelId, linkId))
      if (p.frame.t === 'hello') {
        // 同一个 id 再来一个 hello：侧边栏重新开始了 —— 旧的那条收掉（不发 bye：对面就是新的这条）
        link?.ended('superseded by a new hello')
        let links = byConnection.get(conn.id)
        if (links === undefined) {
          links = new Map()
          byConnection.set(conn.id, links)
        }
        link = open(conn, links, p.panelId, tabId, linkId)
      }
      // 没有 hello 打头的帧：一条已经收掉的链路的迟到帧（或 SW 替关掉的侧边栏补的 bye），丢掉
      link?.deliver(p.frame)
    },
    closeConnection(connId) {
      const links = byConnection.get(connId)
      if (links === undefined) return
      byConnection.delete(connId)
      for (const link of [...links.values()]) link.ended('Chrome disconnected')
      links.clear()
    },
    linkCount(connId) {
      if (connId !== undefined) return byConnection.get(connId)?.size ?? 0
      let total = 0
      for (const links of byConnection.values()) total += links.size
      return total
    }
  }
}

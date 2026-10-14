/**
 * 视图同步的桌面窗口链路（pi 1.2 / chord2）—— 每个渲染进程窗口（webContents）上的每条 chord 链路一个
 * `FrameLink`，交给视图服务端（主体 `{kind:'window', webContentsId}`）。本模块不碰 Electron：webContents 由
 * `ipc/syncHandlers` 在收到帧时交进来。
 *
 *  - **帧**：渲染端 `ipcRenderer.send('sync:frame', link, frame)` → `receive(sender, link, frame)`；服务端发出的帧
 *    `webContents.send('sync:frame', link, frame)`。`link` 是渲染端为每条链路现取的 id（重连换新的），所以旧链路
 *    迟到的帧落不进新链路，同一个窗口里也可以有几条链路（e2e 探针）。
 *  - **建链路**：一条链路 id 的第一帧必须是 chord 的 `hello`，否则丢掉（多半是一条已经收掉的链路的迟到帧）。同一个
 *    id 再来一个 `hello`（客户端重新开始了）→ 旧的那条收掉、建新的。每个窗口的链路数有上限。
 *  - **客户端离开**（PIN-02 / P3-08 的规则不变）：webContents `destroyed`、渲染进程没了（`render-process-gone`）、
 *    主框架跨文档导航**落定**（`did-navigate` —— 重载 / 换页）→ 这个窗口的链路全部结束（不发 bye：页面已经没了），
 *    chord 随之放掉经它们的全部持有、钉住松开。**不听 `did-start-navigation`**：导航开始了不等于页面换了 ——
 *    外部链接闸在 `will-navigate` 里拦下的导航照样先报 start（chat-markdown-sanitize 点一个 `href=""` 的链接复现）。
 *  - 发帧时 webContents 已经销毁 / `send` 抛错 → 链路以 `transport error` 结束（不抛给 chord）。
 */
import { FrameLink, type ViewPrincipal } from '@shuvix/agent-runtime'
import type { Link } from '@earendil-works/chord'

/** 视图同步帧的 IPC 通道（两个方向同名：渲染端 send，主进程 webContents.send） */
export const SYNC_FRAME_CHANNEL = 'sync:frame'

/** 一个窗口最多同时开几条链路（渲染端正常只有一条；多出来的是 e2e 探针 / 重连途中） */
export const MAX_LINKS_PER_WINDOW = 16

/** 链路 id 的长度上限 */
const MAX_LINK_ID_CHARS = 200

type Listener = (...args: any[]) => void // eslint-disable-line @typescript-eslint/no-explicit-any

/** 链路要的那一点 webContents（Electron 的 WebContents 满足它；测试给假的） */
export interface SyncWebContents {
  readonly id: number
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
  on(event: string, listener: Listener): unknown
  removeListener(event: string, listener: Listener): unknown
}

/** 日志口（主进程 logger 满足它） */
export interface SyncLinkLogger {
  warn(message: string): void
}

export interface IpcLinkHub {
  /** 渲染端发来的一帧 */
  receive(sender: SyncWebContents, linkId: unknown, frame: unknown): void
  /** 此刻开着的链路数（某个窗口的 / 全部） */
  linkCount(webContentsId?: number): number
}

export interface IpcLinkHubDeps {
  /** 把一条新链路交给视图服务端 */
  readonly accept: (link: Link, principal: ViewPrincipal) => void
  readonly logger?: SyncLinkLogger
  readonly maxLinksPerWindow?: number
}

interface WindowLinks {
  readonly contents: SyncWebContents
  readonly links: Map<string, FrameLink>
  readonly detach: () => void
}

const isFrameObject = (value: unknown): value is { t?: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function createIpcLinkHub(deps: IpcLinkHubDeps): IpcLinkHub {
  const logger = deps.logger ?? { warn: () => {} }
  const max = deps.maxLinksPerWindow ?? MAX_LINKS_PER_WINDOW
  const windows = new Map<number, WindowLinks>()

  /** 这个窗口的链路全部结束（页面没了），监听器摘掉 */
  function closeWindow(id: number, reason: string): void {
    const entry = windows.get(id)
    if (entry === undefined) return
    windows.delete(id)
    entry.detach()
    for (const link of [...entry.links.values()]) link.ended(reason)
    entry.links.clear()
  }

  function windowOf(contents: SyncWebContents): WindowLinks | undefined {
    const existing = windows.get(contents.id)
    if (existing !== undefined && existing.contents === contents) return existing
    if (existing !== undefined) closeWindow(contents.id, 'webContents replaced')
    let destroyed = true
    try {
      destroyed = contents.isDestroyed()
    } catch {
      destroyed = true
    }
    if (destroyed) return undefined
    const id = contents.id
    const onDestroyed: Listener = () => closeWindow(id, 'webContents destroyed')
    const onProcessGone: Listener = () => closeWindow(id, 'render process gone')
    // `did-navigate` 只报主框架的跨文档导航落定（页内导航是 did-navigate-in-page，子框架是 did-frame-navigate）
    const onNavigation: Listener = () => closeWindow(id, 'page navigated')
    contents.on('destroyed', onDestroyed)
    contents.on('render-process-gone', onProcessGone)
    contents.on('did-navigate', onNavigation)
    const entry: WindowLinks = {
      contents,
      links: new Map(),
      detach: () => {
        contents.removeListener('destroyed', onDestroyed)
        contents.removeListener('render-process-gone', onProcessGone)
        contents.removeListener('did-navigate', onNavigation)
      }
    }
    windows.set(id, entry)
    return entry
  }

  function open(entry: WindowLinks, linkId: string): FrameLink | undefined {
    if (entry.links.size >= max) {
      logger.warn(
        `view sync: window ${entry.contents.id} already has ${entry.links.size} links; refused ${linkId}`
      )
      return undefined
    }
    const contents = entry.contents
    const link = new FrameLink(
      (frame) => {
        if (contents.isDestroyed()) throw new Error('webContents destroyed')
        contents.send(SYNC_FRAME_CHANNEL, linkId, frame)
      },
      () => {
        if (entry.links.get(linkId) === link) entry.links.delete(linkId)
      }
    )
    entry.links.set(linkId, link)
    deps.accept(link, { kind: 'window', webContentsId: contents.id })
    return link
  }

  return {
    receive(sender, linkId, frame) {
      if (typeof linkId !== 'string' || linkId.length === 0 || linkId.length > MAX_LINK_ID_CHARS) {
        return
      }
      if (!isFrameObject(frame)) return
      const entry = windowOf(sender)
      if (entry === undefined) return
      let link = entry.links.get(linkId)
      if (frame.t === 'hello') {
        // 同一个 id 再来一个 hello：客户端重新开始了 —— 旧的那条收掉（不发 bye：对面就是新的这条）
        link?.ended('superseded by a new hello')
        link = open(entry, linkId)
      }
      // 没有 hello 打头的帧：一条已经收掉的链路的迟到帧，丢掉
      link?.deliver(frame)
    },
    linkCount(webContentsId) {
      if (webContentsId !== undefined) return windows.get(webContentsId)?.links.size ?? 0
      let total = 0
      for (const entry of windows.values()) total += entry.links.size
      return total
    }
  }
}

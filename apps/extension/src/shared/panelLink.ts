/**
 * 侧边栏 ⇄ service worker 的消息（`chrome.runtime.connect` 端口，名字 `panel:<tabId>`）。
 *
 * 扩展里只有 SW 握着那条原生消息端口（通向本地组件与桌面）；每个标签页的侧边栏各开一条端口连 SW，
 * SW 替它们转发请求、按会话把事件分发回去。所以侧边栏看到的状态也由 SW 给：连没连上桌面、为什么没连上。
 */
import { CHROME_PANEL_ID_PREFIX, type PanelRequestMap } from '@shuvix/chat-protocol/chromeBridge'

/** 端口名前缀（后接标签页 id）—— 也是视图同步链路帧上的 `panelId` 的形状 */
export const PANEL_PORT_PREFIX = CHROME_PANEL_ID_PREFIX

/**
 * 侧边栏能用不能用：
 *  - `connecting`：正在连本地组件、或本地组件连上桌面后正在握手；
 *  - `host-missing`：Chrome 找不到本地组件（ShuviX 桌面没装、或装了还没启动过一次）；
 *  - `desktop-offline`：本地组件在，桌面没在运行；
 *  - `mismatch`：扩展与桌面的协议版本对不上（要更新扩展或桌面）；
 *  - `ready`：可以对话。
 */
export type PanelLinkState =
  | 'connecting'
  | 'host-missing'
  | 'desktop-offline'
  | 'mismatch'
  /** 桌面那边这个扩展安装已经有一条活着的连接了（见 BRIDGE_ERROR_ALREADY_CONNECTED） */
  | 'already-connected'
  | 'ready'

export type PanelMethod = keyof PanelRequestMap

export type PanelToWorker =
  | {
      kind: 'request'
      id: number
      method: PanelMethod
      params: unknown
    }
  /**
   * 视图同步链路上的一帧（pi 1.2 / chord2）：SW 原样转给桌面（桥事件 `sync.link {panelId, link, frame}`，
   * `panelId` 由 SW 按端口名补上），不解析 `frame`
   */
  | { kind: 'sync.link'; link: string; frame: unknown }

export type WorkerToPanel =
  | { kind: 'status'; state: PanelLinkState }
  | { kind: 'response'; id: number; ok: boolean; result?: unknown; error?: string }
  | { kind: 'chat.event'; event: unknown }
  | { kind: 'app.event'; event: unknown }
  /** 视图同步链路上桌面发来的一帧（只发给那条链路所在的侧边栏） */
  | { kind: 'sync.link'; link: string; frame: unknown }

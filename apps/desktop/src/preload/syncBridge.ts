/**
 * `window.api.sync` —— 视图同步的渲染进程一侧（pi 1.2 / chord2；`SessionChannelApi.sync`，一个 `SyncLinkChannel`）。
 *
 *  - `send(link, frame)` → `ipcRenderer.send('sync:frame', link, frame)`（单向；chord 自己在链路上做应答）；
 *  - `onFrame(cb)` → 每次订阅挂一个 `sync:frame` 监听，只把（链路 id，帧）交给回调（不带 IPC 事件）；注销只摘
 *    自己那个，重复注销无事。
 *
 * 桌面窗口的传输永远在（主进程不会先于窗口走），所以没有 `onDown` / `onUp` / `isUp`：主进程那头关掉一条链路时
 * 会在链路上发 chord 的 `bye`，客户端据此结束它。
 *
 * 抽成工厂（PIN-08）是为了能拿假的 ipcRenderer 测：本模块不 import electron。
 */
import type { JsonValue, SyncLinkChannel } from '@shuvix/chat-protocol/sync'

const SYNC_FRAME_CHANNEL = 'sync:frame'

/** 工厂要的那一点 ipcRenderer（Electron 的 IpcRenderer 满足它） */
export interface SyncIpcRenderer {
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

export function createSyncBridge(ipcRenderer: SyncIpcRenderer): SyncLinkChannel {
  return {
    send(link: string, frame: JsonValue): void {
      ipcRenderer.send(SYNC_FRAME_CHANNEL, link, frame)
    },

    onFrame(callback: (link: string, frame: JsonValue) => void): () => void {
      const handler = (_event: unknown, link: unknown, frame: unknown): void => {
        if (typeof link === 'string') callback(link, frame as JsonValue)
      }
      ipcRenderer.on(SYNC_FRAME_CHANNEL, handler)
      let attached = true
      return () => {
        if (!attached) return
        attached = false
        ipcRenderer.removeListener(SYNC_FRAME_CHANNEL, handler)
      }
    }
  }
}

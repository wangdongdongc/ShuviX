/**
 * `window.api.sync` —— 视图同步的渲染进程一侧（phase 3，P3-05；`SessionChannelApi.sync`）。
 *
 *  - `invoke(target, call)` → `ipcRenderer.invoke('sync:invoke', target, call)`；主进程总是 resolve 一个
 *    信封（PIN-01），`ok:false` 在这里再抛成带 `.code` 的 Error（`service_not_found` 等 chord 错误码由此
 *    原样到达 chord 的绑定）。
 *  - `onFrame(cb)` → 每次订阅挂一个 `sync:frame` 监听，只把帧交给回调（不带 IPC 事件）；注销只摘自己那个，
 *    重复注销无事。
 *
 * 抽成工厂（PIN-08）是为了能拿假的 ipcRenderer 测：本模块不 import electron。
 */
import {
  syncInvokeError,
  type JsonValue,
  type SyncChannel,
  type SyncFrame,
  type SyncInvokeResult,
  type SyncTarget
} from '@shuvix/chat-protocol/sync'

const SYNC_INVOKE_CHANNEL = 'sync:invoke'
const SYNC_FRAME_CHANNEL = 'sync:frame'

/** 工厂要的那一点 ipcRenderer（Electron 的 IpcRenderer 满足它） */
export interface SyncIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

export function createSyncBridge(ipcRenderer: SyncIpcRenderer): SyncChannel {
  return {
    async invoke(target: SyncTarget, call: JsonValue): Promise<JsonValue | undefined> {
      const result = (await ipcRenderer.invoke(SYNC_INVOKE_CHANNEL, target, call)) as
        | SyncInvokeResult
        | undefined
      if (result === undefined || result === null || typeof result !== 'object') {
        throw syncInvokeError({ message: 'Malformed sync reply' })
      }
      if (result.ok) return result.value
      throw syncInvokeError(result.error)
    },

    onFrame(callback: (frame: SyncFrame) => void): () => void {
      const handler = (_event: unknown, frame: unknown): void => callback(frame as SyncFrame)
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

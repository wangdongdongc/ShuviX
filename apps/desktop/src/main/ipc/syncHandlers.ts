import { ipcMain } from 'electron'
import {
  createIpcLinkHub,
  SYNC_FRAME_CHANNEL,
  type IpcLinkHub,
  type SyncWebContents
} from '../frontend/sync/ipcLink'
import { getSyncHub } from '../frontend/sync/syncWiring'
import { createLogger } from '../logger'

const log = createLogger('SyncIpc')

/** 注册要的那一点 ipcMain（测试给假的） */
export interface SyncIpcMain {
  on(
    channel: string,
    listener: (event: { sender: SyncWebContents }, ...args: unknown[]) => void
  ): unknown
}

let hub: IpcLinkHub | undefined

/** 桌面窗口的链路表（懒建：第一帧才建，连带视图服务端） */
function ipcLinks(): IpcLinkHub {
  hub ??= createIpcLinkHub({
    accept: (link, principal) => getSyncHub().accept(link, principal),
    logger: log
  })
  return hub
}

/**
 * 视图同步的 IPC（pi 1.2 / chord2）：渲染端的 chord 链路帧 `sync:frame(link, frame)` 交给窗口链路表
 * （`frontend/sync/ipcLink`，主体 = 发送方 webContents），服务端的帧经 `webContents.send('sync:frame', link, frame)`
 * 推回。没有一问一答的调用了（phase 3 的 `sync:invoke` 已删）。
 *
 * 注册本身不建服务端、不建宿主（PIN-12）：第一帧到了才建。
 */
export function registerSyncHandlers(ipc: SyncIpcMain = ipcMain as unknown as SyncIpcMain): void {
  ipc.on(SYNC_FRAME_CHANNEL, (event, linkId, frame) => {
    try {
      ipcLinks().receive(event.sender, linkId, frame)
    } catch (error) {
      log.warn(`sync frame from webContents ${event.sender?.id} failed: ${String(error)}`)
    }
  })
}

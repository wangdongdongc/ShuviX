import { createIpcLinkHub, type IpcLinkHub } from '../frontend/sync/ipcLink'
import { getSyncHub } from '../frontend/sync/syncWiring'
import { createLogger } from '../logger'
import { defineListener } from './registry'
import { webContentsOf } from './ipcAdapter'

const log = createLogger('SyncIpc')

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
 * （`frontend/sync/ipcLink`，主体 = 发送方 webContents —— `webContentsOf(ctx)` 就是 IPC 的 `event.sender`），
 * 服务端的帧经 `webContents.send('sync:frame', link, frame)` 推回。没有一问一答的调用了（phase 3 的
 * `sync:invoke` 已删）。通道名与 `ipcLink.SYNC_FRAME_CHANNEL` 相同（这里写字面量，通道守卫按字面量核对）。
 *
 * 注册本身不建服务端、不建宿主（PIN-12）：第一帧到了才建。
 */
export function registerSyncHandlers(): void {
  defineListener('sync:frame', (ctx, linkId, frame) => {
    let sender: ReturnType<typeof webContentsOf>
    try {
      sender = webContentsOf(ctx)
      if (!sender) throw new Error('the frame has no sender webContents')
      ipcLinks().receive(sender, linkId, frame)
    } catch (error) {
      log.warn(`sync frame from webContents ${sender?.id} failed: ${String(error)}`)
    }
  })
}

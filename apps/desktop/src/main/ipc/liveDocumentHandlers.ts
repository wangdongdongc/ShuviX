import { defineHandler } from './registry'
import { webContentsOf } from './ipcAdapter'
import type { LiveDocResult } from '@shuvix/chat-protocol/liveDocument'
import { resolveLiveDocumentResponse } from '../services/liveDocumentBridge'

/**
 * 协作编辑 IPC —— 只有回程这一条。
 *
 * 去程（`liveDoc:request` / `liveDoc:cancel`）是主进程直接发给开着那份文档的窗口；这里接它的答复。
 * 是不是那个窗口在答，由 liveDocumentBridge 按调用方的 webContents（IPC 的 `event.sender`）核对。
 */
export function registerLiveDocumentHandlers(): void {
  defineHandler('liveDoc:respond', (ctx, params: { requestId: string; result: LiveDocResult }) => {
    const sender = webContentsOf(ctx)
    // 请求只发给开着那份文档的窗口；网络客户端从来不是（这一阶段）—— 它的答复不认
    if (!sender) return { success: false }
    resolveLiveDocumentResponse(sender, params.requestId, params.result)
    return { success: true }
  })
}

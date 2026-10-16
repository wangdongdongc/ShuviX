import { defineHandler } from './registry'
import { webContentsOf } from './ipcAdapter'
import type { LiveDocResult } from '@shuvix/chat-protocol/liveDocument'
import {
  attachLiveDocument,
  detachLiveDocument,
  resolveLiveDocumentResponse
} from '../services/liveDocumentBridge'

/**
 * 协作编辑 IPC —— 编辑器的挂接 / 摘下，和回程。
 *
 * 去程（`liveDoc:request` / `liveDoc:cancel`）是主进程直接发给显示着那份文档的编辑器所在的窗口；
 * 是不是那个窗口在答，由 liveDocumentBridge 按调用方的 webContents（IPC 的 `event.sender`）核对。
 * 网络客户端没有 webContents：挂不上（它开着的笔记本走磁盘回落），答复也不认。
 */
export function registerLiveDocumentHandlers(): void {
  defineHandler('liveDoc:attach', (ctx, params: { sessionId: string; attachId: string }) => {
    const sender = webContentsOf(ctx)
    if (!sender || !params?.sessionId || !params.attachId) return { success: false }
    attachLiveDocument(params.sessionId, sender, params.attachId)
    return { success: true }
  })
  defineHandler('liveDoc:detach', (ctx, params: { sessionId: string; attachId: string }) => {
    const sender = webContentsOf(ctx)
    if (!sender || !params?.sessionId || !params.attachId) return { success: false }
    // 只摘调用方自己挂的那一个
    detachLiveDocument(params.sessionId, params.attachId, sender)
    return { success: true }
  })
  defineHandler('liveDoc:respond', (ctx, params: { requestId: string; result: LiveDocResult }) => {
    const sender = webContentsOf(ctx)
    // 请求只发给显示着那份文档的窗口；网络客户端从来不是 —— 它的答复不认
    if (!sender) return { success: false }
    resolveLiveDocumentResponse(sender, params.requestId, params.result)
    return { success: true }
  })
}

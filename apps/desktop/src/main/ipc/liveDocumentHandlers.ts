import { ipcMain } from 'electron'
import type { LiveDocResult } from '@shuvix/chat-protocol/liveDocument'
import { resolveLiveDocumentResponse } from '../services/liveDocumentBridge'

/**
 * 协作编辑 IPC —— 只有回程这一条。
 *
 * 去程（`liveDoc:request` / `liveDoc:cancel`）是主进程直接发给开着那份文档的窗口；这里接它的答复。
 * 是不是那个窗口在答，由 liveDocumentBridge 按 `event.sender` 核对。
 */
export function registerLiveDocumentHandlers(): void {
  ipcMain.handle(
    'liveDoc:respond',
    (event, params: { requestId: string; result: LiveDocResult }) => {
      resolveLiveDocumentResponse(event.sender, params.requestId, params.result)
      return { success: true }
    }
  )
}

import { ipcMain, webContents } from 'electron'
import type { SyncHub } from '@shuvix/agent-runtime'
import type { SyncInvokeResult } from '@shuvix/chat-protocol/sync'
import { clientIdOf, IPC_CLIENT_PREFIX, type SyncIpcEvent } from '../frontend/sync/clientIdentity'
import { createIpcSyncTransport, type SyncWebContents } from '../frontend/sync/ipcSyncTransport'
import { getSyncHub, syncTransport } from '../frontend/sync/syncWiring'
import { createLogger } from '../logger'

const log = createLogger('SyncIpc')

/** 渲染进程 → 主进程的同步调用通道（preload 的 `sync.invoke`） */
export const SYNC_INVOKE_CHANNEL = 'sync:invoke'

/** 注册要的那一点 ipcMain（测试给假的） */
export interface SyncIpcMain {
  handle(
    channel: string,
    listener: (event: SyncIpcEvent, ...args: unknown[]) => unknown
  ): void
}

export interface SyncHandlerOptions {
  /** hub（缺省：主进程单例，第一次调用时才建） */
  readonly hub?: () => Pick<SyncHub, 'invoke'>
  /** webContents id → webContents（缺省：`webContents.fromId`） */
  readonly lookup?: (webContentsId: number) => SyncWebContents | undefined
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * 视图同步的 IPC（phase 3，P3-05）：
 *  - `sync:invoke(target, call)` → `hub.invoke('ipc:<webContentsId>', target, call)`。回复总是
 *    **resolve** 一个信封（PIN-01）：`{ok:true, value}` / `{ok:false, error:{code, message}}` ——
 *    `ipcMain.handle` 的拒绝只把 `message` 带过去，chord 的错误码（`service_not_found` …）会丢。
 *  - 帧经 `webContents.send('sync:frame', frame)` 推回（路由传输的 `ipc` 那条，在这里挂上）。
 *
 * 注册本身不建 hub、不建宿主（PIN-12）：hub 在第一次调用时才建。
 */
export function registerSyncHandlers(
  ipc: SyncIpcMain = ipcMain as unknown as SyncIpcMain,
  options: SyncHandlerOptions = {}
): void {
  const lookup =
    options.lookup ??
    ((id: number): SyncWebContents | undefined => webContents.fromId(id) ?? undefined)
  syncTransport.addRoute(IPC_CLIENT_PREFIX, createIpcSyncTransport({ lookup, logger: log }))
  const hubOf = options.hub ?? getSyncHub

  ipc.handle(SYNC_INVOKE_CHANNEL, async (event, target, call): Promise<SyncInvokeResult> => {
    try {
      const value = await hubOf().invoke(clientIdOf(event), target, call)
      return { ok: true, value }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = codeOf(error)
      return { ok: false, error: code === undefined ? { message } : { code, message } }
    }
  })
}

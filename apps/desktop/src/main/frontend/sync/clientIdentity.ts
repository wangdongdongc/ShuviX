/**
 * 视图同步的客户端身份（phase 3，P3-05；plan §C、Q-P3-13）。
 *
 * 一个客户端 = 一个能收帧的前端：`ipc:<webContentsId>`（桌面的一个渲染进程窗口）、`chrome:<connId>`
 * （Chrome 侧边栏的一条连接，P3-09）、之后的 `ws:<id>`。前缀决定帧走哪条传输（`ipcSyncTransport` 的
 * 路由传输按它分流）。
 *
 * 只给同步通道（与询问的审计，P3-08）用；其余按 `event.sender` 认人的 IPC 处理器留到 phase 5。
 */

/** 桌面渲染进程（webContents）的客户端前缀 */
export const IPC_CLIENT_PREFIX = 'ipc'

/** IPC 事件里认人只用的那一点：发送方 webContents 的 id */
export interface SyncIpcEvent {
  readonly sender: { readonly id: number }
}

/** 某个 webContents 的客户端 id */
export function ipcClientId(webContentsId: number): string {
  return `${IPC_CLIENT_PREFIX}:${webContentsId}`
}

/**
 * IPC 调用方的客户端 id：只读 `event.sender.id`（不看 `senderFrame` / `processId` —— 帧发给的是整个
 * webContents；渲染进程重载之后 id 不变，重载另由传输报成「客户端离开」）。
 */
export function clientIdOf(event: SyncIpcEvent): string {
  return ipcClientId(event.sender.id)
}

/** 拆开一个客户端 id：`<前缀>:<其余>`；没有冒号、前缀或其余为空 → undefined */
export function parseClientId(clientId: string): { prefix: string; rest: string } | undefined {
  if (typeof clientId !== 'string') return undefined
  const colon = clientId.indexOf(':')
  if (colon <= 0 || colon === clientId.length - 1) return undefined
  return { prefix: clientId.slice(0, colon), rest: clientId.slice(colon + 1) }
}

/** `ipc:<id>` → webContents id；不是 IPC 客户端，或 id 不是非负整数 → undefined */
export function webContentsIdOf(clientId: string): number | undefined {
  const parsed = parseClientId(clientId)
  if (parsed === undefined || parsed.prefix !== IPC_CLIENT_PREFIX) return undefined
  if (!/^[0-9]+$/.test(parsed.rest)) return undefined
  const id = Number(parsed.rest)
  return Number.isSafeInteger(id) ? id : undefined
}

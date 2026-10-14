/**
 * 主进程的通道注册表（server mode phase A，docs/server/phase-a-channel-registry.md §3）—— 渲染端能调的每条
 * 请求通道都在这里**定义一次**，与传输无关：
 *
 *  - `defineHandler(channel, (ctx, ...args) => result)` 取代 `ipcMain.handle`（一问一答）；
 *  - `defineListener(channel, (ctx, ...args) => void)` 取代 `ipcMain.on`（单向）。
 *
 * 处理函数拿到的第一个参数是 `ClientContext`：谁调的（`client`）、经哪条传输（`transport`）。桌面窗口走 `ipc`
 * （`ipc/ipcAdapter.ts`），局域网里的浏览器走 `network`（`frontend/network/`）—— 同一份定义由两条传输来服务。
 *
 * **传输**（`ClientTransport`）是挂上来的：`ipc/ipcAdapter.ts`（唯一碰 `ipcMain` 的地方）在主入口最早处
 * `attachTransport` —— 挂上时把已有的定义全部注册，之后的定义随来随注册，所以处理器注册到 Electron 的时机与
 * 定义的时机相同（`index.ts` 顶层的 `app:*` 仍在模块求值时注册，其余仍在 `registerIpcHandlers()` 里）。
 *
 * 往客户端推东西也经这里：`pushTo(client, …)`（回给某一个调用方，如登录过程、TTS 切片、终端输出）、
 * `onClientGone(client, cb)`（调用方没了）、`broadcastToClients(…)`（所有客户端，如 `app:event`）。
 *
 * 本模块不碰 Electron（所有主进程层都能引它：`utils/downloadManager` 也要广播 —— eslint 里它归 main-util）。
 */

/** 桌面渲染进程窗口（一个 webContents） */
export type WindowClientRef = {
  readonly kind: 'window'
  /** `ipc:<webContentsId>`（与 `frontend/sync/clientIdentity` 的 `ipcClientId` 同一个串） */
  readonly id: string
  readonly webContentsId: number
}

/**
 * 网络客户端（server mode phase B）：局域网里一个浏览器页面的一条 WebSocket 连接。它没有 Electron 窗口 ——
 * `windowOf` / `webContentsOf` 对它回 undefined，要窗口的处理函数按「没有窗口」作答
 * （见 docs/server/phase-bc-network-and-web.md §B2）。
 */
export type NetworkClientRef = {
  readonly kind: 'network'
  /** `ws:<n>`（每条连接一个，进程内不复用） */
  readonly id: string
  /** 对端地址（IPv4 映射的 IPv6 已拆开） */
  readonly remoteAddress: string
  /** 浏览器的 User-Agent（没有 → 空串） */
  readonly userAgent: string
}

/** 调用方：桌面窗口，或网络客户端 */
export type ClientRef = WindowClientRef | NetworkClientRef

/** 一次调用的上下文 */
export interface ClientContext {
  /** 谁调的 */
  readonly client: ClientRef
  /** 经哪条传输来的：`ipc`（桌面窗口）/ `network`（WebSocket） */
  readonly transport: 'ipc' | 'network'
}

/**
 * 处理函数的形状。参数是渲染端传来的（不可信、按通道约定标注类型）：用方法签名取双变，让 `(ctx, params: X)`
 * 这样标了具体类型的处理函数能直接交进来，没标的参数则是 `unknown`。
 */
export type ChannelHandler = {
  bivarianceHack(ctx: ClientContext, ...args: unknown[]): unknown
}['bivarianceHack']

export type ChannelListener = {
  bivarianceHack(ctx: ClientContext, ...args: unknown[]): void
}['bivarianceHack']

/** 一条定义：`handle` = 一问一答（渲染端 invoke），`listen` = 单向（渲染端 send） */
export type ChannelDefinition =
  | { readonly kind: 'handle'; readonly channel: string; readonly fn: ChannelHandler }
  | { readonly kind: 'listen'; readonly channel: string; readonly fn: ChannelListener }

/** 一条传输：把定义注册到自己的收端，并能把东西推回自己的客户端 */
export interface ClientTransport {
  /** 传输名（同名的传输只能挂一个） */
  readonly name: string
  /** 注册一条定义 */
  serve(definition: ChannelDefinition): void
  /** 这个客户端是不是本传输的 */
  owns(client: ClientRef): boolean
  /** 推给一个客户端；它已经没了就什么也不做 */
  pushTo(client: ClientRef, channel: string, payload: readonly unknown[]): void
  /** 客户端此刻还在不在 */
  isClientAlive(client: ClientRef): boolean
  /** 客户端没了时回调一次；返回撤掉监听的函数（客户端已经没了时撤销什么也不做） */
  onClientGone(client: ClientRef, callback: () => void): () => void
  /** 推给本传输的所有客户端 */
  broadcast(channel: string, payload: readonly unknown[]): void
}

const definitions = new Map<string, ChannelDefinition>()
const transports: ClientTransport[] = []

function define(definition: ChannelDefinition): void {
  if (definitions.has(definition.channel)) {
    throw new Error(`IPC channel "${definition.channel}" is already defined`)
  }
  definitions.set(definition.channel, definition)
  for (const transport of transports) transport.serve(definition)
}

/** 定义一条一问一答的通道（取代 `ipcMain.handle`）；同名重复定义抛错 */
export function defineHandler(channel: string, fn: ChannelHandler): void {
  define({ kind: 'handle', channel, fn })
}

/** 定义一条单向通道（取代 `ipcMain.on`）；同名重复定义抛错 */
export function defineListener(channel: string, fn: ChannelListener): void {
  define({ kind: 'listen', channel, fn })
}

/** 此刻的全部定义（按定义顺序） */
export function listDefinitions(): readonly ChannelDefinition[] {
  return [...definitions.values()]
}

/** 挂上一条传输：已有的定义全部交给它，之后的定义随来随交。同名传输挂第二次抛错 */
export function attachTransport(transport: ClientTransport): void {
  if (transports.some((t) => t.name === transport.name)) {
    throw new Error(`client transport "${transport.name}" is already attached`)
  }
  transports.push(transport)
  for (const definition of definitions.values()) transport.serve(definition)
}

function transportOf(client: ClientRef): ClientTransport | undefined {
  return transports.find((t) => t.owns(client))
}

/** 推给某一个客户端（IPC：它的 webContents.send）；客户端已经没了 / 没有传输认它 → 什么也不做 */
export function pushTo(client: ClientRef, channel: string, ...payload: unknown[]): void {
  transportOf(client)?.pushTo(client, channel, payload)
}

/** 客户端此刻还在不在（IPC：它的 webContents 没销毁）；没有传输认它 → false */
export function isClientAlive(client: ClientRef): boolean {
  return transportOf(client)?.isClientAlive(client) ?? false
}

/**
 * 客户端没了时回调一次（IPC：webContents 的 `destroyed`）。返回撤掉监听的函数。
 * 没有传输认它 → 永不回调，撤销是无操作。
 */
export function onClientGone(client: ClientRef, callback: () => void): () => void {
  return transportOf(client)?.onClientGone(client, callback) ?? (() => {})
}

/** 推给所有客户端（IPC：每个 BrowserWindow） */
export function broadcastToClients(channel: string, ...payload: unknown[]): void {
  for (const transport of transports) transport.broadcast(channel, payload)
}

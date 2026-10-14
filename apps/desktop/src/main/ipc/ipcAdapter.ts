/**
 * 通道注册表的 IPC 传输（server mode phase A）—— **主进程里唯一碰 `ipcMain` 的地方**。
 *
 *  - `attachIpcAdapter()`：主入口最早处挂上一次。注册表里每条定义按种类登记到 `ipcMain.handle` / `ipcMain.on`，
 *    处理函数收到的 `ClientContext` 由 IPC 事件构造：`client = { kind: 'window', id: 'ipc:<webContentsId>',
 *    webContentsId }`（`id` 与 `clientIdentity.clientIdOf(event)` 是同一个串）、`transport = 'ipc'`。
 *  - 发送方的 webContents 本身挂在这次调用的 `client` 上（WeakMap，不进上下文对象）：要窗口的处理函数经
 *    `webContentsOf(ctx)` / `windowOf(ctx)` 取到的就是今天的 `event.sender` 那个对象 —— 身份比较（协作编辑的
 *    「只认发请求的窗口」、视图同步的窗口链路）与销毁后的行为都与改造前一样。phase B 的网络客户端答 undefined。
 *  - 推回：`pushTo` / `onClientGone` / `isClientAlive` 优先用这次调用的那个 webContents，取不到（不是经本
 *    适配器来的 ClientRef）再按 id `webContents.fromId`；广播 = 每个没销毁的 BrowserWindow。
 */
import {
  BrowserWindow,
  ipcMain,
  webContents as electronWebContents,
  type WebContents
} from 'electron'
import { clientIdOf, ipcClientId } from '../frontend/sync/clientIdentity'
import {
  attachTransport,
  type ChannelDefinition,
  type ClientContext,
  type ClientRef,
  type ClientTransport
} from './registry'

/** 适配器要的那一点 IPC 事件：发送方 webContents（测试给假的） */
export interface IpcEventLike {
  readonly sender: { readonly id: number }
}

/** 适配器要的那一点 ipcMain（Electron 的 ipcMain 满足它；测试给假的） */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): unknown
  on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): unknown
}

/** 经本适配器构造的 ClientRef → 发送方 webContents（今天的 `event.sender`） */
const senders = new WeakMap<ClientRef, WebContents>()

/** 没有发送方的事件用的 webContents id（Electron 不会这样；只有替身会） */
const NO_SENDER_ID = -1

/** IPC 事件 → 这次调用的上下文（从不抛：处理函数自己的防御照旧兜底） */
function contextOf(event: IpcEventLike): ClientContext {
  const sender = event.sender as WebContents | undefined
  if (!sender) {
    return {
      client: { kind: 'window', id: ipcClientId(NO_SENDER_ID), webContentsId: NO_SENDER_ID },
      transport: 'ipc'
    }
  }
  const client: ClientRef = { kind: 'window', id: clientIdOf(event), webContentsId: sender.id }
  senders.set(client, sender)
  return { client, transport: 'ipc' }
}

/** 某个窗口客户端的 webContents：这次调用的发送方，不是经本适配器来的就按 id 找 */
function contentsOfClient(client: ClientRef): WebContents | undefined {
  if (client.kind !== 'window' || client.webContentsId === NO_SENDER_ID) return undefined
  return senders.get(client) ?? electronWebContents.fromId(client.webContentsId) ?? undefined
}

function createIpcTransport(ipc: IpcMainLike): ClientTransport {
  return {
    name: 'ipc',
    serve(definition: ChannelDefinition): void {
      if (definition.kind === 'handle') {
        const fn = definition.fn
        ipc.handle(definition.channel, (event, ...args) => fn(contextOf(event), ...args))
      } else {
        const fn = definition.fn
        ipc.on(definition.channel, (event, ...args) => {
          fn(contextOf(event), ...args)
        })
      }
    },
    owns: (client) => client.kind === 'window',
    pushTo(client, channel, payload): void {
      const contents = contentsOfClient(client)
      if (contents && !contents.isDestroyed()) contents.send(channel, ...payload)
    },
    isClientAlive(client): boolean {
      const contents = contentsOfClient(client)
      return contents !== undefined && !contents.isDestroyed()
    },
    onClientGone(client, callback): () => void {
      const contents = contentsOfClient(client)
      if (!contents) return () => {}
      contents.once('destroyed', callback)
      return () => {
        if (!contents.isDestroyed()) contents.removeListener('destroyed', callback)
      }
    },
    broadcast(channel, payload): void {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, ...payload)
      }
    }
  }
}

/** 把注册表挂到 ipcMain 上（主入口最早处调一次；测试传假的 ipcMain） */
export function attachIpcAdapter(ipc: IpcMainLike = ipcMain as unknown as IpcMainLike): void {
  attachTransport(createIpcTransport(ipc))
}

/** 调用方的 webContents（IPC：今天的 `event.sender`）；不是窗口客户端 → undefined */
export function webContentsOf(ctx: ClientContext): WebContents | undefined {
  return contentsOfClient(ctx.client)
}

/** 调用方所在的窗口（`BrowserWindow.fromWebContents(event.sender)`）；没有 → undefined */
export function windowOf(ctx: ClientContext): BrowserWindow | undefined {
  const contents = webContentsOf(ctx)
  return contents ? (BrowserWindow.fromWebContents(contents) ?? undefined) : undefined
}

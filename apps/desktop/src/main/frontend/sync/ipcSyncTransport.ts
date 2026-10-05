/**
 * 视图同步的服务端传输（phase 3，P3-05；plan §C）—— SyncHub 只认 `SyncServerTransport`
 * （`send(clientId, frame)` + `onClientGone(clientId, cb)`），这里给它两层：
 *
 *  - **路由传输**（PIN-03）：按客户端 id 的前缀（`ipc:` / `chrome:` / 之后的 `ws:`）把帧交给对应的传输；
 *    前缀没人认领 → 记一笔、丢掉（不抛）。Chrome 侧边栏的传输由 P3-09 经 `addRoute('chrome', …)` 挂上。
 *  - **IPC 传输**：`ipc:<webContentsId>` → `webContents.send('sync:frame', frame)`。webContents 经注入的
 *    `lookup(id)` 取（产品里是 `webContents.fromId`，由 IPC 处理器注册时给 —— 本模块不碰 Electron）。
 *    找不到 / 已销毁 / `send` 抛错：帧丢掉、各记一笔，`send` 从不抛（hub 的 publish 在投影的
 *    `state.change` 里，抛出去就进了会话）。
 *
 * **客户端离开**（`onClientGone`）：webContents `destroyed`、渲染进程没了（`render-process-gone`）、
 * 主框架的跨文档导航（`did-start-navigation`，`isMainFrame && !isSameDocument` —— 重载 / 换页）都算
 * （PIN-02：webContents id 熬过重载，旧页面的订阅却随 JS 一起没了）。回调至多一次，之后监听器全部摘掉；
 * 返回的注销函数恢复原样。登记时 webContents 已经不在 / 已销毁 → 回调在之后的微任务里调一次，绝不在
 * `onClientGone` 里同步调（PIN-04；hub 此刻还在登记这个客户端）。
 */
import type { SyncServerTransport, SyncWireFrame } from '@shuvix/agent-runtime'
import { parseClientId, webContentsIdOf } from './clientIdentity'

/** 服务端推帧的 IPC 通道（preload 的 `sync.onFrame` 听它） */
export const SYNC_FRAME_CHANNEL = 'sync:frame'

/** 传输的日志口（主进程 logger 满足它） */
export interface SyncTransportLogger {
  warn(message: string): void
  error(message: string): void
}

type Listener = (...args: any[]) => void // eslint-disable-line @typescript-eslint/no-explicit-any

/** IPC 传输要的那一点 webContents（Electron 的 WebContents 满足它；测试给假的） */
export interface SyncWebContents {
  readonly id: number
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
  on(event: string, listener: Listener): unknown
  removeListener(event: string, listener: Listener): unknown
}

export interface IpcSyncTransportDeps {
  /** webContents id → webContents；不在了 → undefined */
  readonly lookup: (webContentsId: number) => SyncWebContents | undefined
  readonly logger?: SyncTransportLogger
}

/** 路由传输：多一个按前缀挂传输的口 */
export interface RoutingSyncTransport extends SyncServerTransport {
  /** 认领一个前缀（同前缀再挂 = 替换）；返回注销函数（只摘自己挂上的那一个） */
  addRoute(prefix: string, transport: SyncServerTransport): () => void
  /** 此刻认领着的前缀 */
  routes(): string[]
}

const silent: SyncTransportLogger = { warn: () => {}, error: () => {} }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 回调在之后的微任务里调一次；注销得早就不调 */
function goneLater(callback: () => void): () => void {
  let cancelled = false
  queueMicrotask(() => {
    if (!cancelled) callback()
  })
  return () => {
    cancelled = true
  }
}

/** `did-start-navigation` 的参数（Electron ≥ 25：第一个参数带 isMainFrame / isSameDocument；旧的按位置） */
function isCrossDocumentMainFrame(args: unknown[]): boolean {
  const details = args[0] as { isMainFrame?: unknown; isSameDocument?: unknown } | undefined
  if (details !== undefined && typeof details.isMainFrame === 'boolean') {
    return details.isMainFrame && details.isSameDocument !== true
  }
  // 旧签名：(event, url, isInPlace, isMainFrame, …)
  return args[3] === true && args[2] !== true
}

// ─── IPC ────────────────────────────────────────────────

export function createIpcSyncTransport(deps: IpcSyncTransportDeps): SyncServerTransport {
  const logger = deps.logger ?? silent

  const resolve = (clientId: string): SyncWebContents | undefined => {
    const id = webContentsIdOf(clientId)
    if (id === undefined) return undefined
    try {
      return deps.lookup(id) ?? undefined
    } catch (error) {
      logger.warn(`sync ipc: lookup failed client=${clientId}: ${errorText(error)}`)
      return undefined
    }
  }

  return {
    send(clientId: string, frame: SyncWireFrame): void {
      const contents = resolve(clientId)
      if (contents === undefined) {
        logger.warn(`sync ipc: no webContents for client=${clientId}, frame dropped`)
        return
      }
      try {
        if (contents.isDestroyed()) {
          logger.warn(`sync ipc: webContents destroyed client=${clientId}, frame dropped`)
          return
        }
        contents.send(SYNC_FRAME_CHANNEL, frame)
      } catch (error) {
        logger.error(`sync ipc: send failed client=${clientId}: ${errorText(error)}`)
      }
    },

    onClientGone(clientId: string, callback: () => void): () => void {
      const contents = resolve(clientId)
      let destroyed = true
      try {
        destroyed = contents === undefined || contents.isDestroyed()
      } catch {
        destroyed = true
      }
      if (contents === undefined || destroyed) return goneLater(callback)

      let done = false
      const detach = (): void => {
        contents.removeListener('destroyed', onDestroyed)
        contents.removeListener('render-process-gone', onProcessGone)
        contents.removeListener('did-start-navigation', onNavigation)
      }
      const fire = (): void => {
        if (done) return
        done = true
        detach()
        callback()
      }
      const onDestroyed: Listener = () => fire()
      const onProcessGone: Listener = () => fire()
      const onNavigation: Listener = (...args: unknown[]) => {
        if (isCrossDocumentMainFrame(args)) fire()
      }
      contents.on('destroyed', onDestroyed)
      contents.on('render-process-gone', onProcessGone)
      contents.on('did-start-navigation', onNavigation)
      return () => {
        if (done) return
        done = true
        detach()
      }
    }
  }
}

// ─── 路由 ───────────────────────────────────────────────

export function createRoutingSyncTransport(
  options: { logger?: SyncTransportLogger } = {}
): RoutingSyncTransport {
  const logger = options.logger ?? silent
  const table = new Map<string, SyncServerTransport>()
  const routeOf = (clientId: string): SyncServerTransport | undefined => {
    const parsed = parseClientId(clientId)
    return parsed === undefined ? undefined : table.get(parsed.prefix)
  }

  return {
    send(clientId, frame) {
      const route = routeOf(clientId)
      if (route === undefined) {
        logger.warn(`sync transport: no route for client=${clientId}, frame dropped`)
        return
      }
      try {
        const result = route.send(clientId, frame)
        if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
          ;(result as Promise<void>).then(undefined, (error: unknown) =>
            logger.error(`sync transport: send failed client=${clientId}: ${errorText(error)}`)
          )
        }
      } catch (error) {
        logger.error(`sync transport: send failed client=${clientId}: ${errorText(error)}`)
      }
    },

    onClientGone(clientId, callback) {
      const route = routeOf(clientId)
      // 没人认领的客户端收不到任何帧：当它已经离开（之后的微任务），订阅随之被拒、钉住不留
      if (route === undefined) {
        logger.warn(`sync transport: no route for client=${clientId}, treated as gone`)
        return goneLater(callback)
      }
      const unregister = route.onClientGone(clientId, callback)
      return typeof unregister === 'function' ? unregister : () => {}
    },

    addRoute(prefix, transport) {
      table.set(prefix, transport)
      return () => {
        if (table.get(prefix) === transport) table.delete(prefix)
      }
    },

    routes() {
      return [...table.keys()]
    }
  }
}

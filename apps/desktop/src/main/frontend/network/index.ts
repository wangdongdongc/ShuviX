/**
 * 网络访问（server mode phase B，docs/server/phase-bc-network-and-web.md）—— 局域网里的浏览器经 WebSocket 用与桌面
 * 窗口同一张通道表、同一套处理函数。它是 frontend 的一种具体实现（与 electron、chrome 并列）。
 *
 * **缺省关**（只有设置 `network.enabled` 的字面量 `'true'` 才开），开着时**没有认证**（用户裁决：这一轮没有安全模型，
 * 设置页把风险写在明面上）。设置现读：`network.enabled` / `network.port` 一变（`network:setEnabled` / `setPort`，
 * 或任何写设置的路径发出的 `settings.changed`）就对一次账（`reconcile`）—— 关 → 停止监听、断开每个客户端；
 * 开 → 在设置的端口上监听；开着换端口 → 先断开所有客户端再换。
 *
 * 每条连接：注册成默认聊天前端（`NetworkFrontend`，收每条会话的 `agent:event`）、一张视图同步链路表
 * （`networkLinks.ts`，主体 `{kind:'network'}`，核对一律放行）；连上 / 断开 / 开始 / 停止 / 出错都发 `network.changed`。
 */
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import {
  isNetworkEnabledValue,
  isValidNetworkPort,
  MAX_NETWORK_PORT,
  MIN_NETWORK_PORT,
  NETWORK_ENABLED_KEY,
  NETWORK_PORT_KEY,
  parseNetworkPort,
  type NetworkClientInfo,
  type NetworkStatus
} from '../../../shared/network'
import { settingsDao } from '../../dao/settingsDao'
import { attachTransport } from '../../ipc/registry'
import { createLogger } from '../../logger'
import { settingsService } from '../../services/settingsService'
import { appEventBus } from '../../utils/appEventBus'
import { chatFrontendRegistry } from '../core'
import { getSyncHub, registerViewAuthorizer } from '../sync/syncWiring'
import { createNetworkDispatcher } from './dispatch'
import { isPrivatePeerAddress } from './guards'
import { NetworkFrontend, networkFrontendId } from './NetworkFrontend'
import { createNetworkLinkHub, NETWORK_PRINCIPAL_KIND, type NetworkLinkHub } from './networkLinks'
import { createNetworkServer, type NetworkServer } from './server'
import { createNetworkTransport, type NetworkTransport } from './transport'
import type { FileRouteDeps } from './fileRoutes'
import type { WidgetProxyDeps } from './widgetProxy'

const log = createLogger('Network')

/**
 * 能用来打开 web 客户端的地址：每个非内部、**私有**的 IPv4 接口一条（对端地址那道门只放私有地址进来 ——
 * 公网地址、CGNAT（100.64/10，如 Tailscale）列出来也打不开），外加 `http://127.0.0.1:<port>`（只监听 IPv4：
 * `localhost` 在有的系统上先解析成 ::1，那就连不上）
 */
export function listenAddresses(
  port: number,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): string[] {
  const urls: string[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // Node 18 起 family 是 'IPv4'；更早的版本是数字 4
      const family = entry.family as unknown
      if (entry.internal || (family !== 'IPv4' && family !== 4)) continue
      if (!isPrivatePeerAddress(entry.address)) continue
      const url = `http://${entry.address}:${port}`
      if (!urls.includes(url)) urls.push(url)
    }
  }
  urls.push(`http://127.0.0.1:${port}`)
  return urls
}

/** 监听失败的原因：Node 的错误码（`EADDRINUSE` / `EACCES` …），没有码就是消息 */
function listenErrorOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  return error instanceof Error ? error.message : String(error)
}

export interface NetworkServiceDeps {
  /** 读设置（缺省：settingsDao） */
  readonly readSetting?: (key: string) => string | undefined
  /** 写设置（缺省：settingsService.set —— 会发 settings.changed） */
  readonly writeSetting?: (key: string, value: string) => void
  /** 渲染端构建产物目录（缺省：主进程产物旁边的 `../renderer`） */
  readonly rendererDir?: () => string
  /** 监听的地址（缺省 0.0.0.0；单测给 127.0.0.1） */
  readonly host?: string
  /** 网卡（缺省：os.networkInterfaces；单测给假的） */
  readonly interfaces?: () => ReturnType<typeof networkInterfaces>
  /** 发 `network.changed`（缺省：appEventBus） */
  readonly publishChanged?: () => void
  /** 不挂到全局通道注册表（单测各建各的） */
  readonly transport?: NetworkTransport
}

/**
 * phase D 的动态路由要的依赖（文件路由的路径解析与沙箱库、widget 服务此刻的地址）—— 由主入口在 `init` 时交进来
 * （它们背后是会话服务与 widget 模块；本模块不直接引，单测因此不必把它们整个拉进来）
 */
export interface NetworkRouteDeps {
  readonly fileRoutes?: FileRouteDeps
  readonly widgetProxy?: WidgetProxyDeps
}

export class NetworkService {
  readonly transport: NetworkTransport
  private readonly server: NetworkServer
  private readonly links: NetworkLinkHub
  private readonly deps: NetworkServiceDeps
  private queue: Promise<void> = Promise.resolve()
  private error: string | undefined
  private initialized = false
  private unsubscribe: (() => void) | undefined
  private stopped = false
  private routes: NetworkRouteDeps = {}

  constructor(deps: NetworkServiceDeps = {}) {
    this.deps = deps
    this.transport = deps.transport ?? createNetworkTransport()
    this.links = createNetworkLinkHub({
      accept: (link, principal) => getSyncHub().accept(link, principal),
      logger: { warn: (message) => log.warn(message) }
    })
    const dispatcher = createNetworkDispatcher({
      definitionOf: (channel) => this.transport.definitionOf(channel),
      logger: { warn: (message) => log.warn(message) }
    })
    this.server = createNetworkServer({
      transport: this.transport,
      dispatcher,
      links: this.links,
      rendererDir: deps.rendererDir ?? (() => join(__dirname, '../renderer')),
      fileRoutes: () => this.routes.fileRoutes,
      widgetProxy: () => this.routes.widgetProxy,
      logger: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
      onConnection: (connection) => {
        chatFrontendRegistry.registerDefault(new NetworkFrontend(connection.client))
        this.changed()
      },
      onDisconnection: (connection) => {
        chatFrontendRegistry.unregister(networkFrontendId(connection.client.id))
        this.changed()
      }
    })
  }

  private read(key: string): string | undefined {
    return (this.deps.readSetting ?? ((k) => settingsDao.findByKey(k)))(key)
  }

  private write(key: string, value: string): void {
    ;(this.deps.writeSetting ?? ((k, v) => settingsService.set(k, v)))(key, value)
  }

  private changed(): void {
    ;(this.deps.publishChanged ?? (() => appEventBus.publish({ type: 'network.changed' })))()
  }

  /**
   * 启动时装一次（IPC 注册之后、旧格式切换之后）：网络传输挂到通道注册表、`network` 主体的视图核对（一律放行，
   * 这一轮没有认证）、跟着设置走；然后按设置对一次账（设置是开着的就开始监听）。`routes`：phase D 的文件路由与
   * widget 转发（不给 → 那些路径 404）
   */
  init(routes?: NetworkRouteDeps): Promise<void> {
    if (routes !== undefined) this.routes = routes
    if (!this.initialized) {
      this.initialized = true
      if (this.deps.transport === undefined) attachTransport(this.transport)
      registerViewAuthorizer(NETWORK_PRINCIPAL_KIND, () => true)
      this.unsubscribe = appEventBus.subscribe((event) => {
        if (event.type !== 'settings.changed') return
        if (event.keys && !event.keys.some((key) => key.startsWith('network.'))) return
        void this.reconcile()
      })
    }
    return this.reconcile()
  }

  /** 按设置对一次账（排队：同一时刻只有一次在跑；从不拒绝） */
  reconcile(): Promise<void> {
    const next = this.queue.then(() => this.reconcileNow())
    this.queue = next.catch(() => undefined)
    return this.queue
  }

  private async reconcileNow(): Promise<void> {
    if (this.stopped) return
    const enabled = isNetworkEnabledValue(this.read(NETWORK_ENABLED_KEY))
    const port = parseNetworkPort(this.read(NETWORK_PORT_KEY))
    const current = this.server.port
    if (!enabled) {
      const hadError = this.error !== undefined
      this.error = undefined
      if (current !== undefined) {
        await this.server.stop('network access turned off')
        this.changed()
      } else if (hadError) {
        this.changed()
      }
      return
    }
    if (current === port) return
    if (current !== undefined) await this.server.stop('network port changed')
    try {
      await this.server.start(port, this.deps.host)
      this.error = undefined
    } catch (error) {
      this.error = listenErrorOf(error)
      log.warn(`network: could not listen on port ${port}: ${this.error}`)
    }
    this.changed()
  }

  /** 此刻的状态（`network:status`） */
  status(): NetworkStatus {
    const enabled = isNetworkEnabledValue(this.read(NETWORK_ENABLED_KEY))
    const port = parseNetworkPort(this.read(NETWORK_PORT_KEY))
    const listening = this.server.port !== undefined
    const clients: NetworkClientInfo[] = this.transport.connections().map((c) => ({
      id: c.client.id,
      remoteAddress: c.client.remoteAddress,
      userAgent: c.client.userAgent,
      connectedAt: c.connectedAt
    }))
    const listeningPort = this.server.port
    return {
      enabled,
      port,
      listening,
      addresses:
        listeningPort === undefined
          ? []
          : listenAddresses(listeningPort, (this.deps.interfaces ?? networkInterfaces)()),
      clients,
      ...(this.error === undefined ? {} : { error: this.error })
    }
  }

  /** 开 / 关（写设置，再对一次账）；回改完之后的状态 */
  async setEnabled(enabled: unknown): Promise<NetworkStatus> {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    this.write(NETWORK_ENABLED_KEY, enabled ? 'true' : 'false')
    await this.reconcile()
    return this.status()
  }

  /** 换端口（1024–65535 的整数，否则拒绝；写设置，再对一次账）；回改完之后的状态 */
  async setPort(port: unknown): Promise<NetworkStatus> {
    if (!isValidNetworkPort(port)) {
      throw new Error(
        `The port must be an integer between ${MIN_NETWORK_PORT} and ${MAX_NETWORK_PORT}.`
      )
    }
    this.write(NETWORK_PORT_KEY, String(port))
    await this.reconcile()
    return this.status()
  }

  /** 退出：停止监听、断开每个客户端，之后不再跟着设置走 */
  async shutdown(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.queue
    this.stopped = true
    await this.server.stop('ShuviX is quitting')
  }
}

/** 主进程唯一的网络服务 */
export const networkService = new NetworkService()

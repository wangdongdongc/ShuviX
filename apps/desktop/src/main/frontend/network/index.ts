/**
 * 网络访问（server mode phase B，docs/server/phase-bc-network-and-web.md）—— 局域网里的浏览器经 WebSocket 用与桌面
 * 窗口同一张通道表、同一套处理函数。它是 frontend 的一种具体实现（与 electron、chrome 并列）。
 *
 * **缺省关**（只有设置 `network.enabled` 的字面量 `'true'` 才开），开着时**没有认证**（用户裁决：这一轮没有安全模型，
 * 设置页把风险写在明面上）。设置现读：`network.enabled` / `network.port` / `network.lan` 一变（`network:setEnabled` /
 * `setPort` / `setLan`，或任何写设置的路径发出的 `settings.changed`）就对一次账（`reconcile`）—— 关 → 停止监听、断开
 * 每个客户端；开 → 在设置的端口上监听；开着换端口或换共享 → 先断开所有客户端再换。
 *
 * **监听哪里**（用户裁决 2026-10-14）：网络访问开着时缺省只监听 **127.0.0.1**（只有这台电脑能连，别处经 SSH 隧道）；
 * `network.lan`（「允许局域网里的其他设备」）开着才监听 **0.0.0.0** —— 那时局域网里的任何人都能连进来。
 * **只开放给一个网络**（2026-10-15）：再给 `network.lanInterface`（网卡名或本机地址；无头运行是 `--bind`）就只在那块
 * 网卡的地址上监听，并且只接受那个网段里的对端（`lanScope.ts`）；找不到那块网卡 / 那个地址 → 不监听，状态里
 * `error: ENOINTERFACE`（网卡起来、地址回来之后，下一次对账 —— 改设置或重启 —— 再试）。
 *
 * **无头运行**（`shuvix --headless`，docs/headless/design.md）：`setHeadless({port, lan, bind})` 之后网络访问强制开着、
 * 端口与局域网共享固定，设置不读也不写；关掉、换端口、换共享、换网络一律拒绝（`code: 'headless'`），状态带
 * `headless: true`。
 *
 * 每条连接：注册成默认聊天前端（`NetworkFrontend`，收每条会话的 `agent:event`）、一张视图同步链路表
 * （`networkLinks.ts`，主体 `{kind:'network'}`，核对一律放行）；连上 / 断开 / 开始 / 停止 / 出错都发 `network.changed`。
 */
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import {
  isNetworkEnabledValue,
  isNetworkLanValue,
  isValidLanInterfaceSpec,
  isValidNetworkPort,
  LAN_BIND_ADDRESS,
  LOOPBACK_BIND_ADDRESS,
  MAX_NETWORK_PORT,
  MIN_NETWORK_PORT,
  NETWORK_ENABLED_KEY,
  NETWORK_ERROR_NO_INTERFACE,
  NETWORK_LAN_INTERFACE_KEY,
  NETWORK_LAN_KEY,
  NETWORK_PORT_KEY,
  parseLanInterfaceValue,
  parseNetworkPort,
  type NetworkClientInfo,
  type NetworkLanInfo,
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
import {
  isInLanNetwork,
  lanCandidates,
  lanNetworkUrl,
  resolveLanNetwork,
  type LanNetwork
} from './lanScope'
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

function lanInfo(network: LanNetwork): NetworkLanInfo {
  return { interface: network.interface, address: network.address, cidr: network.cidr }
}

/** 无头运行时拒绝的那几件事（关掉网络访问、换端口）：带 `code: 'headless'`，网络客户端收到的失败结果带着它 */
function headlessRefusal(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = 'headless'
  return error
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
  /**
   * 固定的监听地址（缺省按局域网开关：关 → 127.0.0.1、开 → 0.0.0.0；单测给 127.0.0.1）。给了它，局域网开关照样
   * 决定状态里的 `lan` 与列出的地址、切换时照样重启 —— 只是绑的地址不变
   */
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
  /** 无头运行（`setHeadless`）：网络访问强制开着、端口与局域网共享（及开放给的网络）固定；设置不读不写 */
  private headless:
    | { readonly port: number; readonly lan: boolean; readonly bind?: string }
    | undefined
  /** 此刻的监听是按哪种共享起的：`local` / `all` / `net:<地址>`（没在监听 → undefined） */
  private listeningKey: string | undefined
  /** 只开放给一个网络时，此刻开放给的那一个（对端那道附加门按它核） */
  private listeningNetwork: LanNetwork | undefined

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
      acceptPeer: (address) =>
        this.listeningNetwork === undefined || isInLanNetwork(address, this.listeningNetwork),
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
   * 无头运行（docs/headless/design.md §1）：这个进程活着的时候网络访问**强制开着**、监听 `port`，`lan` 决定只给这台
   * 电脑（127.0.0.1，缺省）还是整个局域网（0.0.0.0，`--lan`），`bind`（`--bind`，网卡名或本机地址）只开放给那一个
   * 网络（隐含 `lan`）—— 与设置 `network.enabled` / `network.port` / `network.lan` / `network.lanInterface` 无关，
   * **也不写它们**（下次以桌面应用启动时一切照旧）。`network:status` 带 `headless: true`；关掉、换端口、换共享、换网络
   * 一律拒绝 —— 第一件等于把唯一的入口关掉，其余让发起的浏览器当场断开；由命令行或服务文件定。主入口在 `init`
   * 之前调一次。
   */
  setHeadless(config: {
    readonly port: number
    readonly lan?: boolean
    readonly bind?: string
  }): void {
    if (!isValidNetworkPort(config.port)) {
      throw new Error(
        `The port must be an integer between ${MIN_NETWORK_PORT} and ${MAX_NETWORK_PORT}.`
      )
    }
    if (config.bind !== undefined && !isValidLanInterfaceSpec(config.bind)) {
      throw new Error('The network must be an interface name or a local address.')
    }
    this.headless =
      config.bind === undefined
        ? { port: config.port, lan: config.lan === true }
        : { port: config.port, lan: true, bind: config.bind }
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

  private async stopListening(reason: string): Promise<void> {
    await this.server.stop(reason)
    this.listeningKey = undefined
    this.listeningNetwork = undefined
  }

  private async reconcileNow(): Promise<void> {
    if (this.stopped) return
    const { enabled, port, lan, scope } = this.wanted()
    const current = this.server.port
    if (!enabled) {
      const hadError = this.error !== undefined
      this.error = undefined
      if (current !== undefined) {
        await this.stopListening('network access turned off')
        this.changed()
      } else if (hadError) {
        this.changed()
      }
      return
    }
    // 只开放给一个网络：每次对账都按此刻的网卡重新落一次（地址可能换了）
    const network =
      lan && scope !== undefined
        ? resolveLanNetwork(scope, (this.deps.interfaces ?? networkInterfaces)())
        : undefined
    if (lan && scope !== undefined && network === undefined) {
      const wasListening = current !== undefined
      if (wasListening) await this.stopListening('the network it was shared on is gone')
      const unchanged = !wasListening && this.error === NETWORK_ERROR_NO_INTERFACE
      this.error = NETWORK_ERROR_NO_INTERFACE
      if (unchanged) return
      log.warn(`network: no network interface or local address "${scope}"`)
      this.changed()
      return
    }
    const key = !lan ? 'local' : network === undefined ? 'all' : `net:${network.cidr}`
    if (current === port && this.listeningKey === key) return
    if (current !== undefined) {
      await this.stopListening(
        current === port ? 'network sharing changed' : 'network port changed'
      )
    }
    try {
      await this.server.start(
        port,
        this.deps.host ?? (!lan ? LOOPBACK_BIND_ADDRESS : (network?.address ?? LAN_BIND_ADDRESS))
      )
      this.listeningKey = key
      this.listeningNetwork = network
      this.error = undefined
    } catch (error) {
      this.error = listenErrorOf(error)
      log.warn(`network: could not listen on port ${port}: ${this.error}`)
    }
    this.changed()
  }

  /**
   * 该不该开、开在哪个端口、给不给局域网、只开放给哪个网络：无头运行 → 强制开着、固定端口、共享与网络；否则按设置
   * （局域网开关关着时不看开放给哪个网络）
   */
  private wanted(): { enabled: boolean; port: number; lan: boolean; scope: string | undefined } {
    if (this.headless !== undefined) {
      return {
        enabled: true,
        port: this.headless.port,
        lan: this.headless.lan,
        scope: this.headless.bind
      }
    }
    const lan = isNetworkLanValue(this.read(NETWORK_LAN_KEY))
    return {
      enabled: isNetworkEnabledValue(this.read(NETWORK_ENABLED_KEY)),
      port: parseNetworkPort(this.read(NETWORK_PORT_KEY)),
      lan,
      scope: lan ? parseLanInterfaceValue(this.read(NETWORK_LAN_INTERFACE_KEY)) : undefined
    }
  }

  /** 此刻的状态（`network:status`） */
  status(): NetworkStatus {
    const { enabled, port, lan } = this.wanted()
    const interfaces = (this.deps.interfaces ?? networkInterfaces)()
    const configuredScope =
      this.headless !== undefined
        ? this.headless.bind
        : parseLanInterfaceValue(this.read(NETWORK_LAN_INTERFACE_KEY))
    const listening = this.server.port !== undefined
    const clients: NetworkClientInfo[] = this.transport.connections().map((c) => ({
      id: c.client.id,
      remoteAddress: c.client.remoteAddress,
      userAgent: c.client.userAgent,
      connectedAt: c.connectedAt
    }))
    const listeningPort = this.server.port
    const bindAddress = this.server.host
    const network = listeningPort === undefined ? undefined : this.listeningNetwork
    return {
      enabled,
      port,
      lan,
      ...(configuredScope === undefined ? {} : { lanInterface: configuredScope }),
      ...(network === undefined ? {} : { lanNetwork: lanInfo(network) }),
      lanCandidates: lanCandidates(interfaces, isPrivatePeerAddress).map(lanInfo),
      ...(bindAddress === undefined ? {} : { bindAddress }),
      listening,
      // 列的是此刻真在监听的那一份：局域网共享 → 每个私有接口 + 127.0.0.1；只开放给一个网络 → 那个地址；
      // 只给这台电脑 → 只有 127.0.0.1
      addresses:
        listeningPort === undefined
          ? []
          : network !== undefined
            ? [lanNetworkUrl(network, listeningPort)]
            : this.listeningKey === 'all'
              ? listenAddresses(listeningPort, interfaces)
              : [`http://${LOOPBACK_BIND_ADDRESS}:${listeningPort}`],
      clients,
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(this.headless === undefined ? {} : { headless: true as const })
    }
  }

  /** 开 / 关（写设置，再对一次账）；回改完之后的状态 */
  async setEnabled(enabled: unknown): Promise<NetworkStatus> {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    if (this.headless !== undefined) {
      if (!enabled) {
        throw headlessRefusal(
          'Network access stays on while ShuviX runs headless. Stop the ShuviX service ' +
            '(or the shuvix --headless process) to turn it off.'
        )
      }
      return this.status()
    }
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
    if (this.headless !== undefined) {
      if (port === this.headless.port) return this.status()
      throw headlessRefusal(
        'The port cannot be changed while ShuviX runs headless (this browser would lose its ' +
          'connection). Restart ShuviX with --port <n>, or change the port in the service file.'
      )
    }
    this.write(NETWORK_PORT_KEY, String(port))
    await this.reconcile()
    return this.status()
  }

  /**
   * 允许 / 不许局域网里的其他设备（写设置，再对一次账 —— 开着时换绑地址，先断开所有客户端）；回改完之后的状态。
   * 无头运行：共享由启动参数定，换成别的一律拒绝（发起的浏览器会当场断开）
   */
  async setLan(lan: unknown): Promise<NetworkStatus> {
    if (typeof lan !== 'boolean') throw new Error('lan must be a boolean')
    if (this.headless !== undefined) {
      if (lan === this.headless.lan) return this.status()
      throw headlessRefusal(
        'Sharing on the local network is chosen when ShuviX starts headless (this browser ' +
          'would lose its connection). Restart ShuviX with or without --lan, or change the ' +
          'service file.'
      )
    }
    this.write(NETWORK_LAN_KEY, lan ? 'true' : 'false')
    await this.reconcile()
    return this.status()
  }

  /**
   * 局域网开关开着时只开放给哪个网络：网卡名或本机地址（`null` / 空串 = 所有网络；写设置，再对一次账 —— 开着时
   * 换网络，先断开所有客户端）；回改完之后的状态。无头运行：由 `--bind` 定，换成别的一律拒绝
   */
  async setLanInterface(spec: unknown): Promise<NetworkStatus> {
    const value = spec === null || spec === '' ? '' : spec
    if (value !== '' && !isValidLanInterfaceSpec(value)) {
      throw new Error('The network must be an interface name or a local address.')
    }
    if (this.headless !== undefined) {
      if ((value === '' ? undefined : value) === this.headless.bind) return this.status()
      throw headlessRefusal(
        'The network ShuviX is shared on is chosen when it starts headless (this browser ' +
          'would lose its connection). Restart ShuviX with --bind <interface or address>, or ' +
          'change the service file.'
      )
    }
    this.write(NETWORK_LAN_INTERFACE_KEY, value)
    await this.reconcile()
    return this.status()
  }

  /** 退出：停止监听、断开每个客户端，之后不再跟着设置走 */
  async shutdown(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.queue
    this.stopped = true
    await this.stopListening('ShuviX is quitting')
  }
}

/** 主进程唯一的网络服务 */
export const networkService = new NetworkService()

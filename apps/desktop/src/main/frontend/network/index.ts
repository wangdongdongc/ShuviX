/**
 * 网络访问（server mode phase B，docs/server/phase-bc-network-and-web.md）—— 局域网里的浏览器经 WebSocket 用与桌面
 * 窗口同一张通道表、同一套处理函数。它是 frontend 的一种具体实现（与 electron、chrome 并列）。
 *
 * **缺省关**（只有设置 `network.enabled` 的字面量 `'true'` 才开），开着时**没有认证**。设置现读：`network.enabled` /
 * `network.port` 一变（`network:setEnabled` / `setPort`，或任何写设置的路径发出的 `settings.changed`）就对一次账
 * （`reconcile`）—— 关 → 停止监听、断开每个客户端；开 → 在设置的端口上监听；开着换端口，先断开所有客户端再换。
 *
 * **谁能连由安全策略定**（用户裁决 2026-10-19，docs/network-policy/design.md）：开着时一律监听 **0.0.0.0**；内置策略
 * `network-admission` 只放这台电脑（127.0.0.1 / ::1），要让别的设备连进来写一份同名的用户策略替换它。服务端在
 * socket / request / path 三个点位、分发器在每条 RPC 上问策略（policyGate.ts）；拒绝记进 NetworkDenialLog，状态里带
 * 最近 20 条与 network-admission 的状态（`admission`），设置页据此给引导。策略变了（`policy.changed`；远程访问开着时
 * 每 POLICY_REFRESH_MS 核一次策略目录，接住 agent / 外部编辑器的写入）→ 按每条连接升级时的事实重判，新被拒的断开。
 * 从前的「允许局域网里的其他设备」（`network.lan`）与「开放给」（`network.lanInterface`）在 init 时迁移成一份
 * network-admission 用户策略后删掉（admissionMigration.ts）。
 *
 * **无头运行**（`shuvix --headless`，docs/headless/design.md）：`setHeadless({port, lan, bind})` 之后网络访问强制开着、
 * 端口固定，设置不读也不写；关掉、换端口一律拒绝（`code: 'headless'`），状态带 `headless: true`。`lan` / `bind` 是
 * 已经弃用的启动参数（服务文件里可能还留着）：按同一条迁移规则写一份 network-admission。
 *
 * 每条连接：注册成默认聊天前端（`NetworkFrontend`，收每条会话的 `agent:event`）、一张视图同步链路表
 * （`networkLinks.ts`，主体 `{kind:'network'}`，核对一律放行）；连上 / 断开 / 开始 / 停止 / 出错 / 新的拒绝都发
 * `network.changed`（拒绝按 DENIAL_CHANGED_THROTTLE_MS 节流）。
 */
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { GateVerdict } from '@shuvix/agent-runtime'
import {
  isNetworkEnabledValue,
  isValidLanInterfaceSpec,
  isValidNetworkPort,
  LEGACY_NETWORK_LAN_INTERFACE_KEY,
  LEGACY_NETWORK_LAN_KEY,
  LOOPBACK_ADDRESS,
  MAX_NETWORK_PORT,
  MIN_NETWORK_PORT,
  NETWORK_BIND_ADDRESS,
  NETWORK_ENABLED_KEY,
  NETWORK_PORT_KEY,
  parseNetworkPort,
  type NetworkAdmission,
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
import { legacySharingOf, migrateLegacySharing, type LegacySharing } from './admissionMigration'
import { createNetworkDispatcher } from './dispatch'
import { isPrivatePeerAddress } from './guards'
import { NetworkFrontend, networkFrontendId } from './NetworkFrontend'
import { createNetworkLinkHub, NETWORK_PRINCIPAL_KIND, type NetworkLinkHub } from './networkLinks'
import { NetworkDenialLog, NetworkPolicyGate, type NetworkSecurityContextFor } from './policyGate'
import { setNetworkPathGate } from './pathGate'
import { createNetworkServer, type NetworkServer } from './server'
import { createNetworkTransport, type NetworkTransport } from './transport'
import type { FileRouteDeps } from './fileRoutes'
import type { WidgetProxyDeps } from './widgetProxy'

const log = createLogger('Network')

/** 远程访问开着时多久核一次策略目录（接住不经过应用的写入，见 policyService 的统一缓存） */
export const POLICY_REFRESH_MS = 3000

/** 新的拒绝最多多久发一次 `network.changed` */
const DENIAL_CHANGED_THROTTLE_MS = 1000

/** 状态里带几条最近的拒绝 */
const STATUS_DENIALS = 20

/**
 * 能用来打开 web 客户端的地址：每个非内部、**私有**的 IPv4 接口一条（对端地址那道门只放私有地址进来 ——
 * 公网地址、CGNAT（100.64/10，如 Tailscale）列出来也打不开），外加 `http://127.0.0.1:<port>`（只监听 IPv4：
 * `localhost` 在有的系统上先解析成 ::1，那就连不上）。哪些真能连进来由策略定
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
  urls.push(`http://${LOOPBACK_ADDRESS}:${port}`)
  return urls
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
  /** 删设置（迁移走的旧键；缺省：settingsDao.remove） */
  readonly removeSetting?: (key: string) => void
  /** 渲染端构建产物目录（缺省：主进程产物旁边的 `../renderer`） */
  readonly rendererDir?: () => string
  /** 固定的监听地址（缺省 0.0.0.0；单测给 127.0.0.1） */
  readonly host?: string
  /** 网卡（缺省：os.networkInterfaces；单测给假的） */
  readonly interfaces?: () => ReturnType<typeof networkInterfaces>
  /** 发 `network.changed`（缺省：appEventBus） */
  readonly publishChanged?: () => void
  /** 不挂到全局通道注册表（单测各建各的） */
  readonly transport?: NetworkTransport
  /** 定时核策略目录的间隔（缺省 POLICY_REFRESH_MS） */
  readonly policyRefreshMs?: number
}

/**
 * 安全策略那一侧（由主入口在 init 时交进来：背后是 toolContext 与 policyService —— 本模块不直接引，单测因此不必
 * 把它们整个拉进来）。不给 → 不判（没有策略 = 放行）
 */
export interface NetworkSecurityDeps {
  /** 给一个网络主体建 SecurityContext（桌面：getDesktopNetworkSecurityContext） */
  readonly contextFor: NetworkSecurityContextFor
  /** network-admission 此刻的状态 */
  readonly admission: () => NetworkAdmission
  /** 核一次策略目录（变了会发 policy.changed） */
  readonly refreshPolicies: () => void
  /** 有没有名叫 network-admission 的用户策略（迁移只在没有时写） */
  readonly hasUserAdmission: () => boolean
  /** 写一份用户策略（迁移用；非法一律拒绝） */
  readonly createPolicy: (text: string) => { success: boolean; error?: string }
}

/**
 * phase D 的动态路由要的依赖（文件路由的路径解析与沙箱库、widget 服务此刻的地址）与安全策略那一侧 —— 由主入口在
 * `init` 时交进来
 */
export interface NetworkRouteDeps {
  readonly fileRoutes?: FileRouteDeps
  readonly widgetProxy?: WidgetProxyDeps
  readonly security?: NetworkSecurityDeps
}

export class NetworkService {
  readonly transport: NetworkTransport
  readonly gate: NetworkPolicyGate
  readonly denials: NetworkDenialLog
  private readonly server: NetworkServer
  private readonly links: NetworkLinkHub
  private readonly deps: NetworkServiceDeps
  private queue: Promise<void> = Promise.resolve()
  private error: string | undefined
  private initialized = false
  private unsubscribe: (() => void) | undefined
  private stopped = false
  private routes: NetworkRouteDeps = {}
  /** 无头运行（`setHeadless`）：网络访问强制开着、端口固定；设置不读不写。`sharing`：弃用的 --lan / --bind */
  private headless: { readonly port: number; readonly sharing?: LegacySharing } | undefined
  private policyTimer: ReturnType<typeof setInterval> | undefined
  private denialTimer: ReturnType<typeof setTimeout> | undefined

  constructor(deps: NetworkServiceDeps = {}) {
    this.deps = deps
    this.transport = deps.transport ?? createNetworkTransport()
    this.denials = new NetworkDenialLog({
      logger: { warn: (message) => log.warn(message) },
      onChange: () => this.denialChanged()
    })
    this.gate = new NetworkPolicyGate({
      contextFor: () => this.routes.security?.contextFor,
      interfaces: () => (this.deps.interfaces ?? networkInterfaces)(),
      denials: this.denials,
      logger: { warn: (message) => log.warn(message) }
    })
    // 文件通道（files:read / files:write / fs:listDirectories）的 path 点位经 pathGate.ts 问到这里
    setNetworkPathGate((facts, connection, mode, path, tool) =>
      this.gate.judgePath(facts.peer, facts.http, connection, mode, path, tool)
    )
    this.links = createNetworkLinkHub({
      accept: (link, principal) => getSyncHub().accept(link, principal),
      logger: { warn: (message) => log.warn(message) }
    })
    const dispatcher = createNetworkDispatcher({
      definitionOf: (channel) => this.transport.definitionOf(channel),
      judge: (ctx, call) =>
        ctx.network
          ? this.gate.judgeChannel(ctx.network.peer, ctx.network.http, ctx.client.id, call)
          : undefined,
      logger: { warn: (message) => log.warn(message) }
    })
    this.server = createNetworkServer({
      transport: this.transport,
      dispatcher,
      links: this.links,
      rendererDir: deps.rendererDir ?? (() => join(__dirname, '../renderer')),
      fileRoutes: () => this.routes.fileRoutes,
      widgetProxy: () => this.routes.widgetProxy,
      gate: this.gate,
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

  private remove(key: string): void {
    ;(this.deps.removeSetting ?? ((k) => settingsDao.remove(k)))(key)
  }

  private changed(): void {
    ;(this.deps.publishChanged ?? (() => appEventBus.publish({ type: 'network.changed' })))()
  }

  /** 新的拒绝：节流地发 `network.changed`（扫描器一秒几十次，设置页不必跟着重拉几十次） */
  private denialChanged(): void {
    if (this.denialTimer !== undefined) return
    this.denialTimer = setTimeout(() => {
      this.denialTimer = undefined
      this.changed()
    }, DENIAL_CHANGED_THROTTLE_MS)
    this.denialTimer.unref?.()
  }

  /**
   * 无头运行（docs/headless/design.md §1）：这个进程活着的时候网络访问**强制开着**、监听 `port` —— 与设置
   * `network.enabled` / `network.port` 无关，**也不写它们**（下次以桌面应用启动时一切照旧）。`lan` / `bind` 是弃用的
   * 启动参数：init 时按迁移规则写一份 network-admission（已有同名用户策略就不碰）。`network:status` 带
   * `headless: true`；关掉、换端口一律拒绝。主入口在 `init` 之前调一次。
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
    this.headless = {
      port: config.port,
      ...(config.bind !== undefined
        ? { sharing: { kind: 'interface', spec: config.bind } as const }
        : config.lan === true
          ? { sharing: { kind: 'lan' } as const }
          : {})
    }
  }

  /**
   * 启动时装一次（IPC 注册之后、旧格式切换之后）：网络传输挂到通道注册表、`network` 主体的视图核对（一律放行）、
   * 跟着设置与策略走；旧的局域网共享设置迁移成策略；然后按设置对一次账（设置是开着的就开始监听）。
   * `routes`：phase D 的文件路由与 widget 转发、安全策略那一侧（不给 → 那些路径 404 / 不判策略）
   */
  init(routes?: NetworkRouteDeps): Promise<void> {
    if (routes !== undefined) this.routes = routes
    if (!this.initialized) {
      this.initialized = true
      if (this.deps.transport === undefined) attachTransport(this.transport)
      registerViewAuthorizer(NETWORK_PRINCIPAL_KIND, () => true)
      this.unsubscribe = appEventBus.subscribe((event) => {
        if (event.type === 'policy.changed') {
          this.recheckConnections()
          this.changed()
          return
        }
        if (event.type !== 'settings.changed') return
        if (event.keys && !event.keys.some((key) => key.startsWith('network.'))) return
        void this.reconcile()
      })
      this.migrateLegacySharing()
    }
    return this.reconcile()
  }

  /** 旧的局域网共享设置（桌面）或弃用的 --lan / --bind（无头）→ network-admission 用户策略 */
  private migrateLegacySharing(): void {
    const security = this.routes.security
    // 没接上策略那一侧（单测）→ 什么也不动：旧键留着，等真的能写策略时再迁
    if (!security) return
    const sharing =
      this.headless !== undefined
        ? this.headless.sharing
        : legacySharingOf(
            this.read(LEGACY_NETWORK_LAN_KEY),
            this.read(LEGACY_NETWORK_LAN_INTERFACE_KEY)
          )
    migrateLegacySharing(sharing, {
      hasUserAdmission: security.hasUserAdmission,
      createPolicy: security.createPolicy,
      interfaces: () => (this.deps.interfaces ?? networkInterfaces)(),
      logger: { info: (message) => log.info(message), warn: (message) => log.warn(message) }
    })
    if (this.headless === undefined) {
      for (const key of [LEGACY_NETWORK_LAN_KEY, LEGACY_NETWORK_LAN_INTERFACE_KEY]) {
        if (this.read(key) !== undefined) this.remove(key)
      }
    }
  }

  /**
   * 策略变了：按每条连接升级时的事实重判 socket 与升级请求两道门，新被拒的以 1008 断开（原因是规则的话，截到
   * WebSocket 关闭原因的长度上限内）
   */
  recheckConnections(): void {
    if (!this.routes.security) return
    for (const connection of this.transport.connections()) {
      const facts = connection.facts
      if (!facts) continue
      let verdict: GateVerdict = this.gate.judgeSocket(facts.peer)
      if (verdict.allowed) {
        verdict = this.gate.judgeRequest(facts.peer, facts.http, {
          method: 'GET',
          path: '/ws',
          query: {},
          route: 'socket'
        })
      }
      if (verdict.allowed) continue
      log.info(`network: client ${connection.client.id} is no longer allowed; disconnecting it`)
      connection.close(
        1008,
        truncateCloseReason(verdict.message ?? 'Refused by a security policy.')
      )
    }
  }

  /** 按设置对一次账（排队：同一时刻只有一次在跑；从不拒绝） */
  reconcile(): Promise<void> {
    const next = this.queue.then(() => this.reconcileNow())
    this.queue = next.catch(() => undefined)
    return this.queue
  }

  private async stopListening(reason: string): Promise<void> {
    await this.server.stop(reason)
    if (this.policyTimer !== undefined) clearInterval(this.policyTimer)
    this.policyTimer = undefined
  }

  private async reconcileNow(): Promise<void> {
    if (this.stopped) return
    const { enabled, port } = this.wanted()
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
    if (current === port) return
    if (current !== undefined) await this.stopListening('network port changed')
    try {
      await this.server.start(port, this.deps.host ?? NETWORK_BIND_ADDRESS)
      this.error = undefined
      // 开着的时候定时核策略目录：agent 的 write、外部编辑器、拷进来的文件都不经过应用，连着但不发请求的
      // 客户端又一直在收推送 —— 没有这一下，新加的 deny 要等它下一次请求才生效
      const refreshMs = this.deps.policyRefreshMs ?? POLICY_REFRESH_MS
      this.policyTimer = setInterval(() => {
        try {
          this.routes.security?.refreshPolicies()
        } catch (error) {
          log.warn(`network: policy refresh failed: ${String(error)}`)
        }
      }, refreshMs)
      this.policyTimer.unref?.()
    } catch (error) {
      this.error = listenErrorOf(error)
      log.warn(`network: could not listen on port ${port}: ${this.error}`)
    }
    this.changed()
  }

  /** 该不该开、开在哪个端口：无头运行 → 强制开着、固定端口；否则按设置 */
  private wanted(): { enabled: boolean; port: number } {
    if (this.headless !== undefined) return { enabled: true, port: this.headless.port }
    return {
      enabled: isNetworkEnabledValue(this.read(NETWORK_ENABLED_KEY)),
      port: parseNetworkPort(this.read(NETWORK_PORT_KEY))
    }
  }

  /** 此刻的状态（`network:status`） */
  status(): NetworkStatus {
    const { enabled, port } = this.wanted()
    const listeningPort = this.server.port
    const clients: NetworkClientInfo[] = this.transport.connections().map((c) => ({
      id: c.client.id,
      remoteAddress: c.client.remoteAddress,
      userAgent: c.client.userAgent,
      device: c.client.device ?? '',
      connectedAt: c.connectedAt
    }))
    let admission: NetworkAdmission = 'builtin'
    try {
      admission = this.routes.security?.admission() ?? 'builtin'
    } catch (error) {
      log.warn(`network: could not read the admission policy state: ${String(error)}`)
    }
    return {
      enabled,
      port,
      listening: listeningPort !== undefined,
      // 内置准入只放这台电脑：只列 127.0.0.1（局域网地址列出来也打不开）；替换 / 停用之后列每个私有接口
      addresses:
        listeningPort === undefined
          ? []
          : admission === 'builtin'
            ? [`http://${LOOPBACK_ADDRESS}:${listeningPort}`]
            : listenAddresses(listeningPort, (this.deps.interfaces ?? networkInterfaces)()),
      clients,
      admission,
      denials: this.denials.recent(STATUS_DENIALS),
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

  /** 退出：停止监听、断开每个客户端，之后不再跟着设置走 */
  async shutdown(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.denialTimer !== undefined) clearTimeout(this.denialTimer)
    this.denialTimer = undefined
    await this.queue
    this.stopped = true
    await this.stopListening('ShuviX is quitting')
  }
}

/** WebSocket 关闭原因至多 123 字节（UTF-8）：超了按字符截、末尾加省略号，不劈开多字节字符 */
export function truncateCloseReason(reason: string): string {
  const max = 123
  if (Buffer.byteLength(reason) <= max) return reason
  let out = ''
  for (const char of reason) {
    if (Buffer.byteLength(`${out}${char}…`) > max) break
    out += char
  }
  return `${out}…`
}

/** 主进程唯一的网络服务 */
export const networkService = new NetworkService()

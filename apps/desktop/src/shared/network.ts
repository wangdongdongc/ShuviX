/**
 * 网络访问（server mode phase B，docs/server/phase-bc-network-and-web.md §B1）—— 主进程的网络服务与设置页
 * 共用的那一点：三个设置键、端口的取值规则、状态的形状。纯数据 + 小函数，preload / 渲染层 / 主进程都能引。
 *
 * 规则（用户裁决）：**缺省关**，只有字面量 `'true'` 才开；端口缺省 7766，必须是 1024–65535 的整数，
 * 读到不合法的值一律按缺省。
 *
 * **两个开关**（用户裁决 2026-10-14）：「网络访问」开着时缺省**只监听 127.0.0.1**（只有这台电脑能连，别处经 SSH
 * 隧道）；另一个开关「允许局域网里的其他设备」（`network.lan`，同样只有字面量 `'true'` 才开）开着才监听 0.0.0.0 ——
 * 那时局域网里的任何人都能完全控制这台电脑（这一轮没有认证），所以设置页把风险写在明面上。
 *
 * **只开放给一个网络**（用户需求 2026-10-15）：局域网开关开着时，`network.lanInterface` 可以指定一块网卡（`eth1`）
 * 或这台电脑上的一个地址（`192.168.50.10`）—— 那时只在那个地址上监听，并且只接受那个网段里的对端；空 = 所有网络。
 * 无头运行由启动参数 `--bind` 定。
 */

/** 设置键：网络访问开关（只有 `'true'` 开） */
export const NETWORK_ENABLED_KEY = 'network.enabled'

/** 设置键：监听端口 */
export const NETWORK_PORT_KEY = 'network.port'

/** 设置键：允许局域网里的其他设备（只有 `'true'` 开；关 → 只监听 127.0.0.1） */
export const NETWORK_LAN_KEY = 'network.lan'

/** 设置键：局域网开关开着时只开放给哪个网络（网卡名或本机地址；缺失 / 空 = 所有网络） */
export const NETWORK_LAN_INTERFACE_KEY = 'network.lanInterface'

/** 状态里 `error` 的取值：指定的网卡 / 地址在这台电脑上找不到 */
export const NETWORK_ERROR_NO_INTERFACE = 'ENOINTERFACE'

/** 只给这台电脑：监听的地址 */
export const LOOPBACK_BIND_ADDRESS = '127.0.0.1'

/** 局域网共享：监听的地址（所有接口） */
export const LAN_BIND_ADDRESS = '0.0.0.0'

/** 缺省端口 */
export const DEFAULT_NETWORK_PORT = 7766

/** 端口下限（不碰特权端口） */
export const MIN_NETWORK_PORT = 1024

/** 端口上限 */
export const MAX_NETWORK_PORT = 65535

/** 设置里的开关值 → 开不开（只有字面量 `'true'` 开；缺失 / 其余一律关） */
export function isNetworkEnabledValue(raw: string | null | undefined): boolean {
  return raw === 'true'
}

/** 设置里的局域网开关值 → 开不开（只有字面量 `'true'` 开；缺失 / 其余一律关） */
export function isNetworkLanValue(raw: string | null | undefined): boolean {
  return raw === 'true'
}

/**
 * 能不能当「只开放给哪个网络」的值：1–64 个字符，只含网卡名与 IP 字面量会用到的字符（ASCII 字母数字 `_ . : -`），
 * 不以 `-` 开头。这个值会进 systemd 服务文件与命令行，所以不认空白、shell 元字符，也不认 `%`（systemd 的说明符；
 * 带 zone 的链路本地地址本来也用不上 —— 给网卡名）
 */
export function isValidLanInterfaceSpec(spec: unknown): spec is string {
  return typeof spec === 'string' && /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,63}$/.test(spec)
}

/**
 * 设置里的值 → 指定的网络（缺失 / 空白 → undefined = 所有网络）。**不合法的值原样返回**：它落不到任何网卡上，
 * 网络服务因此不监听（`ENOINTERFACE`）—— 宁可关着，也不退回到所有网络
 */
export function parseLanInterfaceValue(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 这个数能不能当端口用（1024–65535 的整数） */
export function isValidNetworkPort(port: unknown): port is number {
  return (
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= MIN_NETWORK_PORT &&
    port <= MAX_NETWORK_PORT
  )
}

/** 设置里的端口值 → 端口（只认十进制整数串；不合法 / 缺失 → 缺省） */
export function parseNetworkPort(raw: string | null | undefined): number {
  if (typeof raw !== 'string' || !/^\s*\d+\s*$/.test(raw)) return DEFAULT_NETWORK_PORT
  const port = Number(raw.trim())
  return isValidNetworkPort(port) ? port : DEFAULT_NETWORK_PORT
}

/** 一个连着的网络客户端（设置页的列表） */
export interface NetworkClientInfo {
  /** `ws:<n>` */
  readonly id: string
  /** 对端地址（IPv4 映射的 IPv6 已拆开） */
  readonly remoteAddress: string
  /** 浏览器的 User-Agent（没有 → 空串） */
  readonly userAgent: string
  /** 连上的时刻（毫秒时间戳） */
  readonly connectedAt: number
}

/** 一个可以开放给的网络（设置页的选项、状态里正在开放的那一个） */
export interface NetworkLanInfo {
  /** 网卡名 */
  readonly interface: string
  /** 这块网卡上的地址 */
  readonly address: string
  /** 网段（`192.168.50.10/24`） */
  readonly cidr: string
}

/** `network:status` 的回包 */
export interface NetworkStatus {
  /** 设置里开没开 */
  readonly enabled: boolean
  /** 设置里的端口（不合法时是缺省） */
  readonly port: number
  /** 允许局域网里的其他设备（设置 `network.lan`；无头运行时是启动参数 `--lan`） */
  readonly lan: boolean
  /**
   * 局域网开关开着时只开放给哪个网络（设置 `network.lanInterface`；无头运行时是 `--bind`）—— 网卡名或本机地址，
   * 原样；所有网络 → 没有这一项
   */
  readonly lanInterface?: string
  /** 此刻正只开放给的那个网络（指定了网络且真在监听时）；否则没有这一项 */
  readonly lanNetwork?: NetworkLanInfo
  /** 能挑的网络：每块非内部网卡的第一个私有 IPv4 地址（设置页的选项） */
  readonly lanCandidates: NetworkLanInfo[]
  /** 此刻真正监听的地址（`127.0.0.1` / `0.0.0.0` / 指定网络的地址）；没在监听 → 没有这一项 */
  readonly bindAddress?: string
  /** 此刻是否真在监听（开着但端口被占 → false，见 `error`） */
  readonly listening: boolean
  /**
   * 能用来打开的地址：只给这台电脑 → 只有 `http://127.0.0.1:<port>`；局域网共享 → 每个非内部的私有 IPv4 接口一条，
   * 外加 `http://127.0.0.1:<port>`；只开放给一个网络 → 只有那个地址；没在监听 → 空
   */
  readonly addresses: string[]
  /** 连着的客户端 */
  readonly clients: NetworkClientInfo[]
  /** 监听失败的原因（端口被占 …；指定的网络找不到 → `NETWORK_ERROR_NO_INTERFACE`）；没出错 → 没有这一项 */
  readonly error?: string
  /**
   * 无头运行（`shuvix --headless`，docs/headless/design.md）：网络访问强制开着、端口与局域网共享由命令行定（`--port` /
   * `--lan`），设置页的开关、端口与局域网开关因此锁住（关掉 / 换端口 / 换共享一律拒绝）。桌面应用 → 没有这一项
   */
  readonly headless?: true
}

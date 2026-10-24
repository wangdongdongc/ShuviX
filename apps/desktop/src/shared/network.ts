/**
 * 网络访问（server mode phase B，docs/server/phase-bc-network-and-web.md §B1；网络策略 docs/network-policy/design.md）
 * —— 主进程的网络服务与设置页共用的那一点：两个设置键、端口的取值规则、状态的形状。纯数据 + 小函数，preload /
 * 渲染层 / 主进程都能引。
 *
 * 规则（用户裁决）：**缺省关**，只有字面量 `'true'` 才开；端口缺省 7766，必须是 1024–65535 的整数，
 * 读到不合法的值一律按缺省。
 *
 * **谁能连由安全策略定**（用户裁决 2026-10-19）：开着时一律监听 0.0.0.0，内置策略 `network-admission` 只放这台
 * 电脑（127.0.0.1 / ::1）。要让别的设备连进来，写一份同名的用户策略替换它 —— 一个或几个网段、指定的设备、只读的
 * 设备……都由策略表达。从前的「允许局域网里的其他设备」开关（`network.lan`）与「开放给」网卡（`network.lanInterface`）
 * 已经去掉；旧设置在启动时迁移成一份 network-admission 策略（见 frontend/network/admissionMigration.ts）后删掉。
 */

/** 设置键：网络访问开关（只有 `'true'` 开） */
export const NETWORK_ENABLED_KEY = 'network.enabled'

/** 设置键：监听端口 */
export const NETWORK_PORT_KEY = 'network.port'

/** 旧设置键：允许局域网里的其他设备（只为迁移读一次，迁移后删掉） */
export const LEGACY_NETWORK_LAN_KEY = 'network.lan'

/** 旧设置键：只开放给哪个网络（网卡名或本机地址；只为迁移读一次，迁移后删掉） */
export const LEGACY_NETWORK_LAN_INTERFACE_KEY = 'network.lanInterface'

/** 监听的地址：所有接口（谁能进由策略定） */
export const NETWORK_BIND_ADDRESS = '0.0.0.0'

/** 这台电脑的地址（列出的地址里总有它） */
export const LOOPBACK_ADDRESS = '127.0.0.1'

/** 管谁能连的那份策略的名字（内置一份，用户写同名文件替换） */
export const NETWORK_ADMISSION_POLICY = 'network-admission'

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

/**
 * 旧的「只开放给哪个网络」值（网卡名或本机地址）是否可以迁移：1–64 个字符，只含网卡名与 IP 字面量会用到的
 * 字符（ASCII 字母数字 `_ . : -`），不以 `-` 开头。迁移把它写进策略的 CEL 字符串字面量里，所以不认引号、空白、
 * 反斜杠与其余一切
 */
export function isValidLanInterfaceSpec(spec: unknown): spec is string {
  return typeof spec === 'string' && /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,63}$/.test(spec)
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
  /** 浏览器的设备 ID（`shuvix_device` cookie；没有 → 空串）—— 策略里的 `subject.device` */
  readonly device: string
  /** 连上的时刻（毫秒时间戳） */
  readonly connectedAt: number
}

/** 一次（或一分钟内合并的几次）网络点位上的拒绝（设置页「最近拒绝」） */
export interface NetworkDenialInfo {
  /** 第一次的时刻 */
  readonly at: number
  /** 最近一次的时刻 */
  lastAt: number
  /** 合并了几次 */
  count: number
  /** 哪个阶段（策略里的 object.type） */
  readonly stage: 'socket' | 'request' | 'channel' | 'path'
  /** 对象摘要：`GET /`、`session:prompt`、`read /Users/…` */
  readonly summary: string
  /** 这次请求的 scope（策略里的 object.scope；socket 阶段没有 → 空串） */
  readonly scope: string
  readonly address: string
  /** 设备 ID（没有 → 空串） */
  readonly device: string
  /** 胜出的规则（`network-admission#0`；判定出错 → `error`） */
  readonly rule: string
  /** 带话的策略显示名 */
  readonly policies: string[]
  /** 策略说的是「询问」，网络点位没人可问，按拒绝处置 */
  readonly downgraded: boolean
}

/**
 * 管谁能连的那份策略此刻的状态：`builtin` = 生效的是内置那份（只放这台电脑）；`override` = 用户的同名策略
 * 替换了它；`disabled` = 生效的那份被停用了（局域网里的任何设备都能连）
 */
export type NetworkAdmission = 'builtin' | 'override' | 'disabled'

/** `network:status` 的回包 */
export interface NetworkStatus {
  /** 设置里开没开 */
  readonly enabled: boolean
  /** 设置里的端口（不合法时是缺省） */
  readonly port: number
  /** 此刻是否真在监听（开着但端口被占 → false，见 `error`） */
  readonly listening: boolean
  /**
   * 能用来打开的地址：内置准入（`admission: 'builtin'`）只放这台电脑 → 只有 `http://127.0.0.1:<port>`；替换 / 停用
   * 之后 → 每个非内部的私有 IPv4 接口一条，外加 `http://127.0.0.1:<port>`（具体哪些设备能进由策略定）；没在监听 → 空
   */
  readonly addresses: string[]
  /** 连着的客户端 */
  readonly clients: NetworkClientInfo[]
  /** network-admission 此刻的状态（设置页据此给引导） */
  readonly admission: NetworkAdmission
  /** 最近的拒绝（新 → 旧，至多 20 条） */
  readonly denials: NetworkDenialInfo[]
  /** 监听失败的原因（端口被占 …）；没出错 → 没有这一项 */
  readonly error?: string
  /**
   * 无头运行（`shuvix --headless`，docs/headless/design.md）：网络访问强制开着、端口由命令行定（`--port`），
   * 设置页的开关与端口因此锁住（关掉 / 换端口一律拒绝）。桌面应用 → 没有这一项
   */
  readonly headless?: true
}

/** 一条 TCP 连接的事实（来自 socket；可信）—— 网络策略的 `subject.address` / `port` / `localAddress` … */
export interface PeerFacts {
  readonly address: string
  readonly port: number
  readonly localAddress: string
  readonly localPort: number
  readonly family: 'ipv4' | 'ipv6'
}

/** 一个 HTTP 请求带来的事实（客户端自己说的）—— 网络策略的 `subject.headers` / `device` / `userAgent` */
export interface HttpFacts {
  /** 全部请求头，键小写；同名多值以 `, ` 连接 */
  readonly headers: Readonly<Record<string, string>>
  /** 浏览器带来的设备 ID；没有 → 空串 */
  readonly device: string
  readonly userAgent: string
}

/** 网络客户端一条 WebSocket 连接的事实（升级那一刻的）：处理函数按策略判路径时用 */
export interface NetworkCallFacts {
  readonly peer: PeerFacts
  readonly http: HttpFacts
}

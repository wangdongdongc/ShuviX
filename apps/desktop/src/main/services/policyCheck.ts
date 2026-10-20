/**
 * `shuvix policy check` —— agent 自己核对一份远程访问策略（2026-10-19，设计 docs/network-policy/dry-run-design.md）。
 *
 * 实测里廉价模型写准入策略会漏设备：规则语法全对、解析器不报错，agent 无从知道。这里给它一条命令：
 *
 *   - 不带请求参数 → **默认核对表**：行是用真实数据凑的设备（这台电脑、此刻连着的、最近被拒的、一个外网地址），
 *     列是四种用法（打开页面 / 读 / 写 / 管理），格子是判定。agent 不必知道有哪些属性，对着用户的需求看表即可。
 *   - 带 `--from` / `--device` → **单个请求**：经过的每个点位的判定、胜出规则与它的话、求值出错的规则；
 *     `--expect` 对不上 → 退出码 1。
 *
 * 「按装进去之后算」：给了文件，它顶替 `~/.shuvix/policies/` 里同文件名的那份（没有就是新加一份）—— 草稿
 * 可以先在会话目录里查，查对了再装（装错的准入策略一生效，远程对话的这台设备当场就断了）。判定走真实那条路：
 * 主体 / 客体由 `NetworkPolicyGate` 本身构造（同一份代码，只换 contextFor、不记拒绝记录），引擎、变量、内置、
 * 停用开关都由宿主的 contextFor 给（toolContext.getDesktopNetworkSecurityContext 的 trial 形态）。
 *
 * 纯逻辑：策略、网络状态、网卡表、安全上下文都经 deps 注入（cliServer 接线），单测拿真实引擎跑。
 * 第一版只管网络主体（用户裁定）。
 */
import { basename, isAbsolute, join } from 'path'
import type { networkInterfaces } from 'os'
import {
  ipInCidrs,
  parseIp,
  parsePolicyDefinitionFile,
  resolvePolicyFiles,
  type GateVerdict,
  type ParsedPolicyFile,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import {
  DEVICE_COOKIE,
  NetworkPolicyGate,
  channelGroupOf,
  httpFactsOf,
  requestRouteOf,
  requestTarget,
  type HttpFacts,
  type NetworkSecurityContextFor,
  type PeerFacts
} from '../frontend/network/policyGate'
import { CHANNEL_ACCESS, channelAccessOf } from '../../shared/channelAccess'
import { NETWORK_ADMISSION_POLICY, type NetworkStatus } from '../../shared/network'
import { NETWORK_WS_PATH } from '../../shared/networkEnvelope'
import { namesNetwork } from './policyCheckHint'

type Interfaces = ReturnType<typeof networkInterfaces>

/** 告警收集器（provider.logger 的形状） */
export interface CheckLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface PolicyCheckDeps {
  /** `~/.shuvix/policies` */
  policiesDir: string
  /** 家目录（输出里缩成 `~`）；省略 = 原样 */
  home?: string
  /** 此刻的用户策略（新扫的，含同名的几份） */
  userPolicies(): UserPolicyFile[]
  /** 内置策略（装配用的那批） */
  builtinPolicies(): ParsedPolicyFile[]
  /** 停用开关 */
  isDisabled(policy: ParsedPolicyFile): boolean
  /** 用给定的用户策略清单建网络主体的安全上下文；告警交给 logger */
  contextFor(userPolicies: UserPolicyFile[], logger: CheckLogger): NetworkSecurityContextFor
  /** 网络状态里用得到的那几项 */
  status(): Pick<NetworkStatus, 'port' | 'clients' | 'denials'>
  interfaces(): Interfaces
}

export interface PolicyCheckParams {
  /** CLI 读到的文件（绝对路径 + 全文）；省略 = 查此刻生效的那套 */
  file?: { path: string; text: string }
  /** `--name value` 原样成对（值缺省为空串）；校验在这里做，一份规则 */
  flags: Array<[string, string]>
}

export interface PolicyCheckResult {
  stdout: string
  stderr: string
  /** 0 = 查完 / 符合期望；1 = 不符合 --expect；2 = 用法或文件错误 */
  exitCode: 0 | 1 | 2
}

export const POLICY_CHECK_FLAGS = [
  'from',
  'device',
  'page',
  'channel',
  'read',
  'write',
  'expect'
] as const

export const POLICY_CHECK_USAGE = [
  'Usage: shuvix policy check [<file>] [--from <ip>] [--device <id>]',
  '                           [--page [<path>] | --channel <name> | --read <path> | --write <path>]',
  '                           [--expect allow|deny]',
  '',
  '  <file>            a policy .md to check as if it were installed in ~/.shuvix/policies',
  '                    (it replaces the file of the same name there); omit to check what is in effect now',
  '  (no request)      a table: this computer, connected and recently refused devices, an outside address',
  '                    × page / read / write / admin',
  '  --from <ip>       the address of the device asking',
  '  --device <id>     its device ID (Settings → General → Network access)',
  '  --page [<path>]   open a page (default /)',
  '  --channel <name>  call a channel, e.g. session:list (see the network-channels knowledge entry)',
  '  --read <path>     read a file through files:read (absolute path)',
  '  --write <path>    write a file through files:write (absolute path)',
  '  --expect allow|deny   exit 1 when the result differs'
].join('\n')

/** 默认核对表的列：用法 → 代表通道（page 列只走到 /ws 升级） */
const COLUMNS: ReadonlyArray<{ label: string; channel?: string }> = [
  { label: 'page' },
  { label: 'read', channel: 'session:list' },
  { label: 'write', channel: 'session:create' },
  { label: 'admin', channel: 'settings:set' }
]

/** 外网样例（文档保留段）；只给设备时的地址（同解析期试算的样例） */
const OUTSIDE_ADDRESS = '203.0.113.9'
const DEFAULT_ADDRESS = '192.0.2.10'
const LOOPBACK = '127.0.0.1'
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/
/** 合成请求的对端端口（随便一个临时端口；没有规则会认它） */
const PEER_PORT = 50000
const WS_PATH = NETWORK_WS_PATH
const CONNECTION = 'ws:check'

class UsageError extends Error {}

type Target =
  | { kind: 'page'; path: string }
  | { kind: 'channel'; channel: string }
  | { kind: 'read' | 'write'; path: string }

interface Step {
  stage: 'socket' | 'request' | 'channel' | 'path'
  label: string
  verdict: GateVerdict
  errors: string[]
}

export function runPolicyCheck(
  params: PolicyCheckParams,
  deps: PolicyCheckDeps
): PolicyCheckResult {
  try {
    return check(params, deps)
  } catch (error) {
    if (error instanceof UsageError) {
      return { stdout: '', stderr: `${error.message}\n\n${POLICY_CHECK_USAGE}\n`, exitCode: 2 }
    }
    throw error
  }
}

function check(params: PolicyCheckParams, deps: PolicyCheckDeps): PolicyCheckResult {
  if (params.flags.some(([name]) => name === 'help')) {
    return { stdout: `${POLICY_CHECK_USAGE}\n`, stderr: '', exitCode: 0 }
  }
  const flags = readFlags(params.flags)
  const request = readRequest(flags)
  const out: string[] = []
  const tilde = (p: string): string =>
    deps.home && (p === deps.home || p.startsWith(`${deps.home}/`))
      ? `~${p.slice(deps.home.length)}`
      : p

  // ── 用户策略：给了文件就顶替同文件名的那份 ──
  const current = deps.userPolicies()
  let users = current
  let checked: ParsedPolicyFile | null = null
  if (params.file) {
    const fileName = basename(params.file.path)
    if (!fileName.toLowerCase().endsWith('.md')) {
      throw new UsageError(
        `${fileName}: policy files must end in .md (ShuviX only reads .md files in ~/.shuvix/policies)`
      )
    }
    const reasons: string[] = []
    const parsed = parsePolicyDefinitionFile(params.file.text, fileName.slice(0, -3), (m) =>
      reasons.push(m)
    )
    const installedPath = join(deps.policiesDir, fileName)
    if (!parsed) {
      return {
        stdout: '',
        stderr:
          `${tilde(params.file.path)} is not a valid policy file, so ShuviX would ignore it:\n` +
          reasons.map((r) => `- ${r}`).join('\n') +
          '\n',
        exitCode: 2
      }
    }
    checked = parsed
    const replaces = current.some((p) => p.fileName === fileName)
    users = [...current.filter((p) => p.fileName !== fileName), { ...parsed, fileName }]
    out.push(
      params.file.path === installedPath
        ? `Checked ${tilde(installedPath)} (installed).`
        : `Checked ${tilde(params.file.path)} as if installed at ${tilde(installedPath)}` +
            (replaces ? ' (it replaces the file there).' : ' (a new file there).')
    )
    if (reasons.length > 0) {
      out.push('Parser warnings:', ...reasons.map((r) => `- ${r}`))
    }
  } else {
    out.push('Checked the policies in effect now.')
  }

  // ── 生效的网络策略 + 常见陷阱 ──
  const effective = resolvePolicyFiles(deps.builtinPolicies(), users).filter(
    (entry) => !entry.shadowedBy
  )
  const network = effective.filter((entry) => namesNetwork(entry.policy))
  const describe = (entry: (typeof effective)[number]): string => {
    const off = deps.isDisabled(entry.policy) ? ', turned off' : ''
    return entry.sourceKind === 'builtin'
      ? `${entry.policy.name} (built-in${off})`
      : `${entry.policy.name} (your file ${entry.fileName ?? `${entry.policy.name}.md`}${off})`
  }
  out.push(
    network.length > 0
      ? `Network policies: ${network.map(describe).join(', ')}`
      : 'Network policies: none — every device that can reach this computer gets in.'
  )
  const builtinAdmission = effective.find(
    (entry) =>
      entry.policy.name === NETWORK_ADMISSION_POLICY &&
      entry.sourceKind === 'builtin' &&
      !deps.isDisabled(entry.policy)
  )
  if (
    checked &&
    builtinAdmission &&
    checked.name !== NETWORK_ADMISSION_POLICY &&
    allowsNetwork(checked)
  ) {
    out.push(
      `Note: allow rules cannot override a deny, and the built-in ${NETWORK_ADMISSION_POLICY} still refuses ` +
        `every address but this computer. To let devices in, name this policy \`${NETWORK_ADMISSION_POLICY}\` ` +
        `(file ${NETWORK_ADMISSION_POLICY}.md) so it replaces the built-in one.`
    )
  }
  out.push('')

  // ── 判定 ──
  const warnings: string[] = []
  const logger: CheckLogger = {
    info: () => {},
    // 网络主体没有会话目录：agent 路径策略里那几个目录变量缺席的告警与网络无关，每次核对都冒出来只是噪音
    warn: (m) => {
      if (!m.includes('is not provided by the host')) warnings.push(m)
    },
    error: (m) => warnings.push(m)
  }
  const contextFor = deps.contextFor(users, logger)
  const gate = new NetworkPolicyGate({ contextFor: () => contextFor, interfaces: deps.interfaces })
  const status = deps.status()
  const facts = new FactMaker(status.port, deps.interfaces())
  const judge = (stage: Step['stage'], label: string, run: () => GateVerdict): Step => {
    const before = warnings.length
    const verdict = run()
    return { stage, label, verdict, errors: warnings.slice(before) }
  }
  const walk = (address: string, device: string, userAgent: string, target: Target): Step[] => {
    const peer = facts.peer(address)
    const http = facts.http(peer, device, userAgent)
    const steps: Step[] = []
    const add = (step: Step): boolean => {
      steps.push(step)
      return step.verdict.allowed
    }
    if (!add(judge('socket', 'connect', () => gate.judgeSocket(peer)))) return steps
    const pagePath = target.kind === 'page' ? target.path : WS_PATH
    const { path, query } = requestTarget(pagePath)
    const route = requestRouteOf(path, pagePath === WS_PATH)
    if (
      !add(
        judge('request', `GET ${pagePath}`, () =>
          gate.judgeRequest(peer, http, { method: 'GET', path, query, route })
        )
      )
    ) {
      return steps
    }
    if (target.kind === 'page') {
      // 页面打开之后还得连上 /ws，不然什么也做不了
      if (route === 'page') {
        add(
          judge('request', `GET ${WS_PATH}`, () =>
            gate.judgeRequest(peer, http, {
              method: 'GET',
              path: WS_PATH,
              query: {},
              route: 'socket'
            })
          )
        )
      }
      return steps
    }
    const channel =
      target.kind === 'channel'
        ? target.channel
        : target.kind === 'read'
          ? 'files:read'
          : 'files:write'
    const channelLabel = `invoke ${channel} (group ${channelGroupOf(channel) || '—'}, access ${channelAccessOf(channel)})`
    if (
      !add(
        judge('channel', channelLabel, () =>
          gate.judgeChannel(peer, http, CONNECTION, { channel, kind: 'invoke', size: 64, args: [] })
        )
      )
    ) {
      return steps
    }
    if (target.kind === 'read' || target.kind === 'write') {
      const mode = target.kind
      add(
        judge('path', `${mode} ${target.path}`, () =>
          gate.judgePath(peer, http, CONNECTION, mode, target.path, {
            name: 'files',
            operation: mode
          })
        )
      )
    }
    return steps
  }

  if (request) {
    const steps = walk(request.address, request.device, '', request.target)
    const final = steps[steps.length - 1]
    const result = final.verdict.allowed ? 'allow' : 'deny'
    out.push(
      `Request: ${request.address}${request.device ? ` · device ${request.device}` : ''} → ${describeTarget(request.target)}`
    )
    for (const step of steps) out.push(`  ${step.stage.padEnd(8)} ${stepLine(step)}`)
    for (const error of unique(steps.flatMap((s) => s.errors))) out.push(`  ! ${error}`)
    out.push(`Result: ${result}`)
    if (request.expect) {
      if (request.expect === result) {
        out.push(`As expected (${request.expect}).`)
      } else {
        const why = final.verdict.allowed
          ? 'no rule refused it'
          : `${ruleOf(final.verdict)} refused it at the ${final.stage} step`
        out.push(
          `NOT as expected: expected ${request.expect}, got ${result} — ${why}. Fix the rule ` +
            `(or the expectation, if this is what the user wants).`
        )
        return { stdout: out.join('\n') + '\n', stderr: '', exitCode: 1 }
      }
    }
    return { stdout: out.join('\n') + '\n', stderr: '', exitCode: 0 }
  }

  // ── 默认核对表 ──
  const rows = devicesOf(status)
  const table: string[][] = [['', '', ...COLUMNS.map((c) => c.label), '']]
  const errors: string[] = []
  for (const row of rows) {
    const cells: string[] = []
    const refusedBy = new Map<string, string[]>()
    for (const column of COLUMNS) {
      const target: Target = column.channel
        ? { kind: 'channel', channel: column.channel }
        : { kind: 'page', path: '/' }
      const steps = walk(row.address, row.device, row.userAgent, target)
      const final = steps[steps.length - 1]
      const failed = steps.flatMap((s) => s.errors)
      errors.push(...failed)
      if (final.verdict.allowed) {
        cells.push('allow')
        continue
      }
      const errored =
        final.verdict.decision.winning === 'error' || final.errors.some(isEvaluationFailure)
      cells.push(errored ? 'ERROR' : 'deny')
      const rule = ruleOf(final.verdict)
      refusedBy.set(rule, [...(refusedBy.get(rule) ?? []), column.label])
    }
    const note =
      refusedBy.size === 0
        ? ''
        : refusedBy.size === 1
          ? `← ${[...refusedBy.keys()][0]}`
          : `← ${[...refusedBy.entries()].map(([rule, cols]) => `${cols.join('/')}: ${rule}`).join('; ')}`
    table.push([row.label, row.address, ...cells, note])
  }
  out.push(...formatTable(table))
  out.push(
    '',
    'page = open the app (GET /, then the /ws connection); read = session:list; write = session:create; ' +
      'admin = settings:set.',
    'Compare every row with what the user asked for. Check a specific request with ' +
      '--from <ip> [--device <id>] --channel <name> | --page <path> | --read <path> | --write <path> ' +
      '[--expect allow|deny].'
  )
  const failures = unique(errors.filter(isEvaluationFailure))
  const others = unique(errors.filter((e) => !isEvaluationFailure(e)))
  if (failures.length > 0) {
    out.push(
      '',
      'Rules that failed to evaluate (a failing deny counts as matched, so it refuses every such request):',
      ...failures.map((e) => `- ${e}`)
    )
  }
  if (others.length > 0) out.push('', 'Policy engine warnings:', ...others.map((e) => `- ${e}`))
  return { stdout: out.join('\n') + '\n', stderr: '', exitCode: 0 }
}

// ─────────────────────────── 参数 ───────────────────────────

function readFlags(pairs: Array<[string, string]>): Map<string, string> {
  const known: readonly string[] = POLICY_CHECK_FLAGS
  const flags = new Map<string, string>()
  for (const [name, value] of pairs) {
    if (!known.includes(name)) {
      throw new UsageError(
        `Unknown option --${name}. Options: ${POLICY_CHECK_FLAGS.map((f) => `--${f}`).join(', ')}.`
      )
    }
    if (flags.has(name))
      throw new UsageError(`--${name} is given twice; check one request at a time.`)
    flags.set(name, value)
  }
  return flags
}

interface CheckRequest {
  address: string
  device: string
  target: Target
  expect?: 'allow' | 'deny'
}

function readRequest(flags: Map<string, string>): CheckRequest | null {
  const targets = (['page', 'channel', 'read', 'write'] as const).filter((t) => flags.has(t))
  const from = flags.get('from')
  const device = flags.get('device')
  const expect = flags.get('expect')
  if (from === undefined && device === undefined) {
    if (targets.length > 0 || expect !== undefined) {
      throw new UsageError(
        'Say who is asking: --from <ip> (and --device <id> when the policy matches devices).'
      )
    }
    return null
  }
  if (from !== undefined && !parseIp(from)) {
    throw new UsageError(`--from must be an IP address such as 192.168.1.23 (got '${from}').`)
  }
  if (device !== undefined && !DEVICE_ID_RE.test(device)) {
    throw new UsageError(
      `--device must be a ShuviX device ID: 22 letters, digits, - or _, as listed in Settings → General → ` +
        `Network access (got '${device}').`
    )
  }
  if (targets.length > 1) {
    throw new UsageError(
      `Give one of --page, --channel, --read, --write (got ${targets.map((t) => `--${t}`).join(', ')}).`
    )
  }
  let target: Target = { kind: 'page', path: '/' }
  const kind = targets[0]
  if (kind === 'page') {
    const path = flags.get('page') || '/'
    if (!path.startsWith('/'))
      throw new UsageError(`--page takes a path starting with / (got '${path}').`)
    target = { kind: 'page', path }
  } else if (kind === 'channel') {
    const channel = flags.get('channel') ?? ''
    if (!isKnownChannel(channel)) {
      const near = nearestChannels(channel)
      throw new UsageError(
        `Unknown channel '${channel}'.` +
          (near.length > 0 ? ` Did you mean ${near.join(', ')}?` : '') +
          ' The network-channels knowledge entry lists every channel.'
      )
    }
    target = { kind: 'channel', channel }
  } else if (kind === 'read' || kind === 'write') {
    const path = flags.get(kind) ?? ''
    if (!isAbsolute(path)) {
      throw new UsageError(`--${kind} takes an absolute path (got '${path}').`)
    }
    target = { kind, path }
  }
  if (expect !== undefined && expect !== 'allow' && expect !== 'deny') {
    throw new UsageError(
      expect === 'ask'
        ? '--expect ask: network checks cannot ask anyone (an ask refuses), so expect allow or deny.'
        : `--expect takes allow or deny (got '${expect}').`
    )
  }
  return {
    address: from ?? DEFAULT_ADDRESS,
    device: device ?? '',
    target,
    ...(expect ? { expect } : {})
  }
}

function isKnownChannel(channel: string): boolean {
  return (
    channel !== '' && (channelGroupOf(channel) !== '' || Object.hasOwn(CHANNEL_ACCESS, channel))
  )
}

/** 拼错的通道名 → 至多三个相近的（同一命名空间优先，其余按编辑距离） */
function nearestChannels(channel: string): string[] {
  const all = Object.keys(CHANNEL_ACCESS)
  const scored = all
    .map((name) => ({ name, distance: editDistance(channel.toLowerCase(), name.toLowerCase()) }))
    .filter(({ distance }) => distance <= Math.max(3, Math.floor(channel.length / 3)))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
  return scored.slice(0, 3).map(({ name }) => name)
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[b.length]
}

// ─────────────────────────── 事实 ───────────────────────────

class FactMaker {
  constructor(
    private readonly port: number,
    private readonly interfaces: Interfaces
  ) {}

  peer(address: string): PeerFacts {
    const family = parseIp(address)?.family === 6 ? 'ipv6' : 'ipv4'
    return {
      address,
      port: PEER_PORT,
      localAddress: this.localFor(address, family),
      localPort: this.port,
      family
    }
  }

  http(peer: PeerFacts, device: string, userAgent: string): HttpFacts {
    const host = peer.family === 'ipv6' ? `[${peer.localAddress}]` : peer.localAddress
    return httpFactsOf({
      headers: {
        host: `${host}:${this.port}`,
        ...(userAgent ? { 'user-agent': userAgent } : {}),
        ...(device ? { cookie: `${DEVICE_COOKIE}=${device}` } : {})
      }
    })
  }

  /** 这台电脑会用哪个地址接这个对端：回环 → 回环；同网段的网卡；否则第一块对外的网卡 */
  private localFor(address: string, family: 'ipv4' | 'ipv6'): string {
    if (ipInCidrs(address, ['127.0.0.0/8', '::1'])) return family === 'ipv6' ? '::1' : LOOPBACK
    const entries = Object.values(this.interfaces)
      .flatMap((list) => list ?? [])
      .filter((entry) => !entry.internal && (entry.family === 'IPv6') === (family === 'ipv6'))
    const sameNet = entries.find((entry) => entry.cidr && ipInCidrs(address, [entry.cidr]))
    return (sameNet ?? entries[0])?.address ?? ''
  }
}

interface DeviceRow {
  label: string
  address: string
  device: string
  userAgent: string
}

/** 表的行：这台电脑、连着的、最近被拒的（地址 + 设备去重）、一个外网地址 */
function devicesOf(status: Pick<NetworkStatus, 'clients' | 'denials'>): DeviceRow[] {
  const rows: DeviceRow[] = [
    { label: 'this computer', address: LOOPBACK, device: '', userAgent: '' }
  ]
  const seen = new Set([`${LOOPBACK}|`])
  const add = (label: string, address: string, device: string, userAgent: string): void => {
    const key = `${address}|${device}`
    if (seen.has(key) || !parseIp(address)) return
    seen.add(key)
    rows.push({
      label: device ? `${label} ${device.slice(0, 6)}…` : label,
      address,
      device,
      userAgent
    })
  }
  for (const client of status.clients)
    add('connected', client.remoteAddress, client.device, client.userAgent)
  for (const denial of status.denials) add('refused', denial.address, denial.device, '')
  add('outside', OUTSIDE_ADDRESS, '', '')
  return rows
}

// ─────────────────────────── 输出 ───────────────────────────

function allowsNetwork(policy: ParsedPolicyFile): boolean {
  return policy.rules.some((rule) => {
    const kinds = rule.conditions?.['subject.kind'] ?? policy.scope?.['subject.kind']
    return (
      kinds?.includes('network') === true &&
      (rule.effect === 'allow' || rule.effect === 'force-allow')
    )
  })
}

/** 引擎的 fail-safe 告警：规则的 match（evaluate.ts）或策略的 let（assemble.ts）求值出错 */
function isEvaluationFailure(warning: string): boolean {
  return warning.includes('evaluation failed')
}

function ruleOf(verdict: GateVerdict): string {
  return verdict.decision.winning === 'error' ? 'ERROR' : verdict.decision.winning
}

function stepLine(step: Step): string {
  if (step.verdict.allowed) return `allow  ${step.label}`
  const message = step.verdict.decision.prompt?.text ?? step.verdict.message ?? ''
  const firstLine = message.split('\n')[0].trim()
  return `deny   ${step.label} — ${ruleOf(step.verdict)}${firstLine ? `: ${firstLine}` : ''}`
}

function describeTarget(target: Target): string {
  switch (target.kind) {
    case 'page':
      return `open ${target.path}`
    case 'channel':
      return `invoke ${target.channel}`
    default:
      return `${target.kind} ${target.path}`
  }
}

function formatTable(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)))
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i])))
      .join('  ')
      .trimEnd()
  )
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * SandboxSpec → Seatbelt profile（SBPL）。纯函数，golden 测试钉住输出。
 *
 * 用户路径一律经 `(param "…")` 传入（-D KEY=VALUE），profile 文本里只有固定内容与自增参数名 ——
 * 路径永远不会被当成 SBPL 语法或正则解释。引用的每个参数都会出现在返回的 params 里：
 * profile 引用一个未定义的参数会让整份编译失败（sandbox-exec 以 65 退出）。
 *
 * 以下行为都在 macOS 26.5.2 上逐项实测过（探针矩阵，结论记在注释里）：
 *  - **放回规则必须写与拒绝规则相同的操作名。**`(deny file-read-data …)` 之后写
 *    `(allow file-read* …)` 放不回来——具体操作压过通配。所以读的放回写 `file-read-data file-read-xattr`。
 *  - 敏感目录只拒读**内容**，不拒元数据：工作区常在 ~/Documents 下，node / python 起步时会
 *    lstat 每一级祖先，拒了元数据它们就起不来。
 *  - `signal (target same-sandbox)` 只覆盖**同一个** sandbox-exec 实例：下一条命令停不掉上一条的
 *    后台任务。**不要**加 `(target others)`：它放行的是「不在发信者自己进程组里的同用户进程」，
 *    而 bgTaskService 每条命令都 detached（自成进程组）—— 实测能杀 ShuviX 主进程、Finder。
 *    停上一条命令起的后台任务走宿主：`shuvix task stop <pid>`（bgTaskService.stopBgTaskByAgent）。
 *  - 真正拦住 osascript / open 的是 LaunchServices 的 mach 服务名（-10827）；`(deny appleevent-send)`
 *    单独挡不住。`tell application "X" to get name` 在本地作答，拿它测是假阳性。
 *  - `.git` 规则要限定在工作区 / 授权根里，否则依赖在 tmp、缓存里的 `git init` / clone 全部失败。
 *  - system.sb 是 version 3、Apple SPI，但 version 1 的 profile 可以 import；它放行 trustd、
 *    opendirectory、cfprefsd 与所有 XPC 服务查找，`(system-network)` 是要显式调用的宏。
 */
import { GIT_ENTRY_PATTERN, GIT_PATTERNS } from '../../tables'
import type { SandboxSpec } from '../../types'

export interface CompiledProfile {
  profile: string
  params: Record<string, string>
}

/** LaunchServices / AppleEvents 的入口 —— 拒了它们，open、osascript 就碰不到沙箱外的应用 */
const LAUNCH_SERVICES_MACH_NAMES = [
  'com.apple.coreservices.launchservicesd',
  'com.apple.CoreServices.coreservicesd',
  'com.apple.coreservices.appleevents',
  'com.apple.lsd.mapdb',
  'com.apple.lsd.modifydb'
]

function assertRegexSafe(pattern: string): string {
  // 正则来自 tables.ts 的固定文本；这道检查只防将来有人往里拼了东西
  if (pattern.includes('"')) throw new Error(`SBPL regex must not contain a quote: ${pattern}`)
  return pattern
}

export function compileSeatbeltProfile(spec: SandboxSpec): CompiledProfile {
  const params: Record<string, string> = {}
  let counter = 0
  /** 登记一个参数并返回它在 profile 里的引用 */
  const param = (value: string): string => {
    const key = `P${counter++}`
    params[key] = value
    return `(param "${key}")`
  }
  const subpaths = (list: readonly string[]): string =>
    list.map((p) => `(subpath ${param(p)})`).join(' ')
  const lines: string[] = []
  /** 过滤器为空时整条不写：不带过滤器的 allow / deny 会变成该操作的缺省值 */
  const rule = (head: string, filters: string): void => {
    if (filters.trim()) lines.push(`(${head} ${filters})`)
  }

  lines.push('(version 1)', '(deny default)', '(import "system.sb")')

  // ── 进程 ──
  lines.push(
    '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow mach-task-name)',
    '(allow sysctl-read)',
    '(allow pseudo-tty)',
    '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))',
    '(allow ipc-posix-sem)',
    '(allow ipc-posix-shm*)',
    '(allow file-map-executable)',
    '(system-network)'
  )

  // ── 读：全读 → 拒读敏感内容 → 放回 → 最后一层连元数据都拒 ──
  lines.push('(allow file-read*)')
  rule('deny file-read-data file-read-xattr', subpaths(spec.readDenied))
  rule('allow file-read-data file-read-xattr', subpaths(spec.readAllowBack))
  rule('deny file-read*', subpaths(spec.readDeniedFinal))

  // ── 写：可写根 → 整片拒写 → 放回 → 最后一层 ──
  rule('allow file-write*', subpaths(spec.writableRoots))
  rule('deny file-write*', subpaths(spec.writeDenied))
  rule('allow file-write*', subpaths(spec.writeAllowBack))
  const gitFilters = spec.gitRoots.flatMap((root) => {
    const ref = param(root)
    return GIT_PATTERNS.map(
      (p) => `(require-all (subpath ${ref}) (regex #"${assertRegexSafe(p.sbpl)}"))`
    )
  })
  rule(
    'deny file-write*',
    [
      subpaths(spec.writeDeniedFinal),
      ...spec.writeDeniedPatterns.map((p) => `(regex #"${assertRegexSafe(p.sbpl)}")`),
      ...gitFilters
    ].join(' ')
  )
  rule(
    'deny file-write-create file-write-unlink',
    spec.gitRoots
      .map(
        (root) =>
          `(require-all (subpath ${param(root)}) (regex #"${assertRegexSafe(GIT_ENTRY_PATTERN.sbpl)}"))`
      )
      .join(' ')
  )

  // ── 网络：IP 出站全开（产品决策），unix socket 只放行 CLI、DNS 与本会话自己的 socket ──
  lines.push(
    '(allow network-outbound (remote ip "*:*"))',
    '(allow network-bind network-inbound (local ip "*:*"))'
  )
  rule(
    'allow network-outbound',
    spec.unixSockets.map((s) => `(remote unix-socket (path-literal ${param(s)}))`).join(' ')
  )
  rule(
    'allow network-bind network-outbound',
    spec.unixSocketDirs
      .map((d) => {
        const ref = param(d)
        return `(local unix-socket (subpath ${ref})) (remote unix-socket (subpath ${ref}))`
      })
      .join(' ')
  )

  // ── 尾部：沙箱外代为执行的入口 ──
  lines.push(
    '(deny lsopen)',
    '(deny appleevent-send)',
    '(deny job-creation)',
    `(deny mach-lookup ${LAUNCH_SERVICES_MACH_NAMES.map((n) => `(global-name "${n}")`).join(' ')})`
  )

  return { profile: lines.join('\n') + '\n', params }
}

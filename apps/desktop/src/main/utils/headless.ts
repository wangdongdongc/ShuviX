/**
 * 无头模式（headless，docs/headless/design.md §1）—— 在没有图形界面的服务器上跑 ShuviX：一扇窗都不开，
 * 网络访问强制开着（不写设置），只能从局域网里的浏览器用。
 *
 * 本文件只放**纯**的那一半（不碰 Electron，单测直接引）：
 *  - 命令行解析：`--headless`（或环境变量 `SHUVIX_HEADLESS=1`）、`--port <n>`（别名 `--network-port`）、`--lan`（或
 *    `SHUVIX_LAN=1`：给局域网里的其他设备用；缺省只给这台电脑，监听 127.0.0.1）、`--help`；
 *    同一条命令行上 Chromium 自己的开关（`--ozone-platform=headless`、`--disable-gpu`、`--no-sandbox` …）原样放过；
 *  - 写到 stdout 的几行（措辞固定：脚本与 systemd 日志按它们找）；
 *  - 进程级的模式开关（主入口在一切之前设一次，各窗口入口据此拒绝开窗）；
 *  - 写 stdout 的小工具（同步写 fd 1：第二个实例写完马上 `app.exit`，异步写会丢）。
 *
 * 地址文件与「第二个实例」的裁决在 `headlessInstance.ts`（要读写 userData）。
 */
import { writeSync } from 'node:fs'
import { isValidNetworkPort, MAX_NETWORK_PORT, MIN_NETWORK_PORT } from '../../shared/network'

/** 打开无头模式的环境变量（值为 `1` / `true` / `yes`，大小写不敏感） */
export const HEADLESS_ENV = 'SHUVIX_HEADLESS'

/** 无头运行时给局域网共享的环境变量（同上；缺省只监听 127.0.0.1） */
export const HEADLESS_LAN_ENV = 'SHUVIX_LAN'

/** stdout 每一行的前缀 */
export const HEADLESS_LINE_PREFIX = 'ShuviX headless:'

/** 命令行解析的结果 */
export interface HeadlessArgs {
  /** 要不要无头运行（`--headless` 或环境变量） */
  readonly headless: boolean
  /** `--port` / `--network-port` 给的端口（没给 → 没有这一项） */
  readonly port?: number
  /**
   * `--lan` 或环境变量：给局域网里的其他设备用（监听 0.0.0.0）。缺省 false = 只给这台电脑（127.0.0.1）——
   * 无头运行不读设置里的局域网开关，只认启动参数
   */
  readonly lan: boolean
  /** `--help` / `-h`：打印用法后退出 */
  readonly help: boolean
  /** 参数不对（端口不合法、缺值）：一句人读的原因；之后应以非零码退出 */
  readonly error?: string
}

const PORT_FLAGS = ['--port', '--network-port'] as const

function envSaysYes(value: string | undefined): boolean {
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase())
}

function parsePortValue(flag: string, raw: string | undefined): number | string {
  if (raw === undefined || raw === '' || raw.startsWith('-')) {
    return `${flag} needs a value (an integer between ${MIN_NETWORK_PORT} and ${MAX_NETWORK_PORT})`
  }
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!isValidNetworkPort(port)) {
    return `invalid ${flag} value "${raw}": use an integer between ${MIN_NETWORK_PORT} and ${MAX_NETWORK_PORT}`
  }
  return port
}

/**
 * 解析一条命令行（整个 `process.argv`：可执行文件、开发态的脚本路径、Chromium 的开关都在里面，逐个认，
 * 不按下标跳过）与环境变量。不认得的参数一律放过（交给 Chromium / md 文件的解析）。端口给了多次以最后一次为准。
 */
export function parseHeadlessArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {}
): HeadlessArgs {
  let headless = envSaysYes(env[HEADLESS_ENV])
  let lan = envSaysYes(env[HEADLESS_LAN_ENV])
  let help = false
  let port: number | undefined
  let error: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--headless') {
      headless = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--lan') {
      lan = true
      continue
    }
    const flag = PORT_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`))
    if (flag === undefined) continue
    let raw: string | undefined
    if (arg === flag) {
      raw = argv[i + 1]
      // 下一个是开关（或没有了）：缺值，不吃掉它
      if (raw !== undefined && !raw.startsWith('-')) i++
    } else {
      raw = arg.slice(flag.length + 1)
    }
    const parsed = parsePortValue(flag, raw)
    if (typeof parsed === 'number') port = parsed
    else error ??= parsed
  }
  return {
    headless,
    lan,
    help,
    ...(port === undefined ? {} : { port }),
    ...(error === undefined ? {} : { error })
  }
}

/** `--help` 打印的用法（只讲无头模式相关的开关） */
export function headlessUsage(): string {
  return [
    'Usage: shuvix --headless [--port <n>] [--lan]',
    '',
    'Run ShuviX without any window and use it from a browser.',
    '',
    'Options:',
    '  --headless          run without windows (same as SHUVIX_HEADLESS=1)',
    '  --port <n>          port for network access (alias: --network-port);',
    '                      default: the port saved in Settings, else 7766',
    '  --lan               let other devices on the local network connect',
    '                      (same as SHUVIX_LAN=1); default: only this computer',
    '                      (127.0.0.1), e.g. through ssh -L 7766:127.0.0.1:7766',
    '  --help, -h          print this help and exit',
    '',
    'On a Linux server without a display, also pass the Chromium switches',
    '  --ozone-platform=headless --disable-gpu',
    '(the shuvix-server helper and the systemd service from install-linux.sh do).',
    '',
    'Network access has no password: with --lan, anyone on the same network who',
    'opens the address can fully control this computer through ShuviX.'
  ].join('\n')
}

/** 地址统一以 `/` 结尾（`listenAddresses` 给的是 `http://host:port`） */
function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/** 就绪：能打开的地址（与设置页列出的同一份） */
export function headlessReadyLine(urls: readonly string[]): string {
  return `${HEADLESS_LINE_PREFIX} ready — open one of: ${urls.map(withSlash).join(' ')}`
}

/** 监听失败的原因（Node 的错误码）→ 码 + 一句解释 */
function describeListenError(error: string): string {
  if (error === 'EADDRINUSE') return 'EADDRINUSE (the port is already in use)'
  if (error === 'EACCES') return 'EACCES (permission denied)'
  return error
}

/** 启动时监听不了（之后以非零码退出） */
export function headlessListenErrorLine(port: number, error: string): string {
  return `${HEADLESS_LINE_PREFIX} cannot listen on port ${port}: ${describeListenError(error)}`
}

/** 开始退出（信号 / 其他原因） */
export const HEADLESS_SHUTTING_DOWN_LINE = `${HEADLESS_LINE_PREFIX} shutting down`

/** 退出流程走完 */
export const HEADLESS_STOPPED_LINE = `${HEADLESS_LINE_PREFIX} stopped`

/** 第二个实例：已经有一个无头实例在跑 */
export function headlessAlreadyRunningLine(urls: readonly string[]): string {
  return urls.length > 0
    ? `${HEADLESS_LINE_PREFIX} already running — open one of: ${urls.map(withSlash).join(' ')}`
    : `${HEADLESS_LINE_PREFIX} already running (still starting)`
}

/** 第二个实例要无头，可跑着的是桌面应用（同一份数据，不能两个一起跑） */
export const HEADLESS_DESKTOP_RUNNING_LINE =
  `${HEADLESS_LINE_PREFIX} the ShuviX desktop app is already running for this user; ` +
  'quit it first, then start ShuviX headless'

/** 命令行参数不对 */
export function headlessArgsErrorLine(error: string): string {
  return `${HEADLESS_LINE_PREFIX} ${error} (see shuvix --help)`
}

// ─── 进程级的模式开关 ────────────────────────────────────

let mode: { readonly port?: number; readonly lan: boolean } | null = null

/** 主入口在一切之前调一次：这个进程无头运行（`port`：`--port` 给的端口；`lan`：`--lan`） */
export function enableHeadlessMode(options: { port?: number; lan?: boolean } = {}): void {
  const lan = options.lan === true
  mode = options.port === undefined ? { lan } : { port: options.port, lan }
}

/** 这个进程是不是无头运行 */
export function isHeadless(): boolean {
  return mode !== null
}

/** `--port` 给的端口（没给 / 不是无头 → undefined） */
export function headlessPortOverride(): number | undefined {
  return mode?.port
}

/** 无头运行时给不给局域网（`--lan` / `SHUVIX_LAN`；不是无头 → false） */
export function headlessLan(): boolean {
  return mode?.lan === true
}

/** 单测用：回到桌面模式 */
export function resetHeadlessModeForTests(): void {
  mode = null
}

/** 无头模式下要开窗时的错误（工具 / CLI 照常把它当失败回给调用方）；带 `code: 'headless'` */
export function headlessWindowError(what: string): Error & { code: string } {
  const error = new Error(
    `ShuviX is running headless and does not open windows on this computer (${what}). ` +
      'Use ShuviX from a browser instead.'
  ) as Error & { code: string }
  error.code = 'headless'
  return error
}

// ─── 更新 ─────────────────────────────────────────────

/** 发布所在的 GitHub 仓库（与 electron-builder.yml 的 publish 一致） */
export const RELEASE_REPO = 'wangdongdongc/ShuviX'

/**
 * 无头运行时怎么升级到 `version`：Linux 上是重跑安装脚本的那条命令（不带 --service，所以服务原有的端口 /
 * --lan 保持不变，只换版本；服务在跑就先停再起）；别的平台没有安装脚本 → null。版本号来自更新源，命令是给人
 * 复制去 shell 里跑的，所以只认得 `x.y.z[-pre]` 的形状，别的一律 null（不把任意字符串拼进命令）。
 */
export function headlessUpdateCommand(
  version: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform !== 'linux') return null
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) return null
  const tag = version.startsWith('v') ? version : `v${version}`
  return (
    `curl -fsSL https://github.com/${RELEASE_REPO}/releases/download/${tag}/install-linux.sh` +
    ` | bash -s -- --version ${tag}`
  )
}

/** 无头模式下要下载 / 安装更新时的错误；带 `code: 'headless'` */
export function headlessUpdateError(): Error & { code: string } {
  const error = new Error(
    'ShuviX is running headless and does not install updates itself. ' +
      'Update it on the computer running it (on Linux: rerun install-linux.sh).'
  ) as Error & { code: string }
  error.code = 'headless'
  return error
}

// ─── stdout ─────────────────────────────────────────────

/**
 * 写一行到 stdout（fd 1），同步写完：第二个实例写完就 `app.exit`，异步写在 macOS 的管道上会丢。
 * 管道满了（EAGAIN，libuv 把 fd 设成了非阻塞）重试几次；对面不在了（EPIPE …）静默放弃 —— 这几行
 * 是给人和脚本看的，写不出去不该让进程出事。
 */
export function printHeadlessLine(
  line: string,
  write: (fd: number, data: Buffer) => number = writeSync,
  fd = 1
): void {
  let rest = Buffer.from(line.endsWith('\n') ? line : `${line}\n`)
  for (let attempt = 0; attempt < 50 && rest.length > 0; attempt++) {
    try {
      rest = rest.subarray(write(fd, rest))
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EAGAIN') return
    }
  }
}

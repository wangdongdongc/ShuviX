/**
 * shuvix-cli —— ShuviX 主进程的薄客户端
 *
 * 通过 ELECTRON_RUN_AS_NODE=1 在 Electron 二进制内以 node 模式运行（无新增运行时依赖）。
 * 入口 shell 包装脚本位于 resources/cli/shuvix{,.cmd}，由 bash 工具把 wrapper 所在目录
 * prepend 到 PATH，AI 直接 `shuvix task …` / `shuvix policy …` 即可。组件的命令（`shuvix widget …`）删掉了：
 * 组件的操作全部经 `widget` 工具（它知道是哪条会话、过会话的授权，见 tools/widget.ts）。
 *
 * 职责：
 *   1. 解析 argv
 *   2. 读取 ~/.shuvix/cli-token
 *   3. 连接 Unix socket（POSIX）或 named pipe（Windows）
 *   4. 发 JSON 请求 / 收 JSON 响应
 *   5. 把响应格式化打印到 stdout/stderr，按成功失败映射 exit code
 *
 * Session 信息：bash 工具 spawn 时把 SHUVIX_SESSION_ID 与配对的 SHUVIX_SESSION_KEY 注入 env，CLI 原样
 *               透传给主进程核对（对不上就不算任何会话）；主进程据此认出是哪条会话的命令（停它的后台任务等）。
 *
 * 另有一个与命令无关的模式：`native-host` —— Chrome 为 ShuviX 扩展拉起的原生消息宿主，
 * 常驻、双向转发，见 nativeHost.ts。
 */

import { connect } from 'net'
import { readFileSync, existsSync } from 'fs'
import { homedir, platform, userInfo } from 'os'
import { join, resolve } from 'path'
import { resolveBridgeAddress, runNativeHost } from './nativeHost'

interface ParsedCommand {
  command: string
  params: Record<string, unknown>
}

interface CliResponse {
  success: boolean
  data?: unknown
  error?: string
}

// ────────────────────── path helpers ──────────────────────

function tokenFilePath(): string {
  return join(homedir(), '.shuvix', 'cli-token')
}

function ipcPath(): string {
  if (platform() === 'win32') {
    const user = userInfo().username || 'shuvix'
    return `\\\\.\\pipe\\shuvix-cli-${user}`
  }
  return join(homedir(), '.shuvix', 'cli.sock')
}

function readToken(): string {
  const p = tokenFilePath()
  if (!existsSync(p)) {
    process.stderr.write('Cannot find ~/.shuvix/cli-token. Is ShuviX running?\n')
    process.exit(2)
  }
  return readFileSync(p, 'utf-8').trim()
}

// ────────────────────── arg parsing ──────────────────────

function printUsage(): void {
  process.stderr.write(
    [
      'Usage:',
      '  shuvix task stop <pid>        stop a background task this conversation started',
      '  shuvix policy check [<file>] [--from <ip>] [--device <id>] [--channel <name> | ...]',
      '                                check a network access or redaction policy (shuvix policy check --help)',
      ''
    ].join('\n')
  )
}

/** `shuvix widget …` 删掉了：说清楚该用什么，别让 agent 以为是自己拼错了 */
function widgetCommandRemoved(): never {
  process.stderr.write(
    'shuvix widget was removed: widgets are used and built with the `widget` tool (actions list, describe, call, create, build, preview, sql, export, open).\n'
  )
  process.exit(2)
}

function parseTask(rest: string[]): ParsedCommand | null {
  if (rest[0] !== 'stop') return null
  const pid = rest[1]
  if (!pid || !/^\d+$/.test(pid)) {
    process.stderr.write('task stop: <pid> (a number) is required\n')
    process.exit(1)
  }
  return { command: 'task.stop', params: { pid: Number(pid) } }
}

/**
 * `policy check [<file>] [--name value | --name=value | --flag] …` —— 只拆参数、读文件；参数的合法性在主进程里判
 * （一份规则，报错带全部合法参数）。文件由这个进程读：读得到读不到受沙箱 / 策略约束，主进程不替它读。
 */
/** 不带值的开关：后面跟着的是文件，不是它的值（`--redaction draft.md`） */
const POLICY_SWITCHES = new Set(['scopes', 'redaction', 'help'])

function parsePolicy(rest: string[]): ParsedCommand | null {
  if (rest[0] !== 'check') {
    process.stderr.write(
      `unknown policy action: ${rest[0] ?? '(none)'} (try: shuvix policy check --help)\n`
    )
    process.exit(2)
  }
  const args = rest.slice(1)
  const flags: Array<[string, string]> = []
  let filePath: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-h') {
      flags.push(['help', ''])
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > 2) {
        flags.push([arg.slice(2, eq), arg.slice(eq + 1)])
      } else {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('--') && !POLICY_SWITCHES.has(arg.slice(2))) {
          flags.push([arg.slice(2), next])
          i++
        } else {
          flags.push([arg.slice(2), ''])
        }
      }
    } else if (filePath === undefined) {
      filePath = arg
    } else {
      process.stderr.write(
        `policy check: unexpected argument '${arg}' (one policy file at a time)\n`
      )
      process.exit(2)
    }
  }
  let file: { path: string; text: string } | undefined
  if (filePath !== undefined && !flags.some(([name]) => name === 'help')) {
    // 相对路径按调用方 shell 的 cwd 归一（主进程的 cwd 与会话无关）
    const path = resolve(filePath)
    try {
      file = { path, text: readFileSync(path, 'utf-8') }
    } catch (e) {
      process.stderr.write(`policy check: cannot read ${path}: ${(e as Error).message}\n`)
      process.exit(2)
    }
  }
  return { command: 'policy.check', params: { ...(file ? { file } : {}), flags } }
}

function parse(argv: string[]): ParsedCommand | null {
  const group = argv[0]
  const rest = argv.slice(1)
  if (group === 'widget') widgetCommandRemoved()
  if (group === 'task') return parseTask(rest)
  if (group === 'policy') return parsePolicy(rest)
  return null
}

interface ExecResponseData {
  stdout: string
  stderr: string
  exitCode: number
}

// ────────────────────── transport ──────────────────────

function sendRequest(payload: object): Promise<CliResponse> {
  return new Promise((resolve, reject) => {
    const sock = connect(ipcPath())
    const chunks: Buffer[] = []
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload) + '\n')
    })
    sock.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    sock.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8').trim()
      try {
        resolve(JSON.parse(text) as CliResponse)
      } catch (e) {
        reject(new Error(`invalid response from ShuviX: ${(e as Error).message}\n${text}`))
      }
    })
    sock.on('error', (err: NodeJS.ErrnoException) => {
      const hint =
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? '\nIs ShuviX running?' : ''
      reject(new Error(`Cannot reach ShuviX (${err.code || err.message})${hint}`))
    })
  })
}

// ────────────────────── output ──────────────────────

function printSuccess(data: unknown): void {
  if (data === undefined || data === null) return
  if (typeof data === 'string') {
    process.stdout.write(data + '\n')
    return
  }
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

// ────────────────────── main ──────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    printUsage()
    process.exit(argv.length === 0 ? 1 : 0)
  }

  const parsed = parse(argv)
  if (!parsed) {
    printUsage()
    process.exit(1)
  }

  const token = readToken()
  const sessionId = process.env.SHUVIX_SESSION_ID || undefined
  const sessionKey = process.env.SHUVIX_SESSION_KEY || undefined

  let resp: CliResponse
  try {
    resp = await sendRequest({
      token,
      command: parsed.command,
      params: parsed.params,
      sessionId,
      sessionKey
    })
  } catch (e) {
    process.stderr.write((e as Error).message + '\n')
    process.exit(2)
  }

  if (resp.success) {
    // policy check 走 stdout/stderr/exitCode 形态，打印原文而非 JSON
    if (parsed.command === 'policy.check') {
      const data = resp.data as ExecResponseData | undefined
      if (data) {
        if (data.stdout) {
          process.stdout.write(data.stdout.endsWith('\n') ? data.stdout : data.stdout + '\n')
        }
        if (data.stderr) {
          process.stderr.write(data.stderr.endsWith('\n') ? data.stderr : data.stderr + '\n')
        }
        process.exit(data.exitCode ?? 0)
      }
      process.exit(0)
    }
    printSuccess(resp.data)
    process.exit(0)
  } else {
    process.stderr.write(`Error: ${resp.error || 'unknown error'}\n`)
    process.exit(1)
  }
}

/**
 * 原生消息宿主模式：由宿主清单指向的启动脚本以 `native-host` 拉起（Chrome 另会追加调用方扩展的
 * origin，Windows 上还有 `--parent-window=`）。这一支**绝不能**往 stdout 写任何非帧内容，所以在
 * 解析普通命令之前就分流。
 */
function isNativeHostInvocation(argv: string[]): boolean {
  return argv[0] === 'native-host' || argv.some((a) => a.startsWith('chrome-extension://'))
}

function runNativeHostMain(): void {
  const handle = runNativeHost(process.stdin, process.stdout, {
    // 每次重连现算（见 resolveBridgeAddress）：桌面重启后地址可能变了
    socketPath: () =>
      resolveBridgeAddress({ home: homedir(), platform: platform(), user: userInfo().username }),
    readToken: () => {
      try {
        return readFileSync(tokenFilePath(), 'utf-8').trim() || undefined
      } catch {
        return undefined
      }
    },
    log: (message) => process.stderr.write(`[shuvix native-host] ${message}\n`)
  })
  void handle.done.then(() => process.exit(0))
}

if (isNativeHostInvocation(process.argv.slice(2))) {
  runNativeHostMain()
} else {
  main().catch((e) => {
    process.stderr.write(`Fatal: ${(e as Error).message}\n`)
    process.exit(1)
  })
}

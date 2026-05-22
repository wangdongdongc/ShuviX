/**
 * shuvix-cli —— ShuviX 主进程的薄客户端
 *
 * 通过 ELECTRON_RUN_AS_NODE=1 在 Electron 二进制内以 node 模式运行（无新增运行时依赖）。
 * 入口 shell 包装脚本位于 resources/cli/shuvix{,.cmd}，由 bash 工具把 wrapper 所在目录
 * prepend 到 PATH，AI 直接 `shuvix widget …` 即可。
 *
 * 职责：
 *   1. 解析 argv
 *   2. 读取 ~/.shuvix/cli-token
 *   3. 连接 Unix socket（POSIX）或 named pipe（Windows）
 *   4. 发 JSON 请求 / 收 JSON 响应
 *   5. 把响应格式化打印到 stdout/stderr，按成功失败映射 exit code
 *
 * Session 信息：bash 工具 spawn 时把 SHUVIX_SESSION_ID 注入 env，CLI 透传给主进程，
 *               主进程据此把目标 widget 目录加进 session 的 read/write allowList。
 */

import { connect } from 'net'
import { readFileSync, existsSync } from 'fs'
import { homedir, platform, userInfo } from 'os'
import { join } from 'path'

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
      '  shuvix widget init <id> --name "Display Name" [--description "..."]',
      '  shuvix widget build <id>',
      '  shuvix widget export <id> --to <path>',
      '  shuvix widget list [--archived]',
      '',
      '  shuvix browser open <url>',
      '  shuvix browser close',
      '  shuvix browser snapshot',
      '  shuvix browser screenshot [--full-page] [--uid <id>]',
      '  shuvix browser pdf --out <path> [--page-size <A4|A3|A5|Letter|Legal>] [--landscape]',
      '                     [--no-print-background] [--no-prefer-css-page-size] [--scale <n>]',
      '  shuvix browser click --uid <id>',
      '  shuvix browser fill --uid <id> --value <text>',
      '  shuvix browser type --text <text> [--uid <id>] [--submit-key <key>]',
      '  shuvix browser press-key --key <combo>',
      '  shuvix browser scroll [--direction up|down|left|right] [--amount <px>] [--uid <id>]',
      '  shuvix browser evaluate --expression <js>',
      '  shuvix browser wait-for --text <s> [--timeout <ms>]',
      '  shuvix browser navigate [--url <url>] [--nav goto|back|forward|reload]',
      '  shuvix browser network',
      '  shuvix browser console',
      '',
      '  shuvix python [options] [-c cmd | -m mod | script | -] [arg ...]',
      '                Pyodide WebAssembly Python — see `shuvix python --help`',
      '',
      '  shuvix pglite [-c sql | -f path | -] [--extension name ...]',
      '                Embedded PGLite Postgres — see `shuvix pglite --help`',
      ''
    ].join('\n')
  )
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return undefined
  return args[idx + 1]
}

function parseWidget(rest: string[]): ParsedCommand | null {
  const action = rest[0]
  if (!action) return null
  const args = rest.slice(1)

  switch (action) {
    case 'init': {
      const id = args[0]
      if (!id) {
        process.stderr.write('widget init: <id> is required\n')
        process.exit(1)
      }
      const name = flagValue(args, '--name') ?? ''
      const description = flagValue(args, '--description') ?? ''
      if (!name) {
        process.stderr.write('widget init: --name is required\n')
        process.exit(1)
      }
      return { command: 'widget.init', params: { id, name, description } }
    }
    case 'build': {
      const id = args[0]
      if (!id) {
        process.stderr.write('widget build: <id> is required\n')
        process.exit(1)
      }
      return { command: 'widget.build', params: { id } }
    }
    case 'export': {
      const id = args[0]
      const targetPath = flagValue(args, '--to')
      if (!id || !targetPath) {
        process.stderr.write('widget export: <id> and --to <path> are required\n')
        process.exit(1)
      }
      return { command: 'widget.export', params: { id, targetPath } }
    }
    case 'list': {
      const archived = args.includes('--archived')
      return { command: 'widget.list', params: { archived } }
    }
    default:
      process.stderr.write(`unknown widget action: ${action}\n`)
      process.exit(1)
  }
}

function parseBrowser(rest: string[]): ParsedCommand | null {
  const action = rest[0]
  if (!action) return null
  const args = rest.slice(1)

  switch (action) {
    case 'open': {
      const url = args[0]
      if (!url) {
        process.stderr.write('browser open: <url> is required\n')
        process.exit(1)
      }
      return { command: 'browser.open', params: { url } }
    }
    case 'close':
      return { command: 'browser.close', params: {} }
    case 'snapshot':
      return { command: 'browser.snapshot', params: {} }
    case 'screenshot': {
      const params: Record<string, unknown> = {}
      if (args.includes('--full-page')) params.fullPage = true
      const uid = flagValue(args, '--uid')
      if (uid) params.uid = uid
      return { command: 'browser.screenshot', params }
    }
    case 'pdf': {
      const outputPath = flagValue(args, '--out')
      if (!outputPath) {
        process.stderr.write('browser pdf: --out <path> is required\n')
        process.exit(1)
      }
      const params: Record<string, unknown> = { outputPath }
      const pageSize = flagValue(args, '--page-size')
      if (pageSize) params.pageSize = pageSize
      if (args.includes('--landscape')) params.landscape = true
      if (args.includes('--no-print-background')) params.printBackground = false
      if (args.includes('--no-prefer-css-page-size')) params.preferCSSPageSize = false
      const scale = flagValue(args, '--scale')
      if (scale) {
        const n = Number(scale)
        if (Number.isFinite(n)) params.scale = n
      }
      return { command: 'browser.pdf', params }
    }
    case 'click': {
      const uid = flagValue(args, '--uid')
      if (!uid) {
        process.stderr.write('browser click: --uid <id> is required\n')
        process.exit(1)
      }
      return { command: 'browser.click', params: { uid } }
    }
    case 'fill': {
      const uid = flagValue(args, '--uid')
      const value = flagValue(args, '--value')
      if (!uid || value === undefined) {
        process.stderr.write('browser fill: --uid <id> and --value <text> are required\n')
        process.exit(1)
      }
      return { command: 'browser.fill', params: { uid, value } }
    }
    case 'type': {
      const text = flagValue(args, '--text')
      if (text === undefined) {
        process.stderr.write('browser type: --text <text> is required\n')
        process.exit(1)
      }
      const params: Record<string, unknown> = { text }
      const uid = flagValue(args, '--uid')
      if (uid) params.uid = uid
      const submitKey = flagValue(args, '--submit-key')
      if (submitKey) params.submitKey = submitKey
      return { command: 'browser.type', params }
    }
    case 'press-key': {
      const key = flagValue(args, '--key')
      if (!key) {
        process.stderr.write('browser press-key: --key <combo> is required\n')
        process.exit(1)
      }
      return { command: 'browser.press-key', params: { key } }
    }
    case 'scroll': {
      const params: Record<string, unknown> = {}
      const direction = flagValue(args, '--direction')
      if (direction) params.direction = direction
      const amount = flagValue(args, '--amount')
      if (amount) {
        const n = Number(amount)
        if (Number.isFinite(n)) params.amount = n
      }
      const uid = flagValue(args, '--uid')
      if (uid) params.uid = uid
      return { command: 'browser.scroll', params }
    }
    case 'evaluate': {
      const expression = flagValue(args, '--expression')
      if (expression === undefined) {
        process.stderr.write('browser evaluate: --expression <js> is required\n')
        process.exit(1)
      }
      return { command: 'browser.evaluate', params: { expression } }
    }
    case 'wait-for': {
      const text = flagValue(args, '--text')
      if (!text) {
        process.stderr.write('browser wait-for: --text <s> is required\n')
        process.exit(1)
      }
      const params: Record<string, unknown> = { text }
      const timeout = flagValue(args, '--timeout')
      if (timeout) {
        const n = Number(timeout)
        if (Number.isFinite(n)) params.timeout = n
      }
      return { command: 'browser.wait-for', params }
    }
    case 'navigate': {
      const nav = flagValue(args, '--nav') ?? 'goto'
      const url = flagValue(args, '--url')
      const params: Record<string, unknown> = { navigateAction: nav }
      if (url) params.url = url
      return { command: 'browser.navigate', params }
    }
    case 'network':
      return { command: 'browser.network', params: {} }
    case 'console':
      return { command: 'browser.console', params: {} }
    default:
      process.stderr.write(`unknown browser action: ${action}\n`)
      process.exit(1)
  }
}

function parse(argv: string[]): ParsedCommand | null {
  const group = argv[0]
  const rest = argv.slice(1)
  if (group === 'widget') return parseWidget(rest)
  if (group === 'browser') return parseBrowser(rest)
  return null
}

// ────────────────────── python ──────────────────────
// `shuvix python` 的 argv 在主进程侧解析（argvParser.ts），客户端只做：
//   1. raw 透传 argv
//   2. 按需预读 stdin（`-` 显式 / 无参且 stdin 非 TTY 隐式）
//   3. 透传 cwd / PYTHONPATH

async function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (c: Buffer) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    process.stdin.on('error', reject)
  })
}

function shouldReadStdin(rest: string[]): boolean {
  if (rest[0] === '-') return true
  if (rest.length === 0 && process.stdin.isTTY !== true) return true
  return false
}

interface PythonResponseData {
  stdout: string
  stderr: string
  exitCode: number
}

async function runPython(rest: string[]): Promise<void> {
  let stdinContent: string | undefined
  if (shouldReadStdin(rest)) {
    try {
      stdinContent = await readAllStdin()
    } catch (e) {
      process.stderr.write(`shuvix python: failed to read stdin: ${(e as Error).message}\n`)
      process.exit(1)
    }
  }

  const token = readToken()
  const sessionId = process.env.SHUVIX_SESSION_ID || undefined

  let resp: CliResponse
  try {
    resp = await sendRequest({
      token,
      command: 'python.run',
      params: {
        argv: rest,
        stdin: stdinContent,
        cwd: process.cwd(),
        pythonPath: process.env.PYTHONPATH
      },
      sessionId
    })
  } catch (e) {
    process.stderr.write((e as Error).message + '\n')
    process.exit(2)
  }

  if (!resp.success) {
    process.stderr.write(`Error: ${resp.error || 'unknown error'}\n`)
    process.exit(1)
  }

  const data = resp.data as PythonResponseData | undefined
  if (!data) {
    process.exit(0)
  }
  if (data.stdout) {
    process.stdout.write(data.stdout.endsWith('\n') ? data.stdout : data.stdout + '\n')
  }
  if (data.stderr) {
    process.stderr.write(data.stderr.endsWith('\n') ? data.stderr : data.stderr + '\n')
  }
  process.exit(data.exitCode ?? 0)
}

// ────────────────────── pglite ──────────────────────
// `shuvix pglite` 与 python 类似的 raw 透传模式：
//   1. argv 整体发给主进程让 argvParser 解析
//   2. `-` 或 (无参 + stdin pipe) 时预读 stdin 当 SQL 文本
//   3. `-f path` 时本地 readFileSync 后把内容塞 stdin 字段（handler 协议不感知文件 IO）

async function runPglite(rest: string[]): Promise<void> {
  let stdinContent: string | undefined

  // -f 模式：CLI 端读文件 → 作为 stdin 字段上送
  const fIdx = rest.indexOf('-f')
  if (fIdx !== -1) {
    const path = rest[fIdx + 1]
    if (!path) {
      process.stderr.write('shuvix pglite: -f requires a path argument\n')
      process.exit(2)
    }
    try {
      stdinContent = readFileSync(path, 'utf-8')
    } catch (e) {
      process.stderr.write(`shuvix pglite: failed to read "${path}": ${(e as Error).message}\n`)
      process.exit(1)
    }
  } else if (shouldReadStdin(rest)) {
    try {
      stdinContent = await readAllStdin()
    } catch (e) {
      process.stderr.write(`shuvix pglite: failed to read stdin: ${(e as Error).message}\n`)
      process.exit(1)
    }
  }

  const token = readToken()
  const sessionId = process.env.SHUVIX_SESSION_ID || undefined

  let resp: CliResponse
  try {
    resp = await sendRequest({
      token,
      command: 'pglite.run',
      params: {
        argv: rest,
        stdin: stdinContent
      },
      sessionId
    })
  } catch (e) {
    process.stderr.write((e as Error).message + '\n')
    process.exit(2)
  }

  if (!resp.success) {
    process.stderr.write(`Error: ${resp.error || 'unknown error'}\n`)
    process.exit(1)
  }

  const data = resp.data as PythonResponseData | undefined
  if (!data) {
    process.exit(0)
  }
  if (data.stdout) {
    process.stdout.write(data.stdout.endsWith('\n') ? data.stdout : data.stdout + '\n')
  }
  if (data.stderr) {
    process.stderr.write(data.stderr.endsWith('\n') ? data.stderr : data.stderr + '\n')
  }
  process.exit(data.exitCode ?? 0)
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

  // `shuvix python ...` / `shuvix pglite ...` 都走专用分支：原始 argv 透传 + 异步 stdin
  // 预读 + 自定义 IO 路由（区别于 widget/browser 的 JSON.stringify 输出语义）
  if (argv[0] === 'python') {
    await runPython(argv.slice(1))
    return
  }
  if (argv[0] === 'pglite') {
    await runPglite(argv.slice(1))
    return
  }

  const parsed = parse(argv)
  if (!parsed) {
    printUsage()
    process.exit(1)
  }

  const token = readToken()
  const sessionId = process.env.SHUVIX_SESSION_ID || undefined

  let resp: CliResponse
  try {
    resp = await sendRequest({
      token,
      command: parsed.command,
      params: parsed.params,
      sessionId
    })
  } catch (e) {
    process.stderr.write((e as Error).message + '\n')
    process.exit(2)
  }

  if (resp.success) {
    printSuccess(resp.data)
    process.exit(0)
  } else {
    process.stderr.write(`Error: ${resp.error || 'unknown error'}\n`)
    process.exit(1)
  }
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${(e as Error).message}\n`)
  process.exit(1)
})

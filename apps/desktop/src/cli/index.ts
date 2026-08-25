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
import { join, resolve } from 'path'

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
      '  shuvix widget open <id>',
      '  shuvix widget export <id> --to <dir|file.zip>',
      '  shuvix widget list [--archived]',
      '  shuvix widget db-init <id> --sql "<DDL>" | --file <path>',
      '  shuvix widget db-query <id> --sql "<SQL>" | --file <path>',
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
    case 'open': {
      const id = args[0]
      if (!id) {
        process.stderr.write('widget open: <id> is required\n')
        process.exit(1)
      }
      return { command: 'widget.open', params: { id } }
    }
    case 'export': {
      const id = args[0]
      const targetPath = flagValue(args, '--to')
      if (!id || !targetPath) {
        process.stderr.write('widget export: <id> and --to <path> are required\n')
        process.exit(1)
      }
      // 相对路径在客户端归一 —— 这里的 cwd 是调用方 shell（即会话工作目录）；
      // 交给主进程 resolve 会以 Electron 进程的 cwd 为基准，落到完全无关的地方
      return { command: 'widget.export', params: { id, targetPath: resolve(targetPath) } }
    }
    case 'list': {
      const archived = args.includes('--archived')
      return { command: 'widget.list', params: { archived } }
    }
    case 'db-init':
    case 'db-query': {
      const id = args[0]
      if (!id) {
        process.stderr.write(`widget ${action}: <id> is required\n`)
        process.exit(1)
      }
      const sqlFlag = flagValue(args, '--sql')
      const fileFlag = flagValue(args, '--file')
      if (sqlFlag === undefined && fileFlag === undefined) {
        process.stderr.write(`widget ${action}: --sql "<SQL>" or --file <path> is required\n`)
        process.exit(1)
      }
      let sql: string
      if (sqlFlag !== undefined) {
        sql = sqlFlag
      } else {
        try {
          sql = readFileSync(fileFlag!, 'utf-8')
        } catch (e) {
          process.stderr.write(
            `widget ${action}: failed to read --file "${fileFlag}": ${(e as Error).message}\n`
          )
          process.exit(1)
        }
      }
      return { command: `widget.${action}`, params: { id, sql } }
    }
    default:
      process.stderr.write(`unknown widget action: ${action}\n`)
      process.exit(1)
  }
}

function parse(argv: string[]): ParsedCommand | null {
  const group = argv[0]
  const rest = argv.slice(1)
  if (group === 'widget') return parseWidget(rest)
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
    // db-query 走 stdout/stderr/exitCode 形态，打印原文而非 JSON
    if (parsed.command === 'widget.db-query') {
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

main().catch((e) => {
  process.stderr.write(`Fatal: ${(e as Error).message}\n`)
  process.exit(1)
})

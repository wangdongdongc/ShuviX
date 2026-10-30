/**
 * Ripgrep 通用封装模块
 * 基于 @vscode/ripgrep 提供文件列举和内容搜索能力
 * 供 ls、grep、glob 等工具共享使用
 */

import { spawn } from 'child_process'
import { existsSync } from 'node:original-fs'
import { rgPath } from '@vscode/ripgrep'
import { appContainerExcludeGlobs } from '../appContainers'

/**
 * 获取 rg 二进制路径
 * 打包后 @vscode/ripgrep 的 rgPath 仍指向 app.asar 内部，
 * 但实际二进制由 asarUnpack 解压到 app.asar.unpacked，需要替换路径
 */
export function getRgPath(): string {
  return rgPath.replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked')
}

/**
 * 排除 .git：不带斜杠的模式按 gitignore 语义匹配任意层级 —— 根目录的 .git/、子模块的 sub/.git/、
 * 工作树里那个 .git 文件都不进结果（旧的 `!.git/*` 带斜杠，只锚定根目录那一个）。
 * 必须排在调用方 glob 之后：rg 的 glob 是后者优先（gitignore 语义），放在前面时 `*.md` 之类的白名单
 * 会把 .git/ 下的匹配文件重新捞回来
 */
const EXCLUDE_GIT_DIRS = '--glob=!.git'

/** stderr 最多留这么多字符：rg 拒绝执行时的那段说明很短，多出来的只是噪音 */
const STDERR_CAP = 2048

/**
 * rg 拒绝执行这次搜索（正则或 glob 写错等）：message 是 rg 自己写在 stderr 上的说明。
 * 只在调用方要求报错、且一行结果都没有时抛 —— 部分文件读不了时 rg 也退出 2，但那时结果照样有效
 */
export class RgUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RgUsageError'
  }
}

/**
 * 异步生成器：使用 rg --files 列举目录下的文件
 * 自动遵循 .gitignore，排除 .git 目录，以及落在 cwd 之内的其他应用沙盒容器
 * （`~/Library/Containers`、`~/Library/Group Containers`，见 utils/appContainers）
 */
export async function* rgFiles(input: {
  cwd: string
  glob?: string[]
  hidden?: boolean
  maxDepth?: number
  signal?: AbortSignal
}): AsyncGenerator<string> {
  input.signal?.throwIfAborted()

  const args = ['--files']
  if (input.hidden !== false) args.push('--hidden')
  if (input.maxDepth !== undefined) args.push(`--max-depth=${input.maxDepth}`)
  if (input.glob) {
    for (const g of input.glob) {
      args.push(`--glob=${g}`)
    }
  }
  // .git 排除必须排在调用方 glob 之后（见 EXCLUDE_GIT_DIRS）
  args.push(EXCLUDE_GIT_DIRS)
  // 容器排除同理排在最后：从家目录往下列一遍不该替用户撞上「访问其他应用的数据」授权框
  for (const g of await appContainerExcludeGlobs(input.cwd)) args.push(`--glob=${g}`)

  yield* spawnRgLines(args, input.cwd, input.signal)
}

/** rg --files 结果收集为数组（带 limit 提前中断） */
export async function rgFilesList(input: {
  cwd: string
  glob?: string[]
  hidden?: boolean
  maxDepth?: number
  limit?: number
  signal?: AbortSignal
}): Promise<{ files: string[]; truncated: boolean }> {
  const limit = input.limit ?? Infinity
  const files: string[] = []
  let truncated = false

  for await (const file of rgFiles(input)) {
    if (files.length >= limit) {
      truncated = true
      break
    }
    files.push(file)
  }

  return { files, truncated }
}

/** rg 内容搜索结果 */
export interface RgMatch {
  path: string
  lineNum: number
  lineText: string
}

/**
 * 使用 rg 搜索文件内容（正则模式）
 * 返回匹配的文件路径+行号+行内容
 */
export async function rgSearch(input: {
  cwd: string
  pattern: string
  /** 搜索目标（相对 cwd），默认 '.' 即整个 cwd；指定文件名可只搜单个文件 */
  target?: string
  include?: string
  limit?: number
  signal?: AbortSignal
}): Promise<{ matches: RgMatch[]; truncated: boolean }> {
  input.signal?.throwIfAborted()

  const args = [
    '-nH',
    '--hidden',
    '--no-messages',
    '--field-match-separator=|',
    '--regexp',
    input.pattern
  ]
  if (input.include) {
    args.push('--glob', input.include)
  }
  // 其他应用的沙盒容器不搜（排在 include 之后，见 rgFiles 的同名注释）
  for (const g of await appContainerExcludeGlobs(input.cwd)) args.push(`--glob=${g}`)
  // --hidden 会把 .git 也搜进来（对象库、日志能吃掉大半个结果上限），同样排在 include 之后
  args.push(EXCLUDE_GIT_DIRS)
  // 搜索目标：默认整个 cwd（'.'），或指定的单个文件/子路径。
  // 前面补 `--`：单文件时 target 是文件名原样，名为 `--pre=sh` 的文件否则会被 rg 读成选项
  // （--pre 对每个被搜的文件执行一条命令）
  args.push('--', input.target ?? '.')

  const lines: string[] = []
  // 报错打开：写错的正则（如 `recordRead(`）在 rg 那里是退出码 2 + stderr，不报就成了「没有匹配」
  for await (const line of spawnRgLines(args, input.cwd, input.signal, { reportErrors: true })) {
    lines.push(line)
  }

  const limit = input.limit ?? 100
  const matches: RgMatch[] = []
  let truncated = false

  for (const line of lines) {
    if (!line) continue
    // 格式: ./relative/path|lineNum|lineText
    const parts = line.split('|')
    if (parts.length < 3) continue

    const filePath = parts[0]
    const lineNumStr = parts[1]
    const lineText = parts.slice(2).join('|')
    const lineNum = parseInt(lineNumStr, 10)
    if (isNaN(lineNum)) continue

    if (matches.length >= limit) {
      truncated = true
      break
    }
    matches.push({
      path: filePath.startsWith('./') ? filePath.slice(2) : filePath,
      lineNum,
      lineText
    })
  }

  return { matches, truncated }
}

/**
 * 内部通用：spawn rg 进程，逐行 yield stdout
 *
 * `reportErrors`：留下 stderr 与退出码，一行结果都没有、退出码 2 且 stderr 有话时抛 RgUsageError。
 * 默认关 —— 文件列举（文件面板、知识库扫描、技能目录）遇到读不了的目录照旧当作「少几个文件」
 */
async function* spawnRgLines(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  opts: { reportErrors?: boolean } = {}
): AsyncGenerator<string> {
  signal?.throwIfAborted()

  // 预检查 rg 二进制是否存在，避免 spawn 报出难以定位的 ENOTDIR/ENOENT
  const bin = getRgPath()
  if (!existsSync(bin)) {
    throw new Error(`ripgrep binary not found: ${bin}`)
  }

  const proc = spawn(bin, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Windows 下不创建控制台窗口
    windowsHide: true
  })

  // stderr 要一直读走（管道写满会卡住 rg），只留开头一段；只有 reportErrors 会用到它
  let stderr = ''
  proc.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_CAP) stderr += chunk.toString()
  })

  // 捕获 spawn 级别错误（如 ENOTDIR / EACCES）
  let spawnError: Error | undefined
  // 退出码：spawn 失败时可能不再有 close，error 也算结束
  const exited = new Promise<number | null>((resolve) => {
    proc.on('close', (code) => resolve(code))
    proc.on('error', () => resolve(null))
  })
  proc.on('error', (err: NodeJS.ErrnoException) => {
    spawnError = new Error(`rg spawn failed: ${err.code || err.message} (bin=${bin}, cwd=${cwd})`)
  })

  // 中止时杀进程
  const onAbort = (): void => {
    proc.kill()
  }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })

  try {
    let buffer = ''
    let yielded = 0

    for await (const chunk of proc.stdout) {
      signal?.throwIfAborted()
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (line) {
          yielded++
          yield line
        }
      }
    }

    if (buffer) {
      yielded++
      yield buffer
    }

    // stdout 读完后检查是否有 spawn 错误
    if (spawnError) throw spawnError
    // rg 还没写出一行就被取消：循环一次没进，循环里那道检查也就没跑 —— 不补这一句，
    // 被取消的搜索会读成「没有匹配」
    signal?.throwIfAborted()

    // 有结果就照常返回：部分文件读不了时 rg 同样退出 2，结果仍然有效
    if (opts.reportErrors && yielded === 0) {
      const code = await exited
      if (spawnError) throw spawnError
      const message = stderr.trim()
      if (code === 2 && message) throw new RgUsageError(message.slice(0, STDERR_CAP))
    }
  } catch (err) {
    // 将 spawn 级别错误包装为可读信息重新抛出
    if (spawnError) throw spawnError
    throw err
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    // 确保进程结束
    if (proc.exitCode === null) proc.kill()
  }
}

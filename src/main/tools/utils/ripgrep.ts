/**
 * Ripgrep 通用封装模块
 * 基于 @vscode/ripgrep 提供文件列举和内容搜索能力
 * 供 ls、grep、glob 等工具共享使用
 */

import { spawn } from 'child_process'
import { existsSync } from 'node:original-fs'
import { rgPath } from '@vscode/ripgrep'

/**
 * 获取 rg 二进制路径
 * 打包后 @vscode/ripgrep 的 rgPath 仍指向 app.asar 内部，
 * 但实际二进制由 asarUnpack 解压到 app.asar.unpacked，需要替换路径
 */
export function getRgPath(): string {
  return rgPath.replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked')
}

/**
 * 异步生成器：使用 rg --files 列举目录下的文件
 * 自动遵循 .gitignore，排除 .git 目录
 */
export async function* rgFiles(input: {
  cwd: string
  glob?: string[]
  hidden?: boolean
  maxDepth?: number
  signal?: AbortSignal
}): AsyncGenerator<string> {
  input.signal?.throwIfAborted()

  const args = ['--files', '--glob=!.git/*']
  if (input.hidden !== false) args.push('--hidden')
  if (input.maxDepth !== undefined) args.push(`--max-depth=${input.maxDepth}`)
  if (input.glob) {
    for (const g of input.glob) {
      args.push(`--glob=${g}`)
    }
  }

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
  // 搜索当前 cwd
  args.push('.')

  const lines: string[] = []
  for await (const line of spawnRgLines(args, input.cwd, input.signal)) {
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
 */
async function* spawnRgLines(
  args: string[],
  cwd: string,
  signal?: AbortSignal
): AsyncGenerator<string> {
  signal?.throwIfAborted()

  // 预检查 rg 二进制是否存在，避免 spawn 报出难以定位的 ENOTDIR/ENOENT
  const bin = getRgPath()
  if (!existsSync(bin)) {
    throw new Error(`ripgrep binary not found: ${bin}`)
  }

  const proc = spawn(bin, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    // Windows 下不创建控制台窗口
    windowsHide: true
  })

  // 捕获 spawn 级别错误（如 ENOTDIR / EACCES）
  let spawnError: Error | undefined
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

    for await (const chunk of proc.stdout) {
      signal?.throwIfAborted()
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (line) yield line
      }
    }

    if (buffer) yield buffer

    // stdout 读完后检查是否有 spawn 错误
    if (spawnError) throw spawnError
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

/**
 * 一次 shell 命令调用「实际执行的命令」—— 写在工具结果目录里，与输出日志 `<id>.log` 并排，
 * 工具卡按需读取（HostApi `bgTask.readInvocation`）。
 *
 * 为什么是旁路文件而不进工具结果的 details：套了沙箱的命令光 profile 与 `-D` 路径参数就有
 * 8–9 KB（八十来个绝对路径，每个在参数表里写一遍、规则里再引用一遍），details 会随每条命令进
 * 会话 JSONL、重开会话时整份投影给界面；而这份文本只在用户点开时才需要。删会话时它随整个
 * `tool_results/<sessionId>/` 目录一起删；从后台任务面板移除任务只删日志，不删它 —— 工具卡还在。
 *
 * 文本是**能贴进终端**的形态：bash 为 POSIX sh 语法（`cd` + 变量前缀 + 命令），powershell 为
 * PowerShell 语法。环境变量只写 ShuviX 在自身环境之上为这条命令加的、复现它需要的那几个
 * （沙箱的 TMPDIR 等、SHUVIX_SESSION_ID）；项目环境变量只列名字 —— 值可能是密钥，而这份文本
 * 是给人看、会被复制走的。PATH 前置的 CLI 目录等所有命令都一样的部分不写。
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { createLogger } from '../logger'
import { getToolResultsBase, getToolResultsDir, isSafeSessionId } from '../utils/paths'
import type { ShellInvocation, ShellKind } from '../utils/toolUtils/shell'

const log = createLogger('CommandInvocation')

/** 读取上限：命令本身可以很长（heredoc 塞进整个文件），界面上看这么多足够 */
const MAX_READ_BYTES = 512 * 1024

export interface InvocationRecord {
  shell: ShellKind
  /** 实际 spawn 的可执行文件与参数（套沙箱时已是包装后的那一份） */
  invocation: ShellInvocation
  cwd: string
  /** 连值一起写出的环境变量 */
  env: Record<string, string>
  /** 只列名字的环境变量（项目环境变量） */
  hiddenEnv: readonly string[]
}

/** 文件名只留安全字符 —— toolCallId 来自模型供应商，形状不由我们定；读写两端同一规则 */
function fileNameOf(toolCallId: string): string {
  return `${toolCallId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)}.invocation.txt`
}

// ─── 格式化 ────────────────────────────────────────

/** POSIX sh 单词：安全字符原样，其余单引号包起来（内部单引号写成 '\''） */
export function shQuote(word: string): string {
  if (word !== '' && /^[A-Za-z0-9_/.,:=@%+-]+$/.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * PowerShell 单引号字面量：内部的单引号双写 —— 弯引号 ‘ ’ ‚ ‛ 在 PowerShell 里同样是单引号
 * （复制粘贴的文本里常见），不双写会在那里提前结束字符串。
 */
function psLiteral(word: string): string {
  return `'${word.replace(/['\u2018-\u201B]/g, (q) => q + q)}'`
}

/** PowerShell 命令模式的参数：安全字符原样，其余写成单引号字面量 */
export function psQuote(word: string): string {
  if (word !== '' && /^[A-Za-z0-9_.-]+$/.test(word)) return word
  return psLiteral(word)
}

/** 只列名字的变量名压成一行 —— 名字来自项目配置，只保证非空，换行会逃出那一行说明 */
function hiddenNote(names: readonly string[]): string {
  // eslint-disable-next-line no-control-regex -- 要压掉的正是控制字符
  return `Also set (values not shown): ${names.map((n) => n.replace(/[\x00-\x1f\x7f]/g, '?')).join(', ')}`
}

/**
 * 可执行文件 + 参数排成 sh 命令。参数里有 `--`（sandbox-exec 包装）时，`--` 之前的每个选项连同
 * 它的值各占一行，`--` 之后（被包的那条 shell 命令）排在最后一行 —— 一百多个 `-D` 挤一行没法读；
 * 没有 `--`（没套沙箱的 `/bin/bash --norc -c …`）就是一行。
 */
function posixCommand(file: string, args: readonly string[]): string {
  const end = args.indexOf('--')
  if (end < 0) return [file, ...args].map(shQuote).join(' ')
  const lines = [shQuote(file)]
  for (let i = 0; i < end; i++) {
    const arg = args[i]
    const value = i + 1 < end ? args[i + 1] : undefined
    if (arg.startsWith('-') && value !== undefined && !value.startsWith('-')) {
      lines.push(`  ${shQuote(arg)} ${shQuote(value)}`)
      i++
    } else {
      lines.push(`  ${shQuote(arg)}`)
    }
  }
  lines.push(`  ${args.slice(end).map(shQuote).join(' ')}`)
  return lines.join(' \\\n')
}

/** 实际执行的命令，排成能贴进对应 shell 的文本 */
export function formatInvocation(record: InvocationRecord): string {
  const { shell, invocation, cwd, env, hiddenEnv } = record
  const lines: string[] = []
  if (shell === 'powershell') {
    if (hiddenEnv.length > 0) lines.push(`# ${hiddenNote(hiddenEnv)}`)
    lines.push(`Set-Location -LiteralPath ${psQuote(cwd)}`)
    // 赋值右边是表达式模式，裸词会被当命令跑 —— 值一律写成字面量
    for (const [key, value] of Object.entries(env)) lines.push(`$env:${key} = ${psLiteral(value)}`)
    lines.push(`& ${[invocation.file, ...invocation.args].map(psQuote).join(' ')}`)
    return lines.join('\n') + '\n'
  }
  // 说明行写成 `:` 命令而不是 `#` 注释：macOS 默认的交互式 zsh 不认注释（interactive_comments
  // 默认关），贴进去会把 `#` 当命令跑、在括号上报错
  if (hiddenEnv.length > 0) lines.push(`: ${shQuote(hiddenNote(hiddenEnv))}`)
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${shQuote(value)}`)
  const head = [`cd ${shQuote(cwd)} &&`, ...(assignments.length ? [assignments.join(' ')] : [])]
  lines.push(head.join(' \\\n') + ' \\\n' + posixCommand(invocation.file, invocation.args))
  return lines.join('\n') + '\n'
}

// ─── 读写 ──────────────────────────────────────────

/** spawn 之前记下这条命令（写失败只记日志 —— 它是给人看的附录，不该挡住命令本身） */
export function recordInvocation(
  sessionId: string,
  toolCallId: string,
  record: InvocationRecord
): void {
  try {
    writeFileSync(
      join(getToolResultsDir(sessionId), fileNameOf(toolCallId)),
      formatInvocation(record)
    )
  } catch (err) {
    log.warn(`failed to record invocation for ${toolCallId}: ${(err as Error).message}`)
  }
}

/** 取回记下的命令；会话 id 不安全、没有记录、读失败都返回 null */
export function readInvocation(sessionId: string, toolCallId: string): string | null {
  if (!isSafeSessionId(sessionId) || !toolCallId) return null
  const path = join(getToolResultsBase(), sessionId, fileNameOf(toolCallId))
  try {
    if (!existsSync(path)) return null
    const size = statSync(path).size
    if (size <= MAX_READ_BYTES) return readFileSync(path, 'utf-8')
    const buf = Buffer.alloc(MAX_READ_BYTES)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, MAX_READ_BYTES, 0)
    } finally {
      closeSync(fd)
    }
    return `${buf.toString('utf-8')}\n… (${size - MAX_READ_BYTES} more bytes not shown)\n`
  } catch (err) {
    log.warn(`failed to read invocation for ${toolCallId}: ${(err as Error).message}`)
    return null
  }
}

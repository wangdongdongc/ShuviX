/**
 * Hook 子进程执行器
 *
 * 启动 shell 子进程，stdin 喂入 JSON，等待 stdout JSON / 退出码 / 超时。
 * 不做退出码语义判断（由 HookService 解释），只负责协议层面的 IO。
 */

import { spawn } from 'child_process'
import { createLogger } from '../../logger'
import type { HookEntry, HookInput, HookOutput } from './types'

const log = createLogger('HookRunner')

const DEFAULT_TIMEOUT_SEC = 30

export interface RunResult {
  /** stdout 解析为 HookOutput；解析失败或空 stdout 时为 undefined */
  output?: HookOutput
  /** 子进程退出码；被信号杀死或 spawn 失败时为 null */
  exitCode: number | null
  /** 完整 stderr 文本（trim 由调用方按需处理） */
  stderr: string
  /** 是否被超时强杀 */
  timedOut: boolean
}

export interface RunOptions {
  cwd: string
  env: Record<string, string>
  /** 覆盖 entry.timeout；优先级：参数 > entry.timeout > 默认 30s */
  timeoutSec?: number
}

/** 启动一个 hook 子进程并等待其完成。Promise 不会 reject——所有错误以 RunResult 反映。 */
export function runHookProcess(
  entry: HookEntry,
  input: HookInput,
  opts: RunOptions
): Promise<RunResult> {
  const timeoutSec = Math.max(1, opts.timeoutSec ?? entry.timeout ?? DEFAULT_TIMEOUT_SEC)
  const timeoutMs = timeoutSec * 1000

  return new Promise<RunResult>((resolveResult) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(result)
    }

    const child = spawn(entry.command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => {
      timedOut = true
      log.warn(`hook 超时 (${timeoutSec}s)，强杀: ${entry.command}`)
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8')
    })

    child.on('error', (err) => {
      log.warn(`hook 启动失败: ${err.message}`)
      finish({ output: undefined, exitCode: null, stderr: err.message, timedOut: false })
    })

    child.on('close', (code) => {
      let parsed: HookOutput | undefined
      const trimmed = stdout.trim()
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed) as HookOutput
        } catch {
          // stdout 不是 JSON 视为「无决策」，保留 output = undefined
        }
      }
      finish({ output: parsed, exitCode: code, stderr, timedOut })
    })

    try {
      child.stdin.write(JSON.stringify(input))
      child.stdin.end()
    } catch (err) {
      log.warn(`写 stdin 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

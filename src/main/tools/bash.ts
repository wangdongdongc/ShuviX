/**
 * Bash 工具 — 在指定工作目录中执行 shell 命令
 * 从 pi-coding-agent 移植，支持输出截断、超时控制、abort
 */

import { spawn } from 'child_process'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { truncateTail, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './utils/truncate'
import { getShellConfig, sanitizeBinaryOutput, killProcessTree } from './utils/shell'

/** 默认超时时间（秒） */
const DEFAULT_TIMEOUT = 120

const BashParamsSchema = Type.Object({
  command: Type.String({
    description: '要执行的 shell 命令。支持管道、重定向等 bash 特性。避免需要交互输入的命令。'
  }),
  timeout: Type.Optional(
    Type.Number({
      description: `命令超时时间（秒），默认 ${DEFAULT_TIMEOUT}s。长时间运行的命令建议加大此值。`
    })
  )
})

/** 可插拔的执行接口（用于 Docker 适配） */
export interface BashOperations {
  spawn: (
    command: string,
    cwd: string,
    timeout: number,
    signal?: AbortSignal
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/** 默认本地执行实现 */
function defaultSpawn(
  command: string,
  cwd: string,
  timeout: number,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('操作已中止'))
      return
    }

    const { shell, args } = getShellConfig()
    console.log(`[工具调用] ${shell}(${cwd}): ${args.join(' ')} ${command}`)

    const child = spawn(shell, [...args, command], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    // 收集输出
    child.stdout?.on('data', (data: Buffer) => {
      stdout += sanitizeBinaryOutput(data.toString('utf-8'))
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += sanitizeBinaryOutput(data.toString('utf-8'))
    })

    // 超时处理
    const timer = setTimeout(() => {
      killed = true
      if (child.pid) killProcessTree(child.pid)
    }, timeout * 1000)

    // abort 处理
    const onAbort = (): void => {
      killed = true
      if (child.pid) killProcessTree(child.pid)
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('close', (code) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)

      if (killed && signal?.aborted) {
        reject(new Error('操作已中止'))
        return
      }

      resolve({
        stdout,
        stderr,
        exitCode: killed ? 124 : (code ?? 1)
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(err)
    })
  })
}

const defaultOperations: BashOperations = { spawn: defaultSpawn }

export interface BashToolOptions {
  operations?: BashOperations
}

/** 创建 bash 工具实例 */
export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof BashParamsSchema> {
  const ops = options?.operations ?? defaultOperations

  return {
    name: 'bash',
    label: '执行命令',
    description:
      'Execute a bash command in the working directory. Use this for running shell commands, scripts, installing packages, etc. The command runs in a bash shell with pipe and redirect support.',
    parameters: BashParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { command: string; timeout?: number },
      signal?: AbortSignal
    ) => {
      const timeout = params.timeout ?? DEFAULT_TIMEOUT

      try {
        const result = await ops.spawn(params.command, cwd, timeout, signal)
        const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')

        // 截断过长的输出
        const truncated = truncateTail(combined, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)

        let text = ''
        if (truncated.truncated) {
          text += `[输出已截断：原始 ${truncated.originalLines} 行 / ${formatSize(truncated.originalBytes)}]\n\n`
        }
        text += truncated.text

        if (result.exitCode === 124) {
          text += `\n\n[命令超时（${timeout}s）]`
        } else if (result.exitCode !== 0) {
          text += `\n\n[退出码: ${result.exitCode}]`
        }

        return {
          content: [{ type: 'text' as const, text }],
          details: {
            exitCode: result.exitCode,
            truncated: truncated.truncated
          }
        }
      } catch (err: any) {
        if (err.message === '操作已中止') throw err
        return {
          content: [{ type: 'text' as const, text: `命令执行失败: ${err.message}` }],
          details: undefined
        }
      }
    }
  }
}

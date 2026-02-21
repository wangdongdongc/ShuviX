/**
 * Bash 工具 — 在指定工作目录中执行 shell 命令
 * 从 pi-coding-agent 移植，支持输出截断、超时控制、abort
 */

import { spawn } from 'child_process'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { truncateTail, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './utils/truncate'
import { getShellConfig, sanitizeBinaryOutput, killProcessTree } from './utils/shell'
import { dockerManager, CONTAINER_WORKSPACE } from '../services/dockerManager'
import { resolveProjectConfig, type ToolContext } from './types'
import { t } from '../i18n'

/** 默认超时时间（秒） */
const DEFAULT_TIMEOUT = 120

const BashParamsSchema = Type.Object({
  command: Type.String({
    description: t('tool.paramCommand')
  }),
  timeout: Type.Optional(
    Type.Number({
      description: t('tool.paramTimeout', { default: DEFAULT_TIMEOUT })
    })
  )
})

/** 默认本地执行实现 */
function defaultSpawn(
  command: string,
  cwd: string,
  timeout: number,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(t('tool.aborted')))
      return
    }

    const { shell, args } = getShellConfig()
    console.log(`[Tool: bash] (${cwd}): ${shell} ${args.join(' ')} ${command}`)

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
        reject(new Error(t('tool.aborted')))
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

/** 创建 bash 工具实例 */
export function createBashTool(ctx: ToolContext): AgentTool<typeof BashParamsSchema> {
  return {
    name: 'bash',
    label: t('tool.bashLabel'),
    description:
      'Execute a bash command in the working directory. Use this for running shell commands, scripts, installing packages, etc. The command runs in a bash shell with pipe and redirect support.',
    parameters: BashParamsSchema,
    execute: async (
      toolCallId: string,
      params: { command: string; timeout?: number },
      signal?: AbortSignal
    ) => {
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const config = resolveProjectConfig(ctx)
      const useDocker = config.dockerEnabled && !!config.dockerImage

      // 沙箱模式：bash 命令需用户确认
      if (config.sandboxEnabled && ctx.requestApproval) {
        const approved = await ctx.requestApproval(toolCallId, params.command)
        if (!approved) {
          throw new Error(t('tool.sandboxBashDenied'))
        }
      }

      try {
        let result: { stdout: string; stderr: string; exitCode: number }

        if (useDocker) {
          // Docker 模式：确保容器运行，在容器内执行
          const { containerId, isNew } = await dockerManager.ensureContainer(
            ctx.sessionId, config.dockerImage, config.workingDirectory
          )
          if (isNew) ctx.onContainerCreated?.(containerId)
          console.log(`[Tool: bash] (docker ${config.dockerImage}): ${params.command}`)
          result = await dockerManager.exec(containerId, params.command, CONTAINER_WORKSPACE, signal)
        } else {
          // 本地模式
          result = await defaultSpawn(params.command, config.workingDirectory, timeout, signal)
        }
        const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')

        // 截断过长的输出
        const truncated = truncateTail(combined, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)

        let text = ''
        if (truncated.truncated) {
          text += `${t('tool.outputTruncated', { lines: truncated.originalLines, size: formatSize(truncated.originalBytes) })}\n\n`
        }
        text += truncated.text

        if (result.exitCode === 124) {
          text += `\n\n${t('tool.cmdTimeout', { timeout })}`
        } else if (result.exitCode !== 0) {
          text += `\n\n${t('tool.exitCode', { code: result.exitCode })}`
        }

        return {
          content: [{ type: 'text' as const, text }],
          details: {
            exitCode: result.exitCode,
            truncated: truncated.truncated
          }
        }
      } catch (err: any) {
        if (err.message === t('tool.aborted')) throw err
        throw new Error(t('tool.cmdFailed', { message: err.message }))
      }
    }
  }
}

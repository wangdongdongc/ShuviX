/**
 * Bash 工具 — 在指定工作目录中执行 shell 命令
 * 从 pi-coding-agent 移植，支持输出截断、超时控制、abort
 */

import { spawn } from 'child_process'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { truncateTail, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './utils/truncate'
import { getShellConfig, sanitizeBinaryOutput, killProcessTree } from './utils/shell'
import { dockerManager } from '../services/dockerManager'
import { settingsService } from '../services/settingsService'
import { resolveProjectConfig, TOOL_ABORTED, type ToolContext } from './types'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:bash')

/** 默认超时时间（秒） */
const DEFAULT_TIMEOUT = 120

const BashParamsSchema = Type.Object({
  command: Type.String({
    description: 'The shell command to execute. Supports pipes, redirects, and other bash features. Avoid commands that require interactive input.'
  }),
  timeout: Type.Optional(
    Type.Number({
      description: `Command timeout in seconds (default: ${DEFAULT_TIMEOUT}s). Increase for long-running commands.`
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
      reject(new Error(TOOL_ABORTED))
      return
    }

    const { shell, args } = getShellConfig()
    log.info(`(${cwd}): ${shell} ${args.join(' ')} ${command.slice(0, 50)}`)

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
        reject(new Error(TOOL_ABORTED))
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
      'Execute a bash command in the working directory. The command runs in a bash shell with pipe and redirect support. Use this for running scripts, installing packages, git operations, builds, etc. IMPORTANT: Prefer built-in tools over shell commands when possible — use `ls` instead of `find`/`ls`, `grep` instead of `grep`/`rg`, `glob` instead of `find -name`, `read` instead of `cat`/`head`/`tail`, `write` instead of `echo >`, `edit` instead of `sed`/`awk`. Only use bash when no built-in tool can accomplish the task.',
    parameters: BashParamsSchema,
    execute: async (
      toolCallId: string,
      params: { command: string; timeout?: number },
      signal?: AbortSignal
    ) => {
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const config = resolveProjectConfig(ctx)

      // 从全局设置读取 Docker 配置
      const dockerEnabled = settingsService.get('tool.bash.dockerEnabled') === 'true'
      const dockerImage = settingsService.get('tool.bash.dockerImage') || ''
      const dockerMemory = settingsService.get('tool.bash.dockerMemory') || ''
      const dockerCpus = settingsService.get('tool.bash.dockerCpus') || ''
      const useDocker = dockerEnabled && !!dockerImage

      // 沙箱模式：bash 命令需用户确认
      if (config.sandboxEnabled && ctx.requestApproval) {
        const approval = await ctx.requestApproval(toolCallId, params.command)
        if (!approval.approved) {
          throw new Error(approval.reason || t('tool.sandboxBashDenied'))
        }
      }

      try {
        let result: { stdout: string; stderr: string; exitCode: number }

        if (useDocker) {
          // Docker 模式：确保容器运行，在容器内执行
          let containerId: string
          let isNew: boolean
          try {
            const container = await dockerManager.ensureContainer(
              ctx.sessionId, dockerImage, config.workingDirectory,
              { memory: dockerMemory || undefined, cpus: dockerCpus || undefined, referenceDirs: config.referenceDirs.length > 0 ? config.referenceDirs : undefined }
            )
            containerId = container.containerId
            isNew = container.isNew
          } catch {
            // 容器创建失败时检查具体原因，给出明确提示
            const status = dockerManager.getDockerStatus()
            if (status === 'notInstalled') throw new Error(t('settings.toolBashDockerNotInstalled'))
            if (status === 'notRunning') throw new Error(t('settings.toolBashDockerNotRunning'))
            throw new Error(t('settings.toolBashDockerNotRunning'))
          }
          if (isNew) ctx.onContainerCreated?.(containerId)
          log.info(`(docker ${dockerImage}): ${params.command}`)
          result = await dockerManager.exec(containerId, params.command, config.workingDirectory, signal)
        } else {
          // 本地模式
          result = await defaultSpawn(params.command, config.workingDirectory, timeout, signal)
        }
        const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')

        // 截断过长的输出
        const truncated = truncateTail(combined, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)

        let text = ''
        if (truncated.truncated) {
          text += `[Output truncated: ${truncated.originalLines} lines / ${formatSize(truncated.originalBytes)}]\n\n`
        }
        text += truncated.text

        if (result.exitCode === 124) {
          text += `\n\n[Command timed out (${timeout}s)]`
        } else if (result.exitCode !== 0) {
          text += `\n\n[Exit code: ${result.exitCode}]`
        }

        return {
          content: [{ type: 'text' as const, text }],
          details: {
            exitCode: result.exitCode,
            truncated: truncated.truncated
          }
        }
      } catch (err: any) {
        if (err.message === TOOL_ABORTED) throw err
        throw new Error(`Command failed: ${err.message}`)
      }
    }
  }
}

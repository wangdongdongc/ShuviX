/**
 * Bash 工具 — 在指定工作目录中执行 shell 命令
 * 从 pi-coding-agent 移植，支持输出截断、超时控制、abort
 */

import { spawn } from 'child_process'
import { Type } from 'typebox'
import {
  getShellConfig,
  sanitizeBinaryOutput,
  killProcessTree,
  collapseProgressOutput
} from '../utils/toolUtils/shell'
import { buildSpawnEnv } from '../utils/paths'
import { BaseTool } from '../services/baseTool'
import { resolveProjectConfig, TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import { sessionDao } from '../dao/sessionDao'
import { isCommandAllowedUnified, extractPatterns } from '../utils/toolUtils/allowList'
import { sessionService } from '../services/sessionService'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { BashToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:bash')

/** 默认超时时间（秒） */
const DEFAULT_TIMEOUT = 120

const BashParamsSchema = Type.Object({
  command: Type.String({
    description:
      'The shell command to execute. Supports pipes, redirects, and other bash features. Avoid commands that require interactive input.'
  }),
  description: Type.String({
    description: 'Brief description of what this command does and why.'
  }),
  timeout: Type.Optional(
    Type.Number({
      description: `Command timeout in seconds (default: ${DEFAULT_TIMEOUT}s). Increase for long-running commands.`
    })
  )
})

/** 在本地 shell 中执行命令 */
function defaultSpawn(
  command: string,
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
  extraEnv?: Record<string, string>
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
      env: buildSpawnEnv(extraEnv),
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

export class BashTool extends BaseTool<typeof BashParamsSchema> {
  readonly name = 'bash'
  readonly label = t('tool.bashLabel')
  readonly description =
    'Execute a bash command in the working directory. The command runs in a bash shell with pipe and redirect support. Use this for running scripts, installing packages, git operations, builds, etc. IMPORTANT: Prefer built-in tools over shell commands when possible — use `ls` instead of `find`/`ls`, `grep` instead of `grep`/`rg`, `glob` instead of `find -name`, `read` instead of `cat`/`head`/`tail`, `write` instead of `echo >`, `edit` instead of `sed`/`awk`. Only use bash when no built-in tool can accomplish the task.'
  readonly parameters = BashParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 安全检查 — requestApproval 为动态条件性审批，留在 executeInternal 中 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    toolCallId: string,
    params: { command: string; description: string; timeout?: number },
    signal?: AbortSignal
  ): Promise<AgentToolResult<BashToolDetails>> {
    const timeout = params.timeout ?? DEFAULT_TIMEOUT
    const config = resolveProjectConfig(this.ctx.sessionId)

    // Bash 命令始终需用户审批（免审批或允许列表匹配时跳过）
    if (this.ctx.requestUserInput) {
      const sess = sessionDao.pickSettings(this.ctx.sessionId, ['autoApprove', 'allowList'])
      if (!sess?.autoApprove && !isCommandAllowedUnified(sess?.allowList, 'bash', params.command)) {
        const response = await this.ctx.requestUserInput({
          id: toolCallId,
          kind: 'approval',
          toolName: 'bash',
          command: params.command,
          description: params.description,
          createdAt: Date.now()
        })
        if (response.kind === 'cancel') {
          throw new Error(TOOL_ABORTED)
        }
        // 用户选择"其它":不执行命令,把反馈文本作为正常 tool result 返回给 AI
        if (response.kind === 'other') {
          return {
            content: [
              {
                type: 'text',
                text: `Command was not executed. User responded with feedback instead:\n${response.text}`
              }
            ],
            details: { type: 'bash', exitCode: -1, truncated: false }
          }
        }
        if (response.kind !== 'approval' || !response.approved) {
          throw new Error(
            (response.kind === 'approval' && response.reason) ||
              'User denied execution of this command'
          )
        }
        // 副作用:用户勾选"记住此模式" → 写入会话 allowList
        if (response.extra?.rememberPattern) {
          const patterns = extractPatterns(params.command)
          if (patterns.length > 0) {
            sessionService.addAllowListPatterns(this.ctx.sessionId, 'bash', patterns)
          }
        }
      }
    }

    try {
      // 注入 SHUVIX_SESSION_ID，让 shuvix-cli 把当前 session id 透传给主进程
      // （主进程据此把 widget 目录加入 session 的 read/write allowList）
      const result = await defaultSpawn(params.command, config.workingDirectory, timeout, signal, {
        ...config.envVars,
        SHUVIX_SESSION_ID: this.ctx.sessionId
      })
      const raw = [result.stdout, result.stderr].filter(Boolean).join('\n')
      // 折叠进度输出（仅匹配进度类命令时生效）
      let text = collapseProgressOutput(raw, params.command)

      if (result.exitCode === 124) {
        text += `\n\n[Command timed out (${timeout}s)]`
      } else if (result.exitCode !== 0) {
        text += `\n\n[Exit code: ${result.exitCode}]`
      }

      // 输出长度的截断/落盘统一由 wrapToolOutput 在构建工具时处理
      return {
        content: [{ type: 'text' as const, text }],
        details: {
          type: 'bash',
          exitCode: result.exitCode,
          truncated: false
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg === TOOL_ABORTED) throw err
      throw new Error(`Command failed: ${errMsg}`)
    }
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'bash',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t('tool.bashLabel'),
  getHint: () => t('tool.bashHint'),
  factory: (ctx) => new BashTool(ctx),
  presentation: {
    icon: 'Terminal',
    iconColor: '#eab308',
    summaryField: 'description',
    formItems: [{ field: 'command', renderer: { type: 'code', language: 'bash' } }]
  }
})

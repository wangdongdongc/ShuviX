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
import { BaseTool } from '@shuvix/agent-runtime'
import {
  getDesktopSecurityContext,
  resolveProjectConfig,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
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

const BASH_DESCRIPTION =
  'Execute a bash command in the working directory. The command runs in a bash shell with pipe and redirect support. Use this for running scripts, installing packages, git operations, builds, etc. Prefer built-in tools over shell commands where one fits: `ls` instead of `find`/`ls`, `grep` instead of `grep`/`rg`, `glob` instead of `find -name`, `read` instead of `cat`/`head`/`tail`, `write` instead of `echo >`, `edit` instead of `sed`/`awk`. Use bash when no built-in tool can accomplish the task.'

export class BashTool extends BaseTool<typeof BashParamsSchema> {
  readonly name = 'bash'
  readonly label = t('tool.bashLabel')
  readonly description = BASH_DESCRIPTION
  readonly parameters = BashParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 安全检查 — 条件性询问是动态的，留在 executeInternal 中 */
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

    // Bash 命令逐条需用户询问 —— 唯一豁免是会话级「免询问」开关（无命令模式匹配）。
    // 判定与响应处理收敛到安全模块（内置 ask-on-command 策略给出 ask，autoAllow 走 consent 层）
    const outcome = await getDesktopSecurityContext(this.ctx).enforceCommand(
      // cwd 供安全模块把重定向目标解析成绝对路径
      { channel: 'bash', command: params.command, cwd: config.workingDirectory },
      {
        toolCallId,
        toolName: 'bash',
        description: params.description,
        abortError: TOOL_ABORTED,
        // 用户选择"其它":不执行命令,把反馈文本作为正常 tool result 返回给 AI
        onOther: 'return',
        // fail-closed：ask 且无询问通道 → 拒绝（桌面 root/派生 agent 恒有通道，
        // 无前端时 harness 层已即时 cancel；此分支只防御未来的无通道调用方）
        missingChannel: 'deny'
      }
    )
    if (outcome.status === 'feedback') {
      return {
        content: [
          {
            type: 'text',
            text: `Command was not executed. User responded with feedback instead:\n${outcome.text}`
          }
        ],
        details: { type: 'bash', exitCode: -1, truncated: false }
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
          truncated: false,
          cwd: config.workingDirectory
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
  getLabel: () => t('tool.bashLabel'),
  getHint: () => t('tool.bashHint'),
  factory: (ctx) => new BashTool(ctx),
  presentation: {
    icon: 'Terminal',
    iconColor: '#eab308',
    // 展开态融成一段终端会话（提示符 + cwd + 命令 + 输出）；formItems 保留作降级
    detailView: 'terminal',
    formItems: [
      {
        field: 'command',
        renderer: { type: 'code', language: 'bash', wrap: true, lineNumbers: true }
      }
    ],
    showUndeclaredFields: false
  },
  describe: () => ({ description: BASH_DESCRIPTION, parameters: BashParamsSchema })
})

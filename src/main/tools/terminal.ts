/**
 * Terminal 工具 — 在与用户共享的 PTY 终端中执行命令
 *
 * 两种 action：
 * - exec: 执行命令，返回终端 tail
 * - tail: 不执行命令，只读取终端当前可见内容（用于查看更多输出或检查长命令状态）
 */

import { Type } from '@sinclair/typebox'
import { processToolOutput } from './utils/processToolOutput'
import { BaseTool, resolveProjectConfig, TOOL_ABORTED, type ToolContext } from './types'
import { sessionDao } from '../dao/sessionDao'
import { isCommandAllowedUnified } from './utils/allowList'
import {
  ensureAgentTerminal,
  getAgentTerminalId,
  executeInTerminal,
  readTerminalLines
} from '../services/agentTerminalManager'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { TerminalToolDetails } from '../../shared/types/chatMessage'
import { t } from '../i18n'

const DEFAULT_TIMEOUT = 30

const TerminalParamsSchema = Type.Object({
  action: Type.Union([Type.Literal('exec'), Type.Literal('tail')], {
    description: '`exec` to run a command, `tail` to read current terminal.'
  }),
  description: Type.String({
    description: 'Brief description of what this does and why.'
  }),
  command: Type.Optional(
    Type.String({
      description:
        'The command to execute (required for exec). The terminal persists across calls — environment variables, working directory changes, and other state carry over.'
    })
  ),
  lines: Type.Number({
    description: `Number of terminal lines to return.`
  }),
  timeout: Type.Optional(
    Type.Number({
      description: `Timeout in seconds for exec (default: ${DEFAULT_TIMEOUT}). On timeout the command keeps running — you get the current terminal content and can decide to wait or interrupt.`
    })
  )
})

export class TerminalTool extends BaseTool<typeof TerminalParamsSchema> {
  readonly name = 'terminal'
  readonly label = t('tool.terminalLabel')
  readonly description =
    "Execute commands or read output from the user's shared PTY terminal. Two actions: `exec` runs a command and returns the terminal tail; `tail` reads the current terminal content without executing (use to see more lines or check on running commands). The terminal persists across calls — environment, working directory, and shell state carry over."
  readonly parameters = TerminalParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    const config = resolveProjectConfig(this.ctx.sessionId)
    const existingId = getAgentTerminalId(this.ctx.sessionId)
    const terminalId = ensureAgentTerminal(this.ctx.sessionId, config.workingDirectory)

    if (!existingId) {
      this.ctx.emitChatEvent?.({
        type: 'terminal_event',
        action: 'open',
        ptyId: terminalId
      })
    }
  }

  protected async securityCheck(): Promise<void> {
    /* 审批在 executeInternal 中动态处理 */
  }

  protected async executeInternal(
    toolCallId: string,
    params: {
      action: 'exec' | 'tail'
      command?: string
      description: string
      timeout?: number
      lines: number
    },
    signal?: AbortSignal
  ): Promise<AgentToolResult<TerminalToolDetails>> {
    const tailLines = params.lines

    if (params.action === 'tail') {
      return this.handleTail(toolCallId, tailLines)
    }

    return this.handleExec(toolCallId, params, tailLines, signal)
  }

  /** tail — 只读取终端当前内容 */
  private async handleTail(
    toolCallId: string,
    tailLines: number
  ): Promise<AgentToolResult<TerminalToolDetails>> {
    const terminalId = getAgentTerminalId(this.ctx.sessionId)
    if (!terminalId) throw new Error('No terminal session')

    const content = await readTerminalLines(terminalId, tailLines)
    const processed = processToolOutput({
      sessionId: this.ctx.sessionId,
      toolCallId,
      fullText: content,
      strategy: 'middle'
    })

    return {
      content: [
        {
          type: 'text' as const,
          text: `[Terminal tail: last ${tailLines} lines]\n\n${processed.text}`
        }
      ],
      details: { type: 'terminal', exitCode: 0, truncated: processed.truncated }
    }
  }

  /** exec — 执行命令并返回终端 tail */
  private async handleExec(
    toolCallId: string,
    params: { command?: string; description?: string; timeout?: number },
    tailLines: number,
    signal?: AbortSignal
  ): Promise<AgentToolResult<TerminalToolDetails>> {
    const command = params.command
    if (!command) throw new Error('command is required for exec action')

    const timeout = params.timeout ?? DEFAULT_TIMEOUT

    // 命令审批（复用 bash 的允许列表，与 agentEventHandler.checkToolApproval 配合）
    if (this.ctx.requestApproval) {
      const sess = sessionDao.pickSettings(this.ctx.sessionId, ['autoApprove', 'allowList'])
      if (!sess?.autoApprove && !isCommandAllowedUnified(sess?.allowList, 'bash', command)) {
        const approval = await this.ctx.requestApproval(
          toolCallId,
          'terminal',
          command,
          params.description
        )
        if (!approval.approved) {
          throw new Error(approval.reason || 'User denied execution of this command')
        }
      }
    }

    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    try {
      const result = await executeInTerminal(this.ctx.sessionId, command, timeout, signal)

      const terminalId = getAgentTerminalId(this.ctx.sessionId)
      let tailContent = result.output
      if (terminalId) {
        const fromBuffer = await readTerminalLines(terminalId, tailLines)
        if (fromBuffer) tailContent = fromBuffer
      }

      const processed = processToolOutput({
        sessionId: this.ctx.sessionId,
        toolCallId,
        fullText: tailContent,
        strategy: 'middle'
      })

      const status = result.timedOut
        ? ` | timed out after ${timeout}s — command still running, use tail to check or send Ctrl+C to interrupt`
        : ''
      let text = `[Terminal tail: last ${tailLines} lines${status}]\n${processed.text}`

      if (!result.timedOut && result.exitCode !== 0) {
        text += `\n\n[Exit code: ${result.exitCode}]`
      }

      return {
        content: [{ type: 'text' as const, text }],
        details: {
          type: 'terminal',
          exitCode: result.exitCode,
          truncated: processed.truncated
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg === TOOL_ABORTED) throw err
      throw new Error(`Terminal command failed: ${errMsg}`)
    }
  }
}

import { registerBuiltinTool } from './registry'
registerBuiltinTool({
  name: 'terminal',
  group: 'general',
  defaultEnabled: false,
  getLabel: () => t('tool.terminalLabel'),
  getHint: () => t('tool.terminalHint'),
  factory: (ctx) => new TerminalTool(ctx),
  presentation: {
    icon: 'SquareTerminal',
    iconColor: '#22c55e',
    summaryField: 'description',
    formItems: [{ field: 'command', renderer: { type: 'code', language: 'bash' } }]
  }
})

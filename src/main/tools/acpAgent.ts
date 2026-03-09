/**
 * ACP Agent 工具 — 通用外部 ACP Agent 委托工具
 *
 * 通过 AcpAgentConfig 参数化，一个类服务所有 ACP Agent（Claude Code、Gemini CLI 等）。
 * 参照 explore.ts 模式实现。
 */

import { Type } from '@sinclair/typebox'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { AcpAgentToolDetails } from '../../shared/types/chatMessage'
import { BaseTool, TOOL_ABORTED, type ToolContext } from './types'
import { acpService, type AcpAgentConfig } from '../services/acpService'
import type { ChatEvent } from '../frontend'

const AcpAgentParamsSchema = Type.Object({
  description: Type.String({
    description: 'A short (3-5 word) description of the task'
  }),
  prompt: Type.String({
    description:
      'The task for the agent to perform. This is the ONLY context the agent receives — it does NOT have access to your conversation history. Be thorough and specific, including all relevant file paths, requirements, and constraints.'
  })
})

/** 通用 ACP Agent 工具 */
export class AcpAgentTool extends BaseTool<typeof AcpAgentParamsSchema> {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly parameters = AcpAgentParamsSchema

  constructor(
    private ctx: ToolContext,
    private broadcastEvent: (event: ChatEvent) => void,
    private config: AcpAgentConfig
  ) {
    super()
    this.name = config.name
    this.label = config.displayName
    this.description = config.description
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    // 验证可执行文件存在
    const resolved = acpService.resolveExecutable(this.config)
    if (!resolved) {
      throw new Error(
        `ACP Agent "${this.config.displayName}" is not available. ` +
          `Ensure "${this.config.command}" is installed and available in PATH.`
      )
    }
  }

  protected async executeInternal(
    toolCallId: string,
    params: { description: string; prompt: string },
    signal?: AbortSignal
  ): Promise<AgentToolResult<AcpAgentToolDetails>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    try {
      const { taskId, result } = await acpService.runTask({
        config: this.config,
        ctx: this.ctx,
        toolCallId,
        prompt: params.prompt,
        description: params.description,
        signal,
        onEvent: this.broadcastEvent
      })

      const output = [
        `task_id: ${taskId}`,
        '',
        '<task_result>',
        result,
        '</task_result>'
      ].join('\n')

      return {
        content: [{ type: 'text' as const, text: output }],
        details: {
          type: 'acp-agent',
          agentName: this.config.name,
          taskId,
          description: params.description
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)

      return {
        content: [{ type: 'text' as const, text: `Error: ${errMsg}` }],
        details: {
          type: 'acp-agent',
          agentName: this.config.name,
          taskId: '',
          description: params.description,
          error: errMsg
        }
      }
    }
  }
}

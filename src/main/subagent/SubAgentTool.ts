/**
 * SubAgentTool — 泛型子智能体工具
 *
 * 将 provider.runTask() 的结果包装为标准 tool_result。
 * 子智能体的流式展示由右侧 Sub-agent 面板负责，父对话框中仅作为普通 tool call。
 */

import { Type, type TSchema } from 'typebox'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import { BaseTool } from '../services/baseTool'
import { TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import type { SubAgentProvider } from './types'

/** 默认参数 schema（description + prompt） */
const DefaultParamsSchema = Type.Object({
  description: Type.String({
    description: 'A short (3-5 word) description of the task'
  }),
  prompt: Type.String({
    description:
      'The task for the agent to perform. This is the ONLY context the agent receives — it does NOT have access to your conversation history. Be thorough and specific, including all relevant file paths, requirements, and constraints.'
  })
})

/** 子智能体工具 — 通过 SubAgentProvider 参数化 */
export class SubAgentTool extends BaseTool<TSchema> {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly parameters: TSchema

  constructor(
    private ctx: ToolContext,
    private provider: SubAgentProvider
  ) {
    super()
    this.name = provider.name
    this.label = provider.displayName
    this.description = provider.description
    this.parameters = provider.parameterSchema ?? DefaultParamsSchema
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op — provider 内部处理 */
  }

  protected async executeInternal(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const description = (params.description as string) || ''
    const prompt = (params.prompt as string) || ''

    try {
      const { result } = await this.provider.runTask({
        ctx: this.ctx,
        toolCallId,
        prompt,
        description,
        signal
      })

      return {
        content: [{ type: 'text' as const, text: result }],
        details: undefined
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: `Error: ${errMsg}` }],
        details: undefined
      }
    }
  }
}

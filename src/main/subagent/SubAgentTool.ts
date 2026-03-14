/**
 * SubAgentTool — 泛型子智能体工具
 *
 * 替代 ExploreTool 和 AcpAgentTool，统一处理：
 * - SubAgentTimelineCollector 创建和事件包装
 * - 调用 provider.runTask()
 * - 序列化 timeline + usage 为 SubAgentToolDetails
 * - 错误处理
 *
 * 新增子智能体类型只需实现 SubAgentProvider，无需再写 Tool 类。
 */

import { Type, type TSchema } from '@sinclair/typebox'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { SubAgentToolDetails } from '../../shared/types/chatMessage'
import { BaseTool, TOOL_ABORTED, type ToolContext } from '../tools/types'
import type { SubAgentProvider } from './types'
import type { ChatEvent } from '../frontend'
import { SubAgentTimelineCollector } from './SubAgentTimelineCollector'
import { createLogger } from '../logger'

const log = createLogger('SubAgentTool')

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
    private provider: SubAgentProvider,
    private broadcastEvent: (event: ChatEvent) => void
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
  ): Promise<AgentToolResult<SubAgentToolDetails>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const description = (params.description as string) || ''
    const prompt = (params.prompt as string) || ''
    const taskIdParam = params.task_id as string | undefined

    const collector = new SubAgentTimelineCollector()
    const wrappedOnEvent = (event: ChatEvent): void => {
      collector.onEvent(event)
      this.broadcastEvent(event)
    }

    try {
      const { taskId, result } = await this.provider.runTask({
        ctx: this.ctx,
        toolCallId,
        taskId: taskIdParam,
        prompt,
        description,
        signal,
        onEvent: wrappedOnEvent
      })

      const { timeline, usage } = collector.serialize()
      const entryCounts = timeline
        ? timeline.reduce(
            (acc, e) => {
              acc[e.type] = (acc[e.type] || 0) + 1
              return acc
            },
            {} as Record<string, number>
          )
        : null
      log.info(
        `Timeline serialized: ${JSON.stringify(entryCounts)} (${timeline?.length ?? 0} entries)`
      )

      const output = [
        `task_id: ${taskId}${taskIdParam ? '' : ' (use this to resume the same sub-agent session if needed)'}`,
        '',
        '<task_result>',
        result,
        '</task_result>'
      ].join('\n')

      return {
        content: [{ type: 'text' as const, text: output }],
        details: {
          type: 'sub-agent',
          subAgentType: this.provider.name,
          taskId,
          description,
          prompt,
          timeline,
          usage
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const { timeline, usage } = collector.serialize()

      return {
        content: [{ type: 'text' as const, text: `Error: ${errMsg}` }],
        details: {
          type: 'sub-agent',
          subAgentType: this.provider.name,
          taskId: '',
          description,
          error: errMsg,
          prompt,
          timeline,
          usage
        }
      }
    }
  }
}

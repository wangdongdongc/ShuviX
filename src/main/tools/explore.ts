/**
 * Explore 工具 — 只读代码库搜索子智能体
 *
 * 作为独立工具暴露给主 Agent，内部通过 SubAgentManager 生成
 * explore 类型的子智能体执行只读搜索任务。
 */

import { Type } from '@sinclair/typebox'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { ExploreToolDetails } from '../../shared/types/chatMessage'
import type { Api, Model } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { BaseTool, TOOL_ABORTED, type ToolContext } from './types'
import { subAgentManager, getSubAgentTypes } from '../services/subAgent'
import type { ChatEvent } from '../frontend'
import { SubAgentTimelineCollector } from '../utils/subAgentTimeline'
import { t } from '../i18n'

const ExploreParamsSchema = Type.Object({
  description: Type.String({
    description: 'A short (3-5 word) description of the task'
  }),
  prompt: Type.String({
    description:
      'The task for the agent to perform. This is the ONLY context the sub-agent receives — it does NOT have access to your conversation history. Be thorough and specific.'
  }),
  task_id: Type.Optional(
    Type.String({
      description:
        'Resume a previous explore session by providing its task_id. The sub-agent retains its full conversation history from the previous run.'
    })
  )
})

/** 构建 explore 工具的详细描述 */
function buildExploreDescription(): string {
  const exploreType = getSubAgentTypes().find((t) => t.name === 'explore')
  const desc = exploreType?.description ?? 'Read-only codebase search specialist.'

  return `Launch a read-only sub-agent to explore the codebase autonomously in an isolated context. Use explore for broad codebase exploration and context gathering — this saves your context window.

${desc}

When NOT to use this tool:
- If you want to read a specific file path, use Read directly
- If you are searching for a specific class/function definition, use Grep/Glob directly
- If you are searching within 2-3 known files, use Read directly

Usage notes:
- Launch multiple explore agents concurrently whenever possible (multiple tool calls in one message)
- The sub-agent does NOT share your conversation history — you MUST provide complete context in the prompt parameter
- The result is returned only to you, not visible to the user — summarize it for the user
- Specify what information the agent should return in its final response
- Each invocation starts fresh unless you provide task_id to resume a previous session`
}

/** Explore 工具 */
export class ExploreTool extends BaseTool<typeof ExploreParamsSchema> {
  readonly name = 'explore'
  readonly label = t('tool.exploreLabel')
  readonly description: string
  readonly parameters = ExploreParamsSchema

  constructor(
    private ctx: ToolContext,
    private parentModel: Model<Api>,
    private parentStreamFn: StreamFn,
    private broadcastEvent: (event: ChatEvent) => void
  ) {
    super()
    this.description = buildExploreDescription()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    _toolCallId: string,
    params: {
      description: string
      prompt: string
      task_id?: string
    },
    signal?: AbortSignal
  ): Promise<AgentToolResult<ExploreToolDetails>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const collector = new SubAgentTimelineCollector()
    const wrappedOnEvent = (event: ChatEvent): void => {
      collector.onEvent(event)
      this.broadcastEvent(event)
    }

    const { taskId, result } = await subAgentManager.runTask({
      parentSessionId: this.ctx.sessionId,
      parentToolCallId: _toolCallId,
      taskId: params.task_id,
      subAgentType: 'explore',
      prompt: params.prompt,
      parentModel: this.parentModel,
      parentStreamFn: this.parentStreamFn,
      parentAbortSignal: signal,
      onEvent: wrappedOnEvent
    })

    const { timeline, usage } = collector.serialize()

    const output = [
      `task_id: ${taskId} (use this to resume the same sub-agent session if needed)`,
      '',
      '<task_result>',
      result,
      '</task_result>'
    ].join('\n')

    return {
      content: [{ type: 'text' as const, text: output }],
      details: {
        type: 'explore',
        taskId,
        subAgentType: 'explore',
        description: params.description,
        prompt: params.prompt,
        timeline,
        usage
      }
    }
  }
}

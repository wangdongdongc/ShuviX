/**
 * CustomSubAgentProvider — 用户自定义子智能体
 *
 * 从 DB 配置实例化，复用 SubAgentManager 运行 Agent。
 * 工具集、系统提示词均由用户配置决定。
 */

import { Type } from 'typebox'
import type {
  SubAgentModelConfig,
  SubAgentProvider,
  SubAgentRunParams,
  SubAgentRunResult
} from '../types'
import { subAgentManager, type InProcessAgentType } from '../SubAgentManager'
import type { CustomSubAgent } from '../../dao/types'

/** 自定义子智能体工具参数 schema */
const CustomSubAgentParamsSchema = Type.Object({
  description: Type.String({
    description: 'A short (3-5 word) description of the task'
  }),
  prompt: Type.String({
    description:
      'The task for the sub-agent to perform. This is the ONLY context the sub-agent receives — it does NOT have access to your conversation history. Be thorough and specific.'
  })
})

/** 构建工具描述（给主 Agent 看） */
function buildDescription(config: CustomSubAgent): string {
  return `Launch a sub-agent "${config.displayName}" to handle tasks autonomously in an isolated context.

${config.description}

Usage notes:
- The sub-agent does NOT share your conversation history — you MUST provide complete context in the prompt parameter
- The result is returned only to you, not visible to the user — summarize it for the user
- Each invocation starts fresh unless you provide task_id to resume a previous session`
}

export class CustomSubAgentProvider implements SubAgentProvider {
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly parameterSchema = CustomSubAgentParamsSchema

  private agentType: InProcessAgentType
  private modelConfig?: SubAgentModelConfig

  constructor(config: CustomSubAgent) {
    this.name = config.name
    this.displayName = config.displayName
    this.description = buildDescription(config)
    this.agentType = {
      name: config.name,
      displayName: config.displayName,
      description: config.description,
      tools: config.tools,
      maxTurns: config.maxTurns,
      systemPrompt: config.systemPrompt
    }
  }

  setModelConfig(config: SubAgentModelConfig): void {
    this.modelConfig = config
  }

  async runTask(params: SubAgentRunParams): Promise<SubAgentRunResult> {
    if (!this.modelConfig) {
      throw new Error(
        `CustomSubAgentProvider "${this.name}" requires model config — call setModelConfig() first`
      )
    }

    const { result } = await subAgentManager.runTask({
      parentSessionId: params.ctx.sessionId,
      parentToolCallId: params.toolCallId,
      agentType: this.agentType,
      prompt: params.prompt,
      description: params.description,
      modelConfig: this.modelConfig,
      parentAbortSignal: params.signal
    })

    return { result }
  }

  destroy(sessionId: string): void {
    subAgentManager.destroyAll(sessionId)
  }

  abortAll(sessionId: string): void {
    subAgentManager.abortAll(sessionId)
  }
}

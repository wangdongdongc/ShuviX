/**
 * BuiltinSubAgentProvider — 代码定义的内置子智能体
 *
 * 与 CustomSubAgentProvider 的区别：
 * - 定义来自代码（BuiltinSubAgentDef），不写入数据库
 * - displayName / shortDescription 通过 i18n key 懒加载（getter），随语言切换实时生效
 * - systemPrompt / 工具 description 保持英文（LLM 提示稳定）
 */

import { Type } from 'typebox'
import type {
  SubAgentModelConfig,
  SubAgentProvider,
  SubAgentRunParams,
  SubAgentRunResult
} from '../types'
import { subAgentManager, type InProcessAgentType } from '../SubAgentManager'
import { mcpService } from '../../services/mcpService'
import { t } from '../../i18n'
import type { BuiltinSubAgentDef } from '../builtins/types'

/** 内置子智能体工具参数 schema（与自定义一致） */
const BuiltinSubAgentParamsSchema = Type.Object({
  description: Type.String({
    description: 'A short (3-5 word) description of the task'
  }),
  prompt: Type.String({
    description:
      'The task for the sub-agent to perform. This is the ONLY context the sub-agent receives — it does NOT have access to your conversation history. Be thorough and specific.'
  })
})

export class BuiltinSubAgentProvider implements SubAgentProvider {
  readonly parameterSchema = BuiltinSubAgentParamsSchema

  private readonly agentType: InProcessAgentType
  private modelConfig?: SubAgentModelConfig

  constructor(private readonly def: BuiltinSubAgentDef) {
    this.agentType = {
      name: def.name,
      get displayName(): string {
        const translated = t(def.displayNameKey)
        return translated && translated !== def.displayNameKey ? translated : def.name
      },
      description: def.llmDescription,
      tools: [...def.tools],
      maxTurns: def.maxTurns,
      systemPrompt: def.systemPrompt
    }
  }

  get name(): string {
    return this.def.name
  }

  /** UI 显示名（懒 i18n，语言切换实时生效） */
  get displayName(): string {
    const translated = t(this.def.displayNameKey)
    // 若 key 缺失，i18next 会原样返回 key；此时回退到英文 name
    return translated && translated !== this.def.displayNameKey ? translated : this.def.name
  }

  /** 给主 Agent LLM 看的工具描述（英文，稳定不变） */
  get description(): string {
    return `Launch a sub-agent "${this.def.name}" to handle tasks autonomously in an isolated context.

${this.def.llmDescription}

Usage notes:
- The sub-agent does NOT share your conversation history — you MUST provide complete context in the prompt parameter
- The result is returned only to you, not visible to the user — summarize it for the user
- Each invocation starts fresh unless you provide task_id to resume a previous session`
  }

  /** UI 简短描述（懒 i18n） */
  get shortDescription(): string {
    const translated = t(this.def.shortDescriptionKey)
    return translated && translated !== this.def.shortDescriptionKey ? translated : ''
  }

  setModelConfig(config: SubAgentModelConfig): void {
    this.modelConfig = config
  }

  async runTask(params: SubAgentRunParams): Promise<SubAgentRunResult> {
    if (!this.modelConfig) {
      throw new Error(
        `BuiltinSubAgentProvider "${this.name}" requires model config — call setModelConfig() first`
      )
    }

    // 执行前预检查：所有声明为 requiredMcp 的内置 MCP 必须已连接
    const missing = (this.def.requiredMcp ?? []).filter(
      (mcpName) => !mcpService.isConnectedByName(mcpName)
    )
    if (missing.length > 0) {
      const list = missing.map((n) => `"${n}"`).join(', ')
      const message = [
        `Cannot run sub-agent "${this.name}": required MCP server(s) not connected: ${list}.`,
        `This is usually because the required API key is not configured.`,
        `Ask the user to open Settings → MCP, fill in the environment variables for the listed server(s), then retry.`
      ].join(' ')
      return { result: message }
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

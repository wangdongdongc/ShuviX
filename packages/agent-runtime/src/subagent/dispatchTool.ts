/**
 * 子代理派发工具（跨端共享，从桌面 AgentTool 抽取）。
 *
 * LLM 只看到一个名为 `Agent` 的工具，通过 subagent_type 选择目标。可用类型由注入的
 * SubAgentRegistry 动态给出并嵌入 description。执行时校验类型 + requiredMcp，委托
 * SubAgentManager.runTask，返回最终文本结果。注册表/MCP 连接判定/模型配置经注入，宿主无关。
 */
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { BaseTool } from '../tools/baseTool'
import type {
  AgentDefinition,
  SubAgentModelConfig,
  SubAgentRegistry,
  InProcessAgentType
} from './types'
import type { SubAgentManager } from './manager'

export const AgentParamsSchema = Type.Object({
  description: Type.String({ description: 'A short (3-5 word) description of the task' }),
  subagent_type: Type.Optional(
    Type.String({
      description:
        'The type of specialized agent to use. Available types are listed in this tool description. ' +
        'Optional when a default agent is offered — omit to use the default.'
    })
  ),
  prompt: Type.String({
    description:
      'The task for the agent to perform. The agent does NOT see your conversation history — be self-contained, include file paths, requirements, and constraints.'
  })
})

const MAX_WHEN_TO_USE_CHARS = 240

function formatAgentLine(def: AgentDefinition): string {
  const firstSentence = def.whenToUse.split(/(?<=[.。!?！？])\s+/)[0] ?? def.whenToUse
  const trimmed =
    firstSentence.length > MAX_WHEN_TO_USE_CHARS
      ? firstSentence.slice(0, MAX_WHEN_TO_USE_CHARS - 1) + '…'
      : firstSentence
  const toolsHint = def.tools.length === 0 ? 'none' : def.tools.join(', ')
  return `- ${def.name}: ${trimmed} (Tools: ${toolsHint})`
}

export function buildDescription(
  registry: SubAgentRegistry,
  defaultAgentType?: InProcessAgentType
): string {
  const defs = registry.listEnabled()

  // 具名子代理才进「可选类型」列表；默认子代理不具名展示（否则模型会照抄 subagent_type），
  // 仅在下方说明里提示「可省略 subagent_type 走默认」。
  let typesBlock: string
  if (defs.length > 0) {
    typesBlock =
      `Available agent types and the tools they have access to:\n${defs.map(formatAgentLine).join('\n')}\n\n` +
      (defaultAgentType
        ? 'Set `subagent_type` to one of the types above, or omit it to dispatch a default agent that inherits your current tools.'
        : 'When using the Agent tool, you must specify a subagent_type to select which agent type to use.')
  } else if (defaultAgentType) {
    // 无具名类型：省略 subagent_type 即可，不要提任何类型名
    typesBlock =
      'Omit `subagent_type`: the dispatched agent inherits your current tools to complete the task autonomously.'
  } else {
    typesBlock = '(No agent types are currently available.)'
  }

  return `Launch a new agent to handle complex, multi-step tasks autonomously.

${typesBlock}

Usage notes:
- The agent does NOT share your conversation history — provide complete context in \`prompt\`.
- The agent's final result is returned only to you, not visible to the user — summarize for the user.
- Each invocation is stateless; cannot resume a previous session.
- Re-dispatching is usually unnecessary; only re-run if the result is incomplete or contradicts what you observe.
- Launch multiple agents concurrently when possible (single message, multiple tool calls).`
}

/** 派发工具注入依赖 */
export interface DispatchAgentToolDeps {
  registry: SubAgentRegistry
  manager: SubAgentManager
  modelConfig: SubAgentModelConfig
  parentSessionId: string
  /** abort 时抛出的错误信息（与平台 TOOL_ABORTED 对齐） */
  abortError: string
  /** MCP server 连接判定（校验 requiredMcp）；缺省视为"无 MCP 依赖检查" */
  isMcpConnected?: (name: string) => boolean
  /** 工具显示名（缺省 'Agent'） */
  label?: string
  /**
   * 默认子代理 —— 提供后 subagent_type 变为可选：省略时用它派发。
   * 注册表里的具名定义成为可选附加，而非调用前提。缺省则维持"必须指定 subagent_type"。
   */
  defaultAgentType?: InProcessAgentType
}

function errorResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text' as const, text }], details: undefined }
}

/** 子代理派发工具 —— 唯一对 LLM 暴露的入口 */
export class DispatchAgentTool extends BaseTool<typeof AgentParamsSchema> {
  readonly name = 'Agent'
  readonly label: string
  readonly parameters = AgentParamsSchema

  constructor(private deps: DispatchAgentToolDeps) {
    super()
    this.label = deps.label ?? 'Agent'
  }

  get description(): string {
    return buildDescription(this.deps.registry, this.deps.defaultAgentType)
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op — 子代理内部工具自带沙箱 */
  }

  protected async executeInternal(
    toolCallId: string,
    params: { description: string; subagent_type: string; prompt: string },
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    if (signal?.aborted) throw new Error(this.deps.abortError)

    const description = params.description || ''
    const subagentType = (params.subagent_type || '').trim()
    const prompt = params.prompt || ''
    const names = (): string[] => this.deps.registry.listEnabled().map((a) => a.name)
    const hasDefault = !!this.deps.defaultAgentType

    let agentType: InProcessAgentType
    if (subagentType) {
      // 指定了类型：必须在注册表中（具名定义）
      const def = this.deps.registry.getEnabled(subagentType)
      if (!def) {
        const tail = hasDefault ? ' (or omit subagent_type to use the default)' : ''
        return errorResult(
          `Unknown subagent_type "${subagentType}". Available: [${names().join(', ')}]${tail}`
        )
      }
      const isConnected = this.deps.isMcpConnected ?? (() => true)
      const missingMcp = (def.requiredMcp ?? []).filter((n) => !isConnected(n))
      if (missingMcp.length > 0) {
        const list = missingMcp.map((n) => `"${n}"`).join(', ')
        return errorResult(
          `Cannot run sub-agent "${def.name}": required MCP server(s) not connected: ${list}. ` +
            `Configure the missing server(s) in MCP settings, then retry.`
        )
      }
      agentType = {
        name: def.name,
        displayName: def.displayName,
        description: def.whenToUse,
        tools: [...def.tools],
        maxTurns: def.maxTurns,
        systemPrompt: def.systemPrompt
      }
    } else if (this.deps.defaultAgentType) {
      // 省略类型：用注入的默认子代理（继承调用方工具/系统提示，由宿主装配）
      agentType = this.deps.defaultAgentType
    } else {
      return errorResult(
        `Missing required parameter "subagent_type". Available: [${names().join(', ')}]`
      )
    }

    try {
      const { result } = await this.deps.manager.runTask({
        parentSessionId: this.deps.parentSessionId,
        parentToolCallId: toolCallId,
        agentType,
        prompt,
        description,
        modelConfig: this.deps.modelConfig,
        parentAbortSignal: signal
      })
      return { content: [{ type: 'text' as const, text: result }], details: undefined }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return errorResult(`Error: ${msg}`)
    }
  }
}

/** 工厂：创建派发工具实例 */
export function createDispatchAgentTool(deps: DispatchAgentToolDeps): DispatchAgentTool {
  return new DispatchAgentTool(deps)
}

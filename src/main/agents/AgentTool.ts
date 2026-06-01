/**
 * AgentTool —— 统一 sub-agent 派发工具
 *
 * LLM 只看到一个名为 `Agent` 的工具，通过 `subagent_type` 参数选择目标。
 * 可用的 subagent_type 列表由 AgentService 动态扫描 ~/.shuvix/agents/ 与
 * resources/agents/ 得出，并嵌入 description（每次 buildTools 重建即刷新）。
 *
 * 父对话框中作为普通 tool call 渲染（ToolCallBlock 在标题里特化为
 * `Agent · <subagent_type>`），子智能体的流式过程仍由右侧 Sub-agent 面板负责。
 */

import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { BaseTool } from '../services/baseTool'
import { TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import { mcpService } from '../services/mcpService'
import { agentService } from '../services/agentService'
import { agentManager, type InProcessAgentType } from './AgentManager'
import type { AgentDefinition, SubAgentModelConfig } from './types'
import { registerBuiltinTool } from '../services/toolRegistry'

/** 父级注入的构建上下文 */
export interface AgentToolContext {
  modelConfig: SubAgentModelConfig
}

/** Agent 工具参数（与 Claude Code 对齐：description / subagent_type / prompt） */
const AgentParamsSchema = Type.Object({
  description: Type.String({
    description: 'A short (3-5 word) description of the task'
  }),
  subagent_type: Type.String({
    description:
      'The type of specialized agent to use. Available types are listed in this tool description.'
  }),
  prompt: Type.String({
    description:
      'The task for the agent to perform. The agent does NOT see your conversation history — be self-contained, include file paths, requirements, and constraints.'
  })
})

const MAX_WHEN_TO_USE_CHARS = 240

/** 工具描述中每行 agent 的格式：- name: whenToUse (Tools: ...) */
function formatAgentLine(def: AgentDefinition): string {
  const firstSentence = def.whenToUse.split(/(?<=[.。!?！？])\s+/)[0] ?? def.whenToUse
  const trimmed =
    firstSentence.length > MAX_WHEN_TO_USE_CHARS
      ? firstSentence.slice(0, MAX_WHEN_TO_USE_CHARS - 1) + '…'
      : firstSentence
  const toolsHint = def.tools.length === 0 ? 'none' : def.tools.join(', ')
  return `- ${def.name}: ${trimmed} (Tools: ${toolsHint})`
}

/** 构建动态描述（按 Claude Code Agent prompt 结构） */
function buildDescription(): string {
  const defs = agentService.listEnabled()
  const list =
    defs.length === 0
      ? '(No agent types are currently available — add an AGENT.md under ~/.shuvix/agents/<name>/.)'
      : defs.map(formatAgentLine).join('\n')

  return `Launch a new agent to handle complex, multi-step tasks autonomously.

Available agent types and the tools they have access to:
${list}

When using the Agent tool, you must specify a subagent_type to select which agent type to use.

When NOT to use the Agent tool:
- If you want to read a specific file path, use Read or Glob — faster
- If you are searching for a specific class definition, use Grep — faster
- If a task is straightforward (1-2 tool calls), do it yourself

Usage notes:
- The agent does NOT share your conversation history — provide complete context in \`prompt\`.
- The agent's final result is returned only to you, not visible to the user — summarize for the user.
- Each invocation is stateless; cannot resume a previous session.
- Trust the agent's output — re-running rarely changes results.
- Launch multiple agents concurrently when possible (single message, multiple tool calls).

Example:
<example>
user: "Find every file that touches the auth flow."
assistant: I'm going to launch the explore agent.
Agent({
  description: "Find auth-touching files",
  subagent_type: "explore",
  prompt: "Find every file related to the authentication flow in this repo. Cover login, logout, token refresh, middleware. Return absolute paths grouped by responsibility."
})
</example>`
}

/** Agent 派发工具 —— 唯一对 LLM 暴露的入口 */
export class AgentTool extends BaseTool<typeof AgentParamsSchema> {
  readonly name = 'Agent'
  readonly label = 'Agent'
  readonly parameters = AgentParamsSchema

  constructor(
    private ctx: ToolContext,
    private agentCtx: AgentToolContext
  ) {
    super()
  }

  /** 描述按访问动态生成，反映当前 AgentService 注册表 */
  get description(): string {
    return buildDescription()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op — sub-agent 内部工具自带沙箱 */
  }

  protected async executeInternal(
    toolCallId: string,
    params: { description: string; subagent_type: string; prompt: string },
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const description = params.description || ''
    const subagentType = (params.subagent_type || '').trim()
    const prompt = params.prompt || ''

    // 1. subagent_type 缺失
    if (!subagentType) {
      return errorResult(
        `Missing required parameter "subagent_type". Available: [${availableNames().join(', ')}]`
      )
    }

    // 2. 找定义
    const def = agentService.getEnabled(subagentType)
    if (!def) {
      return errorResult(
        `Unknown subagent_type "${subagentType}". Available: [${availableNames().join(', ')}]`
      )
    }

    // 3. 检查 requiredMcp
    const missingMcp = (def.requiredMcp ?? []).filter((name) => !mcpService.isConnectedByName(name))
    if (missingMcp.length > 0) {
      const list = missingMcp.map((n) => `"${n}"`).join(', ')
      return errorResult(
        `Cannot run sub-agent "${def.name}": required MCP server(s) not connected: ${list}. ` +
          `Open Settings → MCP and configure the missing server(s), then retry.`
      )
    }

    // 4. 派发
    const agentType: InProcessAgentType = {
      name: def.name,
      displayName: def.displayName,
      description: def.whenToUse,
      tools: [...def.tools],
      maxTurns: def.maxTurns,
      systemPrompt: def.systemPrompt
    }

    try {
      const { result } = await agentManager.runTask({
        parentSessionId: this.ctx.sessionId,
        parentToolCallId: toolCallId,
        agentType,
        prompt,
        description,
        modelConfig: this.agentCtx.modelConfig,
        parentAbortSignal: signal
      })
      return {
        content: [{ type: 'text' as const, text: result }],
        details: undefined
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return errorResult(`Error: ${msg}`)
    }
  }
}

function availableNames(): string[] {
  return agentService.listEnabled().map((a) => a.name)
}

function errorResult(text: string): AgentToolResult<undefined> {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined
  }
}

// ─── 注册到 toolRegistry ──────────────────────────────────────
// 不提供 factory —— 由 agentToolBuilder 直接 new AgentTool(ctx, agentCtx)，
// 因为构造需要父级注入的 modelConfig。registerBuiltinTool 这里只承担
// "presentation/label" 的注册作用，供 ToolCallBlock 渲染时查找。
registerBuiltinTool({
  name: 'Agent',
  group: 'agent',
  defaultEnabled: true,
  hidden: true, // 单工具不在工具选择器里出现；它的"开关"语义即"全部子代理"
  getLabel: () => 'Agent',
  getHint: () => 'Launch a sub-agent to handle a complex task',
  presentation: {
    icon: 'Bot',
    summaryField: 'description'
  }
})

/**
 * Agent 派发工具（跨端共享）。
 *
 * LLM 只看到一个名为 `Agent` 的工具，经 `agent` 参数以统一 ref 选择目标：
 *   - 具名 ref（如 "explore"）→ 注入的 SubAgentRegistry 按名解析（内置 + 用户全局定义）；
 *   - 路径 ref（含 "/" 或以 .md 结尾）→ 宿主注入的 resolveAgentFile 即时解析定义文件
 *     （frontmatter: name/whenToUse/tools/maxTurns + 正文为 system prompt）——支持项目内
 *     检入的定义与运行时动态生成的定义，无需注册表刷新；
 *   - 省略 → 默认 agent（宿主提供 defaultAgentType 时）。
 * 可用具名类型动态嵌入 description。执行时校验 ref + requiredMcp，委托
 * SubAgentManager.runTask，返回最终文本结果。注册表/文件解析/MCP 判定/模型配置经注入，宿主无关。
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
  agent: Type.Optional(
    Type.String({
      description:
        'Which agent to dispatch: a named agent type listed in this tool description, ' +
        'or a path to an agent definition file (markdown with YAML frontmatter). ' +
        'Optional when a default agent is offered — omit to use the default.'
    })
  ),
  prompt: Type.String({
    description:
      'The task for the agent to perform. The agent does NOT see your conversation history — be self-contained, include file paths, requirements, and constraints.'
  })
})

const MAX_WHEN_TO_USE_CHARS = 240

/** ref 判别：含路径分隔符或 .md 后缀 → 文件路径形态 */
export function isAgentFileRef(ref: string): boolean {
  return ref.includes('/') || ref.includes('\\') || ref.toLowerCase().endsWith('.md')
}

/** AgentDefinition → 派发运行配置的纯投影（Agent 工具与用户直发派发共用同一口径） */
export function toInProcessAgentType(def: AgentDefinition): InProcessAgentType {
  return {
    name: def.name,
    displayName: def.displayName,
    description: def.whenToUse,
    tools: [...def.tools],
    maxTurns: def.maxTurns,
    systemPrompt: def.systemPrompt
  }
}

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
  defaultAgentType?: InProcessAgentType,
  supportsFileRefs?: boolean
): string {
  const defs = registry.listEnabled()

  // 具名定义才进「可选类型」列表；默认 agent 不具名展示（否则模型会照抄名字），
  // 仅在下方说明里提示「可省略 agent 走默认」。
  let typesBlock: string
  if (defs.length > 0) {
    typesBlock =
      `Available agent types and the tools they have access to:\n${defs.map(formatAgentLine).join('\n')}\n\n` +
      (defaultAgentType
        ? 'Set `agent` to one of the types above, or omit it to dispatch a default agent that inherits your current tools.'
        : 'Set `agent` to one of the types above.')
  } else if (defaultAgentType) {
    // 无具名类型：省略 agent 即可，不要提任何类型名
    typesBlock =
      'Omit `agent`: the dispatched agent inherits your current tools to complete the task autonomously.'
  } else {
    typesBlock = '(No agent types are currently available.)'
  }

  const fileRefNote = supportsFileRefs
    ? '\n- `agent` also accepts a path to an agent definition file: markdown with YAML frontmatter ' +
      '(`name`, `whenToUse` or `description`, `tools: [...]`, optional `maxTurns`) and the body as its system prompt. ' +
      'Relative paths resolve against the working directory; the file must live inside the working directory or the global agents directory. ' +
      'You may write such a file first and dispatch it immediately. ' +
      'Include `Agent` in its `tools` list only if the spawned agent should be able to dispatch further agents (depth-limited).'
    : ''

  return `Launch a new agent to handle complex, multi-step tasks autonomously.

${typesBlock}

Usage notes:
- The agent does NOT share your conversation history — provide complete context in \`prompt\`.
- The agent's final result is returned only to you, not visible to the user — summarize for the user.
- Each invocation is stateless; cannot resume a previous session.
- Re-dispatching is usually unnecessary; only re-run if the result is incomplete or contradicts what you observe.
- Launch multiple agents concurrently when possible (single message, multiple tool calls).${fileRefNote}`
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
   * 默认 agent —— 提供后 `agent` 参数变为可选：省略时用它派发。
   * 注册表里的具名定义成为可选附加，而非调用前提。缺省则维持"必须指定 agent"。
   */
  defaultAgentType?: InProcessAgentType
  /**
   * 路径 ref 解析器（可选；桌面注入，浏览器宿主省略 → 路径形态返回明确错误）。
   * 解析失败应 throw 带原因的 Error；文件不存在/无法解析返回 undefined。
   */
  resolveAgentFile?: (
    path: string
  ) => AgentDefinition | undefined | Promise<AgentDefinition | undefined>
}

function errorResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text' as const, text }], details: undefined }
}

/** Agent 派发工具 —— 唯一对 LLM 暴露的派发入口 */
export class DispatchAgentTool extends BaseTool<typeof AgentParamsSchema> {
  readonly name = 'Agent'
  readonly label: string
  readonly parameters = AgentParamsSchema

  constructor(private deps: DispatchAgentToolDeps) {
    super()
    this.label = deps.label ?? 'Agent'
  }

  get description(): string {
    return buildDescription(
      this.deps.registry,
      this.deps.defaultAgentType,
      !!this.deps.resolveAgentFile
    )
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op — 派生 agent 内部工具自带审批 */
  }

  protected async executeInternal(
    toolCallId: string,
    params: { description: string; agent?: string; prompt: string },
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    if (signal?.aborted) throw new Error(this.deps.abortError)

    const description = params.description || ''
    const ref = (params.agent || '').trim()
    const prompt = params.prompt || ''
    const names = (): string[] => this.deps.registry.listEnabled().map((a) => a.name)
    const hasDefault = !!this.deps.defaultAgentType

    // ── ref 解析：路径 → resolveAgentFile；具名 → 注册表；省略 → 默认 agent ──
    let def: AgentDefinition | undefined
    if (ref && isAgentFileRef(ref)) {
      if (!this.deps.resolveAgentFile) {
        return errorResult(
          `Path-based agent refs are not supported on this host. Use a named agent type instead: [${names().join(', ')}]`
        )
      }
      try {
        def = await this.deps.resolveAgentFile(ref)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return errorResult(`Cannot load agent definition from "${ref}": ${msg}`)
      }
      if (!def) {
        return errorResult(
          `Agent definition file not found or invalid: "${ref}". Expected a markdown file with YAML frontmatter (name/whenToUse/tools) and the system prompt as body.`
        )
      }
    } else if (ref) {
      def = this.deps.registry.getEnabled(ref)
      if (!def) {
        const tail = hasDefault ? ' (or omit `agent` to use the default)' : ''
        return errorResult(
          `Unknown agent "${ref}". Available: [${names().join(', ')}]${tail}. A path to an agent definition file is also accepted.`
        )
      }
    }

    let agentType: InProcessAgentType
    if (def) {
      const isConnected = this.deps.isMcpConnected ?? (() => true)
      const missingMcp = (def.requiredMcp ?? []).filter((n) => !isConnected(n))
      if (missingMcp.length > 0) {
        const list = missingMcp.map((n) => `"${n}"`).join(', ')
        return errorResult(
          `Cannot run agent "${def.name}": required MCP server(s) not connected: ${list}. ` +
            `Configure the missing server(s) in MCP settings, then retry.`
        )
      }
      agentType = toInProcessAgentType(def)
    } else if (this.deps.defaultAgentType) {
      // 省略 ref：用注入的默认 agent（继承调用方工具/系统提示，由宿主装配）
      agentType = this.deps.defaultAgentType
    } else {
      return errorResult(`Missing required parameter "agent". Available: [${names().join(', ')}]`)
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

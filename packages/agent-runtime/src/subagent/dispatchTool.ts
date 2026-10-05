/**
 * Agent 派发工具（跨端共享）。
 *
 * LLM 只看到一个名为 `agent` 的工具，经 `name` 参数以统一 ref 选择目标
 * （参数名与 session 工具 `create-sub-session` 点名档案用的字段同为 name）：
 *   - 具名 ref（如 "explore"）→ 注入的 SubAgentRegistry 按名解析（内置 + 用户全局定义）；
 *   - 路径 ref（含 "/" 或以 .md 结尾）→ 宿主注入的 resolveAgentFile 即时解析定义文件
 *     （frontmatter: name/description/shuvix-tools + 正文为 system prompt）——支持项目内
 *     检入的定义与运行时动态生成的定义，无需注册表刷新。
 * description 为静态文案（纯 md 驱动：不罗列可用类型——要用具名 agent 由用户在系统
 * 提示词/指令文件里自行引导；未知名的错误里才回报可用名列表）。
 *
 * 执行（P2-05）：调用方是谁不靠注入 —— 交给路由的是这次调用的 scope（`api`：调用方对话、任务、现取的
 * 模型与思考档位都在它身上），路由把派发交给会话的协调器。工具是 **replay safe**：崩溃后继续时重跑，
 * 协调器按拥有者边找回已建的子对话、以同一 requestId 重新挂上（不会派出第二个）。解析出的运行投影
 * 记进 `api.memo('agentType')`（PIN-10）：重跑直接用它，档案之后被改 / 被删也不影响这一次派发。
 *
 * 模型看到的文本（PIN-04）：子 agent 没建起来（深度 / 解析失败）→ `Error: <原因>`；建起来了 → 路由交回的
 * 结果文本。从不设 `isError`。自己的 signal 落下 → 抛 `abortError`（durable 的中止语义靠它）。
 */
import type { JsonValue } from '@earendil-works/chord'
import { Type } from 'typebox'
import type { ToolResult } from '../tools/toolResult'
import { BaseTool } from '../tools/baseTool'
import type { ToolCallScope } from '../tools/toolCall'
import type { AgentProfile, SubAgentRegistry, InProcessAgentType } from './types'
import type { SubAgentManager } from './manager'

/**
 * 派发工具名 —— 与其余内置工具同为全小写（read/write/bash…）。
 * 它同时是 agent md `shuvix-tools` 里的嵌套派发白名单值，故各端按名判定统一引用此常量。
 */
export const DISPATCH_TOOL_NAME = 'agent'

export const AgentParamsSchema = Type.Object({
  description: Type.String({ description: 'A short (3-5 word) description of the task' }),
  name: Type.Optional(
    Type.String({
      description:
        'Which agent to dispatch: the name of a configured agent definition, ' +
        'or a path to an agent definition file (markdown with YAML frontmatter). ' +
        'Only use names your instructions or the user provide — do not guess. ' +
        'Optional when a default agent is offered — omit to use the default.'
    })
  ),
  prompt: Type.String({
    description:
      'The task for the agent to perform. The agent does NOT see your conversation history — be self-contained, include file paths, requirements, and constraints.'
  })
})

/** ref 判别：含路径分隔符或 .md 后缀 → 文件路径形态 */
export function isAgentFileRef(ref: string): boolean {
  return ref.includes('/') || ref.includes('\\') || ref.toLowerCase().endsWith('.md')
}

/** AgentProfile → 运行投影的纯口径（Agent 工具/用户直发/根会话创建共用） */
export function toInProcessAgentType(def: AgentProfile): InProcessAgentType {
  return {
    name: def.name,
    displayName: def.displayName,
    description: def.description,
    tools: [...def.tools],
    systemPrompt: def.systemPrompt,
    model: def.model,
    thinkingLevel: def.thinkingLevel,
    instructionFiles: [...def.instructionFiles],
    projectAwareness: def.projectAwareness
  }
}

/**
 * 静态工具描述（纯 md 驱动）：不罗列可用 agent 类型 —— 具名派发由用户在系统提示词/
 * 指令文件中自行引导，模型不该猜名字；未知名在执行错误里回报可用名列表。
 */
export function buildDescription(supportsFileRefs?: boolean): string {
  const typesBlock =
    'Named agent types are defined by the host configuration (built-in and user agent definition files); ' +
    'they are not enumerated here. Set `name` only when your instructions or the user provide one — ' +
    'an unknown name fails with the list of valid names.'

  const fileRefNote = supportsFileRefs
    ? '\n- `name` also accepts a path to an agent definition file: markdown with YAML frontmatter ' +
      '(`name`, `description`, and `shuvix-tools` as a comma-separated list) with the body as its system prompt. ' +
      'Relative paths resolve against the working directory; the file must live inside the working directory or the global agents directory. ' +
      'You may write such a file first and dispatch it immediately. ' +
      'Include `agent` in its `shuvix-tools` list only if the spawned agent should be able to dispatch further agents (depth-limited).'
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
  /** 这个工具所在的会话（派生 agent 的派发工具也是根会话的 id，从不是 agentId） */
  sessionId: string
  /** abort 时抛出的错误信息（与平台 TOOL_ABORTED 对齐） */
  abortError: string
  /** 工具显示名（缺省即工具名 'agent'；宿主可注入本地化名） */
  label?: string
  /**
   * 路径 ref 解析器（可选；桌面注入，浏览器宿主省略 → 路径形态返回明确错误）。
   * 解析失败应 throw 带原因的 Error；文件不存在/无法解析返回 undefined。
   */
  resolveAgentFile?: (path: string) => AgentProfile | undefined | Promise<AgentProfile | undefined>
}

function errorResult(text: string): ToolResult<undefined> {
  return { content: [{ type: 'text' as const, text }], details: undefined }
}

/** 运行投影收成严格 JSON（去掉 undefined 键），才能进 `api.memo` */
function memoable(agentType: InProcessAgentType): JsonValue {
  return JSON.parse(JSON.stringify(agentType)) as JsonValue
}

/** memo 里读回的运行投影（只认对象形；别的形状 = 没记过） */
function agentTypeOf(value: JsonValue | undefined): InProcessAgentType | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as unknown as InProcessAgentType)
    : undefined
}

const AGENT_TYPE_MEMO = 'agentType'

/** agent 派发工具 —— 唯一对 LLM 暴露的派发入口 */
export class DispatchAgentTool extends BaseTool<typeof AgentParamsSchema> {
  readonly name = DISPATCH_TOOL_NAME
  readonly label: string
  readonly parameters = AgentParamsSchema
  /** 重跑无害：协调器按拥有者边重新挂上已建的子对话（P2-05，RT-1b） */
  readonly replay = 'safe' as const

  constructor(private deps: DispatchAgentToolDeps) {
    super()
    this.label = deps.label ?? DISPATCH_TOOL_NAME
  }

  get description(): string {
    return buildDescription(!!this.deps.resolveAgentFile)
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op — 派生 agent 内部工具自带询问 */
  }

  /** 按 ref 解析档案：成功 → 运行投影；失败 → 交给模型的错误文本 */
  private async resolveRef(ref: string): Promise<InProcessAgentType | string> {
    const names = (): string[] => this.deps.registry.list().map((a) => a.name)
    let def: AgentProfile | undefined
    if (ref && isAgentFileRef(ref)) {
      if (!this.deps.resolveAgentFile) {
        return `Path-based agent refs are not supported on this host. Use a named agent type instead: [${names().join(', ')}]`
      }
      try {
        def = await this.deps.resolveAgentFile(ref)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `Cannot load agent definition from "${ref}": ${msg}`
      }
      if (!def) {
        return `Agent definition file not found or invalid: "${ref}". Expected a markdown file with YAML frontmatter (name/description/shuvix-tools) and the system prompt as body.`
      }
    } else if (ref) {
      def = this.deps.registry.get(ref)
      if (!def) {
        return `Unknown agent "${ref}". Available: [${names().join(', ')}]. A path to an agent definition file is also accepted.`
      }
    }
    if (!def) {
      return `Missing "name": \`name\` must select an agent. Available: [${names().join(', ')}]`
    }
    return toInProcessAgentType(def)
  }

  protected async executeInternal(
    toolCallId: string,
    params: { description: string; name?: string; prompt: string },
    signal: AbortSignal | undefined,
    call: ToolCallScope
  ): Promise<ToolResult<undefined>> {
    if (signal?.aborted) throw new Error(this.deps.abortError)

    const description = params.description || ''
    const prompt = params.prompt || ''

    // 重跑：用第一次解析出的投影（PIN-10）；第一次：解析 ref，记下投影
    let agentType = agentTypeOf(await call.api.memo<JsonValue>(AGENT_TYPE_MEMO, call.context))
    if (agentType === undefined) {
      const resolved = await this.resolveRef((params.name || '').trim())
      if (typeof resolved === 'string') return errorResult(resolved)
      agentType =
        agentTypeOf(await call.api.memo(AGENT_TYPE_MEMO, memoable(resolved), call.context)) ??
        resolved
    }

    try {
      const outcome = await this.deps.manager.runTask({
        sessionId: this.deps.sessionId,
        owner: { tool: call },
        parentToolCallId: toolCallId,
        agentType,
        prompt,
        description
      })
      if (signal?.aborted) throw new Error(this.deps.abortError)
      // 子 agent 根本没建起来（深度 / 解析失败）：原因前缀 Error:（PIN-04）
      const text =
        outcome.error !== undefined && outcome.conversationId === undefined
          ? `Error: ${outcome.error}`
          : outcome.result
      return { content: [{ type: 'text' as const, text }], details: undefined }
    } catch (err) {
      if (signal?.aborted) throw new Error(this.deps.abortError)
      const msg = err instanceof Error ? err.message : String(err)
      return errorResult(`Error: ${msg}`)
    }
  }
}

/** 工厂：创建派发工具实例 */
export function createDispatchAgentTool(deps: DispatchAgentToolDeps): DispatchAgentTool {
  return new DispatchAgentTool(deps)
}

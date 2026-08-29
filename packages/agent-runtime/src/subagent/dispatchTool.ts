/**
 * Agent 派发工具（跨端共享）。
 *
 * LLM 只看到一个名为 `agent` 的工具，经 `name` 参数以统一 ref 选择目标
 * （参数名与输入框档案选择器/`session.updateAgentProfile` 用的字段同为 name）：
 *   - 具名 ref（如 "explore"）→ 注入的 SubAgentRegistry 按名解析（内置 + 用户全局定义）；
 *   - 路径 ref（含 "/" 或以 .md 结尾）→ 宿主注入的 resolveAgentFile 即时解析定义文件
 *     （frontmatter: name/description/shuvix-tools + 正文为 system prompt）——支持项目内
 *     检入的定义与运行时动态生成的定义，无需注册表刷新；
 *   - 省略 → 默认 agent（宿主提供 defaultAgentType 时）。
 * description 为静态文案（纯 md 驱动：不罗列可用类型——要用具名 agent 由用户在系统
 * 提示词/指令文件里自行引导；未知名的错误里才回报可用名列表）。执行时校验 ref，
 * 委托 SubAgentManager.runTask，返回最终文本结果。注册表/文件解析/模型配置经注入，宿主无关。
 */
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { BaseTool } from '../tools/baseTool'
import type {
  AgentProfile,
  SubAgentModelConfig,
  SubAgentRegistry,
  InProcessAgentType
} from './types'
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
    instructionFiles: [...def.instructionFiles],
    projectAwareness: def.projectAwareness
  }
}

/**
 * 静态工具描述（纯 md 驱动）：不罗列可用 agent 类型 —— 具名派发由用户在系统提示词/
 * 指令文件中自行引导，模型不该猜名字；未知名在执行错误里回报可用名列表。
 */
export function buildDescription(hasDefaultAgent: boolean, supportsFileRefs?: boolean): string {
  const typesBlock =
    'Named agent types are defined by the host configuration (built-in and user agent definition files); ' +
    'they are not enumerated here. Set `name` only when your instructions or the user provide one — ' +
    'an unknown name fails with the list of valid names.' +
    (hasDefaultAgent
      ? ' Omit `name` to dispatch a default agent that inherits your current tools.'
      : '')

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
  /**
   * 派生 agent 的模型配置。传 getter 则在每次派发时求值 ——
   * 跟随会话当前模型/思考档位（静态值会在会话中途 setModel 后陈旧）。
   */
  modelConfig: SubAgentModelConfig | (() => SubAgentModelConfig)
  parentSessionId: string
  /** abort 时抛出的错误信息（与平台 TOOL_ABORTED 对齐） */
  abortError: string
  /** 工具显示名（缺省即工具名 'agent'；宿主可注入本地化名） */
  label?: string
  /**
   * 默认 agent —— 提供后 `name` 参数变为可选：省略时用它派发。
   * 注册表里的具名定义成为可选附加，而非调用前提。缺省则维持"必须指定 agent"。
   */
  defaultAgentType?: InProcessAgentType
  /**
   * 路径 ref 解析器（可选；桌面注入，浏览器宿主省略 → 路径形态返回明确错误）。
   * 解析失败应 throw 带原因的 Error；文件不存在/无法解析返回 undefined。
   */
  resolveAgentFile?: (path: string) => AgentProfile | undefined | Promise<AgentProfile | undefined>
}

function errorResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text' as const, text }], details: undefined }
}

/** agent 派发工具 —— 唯一对 LLM 暴露的派发入口 */
export class DispatchAgentTool extends BaseTool<typeof AgentParamsSchema> {
  readonly name = DISPATCH_TOOL_NAME
  readonly label: string
  readonly parameters = AgentParamsSchema

  constructor(private deps: DispatchAgentToolDeps) {
    super()
    this.label = deps.label ?? DISPATCH_TOOL_NAME
  }

  get description(): string {
    return buildDescription(!!this.deps.defaultAgentType, !!this.deps.resolveAgentFile)
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op — 派生 agent 内部工具自带询问 */
  }

  protected async executeInternal(
    toolCallId: string,
    params: { description: string; name?: string; prompt: string },
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    if (signal?.aborted) throw new Error(this.deps.abortError)

    const description = params.description || ''
    const ref = (params.name || '').trim()
    const prompt = params.prompt || ''
    const names = (): string[] => this.deps.registry.list().map((a) => a.name)
    const hasDefault = !!this.deps.defaultAgentType

    // ── ref 解析：路径 → resolveAgentFile；具名 → 注册表；省略 → 默认 agent ──
    let def: AgentProfile | undefined
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
          `Agent definition file not found or invalid: "${ref}". Expected a markdown file with YAML frontmatter (name/description/shuvix-tools) and the system prompt as body.`
        )
      }
    } else if (ref) {
      def = this.deps.registry.get(ref)
      if (!def) {
        const tail = hasDefault ? ' (or omit `name` to use the default)' : ''
        return errorResult(
          `Unknown agent "${ref}". Available: [${names().join(', ')}]${tail}. A path to an agent definition file is also accepted.`
        )
      }
    }

    let agentType: InProcessAgentType
    if (def) {
      agentType = toInProcessAgentType(def)
    } else if (this.deps.defaultAgentType) {
      // 省略 ref：用注入的默认 agent（继承调用方工具/系统提示，由宿主装配）
      agentType = this.deps.defaultAgentType
    } else {
      return errorResult(
        `Missing "name": this host offers no default agent, so \`name\` must select one. Available: [${names().join(', ')}]`
      )
    }

    try {
      // getter 形态在派发时求值：跟随会话当前模型/思考档位
      const modelConfig =
        typeof this.deps.modelConfig === 'function'
          ? this.deps.modelConfig()
          : this.deps.modelConfig
      const { result } = await this.deps.manager.runTask({
        parentSessionId: this.deps.parentSessionId,
        parentToolCallId: toolCallId,
        agentType,
        prompt,
        description,
        modelConfig,
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

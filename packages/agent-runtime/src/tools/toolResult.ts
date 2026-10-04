/**
 * 工具结果与工具形状。
 *
 * **durable 原生**（P1-04 起）：工具就是 pi-durable 的 `ToolRegistration`，执行签名
 * `execute(args, api, context)`，交回 `ToolExecutionResult`。BaseTool 子类返回的是 `ToolResult` ——
 * durable 结果的字段，但 details 用 ShuviX 自己的类型（chat-protocol 的 details 接口不带索引签名，
 * 算不上 durable 的 `JsonValue`）；BaseTool 的模板在边界上把它收成严格 JSON（`toExecutionResult`）。
 *
 * **抛错不进 `<harness>`**（裁定 Q12）：durable 把 `execute()` 抛出的错误写成一条
 * `<harness>\n[error] …\n</harness>` 诊断，模型看到的字就变了。ShuviX 的工具改成在自己这一层接住，
 * 交回 `{ isError: true, content: [{ type: 'text', text: message }] }` —— 与 pi 0.80 的
 * createErrorToolResult 同一段文字（`toolErrorResult`）。只有**取消**（context 已 abort）照旧抛，
 * durable 的中止语义靠它。
 *
 * **旧形状**（过渡期）：`AgentTool` / `AgentToolResult` 是 pi 0.80 agent 包的形状
 * `execute(toolCallId, params, signal, onUpdate)`，ask / git / MCP 桥接层还在用。
 * `fromAgentTool` 把一个旧形状工具包成 durable 注册项（错误同样按 Q12 收口），宿主的输出包装器与
 * 测试辅助 `invokeTool` 都经它接受两种形状。
 * TODO(pi-durable p1): P1-05 把 ask / git / MCP 改成 durable 原生之后，旧形状、`fromAgentTool`
 * 与 `isLegacyAgentTool` 一并删除。
 */
import { copyJson, type JsonValue } from '@earendil-works/chord'
import type {
  ToolControl,
  ToolDiagnostic,
  ToolExecutionMode as DurableToolExecutionMode,
  ToolExecutionResult,
  ToolRegistration
} from '@earendil-works/pi-durable'
import type { ImageContent, Static, TextContent, Tool, TSchema } from '@earendil-works/pi-ai'
import { backstopOutputLimits, type OutputDeclaration } from './outputLimits'

// ─── durable 原生 ─────────────────────────────────────────────

/** 工具结果的内容块（模型面） */
export type ToolContent = TextContent | ImageContent

/**
 * BaseTool 子类交回的结果 —— durable `ToolExecutionResult` 的字段，details 用 ShuviX 自己的类型。
 * content 恒给（宿主包装器按块处理文本）。details 键恒在（没有就写 `details: undefined`，与旧形状
 * 一致，文件工具内核等处因此能按具体类型读它）；值必须是严格 JSON（不放 Date / class 实例 /
 * 数组里的 undefined —— 对象属性上的 undefined 会在边界上丢掉，undefined 的 details 整个不带出）。
 */
export interface ToolResult<TDetails = unknown> {
  content: ToolContent[]
  details: TDetails
  isError?: boolean
  /** 工具跑完之后的流程控制（如结果契约 `next` 的 `terminate: true`） */
  control?: ToolControl
  /** 关于这次调用的附注（模型可见，渲染成 `<harness>` 段）—— 慎用 */
  diagnostics?: readonly ToolDiagnostic[]
}

/** 同批工具的执行方式：并行，或按调用顺序逐个（即 durable 的同名类型） */
export type ToolExecutionMode = DurableToolExecutionMode

/** 工具表里混放各种 schema / details 的 durable 注册项 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 混放各种 schema 的工具表
export type AnyTool = ToolRegistration<any, any>

/** 抛错的消息原文（非 Error 的抛出物按 String 化） */
export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 工具抛错 → 模型可见的失败结果（裁定 Q12）：文字就是错误消息本身，与 pi 0.80 一致；
 * 不带 details，也不带诊断（诊断会渲染成 `<harness>` 段，正是要避开的那段文字）。
 */
export function toolErrorResult(error: unknown): ToolExecutionResult {
  return { isError: true, content: [{ type: 'text', text: errorMessageOf(error) }] }
}

/**
 * details 收成严格 JSON：对象属性上的 undefined 丢掉（durable 落库时也这么做）；
 * 真不是 JSON 的东西（Date、class 实例、数组里的 undefined、循环引用）先尝试按
 * `JSON.stringify` 的口径转一遍，再不行就整份丢掉 —— 结果照常交回，只是界面少了这份细节。
 * 两种降级都打一条开发期警告：工具的 details 本该在源头就是 JSON（见各工具的单测）。
 */
export function strictJsonDetails(details: unknown, toolName: string): JsonValue | undefined {
  if (details === undefined) return undefined
  try {
    return copyJson(details, { omitUndefinedProperties: true })
  } catch (strictError) {
    try {
      const coerced = JSON.parse(JSON.stringify(details)) as JsonValue | undefined
      console.warn(
        `[tool] ${toolName}: details are not strict JSON (${errorMessageOf(strictError)}); coerced with JSON.stringify`
      )
      return coerced ?? undefined
    } catch (coerceError) {
      console.warn(
        `[tool] ${toolName}: details dropped — not JSON-serialisable (${errorMessageOf(coerceError)})`
      )
      return undefined
    }
  }
}

/** BaseTool 子类的结果 → durable 结果：只带出给了的字段，details 收成严格 JSON */
export function toExecutionResult(result: ToolResult, toolName: string): ToolExecutionResult {
  const details = strictJsonDetails(result.details, toolName)
  return {
    content: result.content,
    ...(details === undefined ? {} : { details }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.control === undefined ? {} : { control: result.control }),
    ...(result.diagnostics === undefined || result.diagnostics.length === 0
      ? {}
      : { diagnostics: result.diagnostics })
  }
}

// ─── 旧形状（过渡期；P1-05 删） ───────────────────────────────

/** 旧形状工具的最终或中间结果 */
export interface AgentToolResult<T> {
  /** 交给模型的文本 / 图片内容 */
  content: ToolContent[]
  /** 给日志与界面的结构化细节 */
  details: T
  /** 本结果引入、从这一处起可用的工具名（durable：`control.addTools`） */
  addedToolNames?: string[]
  /** 提示本批工具跑完后停下（durable：`control.terminate`） */
  terminate?: boolean
}

/** 旧形状工具流式汇报中间结果的回调（只在本次 execute 期间有效） */
export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void

/** 旧形状的可执行工具定义（pi 0.80 agent 包的 `AgentTool`） */
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 与旧形状一致：details 由各工具自定
  TDetails = any
> extends Tool<TParameters> {
  /** 界面显示名 */
  label: string
  /** 校验前修整模型常写错的参数（须返回符合 schema 的对象） */
  prepareArguments?: (args: unknown) => Static<TParameters>
  /** 执行。失败时抛错，不要把错误编码进 content */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>
  ) => Promise<AgentToolResult<TDetails>>
  /** 单个工具覆盖同批执行方式 */
  executionMode?: ToolExecutionMode
}

/** 任意参数 / 细节类型的旧形状工具 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 混放各种 schema 的工具表
export type AnyLegacyAgentTool = AgentTool<any, any>

/**
 * 是不是旧形状工具。判据是 durable 的 `replay`：ShuviX 的 durable 注册项（BaseTool 子类、
 * `fromAgentTool` 的产物）都明写了它，旧形状工具从来没有这个字段。
 * 新写的 durable 工具因此**必须**显式声明 `replay`（反正也该声明：缺省是 'unsafe'）。
 */
export function isLegacyAgentTool(tool: object): tool is AnyLegacyAgentTool {
  return !('replay' in tool)
}

/** 旧形状结果 → durable 结果：terminate / addedToolNames 进 control，details 收成严格 JSON */
export function fromAgentToolResult(
  result: AgentToolResult<unknown>,
  toolName: string
): ToolExecutionResult {
  const control: { terminate?: true; addTools?: string[] } = {}
  if (result.terminate) control.terminate = true
  if (result.addedToolNames?.length) control.addTools = result.addedToolNames
  return toExecutionResult(
    {
      content: result.content,
      details: result.details,
      ...(Object.keys(control).length > 0 ? { control } : {})
    },
    toolName
  )
}

/**
 * 旧形状工具 → durable 注册项。原工具做原型（name / description / parameters / label / mcpMeta
 * 等字段与 getter 照常可读），只覆盖 `execute` 并补上 `replay`（'unsafe'：旧形状工具没声明过能否
 * 重跑）与 `outputLimits`（按它的截断声明推出的兜底值）。执行时按旧约定调
 * `execute(api.callId, args, context.abortSignal)`；抛错按 Q12 收成失败结果，取消照旧抛。
 */
export function fromAgentTool<P extends TSchema, D>(
  tool: AgentTool<P, D>
): ToolRegistration<P> & AgentTool<P, D> {
  const bridged = Object.create(tool) as ToolRegistration<P> & AgentTool<P, D>
  const execute: ToolRegistration<P>['execute'] = async (args, api, context) => {
    try {
      const result = await tool.execute(api.callId, args, context.abortSignal)
      return fromAgentToolResult(result, tool.name)
    } catch (error) {
      if (context.abortSignal?.aborted) throw error
      return toolErrorResult(error)
    }
  }
  Object.defineProperties(bridged, {
    execute: { value: execute, writable: true, enumerable: true, configurable: true },
    replay: { value: 'unsafe', writable: false, enumerable: true, configurable: true },
    outputLimits: {
      get: () => backstopOutputLimits(tool as OutputDeclaration),
      enumerable: true,
      configurable: true
    }
  })
  return bridged
}

/** 两种形状都收：旧形状经 `fromAgentTool` 转成 durable 注册项，durable 的原样返回 */
export function asToolRegistration(tool: AnyTool | AnyLegacyAgentTool): AnyTool {
  return isLegacyAgentTool(tool) ? (fromAgentTool(tool) as AnyTool) : tool
}

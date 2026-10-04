/**
 * 工具结果与工具形状。
 *
 * ShuviX 的工具就是 pi-durable 的 `ToolRegistration`，执行签名 `execute(args, api, context)`，交回
 * `ToolExecutionResult`。BaseTool 子类返回的是 `ToolResult` —— durable 结果的字段，但 details 用
 * ShuviX 自己的类型（chat-protocol 的 details 接口不带索引签名，算不上 durable 的 `JsonValue`）；
 * 交回之前在边界上把它收成严格 JSON（`toExecutionResult`）。不经 BaseTool 的函数式注册项
 * （ask / git / MCP）走同一个边界。
 *
 * **抛错不进 `<harness>`**（裁定 Q12）：durable 把 `execute()` 抛出的错误写成一条
 * `<harness>\n[error] …\n</harness>` 诊断，模型看到的字就变了。ShuviX 的工具改成在自己这一层接住，
 * 交回 `{ isError: true, content: [{ type: 'text', text: message }] }` —— 与 pi 0.80 的
 * createErrorToolResult 同一段文字（`toolErrorResult`；函数式注册项用 `catchToolErrors`）。只有
 * **取消**（context 已 abort）照旧抛，durable 的中止语义靠它。
 *
 * ShuviX 的注册项一律**显式**声明 `replay`（durable 缺省是 'unsafe'，但「这个工具中断后能不能重跑」
 * 应该是写工具的人想过的事）—— 测试辅助 `invokeTool` 拒收没声明它的工具。
 */
import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import type {
  ToolControl,
  ToolDiagnostic,
  ToolExecutionMode as DurableToolExecutionMode,
  ToolExecutionResult,
  ToolRegistration
} from '@earendil-works/pi-durable'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'

/** 工具结果的内容块（模型面） */
export type ToolContent = TextContent | ImageContent

/**
 * BaseTool 子类交回的结果 —— durable `ToolExecutionResult` 的字段，details 用 ShuviX 自己的类型。
 * content 恒给（宿主包装器按块处理文本）。details 键恒在（没有就写 `details: undefined`，与 pi 0.80
 * 的结果形状一致，文件工具内核等处因此能按具体类型读它）；值必须是严格 JSON（不放 Date / class 实例 /
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

/**
 * 函数式注册项（不经 BaseTool 的 ask / git / MCP）的失败口径，与 BaseTool 模板同一条（裁定 Q12）：
 * `work` 抛错 → `toolErrorResult`（模型看到的就是错误消息）；context 已 abort → 原样抛（取消）。
 */
export async function catchToolErrors(
  context: Context,
  work: () => Promise<ToolExecutionResult>
): Promise<ToolExecutionResult> {
  try {
    return await work()
  } catch (error) {
    if (context.abortSignal?.aborted) throw error
    return toolErrorResult(error)
  }
}

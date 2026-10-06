/**
 * NextTool —— 派发结果契约（resultContract）的收口工具。
 *
 * 调用方声明一份 JSON Schema，协调器据此给派生 agent 附加一个名为 `next` 的工具（解析时作请求的
 * `extraTools`，重建时由 `resultContractTools(record.resultContract)` 现造，PIN-03 R）：
 *   - `parameters` 即该 schema 原样（Type.Unsafe 透传，先例 mcpManager 的 MCP schema）；
 *   - LLM 的调用参数**就是结果**：校验通过 → 结果交回 `details: {result}`（durable 把它记进
 *     `pi.tool-result` 条目，持久、可重读；`nextResultOf(entry)` 从条目里读回来）；
 *   - 校验不过 → throw 带字段级指正的错误（BaseTool 模板收成 isError 结果，模型同轮看到指正并重试）——
 *     错误文案纪律同 5250adc：说清哪个字段、期望什么，而不是一句 invalid。真实运行里 durable 先按
 *     `parameters` 校验（`invalid_arguments`），这道自检多半轮不到（PIN-06），留着兜底。
 *
 * **结果只在返回值里**（PIN-04）：从不经 `api.details()` 汇报 —— 被中断的调用由 durable 按槽位里的
 * details 结算成 isError，若 details 早早进了槽位，中断的调用看起来就像捕获过。也没有回调：协调器读
 * 子对话里**第一条** `nextResultOf` 有值的条目（转写次序）。
 *
 * **收尾靠 `control: { terminate: true }`**：durable 在一批工具结果**全部**带 terminate 时直接结束，
 * 不再发下一次请求 —— 于是「只调了 next」的那一批就是这次运行的最后一步，一次请求出结论（判定型
 * hook 的审查 agent 靠这一点才只花一次请求）。已记录后的重复调用同样带 terminate（但**不**带 details），
 * 免得同批两次 next 把循环拖进下一轮。next 与别的工具同批时 terminate 不成立（要求整批都带），那时由
 * 协调器看到捕获后中止子对话兜底。
 *
 * 任务 prompt 末尾由协调器追加 <result_contract> 契约段（buildResultContractNote），
 * 要求以恰好一次 `next` 调用收尾。未调用的补救（nudge）在协调器侧。
 */
import {
  ToolResultEntry,
  type EntryRecord,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import { Type, type TSchema } from 'typebox'
import { Check, Errors } from 'typebox/value'
import type { ToolResult } from '../tools/toolResult'
import { BaseTool } from '../tools/baseTool'

/** 结果契约工具名 —— 派生 agent 工具集里的保留名（extraTools 注入，宿主同名去重让位） */
export const NEXT_TOOL_NAME = 'next'

/** 派发结果契约：schema 即 next 工具的参数 schema */
export interface ResultContract {
  /** JSON Schema，顶层必须 `type: 'object'`（工具参数恒为对象；标量结果包一层 {result: …}） */
  schema: Record<string, unknown>
  /** run 自然结束却没调 next 时的补救追问次数（缺省 1；0 = 不追问直接判失败） */
  nudges?: number
  /** 契约段里的来源标签（如 workflow 名）；缺省用通用文案 */
  sourceLabel?: string
}

/**
 * 校验契约 schema 本身（派发前调用）。返回 null = 合法；字符串 = 人读原因。
 * 只把「顶层必须是 object schema」定为硬约束 —— 其余交给 JSON Schema 语义自治。
 */
export function validateContractSchema(schema: unknown): string | null {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return 'result schema must be a JSON Schema object'
  }
  if ((schema as { type?: unknown }).type !== 'object') {
    return "result schema must declare top-level `type: 'object'` (wrap scalars as {result: …})"
  }
  return null
}

/** 契约段的围栏标签（LLM 面向）。workflow 引擎退役后不再自称 workflow —— 调用方现在是判定型 hook 等 */
export const RESULT_CONTRACT_TAG = 'result_contract'

/** 任务 prompt 末尾追加的契约段（围栏标签风格同 fenceInstructionFile；LLM 面向，仅英文） */
export function buildResultContractNote(contract: ResultContract): string {
  const source = contract.sourceLabel
    ? `one step of an automated flow ("${contract.sourceLabel}")`
    : 'one step of a larger automated flow'
  return `<${RESULT_CONTRACT_TAG}>
You are running as ${source}. When the task is complete, you MUST end by calling the \`next\` tool exactly once — its arguments are your entire result. Text written outside \`next\` is NOT returned to the caller. If the task cannot be completed, still call \`next\` with the closest conforming result you can produce (use the schema's own fields to express failure where available).
</${RESULT_CONTRACT_TAG}>`
}

/** 未调用 next 的一次性补救追问文案（manager 在 run 自然结束后使用） */
export const NEXT_NUDGE_TEXT =
  'You finished without calling the `next` tool. Call `next` now, exactly once, with your result as its arguments — that call is the only way your result reaches the caller.'

const NextParamsFallback = Type.Object({})

/** 结果契约的确认文案（成功捕获那一次） */
const RECORDED_TEXT = 'Result recorded — the task is complete. Do not call any more tools.'
/** 已捕获之后的重复调用 */
const ALREADY_RECORDED_TEXT =
  'Result already recorded — the task is complete. Do not call any more tools.'

/** `next` 成功那一次交回的 details（结果是参数的拷贝；读的一侧容忍别的键，如宿主审查加的） */
export interface NextToolDetails {
  result: Record<string, unknown>
}

/**
 * next 工具实例 —— 每次带契约的派发（或重建）现造一个（schema 随契约而变，不进内置注册表）。
 * 捕获是一次性的（每实例）：重复调用返回「已记录」、不带 details（并联工具调用的双发防护）；
 * 跨进程的「只认第一次」靠转写次序，不靠这个标记。
 */
export class NextTool extends BaseTool<TSchema> {
  readonly name = NEXT_TOOL_NAME
  readonly label = NEXT_TOOL_NAME
  readonly description =
    "Call this exactly once to finish your task. Your arguments ARE the result handed back to the caller and must satisfy this tool's parameter schema. After a successful call the task ends — do not call any other tool afterwards."
  readonly parameters: TSchema

  private captured = false

  constructor(schema: Record<string, unknown>) {
    super()
    this.parameters = schema ? Type.Unsafe<Record<string, unknown>>(schema) : NextParamsFallback
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op —— 纯捕获，无副作用客体 */
  }

  protected async executeInternal(
    _toolCallId: string,
    params: Record<string, unknown>
  ): Promise<ToolResult> {
    if (this.captured) {
      return {
        content: [{ type: 'text' as const, text: ALREADY_RECORDED_TEXT }],
        details: undefined,
        // 同批两次 next：第二次也得带，否则整批不满足「全部 terminate」，循环会多走一轮
        control: { terminate: true }
      }
    }

    // 完整 JSON Schema 校验（不依赖上游参数校验层的严格程度）；
    // 失败 throw —— BaseTool 模板收成 isError 结果，模型在同一轮内看到指正并重试
    if (!Check(this.parameters, params)) {
      const details = [...Errors(this.parameters, params)]
        .slice(0, 8)
        .map((e) => `  - ${e.instancePath || '(root)'}: ${e.message}`)
        .join('\n')
      throw new Error(
        `Result does not satisfy the schema. Fix these fields and call \`next\` again:\n${details}`
      )
    }

    this.captured = true
    return {
      content: [{ type: 'text' as const, text: RECORDED_TEXT }],
      // 结果是参数的拷贝（调用方之后改参数对象不影响它）；只经返回值交回，从不 api.details()
      details: { result: structuredClone(params) } satisfies NextToolDetails,
      // 这一批只有 next 时，durable 就此结束循环、不再发下一次请求（见文件头）
      control: { terminate: true }
    }
  }
}

/**
 * 按结果契约造附加工具（PIN-03 R）：有契约 → `[new NextTool(schema)]`，没有 → `[]`。重建派生 agent 时
 * 运行时据记录的 `resultContract` 调它，作 `rebuildAgentTools(record, {sessionId, extraTools})` 传给
 * 宿主。存下来的 schema 原样用，不再过 `validateContractSchema`（PIN-09）；nudges / sourceLabel 不影响工具。
 */
export function resultContractTools(contract?: ResultContract): ToolRegistration[] {
  return contract === undefined ? [] : [new NextTool(contract.schema)]
}

/**
 * 一份工具结果 details 里的结果契约值：`{result: 对象, …}` → 那个对象（别的键容忍）；否则 undefined。
 * 只看形状，调用方自己先排除 isError 的结果。
 */
export function nextDetailsResult(details: unknown): Record<string, unknown> | undefined {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return undefined
  const result = (details as { result?: unknown }).result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined
  return result as Record<string, unknown>
}

/**
 * 从转写条目读回结果契约值（PIN-04）：`pi.tool-result` 条目、工具名 `next`、不是 isError、details 带
 * 对象形的 `result` → 那个对象的拷贝；其余（被中断 / 中止的 `next`、重复调用、别的工具、别的条目）→
 * undefined。协调器取子对话里转写次序第一条有值的。
 */
export function nextResultOf(entry: EntryRecord): Record<string, unknown> | undefined {
  if (!ToolResultEntry.is(entry)) return undefined
  const message = entry.model?.[0]
  if (message?.role !== 'toolResult') return undefined
  if (message.toolName !== NEXT_TOOL_NAME || message.isError) return undefined
  const result = nextDetailsResult(message.details)
  return result === undefined ? undefined : structuredClone(result)
}

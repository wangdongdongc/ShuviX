/**
 * NextTool —— 派发结果契约（resultContract）的收口工具。
 *
 * 调用方（workflow 引擎的 `run(agent, prompt, {schema})`；未来 dispatch 工具亦可复用）
 * 声明一份 JSON Schema，协调器据此给派生 agent 临时附加一个名为 `next` 的工具：
 *   - `parameters` 即该 schema 原样（Type.Unsafe 透传，先例 mcpManager 的 MCP schema）；
 *   - LLM 的调用参数**就是结果**：校验通过 → 交给捕获通道并软停止本 agent
 *     （manager.interrupt 语义），step 结果取捕获值而非转写抽取；
 *   - 校验不过 → throw 带字段级指正的错误（harness 记为 tool error，模型同轮重试）——
 *     错误文案纪律同 5250adc：说清哪个字段、期望什么，而不是一句 invalid。
 *
 * 任务 prompt 末尾由协调器追加 <workflow_result_contract> 契约段（buildResultContractNote），
 * 要求以恰好一次 `next` 调用收尾。未调用的补救（nudge）在 manager 侧。
 */
import { Type, type TSchema } from 'typebox'
import { Check, Errors } from 'typebox/value'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
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

/** 任务 prompt 末尾追加的契约段（围栏标签风格同 fenceInstructionFile；LLM 面向，仅英文） */
export function buildResultContractNote(contract: ResultContract): string {
  const source = contract.sourceLabel
    ? `one step of workflow "${contract.sourceLabel}"`
    : 'one step of a larger automated flow'
  return `<workflow_result_contract>
You are running as ${source}. When the task is complete, you MUST end by calling the \`next\` tool exactly once — its arguments are your entire result. Text written outside \`next\` is NOT returned to the caller. If the task cannot be completed, still call \`next\` with the closest conforming result you can produce (use the schema's own fields to express failure where available).
</workflow_result_contract>`
}

/** 未调用 next 的一次性补救追问文案（manager 在 run 自然结束后使用） */
export const NEXT_NUDGE_TEXT =
  'You finished without calling the `next` tool. Call `next` now, exactly once, with your result as its arguments — that call is the only way your result reaches the caller.'

const NextParamsFallback = Type.Object({})

/**
 * next 工具实例 —— 每次带契约的派发现造一个（schema 随契约而变，不进内置注册表）。
 * 捕获是一次性的：重复调用返回「已记录」而不再回调（并联工具调用的双发防护）。
 */
export class NextTool extends BaseTool<TSchema> {
  readonly name = NEXT_TOOL_NAME
  readonly label = NEXT_TOOL_NAME
  readonly description =
    "Call this exactly once to finish your task. Your arguments ARE the result handed back to the caller and must satisfy this tool's parameter schema. After a successful call the task ends — do not call any other tool afterwards."
  readonly parameters: TSchema

  private captured = false

  constructor(
    schema: Record<string, unknown>,
    private readonly onCapture: (value: Record<string, unknown>) => void
  ) {
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
  ): Promise<AgentToolResult<undefined>> {
    if (this.captured) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Result already recorded — the task is complete. Do not call any more tools.'
          }
        ],
        details: undefined
      }
    }

    // 完整 JSON Schema 校验（不依赖上游参数校验层的严格程度）；
    // 失败 throw —— harness 记为 tool error，模型在同一轮内看到指正并重试
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
    this.onCapture(params)
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Result recorded — the task is complete. Do not call any more tools.'
        }
      ],
      details: undefined
    }
  }
}

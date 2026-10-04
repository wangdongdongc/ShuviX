/**
 * BaseTool —— 所有内置工具的抽象基类（宿主无关），实现 pi-durable 的 `ToolRegistration`。
 *
 * 生命周期模板：preExecute → securityCheck → executeInternal（子类不覆写 execute）。
 * durable 调 `execute(args, api, context)`；模板把调用身份与取消收成 `ToolCallScope`，钩子仍按
 * `(toolCallId, params, signal, call)` 拿到 —— 前三个参数与旧版一致，`call` 给要用 durable api 或
 * taskId 的地方（见 toolCall.ts）。
 *
 * 失败的口径（裁定 Q12）：钩子抛错 → 交回 `{ isError: true, content: [{ type: 'text', text: message }] }`，
 * 模型看到的就是错误消息本身（与 pi 0.80 一致），**不**让它落进 durable 的 `<harness>[error]` 诊断；
 * 只有取消（context 已 abort）照旧抛出，durable 的中止语义靠它。
 *
 * 能否重跑（`replay`）：durable 在调用开始前把它记进意图；进程中断后恢复时，只有记下的与当前的
 * 都是 'safe' 才重跑，否则这次调用记为「中断，可能已部分执行」。缺省 'unsafe'；只读、重跑无害的
 * 工具（read / ls / grep / glob）声明 'safe'。
 *
 * 输出截断/落盘由各宿主的包装器在装配工具时统一处理（读取 outputStrategy / outputMax*）；
 * durable 自己的那道截断（`outputLimits`）只当兜底，见 outputLimits.ts。
 */
import type { Context } from '@earendil-works/chord'
import type {
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration
} from '@earendil-works/pi-durable'
import type { TSchema, Static } from 'typebox'
import { toExecutionResult, toolErrorResult, type ToolResult } from './toolResult'
import type { ToolExecutionMode } from './toolResult'
import { toolCallScope, type ToolCallScope } from './toolCall'
import { backstopOutputLimits, type DurableOutputLimits } from './outputLimits'
import type { TruncateStrategy } from '../toolOutput/spill'

/** durable 的重跑策略 */
export type ToolReplay = 'safe' | 'unsafe'

export abstract class BaseTool<
  TParams extends TSchema = TSchema
> implements ToolRegistration<TParams> {
  abstract readonly name: string
  abstract readonly label: string
  abstract readonly description: string
  abstract readonly parameters: TParams
  /** 中断后能否在恢复时重跑（缺省 'unsafe'；只读工具覆盖成 'safe'） */
  readonly replay: ToolReplay = 'unsafe'
  /** 单个工具覆盖同批执行方式（缺省跟随会话设置） */
  readonly executionMode?: ToolExecutionMode
  /** 输出过长时的截断策略 —— 包装器读取此字段决定留下开头 / 末尾 / 首尾（缺省留首尾） */
  readonly outputStrategy: TruncateStrategy = 'middle'
  /** 自定义最大字节数；不设置则采用 processToolOutput 的默认值 */
  readonly outputMaxBytes?: number
  /** 自定义最大行数；不设置则采用 processToolOutput 的默认值 */
  readonly outputMaxLines?: number

  /** durable 的兜底截断上限 —— 恒在宿主包装器的上限之上（见 outputLimits.ts） */
  get outputLimits(): DurableOutputLimits {
    return backstopOutputLimits(this)
  }

  /** 资源初始化（容器创建、连接建立等），在 securityCheck 之前调用 */
  abstract preExecute(
    toolCallId: string,
    params: Record<string, unknown>,
    call: ToolCallScope
  ): Promise<void>

  /**
   * 安全检查 —— 路径越界等确定性校验，抛异常即阻止执行。
   * 动态/条件性询问应留在 executeInternal 中。
   */
  protected abstract securityCheck(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    call: ToolCallScope
  ): Promise<void>

  /** 工具核心逻辑 —— securityCheck 通过后调用 */
  protected abstract executeInternal(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    call: ToolCallScope
  ): Promise<ToolResult>

  /**
   * 模板方法 —— 固定顺序：preExecute → securityCheck → executeInternal，子类不应覆写。
   * 抛错收成失败结果（Q12），取消照旧抛。
   */
  async execute(
    args: Static<TParams>,
    api: ToolExecutionApi,
    context: Context
  ): Promise<ToolExecutionResult> {
    const call = toolCallScope(api, context)
    try {
      await this.preExecute(call.callId, args as Record<string, unknown>, call)
      await this.securityCheck(call.callId, args, call.signal, call)
      const result = await this.executeInternal(call.callId, args, call.signal, call)
      return toExecutionResult(result, this.name)
    } catch (error) {
      if (call.signal?.aborted) throw error
      return toolErrorResult(error)
    }
  }
}

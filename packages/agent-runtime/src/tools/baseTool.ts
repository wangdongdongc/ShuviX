/**
 * BaseTool —— 所有内置工具的抽象基类（宿主无关）。
 * 生命周期模板：preExecute → securityCheck → executeInternal（子类不覆写 execute）。
 *
 * 输出截断/落盘由各宿主的 wrapToolOutput 在装配工具时统一处理（读取 outputStrategy/outputMax*）。
 * 桌面与扩展共用同一份基类，确保工具执行流程两端一致。
 */
import type { TSchema, Static } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { TruncateStrategy } from '../toolOutput/spill'

export abstract class BaseTool<TParams extends TSchema = TSchema> {
  abstract readonly name: string
  abstract readonly label: string
  abstract readonly description: string
  abstract readonly parameters: TParams
  /** 输出过长时的截断策略 —— 包装器读取此字段决定保留首部 / 尾部 / 首尾 */
  readonly outputStrategy: TruncateStrategy = 'middle'
  /** 自定义最大字节数；不设置则采用 processToolOutput 的默认值 */
  readonly outputMaxBytes?: number
  /** 自定义最大行数；不设置则采用 processToolOutput 的默认值 */
  readonly outputMaxLines?: number

  /** 资源初始化（容器创建、连接建立等），在 securityCheck 之前调用 */
  abstract preExecute(toolCallId: string, params: Record<string, unknown>): Promise<void>

  /**
   * 安全检查 —— 沙箱路径越界等确定性校验，抛异常即阻止执行。
   * 动态/条件性审批应留在 executeInternal 中。
   */
  protected abstract securityCheck(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal
  ): Promise<void>

  /** 工具核心逻辑 —— securityCheck 通过后调用 */
  protected abstract executeInternal(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void
  ): Promise<AgentToolResult<unknown>>

  /** 模板方法 —— 固定顺序：preExecute → securityCheck → executeInternal，子类不应覆写 */
  async execute(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void
  ): Promise<AgentToolResult<unknown>> {
    await this.preExecute(toolCallId, params as Record<string, unknown>)
    await this.securityCheck(toolCallId, params, signal)
    return this.executeInternal(toolCallId, params, signal, onUpdate)
  }
}

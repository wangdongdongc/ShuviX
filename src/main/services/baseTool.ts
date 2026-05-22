/**
 * BaseTool —— 所有内置工具的抽象基类。
 *
 * 放在 services/ 层：它是 services 暴露给 tool 实现的"工具合约"抽象
 * （services 构造 tool 实例并调度，tool 实现继承此类）。
 */

import type { TSchema, Static } from 'typebox'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { TruncateStrategy } from '../utils/toolUtils/processToolOutput'

/**
 * 工具基类 — 所有内置工具必须继承此类
 * 生命周期：preExecute → securityCheck → executeInternal
 *
 * 输出截断/落盘统一由 wrapToolOutput 在构建工具列表时处理（见 agentToolBuilder），
 * 子类不要在 executeInternal 里再调 processToolOutput；如需调整策略，仅覆写 outputStrategy 即可。
 */
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
   * 安全检查 — 沙箱路径越界等确定性校验，抛异常即阻止执行。
   * 动态/条件性审批（requestApproval）应留在 executeInternal 中。
   */
  protected abstract securityCheck(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal
  ): Promise<void>

  /** 工具核心逻辑 — securityCheck 通过后调用 */
  protected abstract executeInternal(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void
  ): Promise<AgentToolResult<unknown>>

  /** 模板方法 — 固定顺序：preExecute → securityCheck → executeInternal，子类不应覆写 */
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

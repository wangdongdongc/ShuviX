/**
 * PluginTool — 插件工具接口
 *
 * 对应主程序的 BaseTool 抽象类，但作为纯接口定义，不引入任何主程序依赖。
 * 主程序通过 PluginToolAdapter 将 PluginTool 包装为 BaseTool 实例。
 */

import type { TSchema, Static } from '@sinclair/typebox'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'

/** 插件贡献的工具定义 */
export interface PluginTool<TParams extends TSchema = TSchema> {
  /** 工具唯一标识 */
  readonly name: string
  /** 显示名称 */
  readonly label: string
  /** 工具描述（展示给 LLM） */
  readonly description: string
  /** 参数 JSON Schema（TypeBox 定义） */
  readonly parameters: TParams

  /** 资源初始化（可选，在 execute 之前调用） */
  preExecute?(toolCallId: string, params: Record<string, unknown>): Promise<void>

  /** 安全检查（可选，抛异常即阻止执行） */
  securityCheck?(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal
  ): Promise<void>

  /** 工具核心执行逻辑 */
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
    sessionId?: string
  ): Promise<AgentToolResult<unknown>>
}

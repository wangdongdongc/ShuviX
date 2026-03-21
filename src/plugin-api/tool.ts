/**
 * PluginTool — 插件工具接口
 *
 * 对应主程序的 BaseTool 抽象类，但作为纯接口定义，不引入任何主程序依赖。
 * 主程序通过 PluginToolAdapter 将 PluginTool 包装为 BaseTool 实例。
 */

import type { TSchema, Static } from '@sinclair/typebox'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'

// ─── 渲染定制 ──────────────────────────────────────────

/** 表单项渲染器 — 指定单个参数字段的展示样式 */
export type PluginFormItemRenderer = { type: 'code'; language?: string } | { type: 'text' }

/** 表单项 — 描述一个 args 字段在展开态中的展示方式 */
export interface PluginToolFormItem {
  /** args 中的字段名 */
  field: string
  /** 显示标签（默认使用 field 名） */
  label?: string
  /** 渲染器（默认 { type: 'text' }） */
  renderer?: PluginFormItemRenderer
}

/**
 * 工具渲染提示 — 声明式描述前端如何展示该工具的调用
 *
 * 未提供时 renderer 使用通用的 JSON 参数 + 文本结果渲染。
 */
export interface PluginToolPresentation {
  /** 折叠态图标（lucide 图标名，如 'Terminal'） */
  icon?: string
  /** 图标颜色 class（如 'text-yellow-500'） */
  iconClass?: string
  /** 折叠态摘要：从 args 的哪个字段取首行作为摘要文本 */
  summaryField?: string
  /**
   * 展开态表单项列表
   *
   * - 未定义时：以 JSON 块展示全部 args（默认行为）
   * - 已定义时：按声明顺序渲染各表单项，未列出的 args 字段以 text 形式追加在末尾
   */
  formItems?: PluginToolFormItem[]
}

// ─── 工具接口 ──────────────────────────────────────────

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
  /** 前端渲染提示（可选） */
  readonly presentation?: PluginToolPresentation

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

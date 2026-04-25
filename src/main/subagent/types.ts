/**
 * 子智能体模块类型定义
 *
 * SubAgentProvider 接口 — 所有子智能体后端的统一抽象。
 * 新增子智能体类型只需实现此接口。
 */

import type { TSchema } from '@sinclair/typebox'
import type { ToolContext } from '../services/toolContext'
import type { ModelCapabilities } from '../types'

// ─── 模型配置 ──────────────────────────────────────────

/** 子智能体模型配置（纯数据，不依赖 pi-ai 类型） */
export interface SubAgentModelConfig {
  provider: string
  model: string
  capabilities: ModelCapabilities
}

// ─── Provider 接口 ──────────────────────────────────────────

/** 子智能体执行参数 */
export interface SubAgentRunParams {
  /** 父级工具上下文（含 sessionId、requestUserInput 等回调） */
  ctx: ToolContext
  toolCallId: string
  prompt: string
  description: string
  signal?: AbortSignal
}

/** 子智能体执行结果（仅最终文本；流式过程已通过 ChatEvent 广播） */
export interface SubAgentRunResult {
  result: string
}

/**
 * SubAgentProvider — 子智能体后端抽象
 *
 * 每种执行后端（进程内 Agent、远程 HTTP 等）实现此接口。
 * SubAgentTool 统一调用 provider.runTask() 处理 timeline 收集和事件装饰。
 */
export interface SubAgentProvider {
  /** 工具名（注册到 ALL_TOOL_NAMES 的标识符，如 'explore'） */
  readonly name: string
  /** 展示名（UI 显示） */
  readonly displayName: string
  /** 工具描述（给 LLM 看，帮助它决定何时使用） */
  readonly description: string
  /** 工具参数 schema；为 undefined 时使用默认的 {description, prompt} schema */
  readonly parameterSchema?: TSchema

  /** 注入模型配置（进程内子智能体需要，外部后端可不实现） */
  setModelConfig?(config: SubAgentModelConfig): void

  /** 执行任务 */
  runTask(params: SubAgentRunParams): Promise<SubAgentRunResult>

  /** 销毁指定 session 的资源 */
  destroy(sessionId: string): void

  /** 中止指定 session 的所有活跃任务 */
  abortAll?(sessionId: string): void
}

// ─── 工具摘要 ──────────────────────────────────────────

/** 从工具参数中提取第一个合理长度的字符串值作为摘要 */
export function extractArgsSummary(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined
  for (const v of Object.values(args)) {
    if (typeof v !== 'string' || !v) continue
    const line = v.split('\n')[0]
    if (line.length <= 200) {
      return line.length > 80 ? line.slice(0, 77) + '...' : line
    }
  }
  return undefined
}

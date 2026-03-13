/**
 * 子智能体模块类型定义
 *
 * SubAgentProvider 接口 — 所有子智能体后端（进程内 / ACP / 远程）的统一抽象。
 * 新增子智能体类型只需实现此接口。
 */

import type { TSchema } from '@sinclair/typebox'
import type { Api, Model } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import type { ChatEvent } from '../frontend'
import type { ToolContext } from '../tools/types'

// ─── Provider 接口 ──────────────────────────────────────────

/** 子智能体执行参数 */
export interface SubAgentRunParams {
  /** 父级工具上下文（含 sessionId、requestUserInput 等回调） */
  ctx: ToolContext
  toolCallId: string
  /** 用于恢复已有会话（explore 支持） */
  taskId?: string
  prompt: string
  description: string
  signal?: AbortSignal
  onEvent: (event: ChatEvent) => void
  /** explore 等进程内子智能体需要 */
  parentModel?: Model<Api>
  parentStreamFn?: StreamFn
}

/** 子智能体执行结果 */
export interface SubAgentRunResult {
  taskId: string
  result: string
}

/**
 * SubAgentProvider — 子智能体后端抽象
 *
 * 每种执行后端（进程内 Agent、ACP 外部进程、远程 HTTP 等）实现此接口。
 * SubAgentTool 统一调用 provider.runTask() 处理 timeline 收集和事件装饰。
 */
export interface SubAgentProvider {
  /** 工具名（注册到 ALL_TOOL_NAMES 的标识符，如 'explore', 'claude-code'） */
  readonly name: string
  /** 展示名（UI 显示） */
  readonly displayName: string
  /** 工具描述（给 LLM 看，帮助它决定何时使用） */
  readonly description: string
  /** 工具参数 schema；为 undefined 时使用默认的 {description, prompt} schema */
  readonly parameterSchema?: TSchema

  /** 执行任务 */
  runTask(params: SubAgentRunParams): Promise<SubAgentRunResult>

  /** 销毁指定 session 的资源 */
  destroy(sessionId: string): void

  /** 中止指定 session 的所有活跃任务 */
  abortAll?(sessionId: string): void
}

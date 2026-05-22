/**
 * 统一工具输出后处理包装器
 *
 * 把任何 AgentTool 的 execute 结果中的文本块过一遍 processToolOutput，
 * 实现 "所有工具输出走同一截断 / 落盘入口"。
 *
 * 单一调用点 — 仅由 agentToolBuilder.buildTools 和 SubAgentManager.buildSubAgentTools 使用。
 * 工具本体不应再直接调用 processToolOutput。
 */

import type { TSchema } from 'typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { processToolOutput, type TruncateStrategy } from '../utils/toolUtils/processToolOutput'

/** 工具可以通过这个接口声明自己想要的截断策略；默认 'middle' */
export interface OutputStrategyAware {
  readonly outputStrategy?: TruncateStrategy
}

/** 把 tool 上的 outputStrategy 抽出来（如果有的话） */
export function getOutputStrategy(tool: object): TruncateStrategy {
  const s = (tool as OutputStrategyAware).outputStrategy
  return s ?? 'middle'
}

/** 工具可以传入的截断阈值覆写 */
export interface ProcessToolOutputOverrides {
  maxBytes?: number
  maxLines?: number
}

/**
 * 包装一个 AgentTool —— execute 返回结果后，把 content 里的文本块过 processToolOutput。
 * 同时把 truncated / persisted OR 进 details（仅当 details 已经声明了对应字段时）。
 */
export function wrapToolOutput<P extends TSchema, D>(
  tool: AgentTool<P, D>,
  sessionId: string,
  strategy: TruncateStrategy,
  overrides?: ProcessToolOutputOverrides
): AgentTool<P, D> {
  const originalExecute = tool.execute.bind(tool)
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await originalExecute(toolCallId, params, signal, onUpdate)
      let truncated = false
      let persisted = false
      const newContent = result.content.map((block) => {
        if (block.type !== 'text') return block
        const proc = processToolOutput({
          sessionId,
          toolCallId,
          fullText: block.text,
          strategy,
          maxBytes: overrides?.maxBytes,
          maxLines: overrides?.maxLines
        })
        if (proc.truncated) truncated = true
        if (proc.persisted) persisted = true
        return { ...block, text: proc.text }
      })
      const newDetails = mergeTruncatedIntoDetails(result.details, truncated, persisted)
      return { ...result, content: newContent, details: newDetails }
    }
  }
}

/**
 * 把 truncated / persisted OR 进 details 对象 ——
 * 只在 details 本来就有同名字段时合并，避免给那些没声明这两个字段的 details 类型偷偷加字段。
 */
function mergeTruncatedIntoDetails<D>(details: D, truncated: boolean, persisted: boolean): D {
  if (!details || typeof details !== 'object') return details
  const d = details as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { ...d }
  if ('truncated' in d) out.truncated = Boolean(d.truncated) || truncated
  if ('persisted' in d) out.persisted = Boolean(d.persisted) || persisted
  return out as unknown as D
}

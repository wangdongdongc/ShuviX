/**
 * 扩展工具输出包装（轻量）—— 把每个工具的文本输出过共享 processToolOutput（截断 + 经 sink 落盘），
 * 并（当传入 security 时）挂安全模块的 **L1 全工具门**；语义见桌面 wrapToolOutput 注释。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  processToolOutput,
  type SecurityContext,
  type SpillSink,
  type TruncateStrategy
} from '@shuvix/agent-runtime'
/** 包装单个工具：execute 前过 L1 全工具门 + 文本块过 processToolOutput（保留原型链，仅覆盖 execute） */
export function wrapToolOutput(
  tool: AgentTool,
  sink: SpillSink,
  /** L1 全工具门的评估门面；缺省 = 不设门 */
  security?: SecurityContext
): AgentTool {
  const originalExecute = tool.execute.bind(tool)
  const strategy: TruncateStrategy =
    (tool as { outputStrategy?: TruncateStrategy }).outputStrategy ?? 'middle'
  const toolName = (tool as { name?: string }).name ?? ''

  const wrappedExecute: AgentTool['execute'] = async (toolCallId, params, signal, onUpdate) => {
    // ── L1 全工具门（安全模块）：execute 之前；未命中规则 = 非事件 ──
    if (security) {
      const rawAction = (params as Record<string, unknown> | undefined)?.action
      const outcome = await security.enforceInvocation({
        toolCallId,
        toolName,
        operation: typeof rawAction === 'string' ? rawAction : undefined,
        abortError: 'TOOL_ABORTED',
        onOther: 'return'
      })
      if (outcome.status === 'feedback') {
        return {
          content: [
            {
              type: 'text',
              text: `Tool was not executed. User responded with feedback instead:\n${outcome.text}`
            }
          ],
          details: undefined as never
        }
      }
    }

    const result = await originalExecute(toolCallId, params, signal, onUpdate)
    const newContent: typeof result.content = []
    for (const block of result.content) {
      if (block.type !== 'text') {
        newContent.push(block)
        continue
      }
      const proc = await processToolOutput({ toolCallId, fullText: block.text, strategy, sink })
      newContent.push({ ...block, text: proc.text })
    }
    return { ...result, content: newContent }
  }

  const wrapped = Object.create(tool) as AgentTool
  Object.defineProperty(wrapped, 'execute', {
    value: wrappedExecute,
    writable: true,
    enumerable: true,
    configurable: true
  })
  return wrapped
}

/** 批量包装 */
export function wrapToolsOutput(
  tools: AgentTool[],
  sink: SpillSink,
  security?: SecurityContext
): AgentTool[] {
  return tools.map((t) => wrapToolOutput(t, sink, security))
}

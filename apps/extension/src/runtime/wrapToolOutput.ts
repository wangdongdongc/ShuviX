/**
 * 扩展工具输出包装（轻量）—— 把每个工具的文本输出过共享 processToolOutput（截断 + 经 sink 落盘）。
 * 桌面 wrapToolOutput 还挂 PreToolUse/PostToolUse hooks（桌面专属）；扩展无 hooks，仅做截断/落盘。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { processToolOutput, type SpillSink, type TruncateStrategy } from '@shuvix/agent-runtime'

/** 包装单个工具：execute 返回后，文本块过 processToolOutput（保留原型链，仅覆盖 execute） */
export function wrapToolOutput(tool: AgentTool, sink: SpillSink): AgentTool {
  const originalExecute = tool.execute.bind(tool)
  const strategy: TruncateStrategy =
    (tool as { outputStrategy?: TruncateStrategy }).outputStrategy ?? 'middle'

  const wrappedExecute: AgentTool['execute'] = async (toolCallId, params, signal, onUpdate) => {
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
export function wrapToolsOutput(tools: AgentTool[], sink: SpillSink): AgentTool[] {
  return tools.map((t) => wrapToolOutput(t, sink))
}

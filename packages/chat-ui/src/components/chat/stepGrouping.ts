import type { ChatMessage, ToolUseMessage } from '../../stores/chatStore'

/** 分组结果 — 单条步骤，或一段相邻的同名工具调用 */
export type StepGroup<T> =
  | { kind: 'single'; msg: T }
  | { kind: 'toolGroup'; key: string; toolName: string; msgs: ToolUseMessage[] }

/**
 * 已成功完成的工具调用 —— 只有这类会被合并。
 * 运行中 / 出错的保持独立行：它们的状态需要被看到，合并进计数徽章就藏起来了。
 */
function completedToolCall(msg: ChatMessage): ToolUseMessage | null {
  if (msg.type !== 'tool_use') return null
  if (!msg.content || msg.metadata?.isError) return null
  if (!msg.metadata?.toolName) return null
  return msg
}

/**
 * 合并相邻的同名工具调用 —— 连续 5 次 `browser` 折叠成一行 + 计数，展开才逐条列出。
 * 顺序保持不变，非工具步骤与不可合并的工具调用原样透传。
 */
export function groupConsecutiveToolCalls<T extends ChatMessage>(
  msgs: readonly T[]
): StepGroup<T>[] {
  const out: StepGroup<T>[] = []
  let i = 0
  while (i < msgs.length) {
    const head = completedToolCall(msgs[i])
    if (!head) {
      out.push({ kind: 'single', msg: msgs[i] })
      i += 1
      continue
    }
    const toolName = head.metadata?.toolName as string
    const run: ToolUseMessage[] = [head]
    let j = i + 1
    while (j < msgs.length) {
      const next = completedToolCall(msgs[j])
      if (!next || next.metadata?.toolName !== toolName) break
      run.push(next)
      j += 1
    }
    if (run.length > 1) {
      out.push({ kind: 'toolGroup', key: run[0].id, toolName, msgs: run })
    } else {
      out.push({ kind: 'single', msg: msgs[i] })
    }
    i = j
  }
  return out
}

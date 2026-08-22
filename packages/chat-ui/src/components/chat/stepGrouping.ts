import type { AssistantBlock, AssistantToolBlock } from '../../stores/chatStore'

/** 分组结果 — 单个块，或一段相邻的同名工具调用 */
export type BlockGroup =
  | { kind: 'single'; block: AssistantBlock; key: string }
  | { kind: 'toolGroup'; key: string; toolName: string; blocks: AssistantToolBlock[] }

/**
 * 已成功完成的工具调用 —— 只有这类会被合并。
 * 运行中 / 出错的保持独立行：它们的状态需要被看到，合并进计数徽章就藏起来了。
 */
function completedToolBlock(block: AssistantBlock): AssistantToolBlock | null {
  if (block.type !== 'tool') return null
  if (!block.result || block.isError) return null
  if (!block.toolName) return null
  return block
}

/**
 * 合并相邻的同名工具调用 —— 连续 5 次 `browser` 折叠成一行 + 计数，展开才逐条列出。
 * 顺序保持不变，非工具块与不可合并的工具调用原样透传。
 */
export function groupConsecutiveToolCalls(blocks: readonly AssistantBlock[]): BlockGroup[] {
  const out: BlockGroup[] = []
  let i = 0
  const keyOf = (block: AssistantBlock, idx: number): string =>
    block.type === 'tool' ? block.toolCallId : `${block.type}-${idx}`
  while (i < blocks.length) {
    const head = completedToolBlock(blocks[i])
    if (!head) {
      out.push({ kind: 'single', block: blocks[i], key: keyOf(blocks[i], i) })
      i += 1
      continue
    }
    const toolName = head.toolName
    const run: AssistantToolBlock[] = [head]
    let j = i + 1
    while (j < blocks.length) {
      const next = completedToolBlock(blocks[j])
      if (!next || next.toolName !== toolName) break
      run.push(next)
      j += 1
    }
    if (run.length > 1) {
      out.push({ kind: 'toolGroup', key: run[0].toolCallId, toolName, blocks: run })
    } else {
      out.push({ kind: 'single', block: blocks[i], key: keyOf(blocks[i], i) })
    }
    i = j
  }
  return out
}

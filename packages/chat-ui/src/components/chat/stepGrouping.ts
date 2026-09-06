import type { AssistantBlock, AssistantToolBlock } from '../../stores/chatStore'
import { clipLine } from '../../utils/clipLine'

/** 能并进合并行的块：思考，或已成功完成的工具调用 */
export type StepBlock = Extract<AssistantBlock, { type: 'thinking' }> | AssistantToolBlock

/** 分组结果 — 单个块，或一段相邻的步骤（思考 / 已完成的工具调用，不限同名） */
export type BlockGroup =
  | { kind: 'single'; block: AssistantBlock; key: string }
  | { kind: 'stepGroup'; key: string; blocks: StepBlock[] }

/**
 * 已落定的步骤 —— 只有这类会被合并：思考块，以及已成功完成的工具调用。
 *
 * 运行中 / 出错的调用保持独立行并把一段切开：它们的状态需要被看到，合并进计数徽章就藏
 * 起来了。中间文本也切开一段 —— 它是模型对用户说的话，不是过程步骤，文本前后的步骤各自成组。
 * 「已完成」按契约认 `result !== undefined`（chatMessage.ts：未回填即仍在执行），不按真值：
 * 只交回图片的工具投影出的 result 是空串，按真值判会让它永远是「运行中」。
 */
function settledStep(block: AssistantBlock): StepBlock | null {
  if (block.type === 'thinking') return block
  if (block.type !== 'tool') return null
  if (block.result === undefined || block.isError) return null
  if (!block.toolName) return null
  return block
}

/**
 * 合并相邻的步骤 —— 连续的「思考 → read → read → edit」折叠成一行 + 计数，展开才逐条列出。
 * 这是原先「相邻同名工具调用合并」的推广：同名不再是条件，一段里可以混着思考与不同的工具；
 * 全是同一个工具时行的形态与从前完全一样（图标 + 工具名 + 去重摘要 + 次数）。
 * 顺序保持不变，单个步骤、中间文本与不可合并的工具调用原样透传。
 */
export function groupConsecutiveSteps(blocks: readonly AssistantBlock[]): BlockGroup[] {
  const out: BlockGroup[] = []
  let i = 0
  const keyOf = (block: AssistantBlock, idx: number): string =>
    block.type === 'tool' ? block.toolCallId : `${block.type}-${idx}`
  while (i < blocks.length) {
    const head = settledStep(blocks[i])
    if (!head) {
      out.push({ kind: 'single', block: blocks[i], key: keyOf(blocks[i], i) })
      i += 1
      continue
    }
    const run: StepBlock[] = [head]
    let j = i + 1
    while (j < blocks.length) {
      const next = settledStep(blocks[j])
      if (!next) break
      run.push(next)
      j += 1
    }
    if (run.length > 1) {
      out.push({ kind: 'stepGroup', key: keyOf(blocks[i], i), blocks: run })
    } else {
      out.push({ kind: 'single', block: blocks[i], key: keyOf(blocks[i], i) })
    }
    i = j
  }
  return out
}

/** 一段步骤若全是同一个工具的调用，返回该工具名；混着思考或不同工具则为 null */
export function uniformToolName(blocks: readonly StepBlock[]): string | null {
  let name: string | null = null
  for (const b of blocks) {
    if (b.type !== 'tool') return null
    if (name === null) name = b.toolName
    else if (b.toolName !== name) return null
  }
  return name
}

/** 步骤摘要的一项 —— 同一种步骤出现的次数（`read ×3`） */
export interface StepSequenceItem {
  label: string
  count: number
}

/**
 * 把一段步骤归纳成「每种步骤各出现几次」，按首次出现的顺序排列。
 *
 * 按种类聚合而不是按相邻去重：智能体的过程多半是「思考 → 调用 → 思考 → 调用」交替，
 * 相邻去重对它无能为力，摘要行会变成一串重复的「思考 · 会话 · 思考 · 执行命令 · …」；
 * 先后顺序留给展开态逐行去看，一行摘要只回答「做了哪几类事、各多少次」。
 * 标签由调用方给（工具取 presentation 的显示名、思考取 i18n 文案），这里只管归纳，
 * 所以不牵扯 store 与 i18n，可以直接拿静态数组钉住行为。
 */
export function summarizeSteps(
  blocks: readonly StepBlock[],
  labelOf: (block: StepBlock) => string
): StepSequenceItem[] {
  const byLabel = new Map<string, StepSequenceItem>()
  for (const block of blocks) {
    const label = labelOf(block)
    const item = byLabel.get(label)
    if (item) item.count += 1
    else byLabel.set(label, { label, count: 1 })
  }
  return [...byLabel.values()]
}

/** 步骤摘要 → 一行文本：`思考 ×3 · read ×2 · grep`，超长按字符截断（与工具行摘要同一上限） */
export function formatStepSequence(sequence: readonly StepSequenceItem[], maxLen = 60): string {
  const joined = sequence.map((s) => (s.count > 1 ? `${s.label} ×${s.count}` : s.label)).join(' · ')
  return clipLine(joined, maxLen)
}

import { memo } from 'react'
import { MarkdownText } from './markdownComponents'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { StepGroup } from './StepGroup'
import type { BlockGroup } from './stepGrouping'

/** 两个分组是否画出同样的东西：种类、key 相同，块逐个是同一个对象（块落盘后身份不变） */
function sameGroup(a: BlockGroup, b: BlockGroup): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || a.key !== b.key) return false
  if (a.kind === 'stepGroup' && b.kind === 'stepGroup') {
    return a.blocks.length === b.blocks.length && a.blocks.every((x, i) => x === b.blocks[i])
  }
  return a.kind !== 'stepGroup' && b.kind !== 'stepGroup' && a.block === b.block
}

/**
 * 过程区的一行 —— 按分组种类分发：步骤合并行 / 思考 / 中间文本 / 单次工具调用。
 * 主对话卡与子智能体内联转写共用这一份分发，免得几处各写一遍 switch 之后悄悄走散。
 * key 由调用方按 `group.key` 给。
 *
 * 按分组内容 memo：每落盘一步，分组数组整个重建（`groupConsecutiveSteps` 每次都产新对象），但没变的
 * 那些分组里块还是原来那几个对象 —— 比块的身份就知道这一行不用重画（中间文本不必重新解析 markdown）。
 */
export const StepGroupView = memo(StepGroupViewImpl, (prev, next) => {
  return prev.markdownClassName === next.markdownClassName && sameGroup(prev.group, next.group)
})

function StepGroupViewImpl({
  group,
  markdownClassName = 'markdown-body text-sm'
}: {
  group: BlockGroup
  /** 中间文本的正文类名 —— 子智能体转写用更小的字号 */
  markdownClassName?: string
}): React.JSX.Element {
  if (group.kind === 'stepGroup') return <StepGroup blocks={group.blocks} />
  const block = group.block
  if (block.type === 'thinking') return <ThinkingBlock content={block.text} />
  if (block.type === 'text') {
    return (
      <div className={markdownClassName}>
        <MarkdownText text={block.text} />
      </div>
    )
  }
  return (
    <ToolCallBlock
      toolName={block.toolName}
      toolCallId={block.toolCallId}
      args={block.args}
      result={block.result}
      details={block.details}
      // 未回填（result === undefined）即仍在执行 —— 不按真值判，空串结果（只交回图片的工具）是已完成
      status={block.result === undefined ? 'running' : block.isError ? 'error' : 'done'}
    />
  )
}

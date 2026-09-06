import ReactMarkdown from 'react-markdown'
import {
  markdownComponents,
  markdownRemarkPlugins,
  markdownRehypePlugins
} from './markdownComponents'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { StepGroup } from './StepGroup'
import type { BlockGroup } from './stepGrouping'

/**
 * 过程区的一行 —— 按分组种类分发：步骤合并行 / 思考 / 中间文本 / 单次工具调用。
 * 主对话卡与子智能体内联转写共用这一份分发，免得几处各写一遍 switch 之后悄悄走散。
 * key 由调用方按 `group.key` 给。
 */
export function StepGroupView({
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
        <ReactMarkdown
          remarkPlugins={markdownRemarkPlugins}
          rehypePlugins={markdownRehypePlugins}
          components={markdownComponents}
        >
          {block.text}
        </ReactMarkdown>
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

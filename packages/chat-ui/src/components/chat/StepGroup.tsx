import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildToolSummary } from '@shuvix/chat-protocol/toolSummaries'
import { useChatStore } from '../../stores/chatStore'
import { clipLine } from '../../utils/clipLine'
import { CountBadge, StepRow } from './StepRow'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock, renderToolIcon } from './ToolCallBlock'
import { formatStepSequence, summarizeSteps, uniformToolName, type StepBlock } from './stepGrouping'

/**
 * 步骤合并行 — 一段相邻的步骤（思考 / 已完成的工具调用，不限同名）折叠成单行，
 * 展开后逐条列出原始的思考行 / 工具行。只有这一层，不再往上套。
 *
 * 两种面孔，同一副骨架：
 *  - 全是同一个工具：`[工具图标] 阅读  alpha.txt · beta.txt  [2]` —— 与从前的同名合并行一模一样，
 *    摘要去重后拼接，同工具不同动作（evaluate / screenshot）仍能一眼看出；
 *  - 混着思考或不同工具：`写入文件 · 阅读 ×2  test.txt  [5]` —— 不出图标，标签位换成「每种工具
 *    各几次」（按首次出现顺序），摘要位仍是各次调用摘要的去重拼接。思考不进标签：它几乎每步
 *    都有、只会把行撑满，计数徽章里仍算它一步，展开后照常逐行可见；全是思考的段才写「思考 ×n」。
 */
export function StepGroup({ blocks }: { blocks: StepBlock[] }): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const presentations = useChatStore((s) => s.toolPresentations)

  const toolName = uniformToolName(blocks)
  const uniformPresentation = toolName ? presentations[toolName] : undefined

  // 各次调用的摘要去重后拼接（思考没有摘要）
  const detail = useMemo(() => {
    const seen = new Set<string>()
    for (const b of blocks) {
      if (b.type !== 'tool') continue
      const first = buildToolSummary(b.toolName, b.args)?.split('\n')[0]?.trim()
      if (first) seen.add(first)
    }
    return clipLine([...seen].join(' · '), 60)
  }, [blocks])

  // 混合段的标签：每种工具各几次，`阅读 ×2 · 文本编辑`；思考不进标签，除非这一段只有思考
  const sequence = useMemo(() => {
    const labelOf = (b: StepBlock): string =>
      b.type === 'thinking' ? t('steps.thinking') : presentations[b.toolName]?.label || b.toolName
    const tools = blocks.filter((b) => b.type === 'tool')
    return formatStepSequence(summarizeSteps(tools.length > 0 ? tools : blocks, labelOf))
  }, [blocks, presentations, t])

  const rowProps = toolName
    ? {
        icon: renderToolIcon(uniformPresentation),
        label: uniformPresentation?.label || toolName,
        detail: detail ? <span className="font-mono">{detail}</span> : undefined
      }
    : {
        // 混合段不出图标：几种工具各有各的图标，再造一枚泛指的只是噪音；图标槽留空保持对齐
        label: sequence,
        detail: detail ? <span className="font-mono">{detail}</span> : undefined
      }
  // `data-group-count`：计数徽章的语义锚点（e2e 据此定位，不认样式类）
  const trailing = <CountBadge count={blocks.length} data-group-count="" />

  // `data-step-group` / `data-group-state` / `data-group-count`（根节点）：合并行在 DOM 上的语义锚点
  const rootData = {
    'data-step-group': '',
    'data-group-state': expanded ? 'expanded' : 'collapsed',
    'data-group-size': blocks.length
  }

  if (!expanded) {
    return (
      <div {...rootData}>
        <StepRow {...rowProps} trailing={trailing} expandable onClick={() => setExpanded(true)} />
      </div>
    )
  }

  return (
    <div {...rootData}>
      <StepRow {...rowProps} trailing={trailing} expandable onClick={() => setExpanded(false)} />
      <div className="ml-3 pl-2 border-l border-border-secondary/50 space-y-0.5">
        {blocks.map((b, idx) =>
          b.type === 'thinking' ? (
            <ThinkingBlock key={`thinking-${idx}`} content={b.text} />
          ) : (
            <ToolCallBlock
              key={b.toolCallId}
              toolName={b.toolName}
              toolCallId={b.toolCallId}
              args={b.args}
              result={b.result}
              details={b.details}
              status="done"
            />
          )
        )}
      </div>
    </div>
  )
}

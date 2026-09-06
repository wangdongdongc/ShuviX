import { useState, type ReactNode } from 'react'
import { StepRow } from './StepRow'

/** 三种系统通知 —— 也是根节点 `data-system-notice` 的取值（e2e 据此定位） */
export type SystemNoticeKind = 'compaction' | 'background' | 'instruction'

interface SystemNoticeRowProps {
  kind: SystemNoticeKind
  icon: ReactNode
  label: ReactNode
  /** 折叠态的一行摘要 */
  detail?: ReactNode
  trailing?: ReactNode
  defaultExpanded?: boolean
  /** 展开后从下方长出的正文 */
  children: ReactNode
}

/**
 * 系统通知行 —— 压缩摘要 / 后台完成通知 / 项目指令注入这类「不是谁说的话」的消息，
 * 与工具调用同一副形态：一行 `[图标] 标签  摘要…`，点开正文从下方长出（同样的左侧细线缩进）。
 *
 * 曾经是一张居中通栏卡片（描边 + 底色 + 折叠箭头 + 一行「系统」署名），比对话里任何一条
 * 真正的发言都重，而它们恰恰是最不该抢眼的东西。改成步骤行之后，它们在对话流里的分量
 * 与一次工具调用相当 —— 这正是它们的实际分量。
 */
export function SystemNoticeRow({
  kind,
  icon,
  label,
  detail,
  trailing,
  defaultExpanded = false,
  children
}: SystemNoticeRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  return (
    <div
      className="px-4 py-1"
      data-system-notice={kind}
      data-notice-state={expanded ? 'expanded' : 'collapsed'}
    >
      <StepRow
        icon={icon}
        label={label}
        detail={detail}
        trailing={trailing}
        expandable
        onClick={() => setExpanded(!expanded)}
      />
      {expanded && (
        <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50">{children}</div>
      )}
    </div>
  )
}

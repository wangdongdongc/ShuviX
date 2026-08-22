import type { ReactNode } from 'react'

/**
 * 图标槽 — 类型图标与状态图标共用同一列。
 * 不给状态单独留槽：done 是常态，空槽会让每行白吃一段缩进。
 */
const ICON_SLOT = 'w-3.5 flex-shrink-0 flex items-center justify-center'

interface StepRowProps {
  /** 状态图标 — 传入时顶替类型图标（运行中 spinner、出错标记、待询问等） */
  lead?: ReactNode
  /** 类型图标 */
  icon?: ReactNode
  /** 类型标签 */
  label?: ReactNode
  /** 摘要 — 占满剩余宽度并截断 */
  detail?: ReactNode
  /** 行尾附加内容（计数徽章、生成中提示等） */
  trailing?: ReactNode
  /** 可展开 — 整行给出 hover 反馈；展开与否由下方内容自身体现，不额外出指示符 */
  expandable?: boolean
  onClick?: () => void
  /** 追加类名（展开态卡片头部覆盖内边距/描边） */
  className?: string
}

/**
 * 步骤行骨架 — 工具调用 / 文本步骤共用的单行布局。
 * 单图标列宽度固定，各类步骤行无论有无状态图标都在同一列起排。
 */
export function StepRow({
  lead,
  icon,
  label,
  detail,
  trailing,
  expandable,
  onClick,
  className = ''
}: StepRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-1.5 px-1 py-1 rounded-md text-left text-[11px] text-text-tertiary transition-colors ${
        expandable
          ? 'hover:bg-bg-tertiary/60 hover:text-text-secondary cursor-pointer'
          : 'cursor-default'
      } ${className}`}
    >
      <span className={ICON_SLOT}>{lead ?? icon}</span>
      {label && <span className="font-medium text-text-secondary flex-shrink-0">{label}</span>}
      <span className="flex-1 min-w-0 truncate">{detail}</span>
      {trailing}
    </button>
  )
}

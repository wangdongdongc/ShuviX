import type { ExperimentalFeature } from '@shuvix/chat-protocol/experimentalFeatures'
import { ExperimentalTag } from '../common/ExperimentalTag'

/** Tab 按钮 */
export function TabButton({
  icon,
  label,
  experimental,
  active,
  onClick
}: {
  icon: React.ReactNode
  label: string
  /** 实验功能：文案后缀一枚「实验」小标签 */
  experimental?: ExperimentalFeature
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
        active
          ? 'bg-accent/10 text-accent'
          : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
      }`}
    >
      {icon}
      {/* 文案与标签贴紧（gap-1 而非按钮的 gap-2），放不下时截文案、不挤标签 */}
      <span className="flex items-center gap-1 min-w-0">
        <span data-tab-label className="truncate">
          {label}
        </span>
        {experimental && <ExperimentalTag feature={experimental} />}
      </span>
    </button>
  )
}

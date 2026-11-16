import { useTranslation } from 'react-i18next'
import { UserX } from 'lucide-react'

/**
 * 步骤行行尾的「无人」图标：这一步在一轮无人值守的运行里要交给人（批准 / 回答），当时没人在，所以没做 / 没人答
 * （docs/unattended-run-design.md §6）。只有图标，原因在悬停提示里；按工具结果的形状认（`isUnattendedResult`）。
 */
export function UnattendedMark(): React.JSX.Element {
  const { t } = useTranslation()
  const hint = t('toolCall.unattendedHint')
  return (
    <span
      className="flex-shrink-0 flex items-center text-warning"
      title={hint}
      aria-label={hint}
      data-tool-unattended=""
    >
      <UserX size={12} />
    </span>
  )
}

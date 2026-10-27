/**
 * 自动审查在对话里的三处露面（设计稿 docs/permission-review-design.md §11）—— 措辞与配色收在这一处：
 *
 *  - 工具卡「审查中」：审查员正在替你看这次调用（`tool_review` 事件，过程态）；
 *  - 工具卡「已审查」：审查员放行了它，没经过你（工具结果 details 上的标记，重开会话照样在）；
 *  - 询问卡片上的审查意见：审查员看过、决定交给你 —— 它那句话就是卡片标题，下面一个短句点出该掂量的那一点。
 *
 * 风险配色：低 = 不抢眼，中 = 警示色，高 / 严重 = 危险色。执行只看判决，风险只给人看。
 */
import { ShieldCheck, ShieldEllipsis } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AskReview } from '@shuvix/chat-protocol/types/inputRequest'
import type { PermissionRisk } from '@shuvix/chat-protocol/types/permissionReview'
import type { ToolReviewNote } from '@shuvix/chat-protocol/types/toolReview'

const RISK_TEXT: Record<PermissionRisk, string> = {
  low: 'text-text-tertiary',
  medium: 'text-warning',
  high: 'text-error',
  critical: 'text-error'
}

const RISK_PILL: Record<PermissionRisk, string> = {
  low: 'bg-success/15 text-success',
  medium: 'bg-warning/15 text-warning',
  high: 'bg-error/15 text-error',
  critical: 'bg-error/25 text-error'
}

/** 风险等级的本地化说法（「低风险」…） */
export function useRiskLabel(): (risk: PermissionRisk) => string {
  const { t } = useTranslation()
  return (risk) => t(`toolCall.reviewRisk.${risk}`)
}

/** 工具卡状态槽里的「审查中」—— 顶替运行中的转圈：这段等待在等审查员，不是工具卡住了 */
export function ReviewingIcon(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span className="flex items-center" title={t('toolCall.reviewingHint')} data-tool-reviewing>
      <ShieldEllipsis size={11} className="text-accent animate-pulse" />
    </span>
  )
}

/**
 * 工具卡行尾的「已审查」：只一枚盾牌，颜色随风险；悬停看审查员那句话。
 * 刻意不写字 —— 没有沙箱的平台上几乎每条命令都过审查，一排文字标签只会盖过真正要看的行。
 */
export function ReviewedMark({ note }: { note: ToolReviewNote }): React.JSX.Element {
  const { t } = useTranslation()
  const riskLabel = useRiskLabel()
  // 审查员写的那句拼在后面而不是插值：i18next 的 {{…}} 会被值里的占位符劫持
  const hint =
    t('toolCall.reviewedHint', { risk: riskLabel(note.risk) }) +
    (note.summary.trim() ? `\n${note.summary.trim()}` : '')
  return (
    <span
      className={`flex-shrink-0 flex items-center ${RISK_TEXT[note.risk]}`}
      title={hint}
      data-tool-reviewed={note.risk}
    >
      <ShieldCheck size={11} />
    </span>
  )
}

/** 风险小标签（询问卡片顶上那行，右端） */
export function ReviewRiskBadge({ risk }: { risk: PermissionRisk }): React.JSX.Element {
  const riskLabel = useRiskLabel()
  return (
    <span
      className={`flex-shrink-0 px-1.5 py-px rounded text-[11px] font-medium ${RISK_PILL[risk]}`}
      data-ask-review-risk={risk}
    >
      {riskLabel(risk)}
    </span>
  )
}

/** 「需注意」那一句的颜色：低风险不抢眼，中 = 警示色，高 / 严重 = 危险色 */
const CONCERN_TEXT: Record<PermissionRisk, string> = {
  low: 'text-text-secondary',
  medium: 'text-warning',
  high: 'text-error',
  critical: 'text-error'
}

/**
 * 询问卡片上的审查意见：审查员看过这次操作、决定交给你。summary 就是卡片的标题 —— 命令原文要懂 shell
 * 才读得懂，它用大白话说这次要做什么；reason 是标题下面那一句，点出批准前该掂量的那一点，颜色随风险。
 * 风险标签不在这里，在卡片顶上那行的右端（ReviewRiskBadge）。
 */
export function ReviewOpinion({
  review,
  touch
}: {
  review: AskReview
  touch: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="min-w-0" data-ask-review={review.risk}>
      <p
        className={`break-words font-medium text-text-primary leading-snug ${
          touch ? 'text-sm' : 'text-[13px]'
        }`}
        data-ask-review-summary=""
      >
        {review.summary.trim() || t('toolCall.reviewNoSummary')}
      </p>
      {review.reason.trim() && (
        <p
          className={`mt-0.5 break-words leading-snug ${CONCERN_TEXT[review.risk]} ${
            touch ? 'text-[13px]' : 'text-[12.5px]'
          }`}
          data-ask-review-reason=""
        >
          <span className="sr-only">{t('toolCall.reviewReasonLabel')} </span>
          {review.reason.trim()}
        </p>
      )}
    </div>
  )
}

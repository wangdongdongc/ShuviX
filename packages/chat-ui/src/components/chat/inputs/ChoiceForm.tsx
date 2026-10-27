import { MessageCircleQuestion } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChoiceInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { useChatDensity } from '../../../host/chatHostContext'
import type { InputFormProps } from './types'
import type { ChoiceDraft } from './drafts'
import { OptionRow, useOptionHotkeys } from './OptionRows'

/**
 * 选项题 —— 一律勾选 + 确认，选几项由用户定。
 *
 * 曾经由 agent 用 `allowMultiple` 决定单选还是多选，结果常常是问题里写着「可多选」、
 * 参数却没传，表单成了点一下就交的单选。现在 agent 只给选项和说明，表单不分单选多选：
 * 勾一项就是单选，勾几项就是多选。代价是单选也要多按一次确认 —— 换来的是
 * 表单永远和问题说的对得上。确认键始终在，未勾选时禁用；问题下面一行小字说明可以多选。
 *
 * 形状与审批卡相同：问题在上，选项是占满卡片宽度的行（OptionRows），确认键钉在最下面。
 * 选项多了只有中间那段滚动，问题与确认键始终看得见（面板自身封顶，见 PendingInputsPanel）。
 */
export function ChoiceForm({
  request,
  draft,
  onDraftChange,
  onSubmit,
  titleAccessory
}: InputFormProps<ChoiceInputRequest, ChoiceDraft>): React.JSX.Element {
  const { t } = useTranslation()
  const touch = useChatDensity() === 'touch'
  const { question, detail, options } = request
  const selected = draft.selected ?? []

  /** 勾上 / 勾掉，等确认键 */
  const handlePick = (label: string): void => {
    onDraftChange({
      selected: selected.includes(label)
        ? selected.filter((s) => s !== label)
        : [...selected, label]
    })
  }

  const handleConfirm = (): void => {
    if (selected.length === 0) return
    onSubmit({ kind: 'choice', selections: selected })
  }

  useOptionHotkeys(options.length, (i) => {
    const opt = options[i]
    if (opt) handlePick(opt.label)
  })

  return (
    <div className="flex flex-col min-h-0" data-choice-card="">
      {/* 问题（右端为父级步进器插槽） */}
      <div className={`flex-shrink-0 ${touch ? 'px-4 pt-3.5 pb-2.5' : 'px-3.5 pt-3 pb-2'}`}>
        <div className="flex items-start gap-1.5 min-w-0">
          <MessageCircleQuestion
            size={touch ? 16 : 13}
            className={`text-accent/80 flex-shrink-0 ${touch ? 'mt-0.5' : 'mt-px'}`}
          />
          <p
            className={`flex-1 min-w-0 break-words font-medium text-text-primary leading-snug ${
              touch ? 'text-sm' : 'text-[13px]'
            }`}
            data-choice-question=""
          >
            {question}
          </p>
          {titleAccessory}
        </div>
        <p
          className={`mt-0.5 text-text-tertiary ${touch ? 'pl-[22px] text-[12px]' : 'pl-[19px] text-[11px]'}`}
        >
          {t('pendingInputs.choiceHint')}
        </p>
      </div>

      {/* 说明 + 选项：只有这一段会滚 */}
      <div className="min-h-0 overflow-y-auto thin-scrollbar">
        {detail && (
          <pre
            className={`text-[12px] text-text-tertiary bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 overflow-auto max-h-24 whitespace-pre-wrap break-all font-mono !mt-0 ${
              touch ? 'mx-4 mb-2.5' : 'mx-3.5 mb-2'
            }`}
          >
            {detail}
          </pre>
        )}
        <div role="group" aria-label={question}>
          {options.map((opt, i) => (
            <OptionRow
              key={opt.label}
              index={i}
              label={opt.label}
              detail={opt.description || undefined}
              checked={selected.includes(opt.label)}
              onPick={() => handlePick(opt.label)}
              data={{ 'data-choice-option': opt.label }}
            />
          ))}
        </div>
      </div>

      <div
        className={`flex-shrink-0 flex border-t border-border-secondary/40 ${
          touch ? 'px-4 py-2.5' : 'px-3.5 py-2 justify-end'
        }`}
      >
        <button
          type="button"
          onClick={handleConfirm}
          disabled={selected.length === 0}
          data-choice-confirm=""
          // 没勾任何一项时是一块安静的灰（半透明的强调色在深色主题里发闷，字也读不清）
          className={`rounded-lg font-medium transition-colors disabled:cursor-not-allowed ${
            selected.length > 0
              ? 'bg-accent text-white hover:bg-accent-hover'
              : 'bg-bg-secondary text-text-tertiary'
          } ${touch ? 'flex-1 h-10 text-sm' : 'px-3 py-1 text-xs'}`}
        >
          {t('toolCall.confirmSelection')}
          {selected.length > 0 && <span className="tabular-nums"> ({selected.length})</span>}
        </button>
      </div>
    </div>
  )
}

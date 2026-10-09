import { Check, MessageCircleQuestion } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChoiceInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { InputFormProps } from './types'
import type { ChoiceDraft } from './drafts'

/**
 * 选项题 —— 一律勾选 + 确认，选几项由用户定。
 *
 * 曾经由 agent 用 `allowMultiple` 决定单选还是多选，结果常常是问题里写着「可多选」、
 * 参数却没传，表单成了点一下就交的单选。现在 agent 只给选项和说明，表单不分单选多选：
 * 勾一项就是单选，勾几项就是多选。代价是单选也要多按一次确认 —— 换来的是
 * 表单永远和问题说的对得上。确认键始终在，未勾选时禁用。
 * 折叠开关也撤了：面板自身封顶滚动（PendingInputsPanel 的 max-h），长列表不会顶走输入区。
 */
export function ChoiceForm({
  request,
  draft,
  onDraftChange,
  onSubmit,
  titleAccessory
}: InputFormProps<ChoiceInputRequest, ChoiceDraft>): React.JSX.Element {
  const { t } = useTranslation()
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

  return (
    <div className="space-y-1.5">
      {/* 问题标题行（右端为父级步进器插槽） */}
      <div className="flex items-center gap-1.5 min-w-0">
        <MessageCircleQuestion size={13} className="text-accent/80 flex-shrink-0" />
        <p className="text-xs text-text-primary font-medium leading-snug flex-1 min-w-0 break-words">
          {question}
        </p>
        {titleAccessory}
      </div>

      {detail && (
        <pre className="text-[11px] text-text-tertiary bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 overflow-auto max-h-20 whitespace-pre-wrap break-all font-mono">
          {detail}
        </pre>
      )}

      <div className="flex flex-col gap-0.5">
        {options.map((opt) => {
          const isSelected = selected.includes(opt.label)
          return (
            <button
              key={opt.label}
              onClick={() => handlePick(opt.label)}
              className={`flex items-start gap-2 px-2 py-1 rounded-lg text-left transition-colors ${
                isSelected
                  ? 'bg-accent/10 text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover/40'
              }`}
            >
              <div
                className={`mt-0.5 w-3.5 h-3.5 rounded-[4px] flex-shrink-0 flex items-center justify-center border transition-colors ${
                  isSelected ? 'border-accent bg-accent' : 'border-border-primary/60'
                }`}
              >
                {isSelected && <Check size={9} className="text-white" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium leading-snug">{opt.label}</div>
                {opt.description && (
                  <div className="text-[11px] text-text-tertiary leading-snug">
                    {opt.description}
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>

      <div className="flex items-center">
        <span className="flex-1" />
        <button
          onClick={handleConfirm}
          disabled={selected.length === 0}
          className="px-3 py-1 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {t('toolCall.confirmSelection')}
          {selected.length > 0 && <span className="tabular-nums"> ({selected.length})</span>}
        </button>
      </div>
    </div>
  )
}

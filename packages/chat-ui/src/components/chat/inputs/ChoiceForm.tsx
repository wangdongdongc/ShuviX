import { Check, ChevronDown, MessageCircleQuestion } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChoiceInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { InputFormProps } from './types'
import type { ChoiceDraft } from './drafts'

export function ChoiceForm({
  request,
  draft,
  onDraftChange,
  onSubmit,
  titleAccessory
}: InputFormProps<ChoiceInputRequest, ChoiceDraft>): React.JSX.Element {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const { question, detail, options, allowMultiple } = request
  const selected = draft.selected ?? []

  const handleToggle = (label: string): void => {
    let next: string[]
    if (allowMultiple) {
      next = selected.includes(label) ? selected.filter((s) => s !== label) : [...selected, label]
    } else {
      next = selected.includes(label) ? [] : [label]
    }
    onDraftChange({ selected: next })
  }

  const handleConfirm = (): void => {
    if (selected.length === 0) return
    onSubmit({ kind: 'choice', selections: selected })
  }

  return (
    <div>
      {/* 问题标题行（点击折叠/展开；右端为父级步进器插槽） */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex-1 min-w-0 flex items-center gap-1.5 py-0.5 text-left rounded-lg hover:bg-bg-hover/30 transition-colors"
        >
          <MessageCircleQuestion size={13} className="text-accent/80 flex-shrink-0" />
          <p className="text-xs text-text-primary font-medium leading-snug flex-1 min-w-0 break-words">
            {question}
          </p>
          <ChevronDown
            size={13}
            className={`text-text-tertiary/60 flex-shrink-0 transition-transform duration-200 ${collapsed ? '-rotate-90' : 'rotate-0'}`}
          />
        </button>
        {titleAccessory}
      </div>

      {/* 可折叠区域 */}
      <div className={`collapse-grid${collapsed ? '' : ' expanded'}`}>
        <div className="collapse-inner">
          {detail && (
            <pre className="text-[11px] text-text-tertiary bg-bg-secondary/70 rounded-lg mt-1.5 px-2.5 py-1.5 overflow-auto max-h-20 whitespace-pre-wrap break-all font-mono">
              {detail}
            </pre>
          )}
          <div className="flex flex-col gap-0.5 pt-1">
            {options.map((opt) => {
              const isSelected = selected.includes(opt.label)
              return (
                <button
                  key={opt.label}
                  onClick={() => handleToggle(opt.label)}
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

          <div className="flex items-center gap-2 pt-1.5">
            <button
              onClick={handleConfirm}
              disabled={selected.length === 0}
              className="px-3 py-1 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {t('toolCall.confirmSelection')}
            </button>
            {allowMultiple && (
              <span className="text-[11px] text-text-tertiary/70">
                {t('toolCall.multiSelectHint')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

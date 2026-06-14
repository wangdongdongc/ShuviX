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
  onSubmit
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
    <div className="rounded-md border border-accent/20 bg-accent/5 overflow-hidden">
      {/* 问题标题栏（可点击折叠/展开） */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-bg-hover/20 transition-colors"
      >
        <MessageCircleQuestion size={11} className="text-accent/70 flex-shrink-0" />
        <p className="text-[11px] text-text-primary font-medium leading-snug flex-1 min-w-0 break-words">
          {question}
        </p>
        <ChevronDown
          size={11}
          className={`text-text-tertiary/60 flex-shrink-0 transition-transform duration-200 ${collapsed ? '-rotate-90' : 'rotate-0'}`}
        />
      </button>

      {/* 可折叠区域 */}
      <div className={`collapse-grid${collapsed ? '' : ' expanded'}`}>
        <div className="collapse-inner">
          {detail && (
            <pre className="text-[10px] text-text-tertiary bg-bg-primary/50 rounded mx-2 mb-1 px-2 py-1 overflow-auto max-h-20 whitespace-pre-wrap break-all font-mono border border-border-secondary/40">
              {detail}
            </pre>
          )}
          <div className="flex flex-col gap-0.5 px-2 pb-1">
            {options.map((opt) => {
              const isSelected = selected.includes(opt.label)
              return (
                <button
                  key={opt.label}
                  onClick={() => handleToggle(opt.label)}
                  className={`flex items-start gap-1.5 px-2 py-1 rounded text-left transition-colors ${
                    isSelected
                      ? 'bg-accent/10 text-text-primary'
                      : 'text-text-secondary hover:bg-bg-hover/40'
                  }`}
                >
                  <div
                    className={`mt-0.5 w-3 h-3 rounded-sm flex-shrink-0 flex items-center justify-center border transition-colors ${
                      isSelected ? 'border-accent bg-accent' : 'border-border-primary/60'
                    }`}
                  >
                    {isSelected && <Check size={8} className="text-white" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium leading-snug">{opt.label}</div>
                    {opt.description && (
                      <div className="text-[10px] text-text-tertiary mt-0 leading-snug">
                        {opt.description}
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-1.5 px-2 py-1 border-t border-border-secondary/30">
            <button
              onClick={handleConfirm}
              disabled={selected.length === 0}
              className="px-2.5 py-0.5 rounded text-[11px] font-medium bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {t('toolCall.confirmSelection')}
            </button>
            {allowMultiple && (
              <span className="text-[10px] text-text-tertiary/60">
                {t('toolCall.multiSelectHint')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

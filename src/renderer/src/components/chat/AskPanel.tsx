import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, MessageCircleQuestion } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'

interface AskPanelProps {
  /** 用户选择回调 */
  onUserInput: (toolCallId: string, selections: string[]) => void
}

/**
 * Ask 浮动面板 — 渲染在输入框上方
 * 自动检测 pending_user_input 状态的 ask 工具执行，展示问题和可点击选项
 */
export function AskPanel({ onUserInput }: AskPanelProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set())

  // 从 store 查找当前处于 pending_user_input 状态的 ask 工具执行
  const pendingAsk = useChatStore((s) =>
    s.toolExecutions.find((te) => te.status === 'pending_user_input' && te.toolName === 'ask')
  )

  if (!pendingAsk) return null

  const { toolCallId, args } = pendingAsk
  const question = args?.question || ''
  const options: Array<{ label: string; description: string }> = args?.options || []
  const allowMultiple = args?.allowMultiple ?? false

  const handleToggle = (label: string): void => {
    setSelectedOptions((prev) => {
      const next = new Set(prev)
      if (allowMultiple) {
        if (next.has(label)) next.delete(label)
        else next.add(label)
      } else {
        // 单选：直接切换
        if (next.has(label)) next.clear()
        else { next.clear(); next.add(label) }
      }
      return next
    })
  }

  const handleConfirm = (): void => {
    if (!toolCallId || selectedOptions.size === 0) return
    onUserInput(toolCallId, Array.from(selectedOptions))
    setSelectedOptions(new Set())
  }

  return (
    <div className="mx-3 mb-2 rounded-xl border border-accent/30 bg-bg-secondary/90 backdrop-blur-sm shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      {/* 问题标题 */}
      <div className="flex items-start gap-2 px-4 pt-3 pb-2">
        <MessageCircleQuestion size={16} className="text-accent flex-shrink-0 mt-0.5" />
        <p className="text-sm text-text-primary font-medium leading-snug">{question}</p>
      </div>

      {/* 选项列表 */}
      <div className="flex flex-col gap-1.5 px-4 pb-2">
        {options.map((opt) => {
          const isSelected = selectedOptions.has(opt.label)
          return (
            <button
              key={opt.label}
              onClick={() => handleToggle(opt.label)}
              className={`flex items-start gap-2.5 px-3 py-2 rounded-lg text-left transition-all border ${
                isSelected
                  ? 'border-accent bg-accent/10 text-text-primary shadow-sm'
                  : 'border-border-secondary bg-bg-primary/50 text-text-secondary hover:bg-bg-hover/50 hover:border-border-primary'
              }`}
            >
              <div className={`mt-0.5 w-4 h-4 rounded flex-shrink-0 flex items-center justify-center border transition-colors ${
                isSelected ? 'border-accent bg-accent' : 'border-border-primary'
              }`}>
                {isSelected && <Check size={11} className="text-white" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">{opt.label}</div>
                {opt.description && <div className="text-[11px] text-text-tertiary mt-0.5 leading-relaxed">{opt.description}</div>}
              </div>
            </button>
          )
        })}
      </div>

      {/* 确认栏 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border-secondary/50 bg-bg-tertiary/30">
        <button
          onClick={handleConfirm}
          disabled={selectedOptions.size === 0}
          className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t('toolCall.confirmSelection')}
        </button>
        {allowMultiple && (
          <span className="text-[10px] text-text-tertiary">{t('toolCall.multiSelectHint')}</span>
        )}
      </div>
    </div>
  )
}

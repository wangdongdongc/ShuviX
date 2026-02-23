import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, MessageCircleQuestion, ShieldAlert } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'

interface UserActionPanelProps {
  /** ask 工具：用户选择回调 */
  onUserInput: (toolCallId: string, selections: string[]) => void
  /** 沙箱审批：用户允许/拒绝工具调用 */
  onApproval: (toolCallId: string, approved: boolean) => void
}

/**
 * 用户操作浮动面板 — 悬浮在输入框上方
 * 统一处理 AI 执行过程中需要用户介入的两种场景：
 *   1. ask 工具提问（pending_user_input）— 展示问题和可选选项
 *   2. bash 审批（pending_approval）— 展示待执行命令和允许/拒绝按钮
 */
export function UserActionPanel({ onUserInput, onApproval }: UserActionPanelProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set())

  // 从 store 查找当前需要用户操作的工具执行
  const pendingAsk = useChatStore((s) =>
    s.toolExecutions.find((te) => te.status === 'pending_user_input' && te.toolName === 'ask')
  )
  const pendingApproval = useChatStore((s) =>
    s.toolExecutions.find((te) => te.status === 'pending_approval')
  )

  // ask 优先（两者不会同时出现，但保险起见）
  if (pendingAsk) {
    return <AskContent pending={pendingAsk} selectedOptions={selectedOptions} setSelectedOptions={setSelectedOptions} onUserInput={onUserInput} t={t} />
  }
  if (pendingApproval) {
    return <ApprovalContent pending={pendingApproval} onApproval={onApproval} t={t} />
  }
  return null
}

// ---------- ask 提问子内容 ----------

function AskContent({
  pending,
  selectedOptions,
  setSelectedOptions,
  onUserInput,
  t
}: {
  pending: { toolCallId: string; args?: any }
  selectedOptions: Set<string>
  setSelectedOptions: React.Dispatch<React.SetStateAction<Set<string>>>
  onUserInput: (toolCallId: string, selections: string[]) => void
  t: (key: string) => string
}): React.JSX.Element {
  const { toolCallId, args } = pending
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

// ---------- bash 审批子内容 ----------

function ApprovalContent({
  pending,
  onApproval,
  t
}: {
  pending: { toolCallId: string; toolName: string; args?: any }
  onApproval: (toolCallId: string, approved: boolean) => void
  t: (key: string) => string
}): React.JSX.Element {
  const { toolCallId, args } = pending
  const command = args?.command || ''

  return (
    <div className="mx-3 mb-2 rounded-xl border border-warning/30 bg-bg-secondary/90 backdrop-blur-sm shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      {/* 标题 */}
      <div className="flex items-start gap-2 px-4 pt-3 pb-2">
        <ShieldAlert size={16} className="text-warning flex-shrink-0 mt-0.5" />
        <p className="text-sm text-text-primary font-medium leading-snug">{t('toolCall.pendingApproval')}</p>
      </div>

      {/* 命令预览 */}
      <div className="px-4 pb-2">
        <pre className="text-[11px] text-text-secondary bg-bg-primary/50 rounded-lg px-3 py-2 overflow-auto max-h-32 whitespace-pre-wrap break-words font-mono border border-border-secondary/50">
          {command}
        </pre>
      </div>

      {/* 操作栏 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border-secondary/50 bg-bg-tertiary/30">
        <button
          onClick={() => onApproval(toolCallId, true)}
          className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
        >
          {t('toolCall.allow')}
        </button>
        <button
          onClick={() => onApproval(toolCallId, false)}
          className="px-4 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
        >
          {t('toolCall.deny')}
        </button>
        <span className="text-[10px] text-text-tertiary ml-1">{t('toolCall.sandboxHint')}</span>
      </div>
    </div>
  )
}

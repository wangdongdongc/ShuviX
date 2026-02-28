import { useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useClickOutside } from '../../hooks/useClickOutside'
import type { ThinkingLevel } from '../../../../main/types'

/**
 * 思考深度选择器 — 仅当模型支持 reasoning 时显示
 */
export function ThinkingPicker(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { activeSessionId, modelSupportsReasoning, thinkingLevel, setThinkingLevel } = useChatStore()

  const thinkingRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(thinkingRef, close, open)

  if (!modelSupportsReasoning) return null

  const levels = [
    { value: 'off', label: t('input.thinkOff') },
    { value: 'low', label: t('input.thinkLow') },
    { value: 'medium', label: t('input.thinkMedium') },
    { value: 'high', label: t('input.thinkHigh') },
    { value: 'xhigh', label: t('input.thinkXHigh') }
  ]

  /** 切换思考深度 */
  const handleSetLevel = async (level: string): Promise<void> => {
    setThinkingLevel(level)
    setOpen(false)
    if (activeSessionId) {
      await window.api.agent.setThinkingLevel({ sessionId: activeSessionId, level: level as ThinkingLevel })
      // 持久化思考深度到会话
      await window.api.session.updateModelMetadata({
        id: activeSessionId,
        modelMetadata: JSON.stringify({ thinkingLevel: level })
      })
    }
  }

  return (
    <div ref={thinkingRef} className="relative flex items-center">
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 text-[11px] transition-colors ${
          thinkingLevel !== 'off'
            ? 'text-purple-400 hover:text-purple-300'
            : 'text-purple-400/50 hover:text-purple-400'
        }`}
        title={t('input.thinkingDepth')}
      >
        <Brain size={11} />
        <span>{levels.find((l) => l.value === thinkingLevel)?.label || t('input.thinkOff')}</span>
      </button>

      {open && (
        <div className="absolute left-0 bottom-8 w-[120px] rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden">
          <div className="px-2 py-1.5 border-b border-border-secondary text-[10px] text-text-tertiary">{t('input.thinkingDepth')}</div>
          <div className="py-1">
            {levels.map((l) => (
              <button
                key={l.value}
                onClick={() => { void handleSetLevel(l.value) }}
                className={`w-full text-left px-2 py-1.5 text-[11px] hover:bg-bg-hover transition-colors ${
                  thinkingLevel === l.value ? 'text-purple-400 font-medium' : 'text-text-primary'
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

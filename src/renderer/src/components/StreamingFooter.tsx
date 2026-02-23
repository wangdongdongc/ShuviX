import { useTranslation } from 'react-i18next'
import { Sparkles, AlertCircle } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { MessageBubble } from './MessageBubble'

/**
 * 流式输出底部区域 — 思考过程、流式助手消息、加载指示器、错误提示
 * 独立组件，通过自身的 store subscription 获取最新状态
 */
export function StreamingFooter(): React.JSX.Element {
  const { t } = useTranslation()
  const { isStreaming, streamingContent, streamingThinking, error, setError } = useChatStore()

  return (
    <>
      {/* 流式输出的助手消息（thinking 也在气泡内渲染） */}
      {isStreaming && (streamingContent || streamingThinking) && (
        <MessageBubble
          role="assistant"
          content={streamingContent || ''}
          isStreaming
          streamingThinking={streamingThinking}
          model={useSettingsStore.getState().activeModel}
        />
      )}

      {/* 等待响应的加载指示器 */}
      {isStreaming && !streamingContent && !streamingThinking && !error && (
        <div className="flex gap-3 px-4 py-3">
          <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-bg-tertiary flex items-center justify-center">
            <Sparkles size={14} className="text-text-secondary animate-pulse" />
          </div>
          <div className="flex items-center gap-1 pt-1">
            <div className="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="mx-4 my-2 flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg bg-error/10 border border-error/20">
          <AlertCircle size={15} className="text-error flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-error font-medium mb-0.5">{t('chat.genFailed')}</p>
            <p className="text-[11px] text-error/80 break-words whitespace-pre-wrap">{error}</p>
          </div>
          <button
            onClick={() => setError(null)}
            className="text-error/50 hover:text-error transition-colors flex-shrink-0"
            title={t('common.close')}
          >
            ×
          </button>
        </div>
      )}
    </>
  )
}

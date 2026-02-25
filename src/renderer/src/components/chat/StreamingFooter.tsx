import { Sparkles } from 'lucide-react'
import { useChatStore, selectIsStreaming, selectStreamingContent, selectStreamingThinking } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { MessageBubble } from './MessageBubble'

/**
 * 流式输出底部区域 — 思考过程、流式助手消息、加载指示器、错误提示
 * 独立组件，通过自身的 store subscription 获取最新状态
 */
export function StreamingFooter(): React.JSX.Element {
  const isStreaming = useChatStore(selectIsStreaming)
  const streamingContent = useChatStore(selectStreamingContent)
  const streamingThinking = useChatStore(selectStreamingThinking)

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
      {isStreaming && !streamingContent && !streamingThinking && (
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
    </>
  )
}

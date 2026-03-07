import { Sparkles } from 'lucide-react'
import {
  useChatStore,
  selectIsStreaming,
  selectStreamingContent,
  selectStreamingThinking,
  selectStreamingImages,
  type AssistantTextMessage
} from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { AssistantBubble } from './AssistantBubble'
import type { StepItem, StepMessage } from './types'
import type { VisibleItem } from './MessageRenderer'

interface StreamingFooterProps {
  context?: { streamingSteps?: VisibleItem[] }
}

/**
 * 流式输出底部区域 — 思考过程、流式助手消息、加载指示器
 * 独立组件，通过自身的 store subscription 获取最新状态
 * 通过 Virtuoso context 接收流式中的 steps
 */
export function StreamingFooter({ context }: StreamingFooterProps): React.JSX.Element {
  const isStreaming = useChatStore(selectIsStreaming)
  const streamingContent = useChatStore(selectStreamingContent)
  const streamingThinking = useChatStore(selectStreamingThinking)
  const streamingImages = useChatStore(selectStreamingImages)

  // 将 VisibleItem[] 转换为 StepItem[]（窄化 msg 类型）
  const steps: StepItem[] | undefined =
    context?.streamingSteps && context.streamingSteps.length > 0
      ? context.streamingSteps.map((s) => ({
          msg: s.msg as StepMessage
        }))
      : undefined

  const hasSteps = steps && steps.length > 0

  // 构造流式用的临时 AssistantTextMessage
  const streamingMsg: AssistantTextMessage = {
    id: 'streaming',
    sessionId: '',
    role: 'assistant',
    type: 'text',
    content: streamingContent || '',
    metadata: null,
    model: useSettingsStore.getState().activeModel || '',
    createdAt: Date.now()
  }

  return (
    <>
      {/* 流式输出的助手消息（steps + thinking 在气泡内渲染） */}
      {isStreaming &&
        (streamingContent || streamingThinking || streamingImages.length > 0 || hasSteps) && (
          <AssistantBubble
            msg={streamingMsg}
            isStreaming
            streamingThinking={streamingThinking}
            streamingImages={streamingImages}
            steps={steps}
          />
        )}

      {/* 等待响应的加载指示器（仅在无任何内容时显示） */}
      {isStreaming && !streamingContent && !streamingThinking && !hasSteps && (
        <div className="flex gap-3 px-4 py-3">
          <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-bg-tertiary flex items-center justify-center">
            <Sparkles size={14} className="text-text-secondary animate-pulse" />
          </div>
          <div className="flex items-center gap-1 pt-1">
            <div
              className="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce"
              style={{ animationDelay: '0ms' }}
            />
            <div
              className="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce"
              style={{ animationDelay: '150ms' }}
            />
            <div
              className="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce"
              style={{ animationDelay: '300ms' }}
            />
          </div>
        </div>
      )}
    </>
  )
}

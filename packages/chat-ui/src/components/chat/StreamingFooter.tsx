import { Sparkles } from 'lucide-react'
import {
  useChatStore,
  selectIsStreaming,
  selectStreamingContent,
  selectStreamingThinking,
  selectStreamingToolCall
} from '../../stores/chatStore'

/**
 * 流式等待指示器 — 仅在流式已开始但尚无任何内容时显示 loading dots
 * 所有流式内容渲染已移至 Virtuoso 列表内的合成占位项（AssistantBubble）
 */
export function StreamingFooter(): React.JSX.Element {
  const isStreaming = useChatStore(selectIsStreaming)
  const streamingContent = useChatStore(selectStreamingContent)
  const streamingThinking = useChatStore(selectStreamingThinking)
  const streamingToolCall = useChatStore(selectStreamingToolCall)

  // 检查消息列表中是否有流式阶段的 step 消息（由 buildVisibleItems 合成项承载）
  const hasStreamingSteps = useChatStore((s) => {
    if (!s.activeSessionId || !isStreaming) return false
    // 如果 messages 中有任何 step/tool 类型，说明已有内容
    const msgs = s.messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === 'user' && m.type === 'text') break
      if (m.type === 'tool_use' || m.type === 'step_text' || m.type === 'step_thinking') return true
    }
    return false
  })

  // 仅在等待首个 token 时显示 loading dots
  if (
    !isStreaming ||
    streamingContent ||
    streamingThinking ||
    streamingToolCall ||
    hasStreamingSteps
  ) {
    return <></>
  }

  return (
    <div className="relative flex gap-3 pl-10 pr-4 py-3">
      <div className="absolute left-[1.35rem] top-0 bottom-0 w-px bg-border-secondary/40" />
      <div className="absolute left-2.5 top-3 flex-shrink-0 w-5 h-5 rounded-full bg-bg-tertiary flex items-center justify-center ring-2 ring-bg-primary z-10">
        <Sparkles size={10} className="text-text-secondary animate-pulse" />
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
  )
}

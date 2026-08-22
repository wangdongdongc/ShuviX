import { useChatStore, selectIsStreaming, selectHasLiveStreamContent } from '../../stores/chatStore'

/**
 * 流式等待指示器 —— 只在「已开始生成但还没有任何可见内容」时显示 loading dots。
 * 一旦有了正文/思考/工具调用，内容就由列表末尾的流式占位卡承载（见 Conversation）。
 */
export function StreamingFooter(): React.JSX.Element {
  const isStreaming = useChatStore(selectIsStreaming)
  const hasLiveContent = useChatStore(selectHasLiveStreamContent)

  // 本轮是否已经有落盘的助手卡在屏上（多轮工具调用时，第二轮等首 token 期间
  // 上一轮的工具行仍在，不该再补一排点）
  const hasSettledCard = useChatStore((s) => {
    if (!s.activeSessionId || !isStreaming) return false
    const msgs = s.messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === 'user') break
      if (m.role === 'assistant' && m.type === 'message') return true
    }
    return false
  })

  if (!isStreaming || hasLiveContent || hasSettledCard) return <></>

  return (
    <div className="relative max-w-[784px] mx-auto px-4 py-3">
      <div className="flex items-center gap-1">
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

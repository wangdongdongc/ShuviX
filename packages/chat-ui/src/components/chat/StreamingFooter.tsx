import {
  useChatStore,
  selectIsStreaming,
  selectHasLiveStreamContent,
  selectSessionRun
} from '../../stores/chatStore'
import { RunCompactingRow, RunRetryRow } from './RunStatusRows'

/**
 * 流式等待指示器 —— 只在「已开始生成但还没有任何可见内容」时显示 loading dots。
 * 一旦有了正文/思考/工具调用，内容就由列表末尾的流式占位卡承载（见 Conversation）。
 *
 * 同一格还承载运行状态行（P3-12）：重试退避时的倒计时（退避期间没有实时卡，它顶替点点）与压缩通知
 * （挡着生成的压缩同样顶替点点，后台压缩与点点并存）。两者只在运行 busy 时由视图给出。
 */
export function StreamingFooter(): React.JSX.Element {
  const isStreaming = useChatStore(selectIsStreaming)
  const hasLiveContent = useChatStore(selectHasLiveStreamContent)
  const run = useChatStore(selectSessionRun)
  const retry = run.state === 'busy' ? run.retry : undefined
  const compacting = run.state === 'busy' ? run.compacting : undefined

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

  const showDots =
    isStreaming && !hasLiveContent && !hasSettledCard && !retry && !compacting?.blocking

  if (!showDots && !retry && !compacting) return <></>

  return (
    <div className="relative max-w-[784px] mx-auto px-4 py-3 space-y-1">
      {compacting && <RunCompactingRow compacting={compacting} />}
      {retry && <RunRetryRow retry={retry} />}
      {showDots && (
        <div data-streaming-dots="" className="flex items-center gap-1">
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
      )}
    </div>
  )
}

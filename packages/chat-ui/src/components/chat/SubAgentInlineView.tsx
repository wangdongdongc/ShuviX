import { memo, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { segmentContent } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { markdownComponents } from './markdownComponents'
import { StepBlock } from './StepBlock'
import { ToolCallBlock, ToolCallGroup } from './ToolCallBlock'
import { groupConsecutiveToolCalls } from './stepGrouping'
import { TokenBadge, InvalidTokenBadge } from './InlineTokenBadge'
import type { ChatMessage } from '../../stores/chatStore'
import type { SubSessionState } from '../../stores/subSessionStore'

/**
 * 子智能体内联转写视图 — Agent 经派发工具自行触发的子会话，在对话流的 ToolCallBlock
 * 展开卡片内展示其转写（用户主动触发的子会话仍走右侧 Sub-agent 面板）。
 * 自带限高滚动容器（替代卡片的通用内容区），运行中自动跟随滚动到底部。
 */

/** 轻量用户气泡 — 右对齐 accent 浅底，与右侧面板子会话转写同形 */
function PromptBubble({
  content,
  inlineTokens
}: {
  content: string
  inlineTokens?: Record<string, InlineToken>
}): React.JSX.Element | null {
  if (!content) return null
  const segments = segmentContent(content, inlineTokens)
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg bg-accent/10 text-text-primary text-xs px-2 py-1 whitespace-pre-wrap break-words">
        {segments.map((seg, idx) => {
          if (seg.type === 'text') return <span key={idx}>{seg.text}</span>
          if (seg.type === 'token') return <TokenBadge key={idx} segment={seg} />
          return <InvalidTokenBadge key={idx} segment={seg} />
        })}
      </div>
    </div>
  )
}

/** Markdown 正文（子会话转写用小字号） */
function SubMarkdown({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="markdown-body text-xs">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, rehypeRaw]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

/**
 * 单条子会话消息 — tool_use / step / assistant text / user 追问分发渲染。
 * memo（默认引用比较）：流式期间历史消息引用稳定 → 跳过整段 markdown 逐帧重解析；
 * store 更新某条消息（tool_end 回填等）会替换其对象引用，memo 自动放行。
 */
const SubMessage = memo(function SubMessage({
  msg
}: {
  msg: ChatMessage
}): React.JSX.Element | null {
  if (msg.type === 'tool_use') {
    const meta = msg.metadata
    const status = msg.content ? (meta?.isError ? 'error' : 'done') : 'running'
    return (
      <ToolCallBlock
        toolName={meta?.toolName || ''}
        toolCallId={meta?.toolCallId}
        args={meta?.args}
        result={msg.content || undefined}
        details={meta?.details}
        status={status}
      />
    )
  }
  if (msg.type === 'step_text') return <SubMarkdown content={msg.content} />
  if (msg.type === 'step_thinking') return <StepBlock message={msg} />
  if (msg.role === 'assistant' && msg.type === 'text') return <SubMarkdown content={msg.content} />
  if (msg.role === 'user' && msg.type === 'text') {
    const tokens = (msg.metadata as { inlineTokens?: Record<string, InlineToken> } | null)
      ?.inlineTokens
    return <PromptBubble content={msg.content} inlineTokens={tokens} />
  }
  return null
})

export function SubAgentInlineView({ sub }: { sub: SubSessionState }): React.JSX.Element {
  const { t } = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const msgGroups = useMemo(() => groupConsecutiveToolCalls(sub.messages), [sub.messages])

  // 运行中自动跟随最新输出；结束后不再打扰用户的滚动位置
  useEffect(() => {
    if (sub.status !== 'running') return
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sub.status, sub.messages.length, sub.streamingContent, sub.streamingThinking])

  return (
    <div
      ref={scrollerRef}
      className="max-h-80 overflow-y-auto overscroll-contain thin-scrollbar px-2.5 py-2 space-y-1 text-text-secondary"
    >
      {/* 起始指令（注入上下文 + 派发 prompt） */}
      {sub.contextNote && <PromptBubble content={sub.contextNote} />}
      <PromptBubble content={sub.prompt} inlineTokens={sub.promptInlineTokens} />

      {/* 已提交消息（tool_use + step + assistant text），相邻同名工具调用合并 */}
      {msgGroups.map((g) =>
        g.kind === 'toolGroup' ? (
          <ToolCallGroup key={g.key} toolName={g.toolName} msgs={g.msgs} />
        ) : (
          <SubMessage key={g.msg.id} msg={g.msg} />
        )
      )}

      {/* 流式 thinking */}
      {sub.streamingThinking && (
        <StepBlock
          message={{
            id: `${sub.subSessionId}-streaming-thinking`,
            sessionId: sub.subSessionId,
            role: 'assistant' as const,
            type: 'step_thinking' as const,
            content: sub.streamingThinking,
            metadata: null,
            model: '',
            createdAt: sub.startedAt
          }}
          isGenerating={sub.isStreaming && !sub.streamingContent}
        />
      )}

      {/* 流式 text */}
      {sub.streamingContent && (
        <div className="markdown-body text-xs">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight, rehypeRaw]}
            components={markdownComponents}
          >
            {sub.streamingContent}
          </ReactMarkdown>
          {sub.isStreaming && (
            <span className="inline-block w-2 h-4 ml-0.5 bg-accent/70 animate-pulse rounded-sm" />
          )}
        </div>
      )}

      {/* 生成中/待执行的工具调用 */}
      {sub.streamingToolCall && (
        <ToolCallBlock
          toolName={sub.streamingToolCall.toolName}
          streamingArgsText={sub.streamingToolCall.argsText}
          status="generating"
        />
      )}
      {sub.completedStreamingToolCalls.map((tc, i) => (
        <ToolCallBlock
          key={`completed-${i}`}
          toolName={tc.toolName}
          args={tc.args}
          status="pending"
        />
      ))}

      {/* 结束态无转写消息时以 result 兜底 */}
      {sub.status !== 'running' &&
        sub.messages.length === 0 &&
        !sub.streamingContent &&
        sub.result && (
          <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 whitespace-pre-wrap break-words">
            {sub.result}
          </pre>
        )}

      {/* 空状态兜底 */}
      {sub.messages.length === 0 &&
        !sub.streamingContent &&
        !sub.streamingThinking &&
        !sub.streamingToolCall &&
        sub.status === 'running' && (
          <div className="text-[11px] text-text-tertiary italic">
            {t('panel.subAgentStatusRunning')}…
          </div>
        )}
    </div>
  )
}

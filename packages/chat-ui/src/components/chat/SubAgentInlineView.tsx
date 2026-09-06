import { memo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { segmentContent } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { hasThinkingContent } from '@shuvix/chat-protocol/utils/thinking'
import {
  markdownComponents,
  markdownRemarkPlugins,
  markdownRehypePlugins
} from './markdownComponents'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { StepGroupView } from './StepGroupView'
import { groupConsecutiveSteps } from './stepGrouping'
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

/**
 * 单条子会话消息 —— 与主对话同构：一条 entry 一项，assistant 卡内按 blocks 顺序展开。
 * memo（默认引用比较）：流式期间历史消息引用稳定 → 跳过整段 markdown 逐帧重解析；
 * store 更新某条消息（tool_end 回填等）会替换其对象引用，memo 自动放行。
 */
const SubMessage = memo(function SubMessage({
  msg
}: {
  msg: ChatMessage
}): React.JSX.Element | null {
  if (msg.role === 'user' && msg.type === 'text') {
    const tokens = (msg.metadata as { inlineTokens?: Record<string, InlineToken> } | null)
      ?.inlineTokens
    return <PromptBubble content={msg.content} inlineTokens={tokens} />
  }
  if (msg.type === 'error_event') {
    return <div className="text-[11px] text-error/90 break-words">{msg.content}</div>
  }
  if (msg.role !== 'assistant') return null

  // 相邻步骤合并为一行（与主对话同一套分组）
  return (
    <div className="space-y-1">
      {groupConsecutiveSteps(msg.blocks).map((g) => (
        <StepGroupView key={g.key} group={g} markdownClassName="markdown-body text-xs" />
      ))}
    </div>
  )
})

export function SubAgentInlineView({ sub }: { sub: SubSessionState }): React.JSX.Element {
  const { t } = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)

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

      {/* 已落盘的消息（每条卡内自行按块展开，相邻同名工具调用合并） */}
      {sub.messages.map((m) => (
        <SubMessage key={m.id} msg={m} />
      ))}

      {/* 流式 thinking */}
      {hasThinkingContent(sub.streamingThinking) && (
        <ThinkingBlock
          content={sub.streamingThinking}
          isGenerating={sub.isStreaming && !sub.streamingContent}
        />
      )}

      {/* 流式 text */}
      {sub.streamingContent && (
        <div className="markdown-body text-xs">
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
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

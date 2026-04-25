import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquare,
  Settings,
  X
} from 'lucide-react'
import {
  useSubSessionStore,
  selectSubSessionList,
  type SubSessionState,
  type SubSessionStatus
} from '../../stores/subSessionStore'
import { useChatStore, type ChatMessage } from '../../stores/chatStore'
import { CodeBlock } from '../chat/CodeBlock'
import { ToolCallBlock } from '../chat/ToolCallBlock'
import { StepBlock } from '../chat/StepBlock'

/** 状态图标 */
function StatusIcon({ status }: { status: SubSessionStatus }): React.JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 size={10} className="animate-spin text-accent" />
    case 'done':
      return <Check size={10} className="text-success" />
    case 'error':
      return <X size={10} className="text-error" />
  }
}

/**
 * 提示卡片 — 用于展示子智能体的 system prompt / user prompt。
 * 和下方的 tool call / 助手消息有明显视觉区分（左侧色条 + 灰底）。
 */
function PromptCard({
  icon,
  label,
  content,
  accent,
  defaultExpanded = false
}: {
  icon: React.ReactNode
  label: string
  content: string
  /** Tailwind color class like 'text-amber-500' */
  accent: string
  defaultExpanded?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  if (!content) return <></>
  return (
    <div
      className={`my-1 rounded border border-border-secondary/40 bg-bg-secondary/40 border-l-2 ${accent}`}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary transition-colors"
      >
        {expanded ? (
          <ChevronDown size={10} className="flex-shrink-0 opacity-60" />
        ) : (
          <ChevronRight size={10} className="flex-shrink-0 opacity-60" />
        )}
        <span className={`flex-shrink-0 ${accent}`}>{icon}</span>
        <span className="font-medium">{label}</span>
        {!expanded && (
          <span className="flex-1 truncate text-text-tertiary opacity-70 text-left">
            {content.split('\n')[0]}
          </span>
        )}
      </button>
      {expanded && (
        <pre className="mx-2 mb-2 text-[11px] text-text-secondary whitespace-pre-wrap break-words overflow-auto max-h-[40vh] leading-relaxed">
          {content}
        </pre>
      )}
    </div>
  )
}

/** 单条子会话消息渲染 — 复用主对话框中使用的 ToolCallBlock / StepBlock + 相同的 markdown 规则 */
function SubMessageBubble({ msg }: { msg: ChatMessage }): React.JSX.Element | null {
  if (msg.type === 'tool_use') {
    const meta = msg.metadata
    const toolName = meta?.toolName || ''
    const status = msg.content ? (meta?.isError ? 'error' : 'done') : 'running'
    return (
      <ToolCallBlock
        toolName={toolName}
        toolCallId={meta?.toolCallId}
        args={meta?.args}
        result={msg.content || undefined}
        details={meta?.details}
        status={status}
      />
    )
  }
  if (msg.type === 'step_text') {
    return (
      <div className="markdown-body text-sm">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight, rehypeRaw]}
          components={{ pre: CodeBlock as never }}
        >
          {msg.content}
        </ReactMarkdown>
      </div>
    )
  }
  if (msg.type === 'step_thinking') {
    return <StepBlock message={msg} />
  }
  if (msg.role === 'assistant' && msg.type === 'text') {
    return (
      <div className="markdown-body text-sm">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight, rehypeRaw]}
          components={{ pre: CodeBlock as never }}
        >
          {msg.content}
        </ReactMarkdown>
      </div>
    )
  }
  return null
}

/** 子会话流式内容视图（消息列表 + 当前流式 text/thinking/tool 调用） */
const SubSessionStream = memo(function SubSessionStream({
  sub
}: {
  sub: SubSessionState
}): React.JSX.Element {
  const { t } = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)

  // 新增内容自动滚到底部
  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sub.messages.length, sub.streamingContent, sub.streamingThinking])

  return (
    <div
      ref={scrollerRef}
      className="h-full overflow-y-auto overflow-x-hidden px-3 py-2 space-y-1 text-text-primary"
    >
      {/* 上下文卡片：系统提示词 + 上级 Agent 发送的初始 user 消息 */}
      <PromptCard
        icon={<Settings size={11} />}
        label={t('panel.subAgentSystemPrompt')}
        content={sub.systemPrompt}
        accent="border-l-amber-500 text-amber-500"
      />
      <PromptCard
        icon={<MessageSquare size={11} />}
        label={t('panel.subAgentUserPrompt')}
        content={sub.prompt}
        accent="border-l-accent text-accent"
        defaultExpanded={true}
      />

      {/* 已提交消息（tool_use + assistant text） */}
      {sub.messages.map((m) => (
        <SubMessageBubble key={m.id} msg={m} />
      ))}

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
        <div className="markdown-body text-sm">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight, rehypeRaw]}
            components={{ pre: CodeBlock as never }}
          >
            {sub.streamingContent}
          </ReactMarkdown>
          {sub.isStreaming && (
            <span className="inline-block w-2 h-4 ml-0.5 bg-accent/70 animate-pulse rounded-sm" />
          )}
        </div>
      )}

      {/* 生成中的工具调用 */}
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

      {/* 结束态结果（如果无流式消息且已结束，显示 result 作为 fallback） */}
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
})

/** 子 Tab 栏 + 当前活跃子会话内容 */
export function SubAgentPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const allList = useSubSessionStore(selectSubSessionList)
  const activeId = useSubSessionStore((s) => s.activeSubSessionId)
  const setActive = useSubSessionStore((s) => s.setActive)
  const closeSub = useSubSessionStore((s) => s.close)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  // 只显示当前主会话下的子会话
  const list = useMemo(
    () => (activeSessionId ? allList.filter((s) => s.parentSessionId === activeSessionId) : []),
    [allList, activeSessionId]
  )

  // 当 activeSubSessionId 不在过滤后的列表里（比如切换主会话），自动纠正到本会话的第一个
  useEffect(() => {
    const exists = list.some((s) => s.subSessionId === activeId)
    if (!exists) {
      setActive(list.length > 0 ? list[0].subSessionId : null)
    }
  }, [list, activeId, setActive])

  const active = useMemo(
    () => list.find((s) => s.subSessionId === activeId) ?? null,
    [list, activeId]
  )

  const handleClose = (e: React.MouseEvent, subSessionId: string): void => {
    e.stopPropagation()
    // 通知服务端销毁，再从本地 store 移除
    window.api.subSession?.destroy(subSessionId).catch(() => {})
    closeSub(subSessionId)
  }

  if (list.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-text-tertiary">
        {t('panel.subAgentNone')}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* 子 Tab 栏 */}
      <div className="flex-shrink-0 flex items-center gap-0 overflow-x-auto border-b border-border-secondary/30 bg-bg-primary">
        {list.map((sub) => {
          const isActive = sub.subSessionId === activeId
          return (
            <div
              key={sub.subSessionId}
              onClick={() => setActive(sub.subSessionId)}
              className={`relative flex items-center gap-1.5 pl-2.5 pr-1.5 h-7 text-[11px] cursor-pointer select-none border-r border-border-secondary/30 flex-shrink-0 transition-colors ${
                isActive
                  ? 'text-text-primary bg-bg-secondary/60'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-secondary/30'
              }`}
            >
              <Bot size={11} className="flex-shrink-0" />
              <span className="max-w-[140px] truncate">{sub.displayName}</span>
              <StatusIcon status={sub.status} />
              <button
                onClick={(e) => handleClose(e, sub.subSessionId)}
                className="ml-0.5 p-0.5 rounded hover:bg-current/20 transition-colors"
                title={t('panel.subAgentClose')}
              >
                <X size={10} />
              </button>
              {isActive && (
                <span className="absolute bottom-0 left-1 right-1 h-[2px] bg-accent rounded-t" />
              )}
            </div>
          )
        })}
      </div>

      {/* 活跃子会话的流式内容 */}
      <div className="flex-1 min-h-0">
        {active ? (
          <SubSessionStream sub={active} />
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-text-tertiary">
            {t('panel.subAgentNone')}
          </div>
        )}
      </div>
    </div>
  )
}

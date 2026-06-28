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
  Send,
  Settings,
  X
} from 'lucide-react'
import {
  useSubSessionStore,
  selectSubSessionList,
  getSessionChannelApi,
  type SubSessionState,
  type SubSessionStatus
} from '@shuvix/chat-ui'
import { useChatStore, type ChatMessage } from '@shuvix/chat-ui'
import { CodeBlock } from '@shuvix/chat-ui'
import { ToolCallBlock } from '@shuvix/chat-ui'
import { StepBlock } from '@shuvix/chat-ui'
import { useFocusDim } from '../sidebar/useFocusDim'

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
 * 提示横幅 — 展示子智能体的 system / user 消息。扁平整宽横幅（accent 浅底 + 上下分隔线，
 * 风格同 Files 面板「新建会话」横幅），点击展开/折叠原文。
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
  /** 横幅的 Tailwind 文本+底色类，如 'text-accent bg-accent/5 hover:bg-accent/10' */
  accent: string
  defaultExpanded?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  if (!content) return <></>
  return (
    <div className="border-b border-border-secondary/30">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center gap-1 px-2.5 h-6 text-[10px] font-medium transition-colors ${accent}`}
      >
        <span className="flex-shrink-0 flex items-center">{icon}</span>
        {/* 固定宽度让 System / User 后的摘要起点对齐（须容纳较宽的 "System" 不溢出） */}
        <span className="flex-shrink-0 w-12 whitespace-nowrap">{label}</span>
        {/* 摘要常显（展开时也保留），便于折叠态/展开态都能一眼看到首行 */}
        <span className="flex-1 min-w-0 truncate text-left font-normal text-text-tertiary/70">
          {content.split('\n')[0]}
        </span>
        {expanded ? (
          <ChevronDown size={11} className="flex-shrink-0 opacity-50" />
        ) : (
          <ChevronRight size={11} className="flex-shrink-0 opacity-50" />
        )}
      </button>
      {expanded && (
        <pre className="px-3 py-2 text-[11px] text-text-secondary whitespace-pre-wrap break-words overflow-auto max-h-[40vh] leading-relaxed bg-bg-secondary/30">
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
      <div className="markdown-body text-xs">
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
      <div className="markdown-body text-xs">
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
  // 用户后续追问：右对齐的 accent 浅底气泡，区别于助手输出
  if (msg.role === 'user' && msg.type === 'text') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-accent/10 text-text-primary text-xs px-2 py-1 whitespace-pre-wrap break-words">
          {msg.content}
        </div>
      </div>
    )
  }
  return null
}

/** 子会话流式内容视图（消息列表 + 当前流式 text/thinking/tool 调用） */
const SubSessionStream = memo(function SubSessionStream({
  sub,
  focusLast
}: {
  sub: SubSessionState
  /** 专注模式下进一步聚焦：淡化转写区除最后一块外的所有内容（最新输出常亮，hover 临时点亮其余） */
  focusLast: boolean
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
      className="max-h-[480px] overflow-y-auto overflow-x-hidden no-scrollbar px-3 py-1.5 space-y-1 text-text-secondary"
    >
      {/* 上下文横幅按角色直显 System / User（整宽 accent 浅底横幅，风格同「新建会话」）。
          整体 -mx-3 -mt-2 突破内容区内边距，做到边到边、与消息区平齐。
          focusLast（专注模式）：System/User 同属非最新输出，一并淡化，hover 临时点亮。 */}
      <div
        className={`-mx-3 -mt-2 mb-1 ${
          focusLast ? 'opacity-40 transition-opacity duration-200 hover:opacity-100' : ''
        }`}
      >
        <PromptCard
          icon={<Settings size={10} />}
          label="System"
          content={sub.systemPrompt}
          accent="text-amber-500 bg-amber-500/5 hover:bg-amber-500/10"
        />
        {/* 注入上下文（如笔记本当前内容）+ 用户指令，均默认折叠 */}
        {sub.contextNote && (
          <PromptCard
            icon={<MessageSquare size={10} />}
            label="User"
            content={sub.contextNote}
            accent="text-accent bg-accent/5 hover:bg-accent/10"
          />
        )}
        <PromptCard
          icon={<MessageSquare size={10} />}
          label="User"
          content={sub.prompt}
          accent="text-accent bg-accent/5 hover:bg-accent/10"
        />
      </div>

      {/* 转写区整体再缩小并收紧行距（含共享 ToolCallBlock/StepBlock）：用 zoom 等比缩 + 更小的块间距，
          不改共享组件、不影响主对话框。Chromium（Electron/扩展）均支持 zoom。
          focusLast（专注模式）：直接子块除最后一块外淡化，最新输出常亮，hover 临时点亮其余。 */}
      <div
        className={`space-y-0.5 ${
          focusLast
            ? '[&>*]:opacity-40 [&>*]:transition-opacity [&>*]:duration-200 [&>*:last-child]:opacity-100 [&>*:hover]:opacity-100'
            : ''
        }`}
        style={{ zoom: 0.85 }}
      >
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
          <div className="markdown-body text-xs">
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

      {/* 追问输入框置于转写末尾（随内容滚动，非固定贴底）：仅本轮结束后出现，滚到底即可见 */}
      {sub.status !== 'running' && <SubAgentReplyInput subSessionId={sub.subSessionId} />}
    </div>
  )
})

/**
 * 子代理追问输入框 —— 复用笔记本输入的磨砂风格，但更简：单行、仅一个发送按钮、整体更矮，
 * 输入框与按钮压缩在同一行。发送走 agent.subAgentPrompt（fire-and-forget，复用该子会话 Agent）。
 * 仅在子代理本轮结束后渲染（调用方据 status 控制），故无需在飞态禁用逻辑。
 */
function SubAgentReplyInput({ subSessionId }: { subSessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')

  const send = (): void => {
    const v = text.trim()
    if (!v) return
    setText('')
    void getSessionChannelApi().agent.subAgentPrompt({ subSessionId, text: v })
  }

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border-secondary/40 bg-bg-primary/60 pl-2 pr-0.5">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
        rows={1}
        placeholder={t('panel.subAgentReplyPlaceholder')}
        className="flex-1 resize-none bg-transparent py-1 text-[11px] leading-4 outline-none placeholder:text-text-tertiary/60"
      />
      <button
        onClick={send}
        disabled={!text.trim()}
        className="flex-shrink-0 p-0.5 rounded text-accent hover:bg-bg-hover disabled:text-text-tertiary/40 disabled:hover:bg-transparent transition-colors"
        title={t('panel.subAgentReplySend')}
      >
        <Send size={12} />
      </button>
    </div>
  )
}

/** 子 Tab 栏 + 当前活跃子会话内容 */
export interface SubAgentPanelProps {
  /** 关闭子会话时通知宿主后端销毁运行时（桌面 window.api.subSession.destroy；扩展可省略）。 */
  onDestroySubSession?: (subSessionId: string) => void
}

export function SubAgentPanel({ onDestroySubSession }: SubAgentPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const allList = useSubSessionStore(selectSubSessionList)
  const closeSub = useSubSessionStore((s) => s.close)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // 专注模式：淡化未展开（非聚焦）的子智能体块，聚焦于当前展开的那个；hover 临时点亮
  const { dim } = useFocusDim()

  // 只显示当前主会话下的子会话
  const list = useMemo(
    () => (activeSessionId ? allList.filter((s) => s.parentSessionId === activeSessionId) : []),
    [allList, activeSessionId]
  )

  // 纵向手风琴：每个子会话一节，独立展开/折叠。新出现的子会话独占展开、同时折叠其余（聚焦最新一次任务的
  // 进展）；此后保持用户的开合状态不自动变化；可同时堆叠任意多个子会话（不再受横向 tab 数量限制）。
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const seenRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const newly = list.map((s) => s.subSessionId).filter((id) => !seenRef.current.has(id))
    if (newly.length === 0) return
    newly.forEach((id) => seenRef.current.add(id))
    // 新会话独占展开：折叠其它，仅保留本批新出现的
    setExpandedIds(new Set(newly))
  }, [list])

  const toggle = (id: string): void =>
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const handleClose = (e: React.MouseEvent, subSessionId: string): void => {
    e.stopPropagation()
    // 通知宿主后端销毁，再从本地 store 移除
    onDestroySubSession?.(subSessionId)
    closeSub(subSessionId)
  }

  if (list.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-secondary">
        <Bot size={48} strokeWidth={1.5} className="text-text-tertiary/30" />
      </div>
    )
  }

  return (
    // 外层留白：整组与面板四周留一点间隔；内层卡片：圆角描边浅底，多个智能体块在卡内平铺、
    // 彼此用分隔线相连不留间隔（overflow-hidden 让首尾块继承卡片圆角）
    <div className="h-full overflow-y-auto no-scrollbar p-1.5 bg-bg-secondary">
      <div className="rounded-lg border border-border-secondary/40 bg-bg-primary overflow-hidden">
        {list.map((sub, idx) => {
          const expanded = expandedIds.has(sub.subSessionId)
          return (
            <div
              key={sub.subSessionId}
              className={`transition-opacity duration-200 ${idx > 0 ? 'border-t border-border-secondary/30' : ''} ${
                dim && !expanded ? 'opacity-40 hover:opacity-100' : ''
              }`}
            >
              {/* 折叠头：展开箭头 + 名称 + 状态 + 关闭 */}
              <div
                onClick={() => toggle(sub.subSessionId)}
                className="flex items-center gap-1.5 px-2 h-7 cursor-pointer select-none text-[11px] text-text-secondary hover:bg-bg-secondary/30 transition-colors"
              >
                {expanded ? (
                  <ChevronDown size={13} className="flex-shrink-0 text-text-tertiary" />
                ) : (
                  <ChevronRight size={13} className="flex-shrink-0 text-text-tertiary" />
                )}
                <Bot size={12} className="flex-shrink-0 text-text-tertiary" />
                <span className="flex-1 truncate">{sub.displayName}</span>
                <StatusIcon status={sub.status} />
                <button
                  onClick={(e) => handleClose(e, sub.subSessionId)}
                  className="ml-0.5 p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
                  title={t('panel.subAgentClose')}
                >
                  <X size={11} />
                </button>
              </div>

              {/* 展开内容：该子会话的转写（含末尾追问输入框，随内容滚动） */}
              {expanded && <SubSessionStream sub={sub} focusLast={dim} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

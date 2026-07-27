import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { Bot, Check, ChevronDown, ChevronRight, Send, Settings, Square, X } from 'lucide-react'
import {
  useSubSessionStore,
  selectSubSessionList,
  getSessionChannelApi,
  TokenBadge,
  InvalidTokenBadge,
  type SubSessionState,
  type SubSessionStatus
} from '@shuvix/chat-ui'
import { useChatStore, type ChatMessage } from '@shuvix/chat-ui'
import { markdownComponents } from '@shuvix/chat-ui'
import { ToolCallBlock } from '@shuvix/chat-ui'
import { StepBlock } from '@shuvix/chat-ui'
import { segmentContent, parseSlashCommandInput } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { useFocusDim } from '../sidebar/useFocusDim'

/**
 * 折叠头右侧的单一状态/动作按钮 —— 合并原「状态图标 + 关闭按钮」为一个状态唯一的按钮：
 *   进行中：主 agent 输入框同款的小号中断按钮（实心方块，error 红），点击软停止生成；
 *   已完成/出错：静止显示状态图标（✓ 绿 / ✕ 红），hover 切换为删除 ✕，点击移除该子会话。
 */
function HeaderAction({
  status,
  onInterrupt,
  onDelete
}: {
  status: SubSessionStatus
  onInterrupt: (e: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (status === 'running') {
    return (
      <button
        onClick={onInterrupt}
        className="ml-0.5 p-0.5 rounded bg-error/20 text-error hover:bg-error/30 transition-colors"
        title={t('panel.subAgentInterrupt')}
      >
        <Square size={10} fill="currentColor" />
      </button>
    )
  }
  return (
    <button
      onClick={onDelete}
      className="group/del ml-0.5 p-0.5 rounded hover:bg-bg-hover transition-colors"
      title={t('panel.subAgentClose')}
    >
      {status === 'done' ? (
        <Check size={11} className="text-success group-hover/del:hidden" />
      ) : (
        <X size={11} className="text-error group-hover/del:hidden" />
      )}
      <X size={11} className="hidden text-text-secondary group-hover/del:block" />
    </button>
  )
}

/**
 * 提示元信息行 — 展示子智能体的 system / user 指令。设计为「安静的元信息」而非醒目横幅：
 * 无底色填充、中性微型标签 + 仅靠小号弱化色图标作类别提示，点击展开看全文。
 * 既让用户清晰看到所有指令，又不喧宾夺主（让位给下方转写正文）。
 */
function PromptCard({
  icon,
  label,
  content,
  defaultExpanded = false,
  inlineTokens
}: {
  /** 类别图标（自带弱化色：System 琥珀 / User 蓝，作唯一颜色提示） */
  icon: React.ReactNode
  label: string
  content: string
  defaultExpanded?: boolean
  /** prompt 含内联 Token（slash 命令 / skill）时，按 segmentContent 拆分渲染命令标签 + 文本 */
  inlineTokens?: Record<string, InlineToken>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  if (!content) return <></>
  // 含内联 Token 时整条按 segments 渲染（标签内联）；否则走原纯文本路径
  const segments =
    inlineTokens && Object.keys(inlineTokens).length > 0
      ? segmentContent(content, inlineTokens)
      : null
  const renderSegments = (): React.ReactNode =>
    segments?.map((seg, i) => {
      if (seg.type === 'text') return <span key={i}>{seg.text}</span>
      if (seg.type === 'token') return <TokenBadge key={i} segment={seg} />
      return <InvalidTokenBadge key={i} segment={seg} />
    })
  return (
    <div className="border-b border-border-secondary/20 last:border-b-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="group w-full flex items-center gap-1.5 px-2.5 h-6 text-[10px] transition-colors hover:bg-bg-secondary/40"
      >
        {/* 弱化色小图标——本行唯一的颜色，作 System/User 类别提示 */}
        <span className="flex-shrink-0 flex items-center opacity-70">{icon}</span>
        {/* 中性微型标签（固定宽对齐摘要起点）；不再用醒目 accent 色 */}
        <span className="flex-shrink-0 w-10 whitespace-nowrap text-left uppercase tracking-wider text-[9px] font-medium text-text-tertiary">
          {label}
        </span>
        {/* 摘要常显（展开时也保留），便于折叠态/展开态都能一眼看到首行 */}
        <span className="flex-1 min-w-0 truncate text-left text-text-tertiary/55 group-hover:text-text-tertiary/80 transition-colors">
          {segments ? renderSegments() : content.split('\n')[0]}
        </span>
        {expanded ? (
          <ChevronDown size={11} className="flex-shrink-0 text-text-tertiary/40" />
        ) : (
          <ChevronRight size={11} className="flex-shrink-0 text-text-tertiary/40" />
        )}
      </button>
      {expanded &&
        (segments ? (
          <div className="px-3 py-2 text-[11px] text-text-secondary whitespace-pre-wrap break-words overflow-auto max-h-[40vh] leading-relaxed bg-bg-secondary/30">
            {renderSegments()}
          </div>
        ) : (
          <pre className="px-3 py-2 text-[11px] text-text-secondary whitespace-pre-wrap break-words overflow-auto max-h-[40vh] leading-relaxed bg-bg-secondary/30">
            {content}
          </pre>
        ))}
    </div>
  )
}

/**
 * 用户消息气泡 — 右对齐 accent 浅底圆角，含内联 Token（slash/skill）标签，与主对话框用户气泡同形。
 * 子会话的「起始指令（User）」与「后续追问」共用同一气泡，使子会话转写读起来就是一段对话。
 */
function UserBubble({
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
          components={markdownComponents}
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
          components={markdownComponents}
        >
          {msg.content}
        </ReactMarkdown>
      </div>
    )
  }
  // 用户后续追问：复用 UserBubble（与起始指令同形）
  if (msg.role === 'user' && msg.type === 'text') {
    const tokens = (msg.metadata as { inlineTokens?: Record<string, InlineToken> } | null)
      ?.inlineTokens
    return <UserBubble content={msg.content} inlineTokens={tokens} />
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
      {/* System 指令：安静的元信息行（无底色，仅小号弱化色图标），点击展开看全文。
          -mx-3 -mt-2 边到边、底部细分隔线与转写区隔开。focusLast：非最新输出，淡化、hover 点亮。 */}
      <div
        className={`-mx-3 -mt-2 mb-1.5 border-b border-border-secondary/30 ${
          focusLast ? 'opacity-40 transition-opacity duration-200 hover:opacity-100' : ''
        }`}
      >
        <PromptCard
          icon={<Settings size={10} className="text-amber-500/70" />}
          label="System"
          content={sub.systemPrompt}
        />
      </div>

      {/* 转写区收紧行距（含共享 ToolCallBlock/StepBlock），字号与主对话框一致。
          focusLast（专注模式）：直接子块除最后一块外淡化，最新输出常亮，hover 临时点亮其余。 */}
      <div
        className={`space-y-0.5 ${
          focusLast
            ? '[&>*]:opacity-40 [&>*]:transition-opacity [&>*]:duration-200 [&>*:last-child]:opacity-100 [&>*:hover]:opacity-100'
            : ''
        }`}
      >
        {/* 起始 User 指令（注入上下文 + 用户 prompt）：与下方追问同款用户气泡，使转写读起来就是一段对话 */}
        {sub.contextNote && <UserBubble content={sub.contextNote} />}
        <UserBubble content={sub.prompt} inlineTokens={sub.promptInlineTokens} />

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
              components={markdownComponents}
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
  const slashCommands = useChatStore((s) => s.slashCommands)

  const send = (): void => {
    const v = text.trim()
    if (!v) return
    setText('')

    // 斜杠命令展开（与主输入框共用 parseSlashCommandInput）：识别 /cmd 参数 → 构造内联 Token，
    // 发送含标记的展示文本 + tokens；后端解析为发给子 Agent 的真实指令，面板渲染命令标签。
    const parsed = parseSlashCommandInput(v, slashCommands, { sessionId: subSessionId })

    void getSessionChannelApi().agent.subAgentPrompt({
      subSessionId,
      text: parsed?.contentText ?? v,
      inlineTokens: parsed?.inlineTokens
    })
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
export function SubAgentPanel(): React.JSX.Element {
  const allList = useSubSessionStore(selectSubSessionList)
  const closeSub = useSubSessionStore((s) => s.close)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // 专注模式：淡化未展开（非聚焦）的子智能体块，聚焦于当前展开的那个；hover 临时点亮
  const { dim } = useFocusDim()

  // 只显示当前主会话下「用户主动触发」的子会话；Agent 经派发工具自行触发的（有 parentToolCallId）
  // 内联在对话流的 ToolCallBlock 卡片中展示，不进右侧面板
  const list = useMemo(
    () =>
      activeSessionId
        ? allList.filter((s) => s.parentSessionId === activeSessionId && !s.parentToolCallId)
        : [],
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
    // 经共享 ChatApi 通知后端销毁（基础能力，各端必实现），再从本地 store 移除
    void getSessionChannelApi()
      .agent.subSessionDestroy(subSessionId)
      .catch(() => {})
    closeSub(subSessionId)
  }

  const handleInterrupt = (e: React.MouseEvent, subSessionId: string): void => {
    e.stopPropagation()
    // 经共享 ChatApi 软停止；状态翻转交由后续 sub_session_end 事件驱动（store.markEnded）
    void getSessionChannelApi()
      .agent.subSessionInterrupt(subSessionId)
      .catch(() => {})
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
                <HeaderAction
                  status={sub.status}
                  onInterrupt={(e) => handleInterrupt(e, sub.subSessionId)}
                  onDelete={(e) => handleClose(e, sub.subSessionId)}
                />
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

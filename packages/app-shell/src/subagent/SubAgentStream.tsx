/**
 * 派生 agent 的转写视图 —— 它在界面上唯一的家。
 *
 * 曾经有两份几乎一样的实现：对话流里那张工具卡内联一份（SubAgentInlineView），右侧
 * 子代理面板一份。现在只剩这一份，装在后台任务面板的派生 agent 详情里 —— 对话流里的
 * 工具卡退化成普通形态（参数 + 结果文本），实时状态挂在摘要行尾。
 * 见 docs/background-task-hub-design.md §6。
 */
import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { ChevronDown, ChevronRight, Send, Settings } from 'lucide-react'
import {
  getSessionChannelApi,
  TokenBadge,
  InvalidTokenBadge,
  type SubSessionState
} from '@shuvix/chat-ui'
import { useChatStore, type ChatMessage } from '@shuvix/chat-ui'
import { isImeComposing } from '@shuvix/chat-ui'
import { markdownComponents, markdownRemarkPlugins, markdownRehypePlugins } from '@shuvix/chat-ui'
import { ToolCallBlock } from '@shuvix/chat-ui'
import { ThinkingBlock } from '@shuvix/chat-ui'
import { segmentContent, parseSlashCommandInput } from '@shuvix/chat-protocol/utils/inlineTokens'
import { hasThinkingContent } from '@shuvix/chat-protocol/utils/thinking'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'

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

/** 单条子会话消息渲染 —— 一条 entry 一项；assistant 卡内按 blocks 顺序展开 */
function SubMessageBubble({ msg }: { msg: ChatMessage }): React.JSX.Element | null {
  // 用户后续追问：复用 UserBubble（与起始指令同形）
  if (msg.role === 'user' && msg.type === 'text') {
    const tokens = (msg.metadata as { inlineTokens?: Record<string, InlineToken> } | null)
      ?.inlineTokens
    return <UserBubble content={msg.content} inlineTokens={tokens} />
  }
  if (msg.type === 'error_event') {
    return <div className="text-[11px] text-error/90 break-words">{msg.content}</div>
  }
  if (msg.role !== 'assistant') return null

  return (
    <div className="space-y-1">
      {msg.blocks.map((block, idx) => {
        if (block.type === 'thinking') {
          return <ThinkingBlock key={idx} content={block.text} />
        }
        if (block.type === 'text') {
          return (
            <div key={idx} className="markdown-body text-xs">
              <ReactMarkdown
                remarkPlugins={markdownRemarkPlugins}
                rehypePlugins={markdownRehypePlugins}
                components={markdownComponents}
              >
                {block.text}
              </ReactMarkdown>
            </div>
          )
        }
        return (
          <ToolCallBlock
            key={block.toolCallId || idx}
            toolName={block.toolName}
            toolCallId={block.toolCallId}
            args={block.args}
            result={block.result}
            details={block.details}
            status={block.result === undefined ? 'running' : block.isError ? 'error' : 'done'}
          />
        )
      })}
    </div>
  )
}

/** 子会话流式内容视图（消息列表 + 当前流式 text/thinking/tool 调用） */
export const SubSessionStream = memo(function SubSessionStream({
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

      {/* 转写区收紧行距（含共享 ToolCallBlock/ThinkingBlock），字号与主对话框一致。
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

        {/* 已落盘的消息（每条卡内自行按块展开） */}
        {sub.messages.map((m) => (
          <SubMessageBubble key={m.id} msg={m} />
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
            /* 实心 tertiary（不带 alpha）：会话面板内 bg-primary/secondary 被对调，
               半透明 tertiary 叠在卡片上差值会腰斩到 ~5/255 */
            <pre className="text-[11px] text-text-secondary bg-bg-tertiary rounded px-2 py-1 whitespace-pre-wrap break-words">
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
          // 输入法组字中的回车是「确认选词」，不能当成发送
          if (isImeComposing(e)) return
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

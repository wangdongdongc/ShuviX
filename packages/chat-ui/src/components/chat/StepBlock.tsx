import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquareText, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { StepRow } from './StepRow'
import { markdownComponents } from './markdownComponents'
import type { StepTextMessage, StepThinkingMessage, SteerMessage } from '../../stores/chatStore'

interface StepBlockProps {
  message: StepTextMessage | StepThinkingMessage | SteerMessage
  /** 是否正在流式生成中 */
  isGenerating?: boolean
}

/**
 * 中间步骤块 — 默认折叠，点击展开/折叠。
 * 思考走独立的「中间文本」形态（无图标无标签，原地展开）；其余步骤走 StepRow 单行摘要。
 */
export function StepBlock({ message, isGenerating }: StepBlockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const isThinking = message.type === 'step_thinking'
  const isSteer = message.type === 'steer'

  if (isThinking) {
    return <ThinkingText content={message.content} isGenerating={isGenerating} />
  }

  // 首行预览
  const firstLine = message.content.split('\n')[0] || ''
  const preview = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine

  const icon = (
    <MessageSquareText
      size={12}
      className={`flex-shrink-0 ${isSteer ? 'text-warning' : 'text-text-tertiary'}`}
    />
  )

  return (
    <div className="my-0.5">
      <StepRow
        expandable
        onClick={() => setExpanded(!expanded)}
        lead={
          isGenerating ? (
            <Loader2 size={10} className="animate-spin text-text-tertiary" />
          ) : undefined
        }
        icon={icon}
        label={isSteer ? t('toolCall.steerMessage') : t('toolCall.stepText')}
        detail={preview ? <span className="font-mono">{preview}</span> : undefined}
      />

      {expanded && (
        <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50">
          <div className="text-[12px] text-text-secondary prose prose-sm prose-invert max-w-none overflow-auto overscroll-contain thin-scrollbar max-h-80">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={markdownComponents}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 思考 — 一段特殊的中间文本，不是「行」：无图标、无标签、无边框。
 * 折叠时收成两行，点击原地撑开同一段文字（不另起一块，避免开头重复出现两遍）。
 */
function ThinkingText({
  content,
  isGenerating
}: {
  content: string
  isGenerating?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const viewRef = useRef<HTMLDivElement>(null)

  // 生成中始终贴着最新内容：折叠态是两行高的跑马灯窗口，展开态跟随滚到底
  useEffect(() => {
    if (!isGenerating) return
    const el = viewRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [isGenerating, expanded, content])

  // 折叠态压平换行按一段连续文字滚动；展开态保留原始换行按段落读
  const flat = content.replace(/\s*\n+\s*/g, ' ').trim()

  const caret = isGenerating ? (
    <span className="inline-block w-1.5 h-3 ml-1 align-[-1px] bg-accent/60 animate-pulse rounded-sm" />
  ) : null

  return (
    <button
      type="button"
      // 展开后是大段可读文本，选中文字时不该顺手折叠掉
      onClick={() => {
        if (window.getSelection()?.toString()) return
        setExpanded(!expanded)
      }}
      className="w-full my-1 px-1 py-1 rounded-md text-left font-serif text-[13.5px] leading-relaxed text-text-tertiary select-text cursor-pointer transition-colors hover:text-text-secondary hover:bg-bg-tertiary/40"
    >
      {expanded ? (
        <div ref={viewRef} className="whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
          {content}
          {caret}
        </div>
      ) : isGenerating ? (
        /* 两行高的定高窗口 + 程序化滚到底：clamp 只会卡在开头，看不出模型在想什么 */
        <div ref={viewRef} className="h-[3.25em] overflow-hidden break-words">
          {flat}
          {caret}
        </div>
      ) : (
        <div className="line-clamp-2 break-words">{flat}</div>
      )}
    </button>
  )
}

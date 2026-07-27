import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { ChevronRight } from 'lucide-react'
import { markdownComponents } from './markdownComponents'

interface SystemNoticeCardProps {
  /** 左侧图标 */
  icon: ReactNode
  /** 标题文本 */
  title: string
  /** 折叠状态下的预览（默认取首个非空行前 80 字） */
  preview?: string
  /** 展开后渲染的 Markdown 正文 */
  content: string
  /** 默认展开状态 */
  defaultExpanded?: boolean
}

/**
 * 系统通知卡片 — 居中通栏样式，用于压缩摘要、项目指令注入等"非对话"消息
 * 默认折叠，点击展开 Markdown 正文
 */
export function SystemNoticeCard({
  icon,
  title,
  preview,
  content,
  defaultExpanded = false
}: SystemNoticeCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const previewText =
    preview ??
    content
      .split('\n')
      .find((l) => l.trim())
      ?.slice(0, 80)

  return (
    <div className="rounded-lg border border-border-secondary/60 bg-bg-secondary/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover/40 transition-colors"
      >
        <span className="flex-shrink-0 text-accent/70">{icon}</span>
        <ChevronRight
          size={14}
          className={`flex-shrink-0 text-text-tertiary transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="text-xs font-medium text-text-secondary truncate">{title}</span>
        {!expanded && previewText && (
          <span className="text-xs text-text-tertiary truncate ml-1">{previewText}...</span>
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-border-secondary/40">
          <div className="markdown-body text-sm pt-2">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight, rehypeRaw]}
              components={markdownComponents}
            >
              {content}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}

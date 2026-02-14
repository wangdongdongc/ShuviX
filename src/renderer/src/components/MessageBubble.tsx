import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { User, Bot, Copy, Check } from 'lucide-react'
import { useState } from 'react'

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system'
  content: string
  isStreaming?: boolean
}

/**
 * 消息气泡 — 渲染用户和助手消息
 * 助手消息使用 Markdown 渲染，支持代码高亮
 */
export const MessageBubble = memo(function MessageBubble({
  role,
  content,
  isStreaming
}: MessageBubbleProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const isUser = role === 'user'

  /** 复制消息内容 */
  const handleCopy = (): void => {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={`group flex gap-3 px-4 py-3 ${isUser ? '' : 'bg-bg-secondary/30'}`}>
      {/* 头像 */}
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5 ${
          isUser
            ? 'bg-accent/20 text-accent'
            : 'bg-bg-tertiary text-text-secondary'
        }`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>

      {/* 消息内容 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-text-secondary">
            {isUser ? '你' : 'ShiroBot'}
          </span>
          {/* 复制按钮 */}
          {!isStreaming && content && (
            <button
              onClick={handleCopy}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title="复制"
            >
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            </button>
          )}
        </div>

        {isUser ? (
          /* 用户消息：纯文本 */
          <div className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
            {content}
          </div>
        ) : (
          /* 助手消息：Markdown 渲染 */
          <div className="markdown-body text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight, rehypeRaw]}>
              {content}
            </ReactMarkdown>
            {/* 流式输出光标 */}
            {isStreaming && (
              <span className="inline-block w-2 h-4 ml-0.5 bg-accent/70 animate-pulse rounded-sm" />
            )}
          </div>
        )}
      </div>
    </div>
  )
})

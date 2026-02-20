import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { User, Bot, Copy, Check, Code, FileText } from 'lucide-react'
import { useState } from 'react'

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  metadata?: string | null
  isStreaming?: boolean
}

/**
 * 消息气泡 — 渲染用户和助手消息
 * 助手消息使用 Markdown 渲染，支持代码高亮
 */
export const MessageBubble = memo(function MessageBubble({
  role,
  content,
  metadata,
  isStreaming
}: MessageBubbleProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  const isUser = role === 'user'

  // 从 metadata 解析思考过程
  const thinking = (() => {
    if (!metadata) return null
    try {
      const parsed = JSON.parse(metadata)
      return parsed.thinking || null
    } catch { return null }
  })()

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
          {/* 切换原始文本 / Markdown 渲染 */}
          {!isUser && !isStreaming && content && (
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={showRaw ? '显示渲染' : '显示源码'}
            >
              {showRaw ? <FileText size={12} /> : <Code size={12} />}
            </button>
          )}
        </div>

        {isUser ? (
          /* 用户消息：文本 + 图片 */
          <div>
            {/* 图片展示 */}
            {(() => {
              if (!metadata) return null
              try {
                const parsed = JSON.parse(metadata)
                if (!parsed.images?.length) return null
                return (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {parsed.images.map((img: { preview: string; mimeType: string }, idx: number) => (
                      <img
                        key={idx}
                        src={img.preview}
                        alt={`附图 ${idx + 1}`}
                        className="max-w-[240px] max-h-[180px] rounded-lg border border-border-primary object-contain cursor-pointer hover:opacity-90 transition-opacity"
                        onClick={() => window.api.app.openImage(img.preview)}
                      />
                    ))}
                  </div>
                )
              } catch { return null }
            })()}
            <div className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
              {content}
            </div>
          </div>
        ) : (
          <>
            {/* 思考过程（可折叠） */}
            {thinking && (
              <details className="group mb-2">
                <summary className="cursor-pointer select-none text-xs text-text-tertiary hover:text-text-secondary flex items-center gap-1.5 py-1">
                  <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  <span>已深度思考</span>
                </summary>
                <div className="mt-1 ml-4.5 pl-3 border-l-2 border-purple-500/30 text-xs text-text-tertiary leading-relaxed whitespace-pre-wrap max-h-[300px] overflow-y-auto">
                  {thinking}
                </div>
              </details>
            )}
            {/* 助手消息：Markdown 渲染 / 原始文本 */}
            {showRaw ? (
              <pre className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed font-mono bg-bg-tertiary/50 rounded-lg p-3 border border-border-primary overflow-auto">
                {content}
              </pre>
            ) : (
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
          </>
        )}
      </div>
    </div>
  )
})

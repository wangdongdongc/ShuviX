import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { User, Copy, Check, Code, FileText, RotateCcw, RefreshCw } from 'lucide-react'
import assistantAvatar from '../../assets/ngnl_xiubi_color_mini.jpg'
import { CodeBlock } from './CodeBlock'

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  metadata?: string | null
  isStreaming?: boolean
  /** 流式阶段的思考内容（实时更新） */
  streamingThinking?: string | null
  /** 流式阶段的生成图片（实时更新） */
  streamingImages?: Array<{ data: string; mimeType: string }>
  /** 生成该消息的模型名称 */
  model?: string
  /** 回退到此消息（删除之后的所有消息） */
  onRollback?: () => void
  /** 重新生成此消息（仅助手消息） */
  onRegenerate?: () => void
}

/**
 * 消息气泡 — 渲染用户和助手消息
 * 助手消息使用 Markdown 渲染，支持代码高亮
 */
export const MessageBubble = memo(function MessageBubble({
  role,
  content,
  metadata,
  isStreaming,
  streamingThinking,
  streamingImages,
  model,
  onRollback,
  onRegenerate
}: MessageBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  const isUser = role === 'user'

  // 从 metadata 解析思考过程和 token 用量
  const parsedMeta = (() => {
    if (!metadata) return null
    try {
      return JSON.parse(metadata)
    } catch {
      return null
    }
  })()
  // 流式阶段优先使用实时 thinking，完成后从 metadata 读取
  const thinking = streamingThinking || parsedMeta?.thinking || null
  const usage = parsedMeta?.usage as
    | {
        input: number
        output: number
        total: number
        details?: Array<{ input: number; output: number; total: number; stopReason: string }>
      }
    | undefined

  /** 复制消息内容 */
  const handleCopy = (): void => {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={`group flex gap-3 px-4 py-3 ${isUser ? '' : 'bg-bg-secondary/30'}`}>
      {/* 头像 */}
      {isUser ? (
        <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5 bg-accent/20 text-accent">
          <User size={14} />
        </div>
      ) : (
        <div className="flex-shrink-0 w-7 h-7 rounded-lg overflow-hidden mt-0.5">
          <img src={assistantAvatar} alt="assistant" className="w-full h-full object-cover" />
        </div>
      )}

      {/* 消息内容 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-text-secondary">
            {isUser ? t('message.you') : model || 'Assistant'}
          </span>
          {/* 复制按钮 */}
          {!isStreaming && content && (
            <button
              onClick={handleCopy}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={t('message.copy')}
            >
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            </button>
          )}
          {/* 切换原始文本 / Markdown 渲染 */}
          {!isUser && !isStreaming && content && (
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={showRaw ? t('message.showRendered') : t('message.showSource')}
            >
              {showRaw ? <FileText size={12} /> : <Code size={12} />}
            </button>
          )}
          {/* 回退到此处 */}
          {!isStreaming && onRollback && (
            <button
              onClick={onRollback}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={t('message.rollback')}
            >
              <RotateCcw size={12} />
            </button>
          )}
          {/* 重新生成 */}
          {!isUser && !isStreaming && onRegenerate && (
            <button
              onClick={onRegenerate}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={t('message.regenerate')}
            >
              <RefreshCw size={12} />
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
                    {parsed.images.map(
                      (img: { preview: string; mimeType: string }, idx: number) => (
                        <img
                          key={idx}
                          src={img.preview}
                          alt={t('message.attachment', { index: idx + 1 })}
                          className="max-w-[240px] max-h-[180px] rounded-lg border border-border-primary object-contain cursor-pointer hover:opacity-90 transition-opacity"
                          onClick={() => window.api.app.openImage(img.preview)}
                        />
                      )
                    )}
                  </div>
                )
              } catch {
                return null
              }
            })()}
            <div className="text-sm text-text-primary whitespace-pre-wrap break-all leading-relaxed">
              {content}
            </div>
          </div>
        ) : (
          <>
            {/* 思考过程（可折叠，流式时默认展开并显示动画） */}
            {thinking && (
              <details open={!!streamingThinking} className="group mb-2">
                <summary className="cursor-pointer select-none text-xs text-text-tertiary hover:text-text-secondary flex items-center gap-1.5 py-1">
                  <svg
                    className="w-3 h-3 transition-transform group-open:rotate-90"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  <span className={streamingThinking ? 'animate-pulse' : ''}>
                    {t('message.deepThought')}
                  </span>
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
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight, rehypeRaw]}
                  components={{
                    pre: CodeBlock as never
                  }}
                >
                  {content}
                </ReactMarkdown>
                {/* 流式输出光标 */}
                {isStreaming && (
                  <span className="inline-block w-2 h-4 ml-0.5 bg-accent/70 animate-pulse rounded-sm" />
                )}
              </div>
            )}
            {/* 助手生成的图片（持久化：从 metadata.images 加载） */}
            {!isStreaming && parsedMeta?.images?.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {parsedMeta.images.map((img: { data: string; mimeType: string }, idx: number) => (
                  <img
                    key={idx}
                    src={img.data}
                    alt={t('message.generatedImage', {
                      index: idx + 1,
                      defaultValue: `Generated image ${idx + 1}`
                    })}
                    className="max-w-[400px] max-h-[400px] rounded-lg border border-border-primary object-contain cursor-pointer hover:opacity-90 transition-opacity"
                    onClick={() => window.api.app.openImage(img.data)}
                  />
                ))}
              </div>
            )}
            {/* 流式阶段的生成图片（实时推送） */}
            {isStreaming && streamingImages && streamingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {streamingImages.map((img, idx) => (
                  <img
                    key={idx}
                    src={img.data}
                    alt={t('message.generatedImage', {
                      index: idx + 1,
                      defaultValue: `Generated image ${idx + 1}`
                    })}
                    className="max-w-[400px] max-h-[400px] rounded-lg border border-border-primary object-contain"
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* token 用量（助手消息底部） */}
        {!isUser && usage && !isStreaming && (
          <div className="mt-1.5 text-[10px] text-text-tertiary">
            {usage.details && usage.details.length > 1 ? (
              <details>
                <summary className="cursor-pointer select-none hover:text-text-secondary">
                  tokens: {usage.input} in / {usage.output} out
                  {usage.total ? ` · ${usage.total} total` : ''}
                  {` · ${usage.details.length} 次调用`}
                </summary>
                <div className="mt-1 ml-2 space-y-0.5">
                  {usage.details.map((d, i) => (
                    <div key={i}>
                      #{i + 1} {d.input} in / {d.output} out
                      {d.total ? ` · ${d.total}` : ''}
                      {d.stopReason ? ` (${d.stopReason})` : ''}
                    </div>
                  ))}
                </div>
              </details>
            ) : (
              <span>
                tokens: {usage.input} in / {usage.output} out
                {usage.total ? ` · ${usage.total} total` : ''}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

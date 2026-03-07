import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { Copy, Check, Code, FileText, RefreshCw } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import assistantAvatar from '../../assets/ngnl_xiubi_color_mini.jpg'
import { CodeBlock } from './CodeBlock'
import { StepBlock } from './StepBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { SubAgentBlock } from './SubAgentBlock'
import type { AssistantTextMessage } from '../../stores/chatStore'
import type { StepItem } from './types'

interface AssistantBubbleProps {
  msg: AssistantTextMessage
  steps?: StepItem[]
  isStreaming?: boolean
  /** 流式阶段的思考内容（实时更新） */
  streamingThinking?: string | null
  /** 流式阶段的生成图片（实时更新） */
  streamingImages?: Array<{ data: string; mimeType: string }>
  /** 重新生成此消息 */
  onRegenerate?: () => void
}

/**
 * 助手消息气泡 — Markdown 渲染、步骤、思考、图片、用量
 */
export const AssistantBubble = memo(function AssistantBubble({
  msg,
  steps,
  isStreaming,
  streamingThinking,
  streamingImages,
  onRegenerate
}: AssistantBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  const thinking = streamingThinking || msg.metadata?.thinking || null
  const usage = msg.metadata?.usage

  const handleCopy = (): void => {
    copyToClipboard(msg.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="group flex gap-3 px-4 py-3 bg-bg-secondary/30">
      {/* 头像 */}
      <div className="flex-shrink-0 w-7 h-7 rounded-lg overflow-hidden mt-0.5">
        <img src={assistantAvatar} alt="assistant" className="w-full h-full object-cover" />
      </div>

      {/* 内容 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-text-secondary">
            {msg.model || 'Assistant'}
          </span>
          {/* 复制 */}
          {!isStreaming && msg.content && (
            <button
              onClick={handleCopy}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={t('message.copy')}
            >
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            </button>
          )}
          {/* 原始/渲染 切换 */}
          {!isStreaming && msg.content && (
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={showRaw ? t('message.showRendered') : t('message.showSource')}
            >
              {showRaw ? <FileText size={12} /> : <Code size={12} />}
            </button>
          )}
          {/* 重新生成 */}
          {!isStreaming && onRegenerate && (
            <button
              onClick={onRegenerate}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={t('message.regenerate')}
            >
              <RefreshCw size={12} />
            </button>
          )}
        </div>

        {/* 步骤 */}
        {steps && steps.length > 0 && (
          <div className="mb-2 space-y-0.5">
            {steps.map((step) => {
              if (step.msg.type === 'step_text') {
                return (
                  <div key={step.msg.id} className="markdown-body text-sm">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight, rehypeRaw]}
                      components={{ pre: CodeBlock as never }}
                    >
                      {step.msg.content}
                    </ReactMarkdown>
                  </div>
                )
              }
              if (step.msg.type === 'step_thinking') {
                return <StepBlock key={step.msg.id} message={step.msg} />
              }
              if (step.msg.type === 'tool_use') {
                const meta = step.msg.metadata
                const toolName = meta?.toolName || ''
                const status = step.msg.content ? (meta?.isError ? 'error' : 'done') : 'running'
                if (toolName === 'explore') {
                  return (
                    <SubAgentBlock
                      key={step.msg.id}
                      toolCallId={meta?.toolCallId}
                      args={meta?.args}
                      result={step.msg.content || undefined}
                      status={status}
                    />
                  )
                }
                return (
                  <ToolCallBlock
                    key={step.msg.id}
                    toolName={toolName}
                    toolCallId={meta?.toolCallId}
                    args={meta?.args}
                    result={step.msg.content || undefined}
                    details={meta?.details}
                    status={status}
                  />
                )
              }
              return null
            })}
          </div>
        )}

        {/* 思考过程 */}
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

        {/* Markdown / 原始文本 */}
        {showRaw ? (
          <pre className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed font-mono bg-bg-tertiary/50 rounded-lg p-3 border border-border-primary overflow-auto">
            {msg.content}
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
              {msg.content}
            </ReactMarkdown>
            {isStreaming && (
              <span className="inline-block w-2 h-4 ml-0.5 bg-accent/70 animate-pulse rounded-sm" />
            )}
          </div>
        )}

        {/* 持久化图片 */}
        {!isStreaming && (msg.metadata?.images?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {msg.metadata!.images!.map((img, idx) => (
              <img
                key={idx}
                src={img.data || ''}
                alt={t('message.generatedImage', {
                  index: idx + 1,
                  defaultValue: `Generated image ${idx + 1}`
                })}
                className="max-w-[400px] max-h-[400px] rounded-lg border border-border-primary object-contain"
              />
            ))}
          </div>
        )}
        {/* 流式图片 */}
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

        {/* token 用量 */}
        {usage && !isStreaming && (
          <div className="mt-1.5 text-[10px] text-text-tertiary">
            {usage.details && usage.details.length > 1 ? (
              <details>
                <summary className="cursor-pointer select-none hover:text-text-secondary">
                  tokens: {usage.input} in / {usage.output} out
                  {usage.total ? ` · ${usage.total} total` : ''}
                  {usage.cacheRead ? ` · ${usage.cacheRead} ${t('message.cacheRead')}` : ''}
                  {usage.cacheWrite ? ` · ${usage.cacheWrite} ${t('message.cacheWrite')}` : ''}
                  {` · ${usage.details.length} ${t('message.nCalls')}`}
                </summary>
                <div className="mt-1 ml-2 space-y-0.5">
                  {usage.details.map((d, i) => (
                    <div key={i}>
                      #{i + 1} {d.input} in / {d.output} out
                      {d.total ? ` · ${d.total}` : ''}
                      {d.cacheRead ? ` · ${d.cacheRead} ${t('message.cacheRead')}` : ''}
                      {d.cacheWrite ? ` · ${d.cacheWrite} ${t('message.cacheWrite')}` : ''}
                      {d.stopReason ? ` (${d.stopReason})` : ''}
                    </div>
                  ))}
                </div>
              </details>
            ) : (
              <span>
                tokens: {usage.input} in / {usage.output} out
                {usage.total ? ` · ${usage.total} total` : ''}
                {usage.cacheRead ? ` · ${usage.cacheRead} ${t('message.cacheRead')}` : ''}
                {usage.cacheWrite ? ` · ${usage.cacheWrite} ${t('message.cacheWrite')}` : ''}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

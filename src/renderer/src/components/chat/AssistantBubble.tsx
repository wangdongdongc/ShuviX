import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import {
  Copy,
  Check,
  Code,
  FileText,
  RefreshCw,
  Volume2,
  Square,
  Loader2,
  Archive,
  ChevronRight
} from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import assistantAvatar from '../../assets/ngnl_xiubi_color_mini.jpg'
import { CodeBlock } from './CodeBlock'
import { StepBlock } from './StepBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { SubAgentBlock } from './SubAgentBlock'
import {
  useChatStore,
  selectStreamingContent,
  selectStreamingThinking,
  selectStreamingImages,
  selectStreamingToolCall,
  selectCompletedStreamingToolCalls,
  type AssistantTextMessage
} from '../../stores/chatStore'
import { useTtsPlayback } from '../../hooks/useTtsPlayback'
import type { StepItem } from './types'

/** 检查某 toolCallId 在当前活跃会话中是否有关联的子智能体执行 */
function hasSubAgentExecution(toolCallId?: string): boolean {
  if (!toolCallId) return false
  const s = useChatStore.getState()
  if (!s.activeSessionId) return false
  const execs = s.sessionSubAgentExecutions[s.activeSessionId]
  return execs?.some((sa) => sa.parentToolCallId === toolCallId) ?? false
}

interface AssistantBubbleProps {
  msg: AssistantTextMessage
  steps?: StepItem[]
  isStreaming?: boolean
  /** 重新生成此消息 */
  onRegenerate?: () => void
}

/**
 * 助手消息气泡 — Markdown 渲染、步骤、思考、图片、用量
 * 流式模式下自行从 store 读取 streaming 状态，无需外部传入
 */
export const AssistantBubble = memo(function AssistantBubble({
  msg,
  steps,
  isStreaming,
  onRegenerate
}: AssistantBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const isCompactionSummary = !!msg.metadata?.isCompactionSummary
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const { isPlaying, isLoading, playingMessageId, speak, stop } = useTtsPlayback()
  const isThisPlaying = isPlaying && playingMessageId === msg.id
  const isThisLoading = isLoading && playingMessageId === msg.id

  // 流式模式下从 store 直接读取状态
  const storeStreamingContent = useChatStore(selectStreamingContent)
  const storeStreamingThinking = useChatStore(selectStreamingThinking)
  const storeStreamingImages = useChatStore(selectStreamingImages)
  const streamingToolCall = useChatStore(selectStreamingToolCall)
  const completedStreamingToolCalls = useChatStore(selectCompletedStreamingToolCalls)

  const displayContent = isStreaming ? storeStreamingContent : msg.content
  const thinking = (isStreaming ? storeStreamingThinking : null) || msg.metadata?.thinking || null
  const liveImages = isStreaming ? storeStreamingImages : []
  const usage = msg.metadata?.usage

  const handleCopy = (): void => {
    copyToClipboard(displayContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="group relative flex gap-3 pl-10 pr-4 py-3">
      {/* 时间线 */}
      <div className="absolute left-[1.35rem] top-0 bottom-0 w-px bg-border-secondary/40" />
      {/* 头像节点 */}
      <div className="absolute left-2.5 top-3 flex-shrink-0 w-5 h-5 rounded-full overflow-hidden ring-2 ring-bg-primary z-10">
        <img src={assistantAvatar} alt="assistant" className="w-full h-full object-cover" />
      </div>

      {/* 内容 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-text-secondary">
            {msg.model || 'Assistant'}
          </span>
          {/* 复制 */}
          {!isStreaming && displayContent && (
            <button
              onClick={handleCopy}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={t('message.copy')}
            >
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            </button>
          )}
          {/* TTS 朗读 */}
          {!isStreaming && displayContent && (
            <button
              onClick={() =>
                isThisPlaying || isThisLoading
                  ? stop()
                  : speak(displayContent.slice(0, 4000), msg.id)
              }
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={isThisPlaying || isThisLoading ? t('message.stopTts') : t('message.playTts')}
            >
              {isThisLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : isThisPlaying ? (
                <Square size={12} />
              ) : (
                <Volume2 size={12} />
              )}
            </button>
          )}
          {/* 原始/渲染 切换（压缩摘要不显示） */}
          {!isStreaming && displayContent && !isCompactionSummary && (
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={showRaw ? t('message.showRendered') : t('message.showSource')}
            >
              {showRaw ? <FileText size={12} /> : <Code size={12} />}
            </button>
          )}
          {/* 重新生成（压缩摘要不显示） */}
          {!isStreaming && onRegenerate && !isCompactionSummary && (
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
          <div className="mb-0.5 space-y-0.5">
            {steps.map((step) => {
              if (step.msg.type === 'steer') {
                return <StepBlock key={step.msg.id} message={step.msg} />
              }
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
                // 子智能体路由：优先看 details.type（持久化），回退到 subAgentExecutions（流式）
                const detailsType = meta?.details?.type
                const isSubAgent =
                  detailsType === 'sub-agent' ||
                  (!detailsType && hasSubAgentExecution(meta?.toolCallId))
                if (isSubAgent) {
                  return (
                    <SubAgentBlock
                      key={step.msg.id}
                      toolCallId={meta?.toolCallId}
                      toolName={toolName}
                      args={meta?.args}
                      result={step.msg.content || undefined}
                      status={status}
                      details={meta?.details}
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

        {/* 思考过程 — 统一使用 StepBlock，默认折叠 */}
        {thinking && (
          <StepBlock
            message={{
              id: 'streaming-thinking',
              sessionId: msg.sessionId,
              role: 'assistant' as const,
              type: 'step_thinking' as const,
              content: thinking,
              metadata: null,
              model: msg.model,
              createdAt: msg.createdAt
            }}
            isGenerating={
              isStreaming && !!storeStreamingThinking && !displayContent && !streamingToolCall
            }
          />
        )}

        {/* Markdown / 原始文本 */}
        {displayContent &&
          (isCompactionSummary ? (
            /* ── 压缩摘要：默认折叠，点击展开 ── */
            <div className="rounded-lg border border-border-secondary/60 bg-bg-secondary/30 overflow-hidden">
              <button
                onClick={() => setSummaryExpanded(!summaryExpanded)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover/40 transition-colors"
              >
                <Archive size={14} className="flex-shrink-0 text-accent/70" />
                <ChevronRight
                  size={14}
                  className={`flex-shrink-0 text-text-tertiary transition-transform duration-200 ${summaryExpanded ? 'rotate-90' : ''}`}
                />
                <span className="text-xs font-medium text-text-secondary truncate">
                  {t('compact.summaryLabel')}
                </span>
                {!summaryExpanded && (
                  <span className="text-xs text-text-tertiary truncate ml-1">
                    {displayContent
                      .split('\n')
                      .find((l) => l.trim())
                      ?.slice(0, 80)}
                    ...
                  </span>
                )}
              </button>
              {summaryExpanded && (
                <div className="px-3 pb-3 border-t border-border-secondary/40">
                  <div className="markdown-body text-sm pt-2">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight, rehypeRaw]}
                      components={{ pre: CodeBlock as never }}
                    >
                      {displayContent}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          ) : showRaw ? (
            <pre className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed font-mono bg-bg-tertiary/50 rounded-lg p-3 border border-border-primary overflow-auto">
              {displayContent}
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
                {displayContent}
              </ReactMarkdown>
              {isStreaming && displayContent && !streamingToolCall && (
                <span className="inline-block w-2 h-4 ml-0.5 bg-accent/70 animate-pulse rounded-sm" />
              )}
            </div>
          ))}

        {/* 已完成生成的工具调用（等待执行） */}
        {isStreaming &&
          completedStreamingToolCalls.map((tc, i) => (
            <ToolCallBlock
              key={`completed-tc-${i}`}
              toolName={tc.toolName}
              args={tc.args}
              status="pending"
            />
          ))}

        {/* 当前正在生成的工具调用 */}
        {isStreaming && streamingToolCall && (
          <ToolCallBlock
            toolName={streamingToolCall.toolName}
            streamingArgsText={streamingToolCall.argsText}
            status="generating"
          />
        )}

        {/* 图片（流式用 store，非流式用持久化 metadata） */}
        {(() => {
          const images = isStreaming ? liveImages : msg.metadata?.images
          if (!images || images.length === 0) return null
          return (
            <div className="flex flex-wrap gap-2 mt-2">
              {images.map((img, idx) => (
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
          )
        })()}

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

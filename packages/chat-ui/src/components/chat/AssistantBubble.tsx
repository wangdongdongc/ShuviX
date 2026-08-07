import { memo, useMemo, useState } from 'react'
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
  Archive
} from 'lucide-react'
import { SystemNoticeCard } from './SystemNoticeCard'
import { copyToClipboard } from '../../utils/clipboard'
import { ProviderIcon } from '../settings/ProviderIcons'
import { markdownComponents } from './markdownComponents'
import { StepBlock } from './StepBlock'
import { ToolCallBlock, ToolCallGroup } from './ToolCallBlock'
import { groupConsecutiveToolCalls } from './stepGrouping'
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
  const { isPlaying, isLoading, playingMessageId, speak, stop } = useTtsPlayback()
  const isThisPlaying = isPlaying && playingMessageId === msg.id
  const isThisLoading = isLoading && playingMessageId === msg.id

  // 流式模式下从 store 直接读取状态
  const storeStreamingContent = useChatStore(selectStreamingContent)
  const storeStreamingThinking = useChatStore(selectStreamingThinking)
  const storeStreamingImages = useChatStore(selectStreamingImages)
  const streamingToolCall = useChatStore(selectStreamingToolCall)
  const completedStreamingToolCalls = useChatStore(selectCompletedStreamingToolCalls)
  // 归属信息取自消息自身（投影时从 AgentMessage 的 provider/model 带过来）：
  // 记录的是**实际产出这条回复**的模型，中途切过模型时比"会话当前配置"准确。
  const msgProvider = msg.provider ?? ''
  const msgModel = msg.model ?? ''

  // 相邻的同名成功调用合并为一行 + 次数，其余步骤原样透传
  const stepGroups = useMemo(
    () => groupConsecutiveToolCalls((steps ?? []).map((s) => s.msg)),
    [steps]
  )

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
      {/* 提供商图标节点 */}
      <div className="absolute left-2.5 top-3 flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full bg-bg-primary ring-2 ring-bg-primary text-text-secondary z-10">
        <ProviderIcon name={msgProvider} />
      </div>

      {/* 内容 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-text-secondary">
            {msg.model || msgModel || 'Assistant'}
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

        {/* 过程区（步骤 + 思考）— 有正文跟随时以一条细线收尾，把「过程」和「结论」分层
            （不用左侧竖轴：那会再吃掉一列缩进） */}
        {(stepGroups.length > 0 || thinking) && (
          <div
            className={
              displayContent ? 'mb-2.5 pb-2 border-b border-border-secondary/40' : 'mb-0.5'
            }
          >
            {stepGroups.length > 0 && (
              <div className="space-y-0.5">
                {stepGroups.map((group) => {
                  if (group.kind === 'toolGroup') {
                    return (
                      <ToolCallGroup key={group.key} toolName={group.toolName} msgs={group.msgs} />
                    )
                  }
                  const step = group.msg
                  if (step.type === 'steer') {
                    return <StepBlock key={step.id} message={step} />
                  }
                  if (step.type === 'step_text') {
                    return (
                      <div key={step.id} className="markdown-body text-sm">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[rehypeHighlight, rehypeRaw]}
                          components={markdownComponents}
                        >
                          {step.content}
                        </ReactMarkdown>
                      </div>
                    )
                  }
                  if (step.type === 'step_thinking') {
                    return <StepBlock key={step.id} message={step} />
                  }
                  if (step.type === 'tool_use') {
                    const meta = step.metadata
                    const toolName = meta?.toolName || ''
                    const status = step.content ? (meta?.isError ? 'error' : 'done') : 'running'
                    return (
                      <ToolCallBlock
                        key={step.id}
                        toolName={toolName}
                        toolCallId={meta?.toolCallId}
                        args={meta?.args}
                        result={step.content || undefined}
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
          </div>
        )}

        {/* Markdown / 原始文本 */}
        {displayContent &&
          (isCompactionSummary ? (
            <SystemNoticeCard
              icon={<Archive size={14} />}
              title={t(
                msg.metadata?.autoCompacted ? 'compact.autoSummaryLabel' : 'compact.summaryLabel'
              )}
              content={displayContent}
            />
          ) : showRaw ? (
            <pre className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed font-mono bg-bg-tertiary/50 rounded-lg p-3 border border-border-primary overflow-auto">
              {displayContent}
            </pre>
          ) : (
            <div className="markdown-body text-sm">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight, rehypeRaw]}
                components={markdownComponents}
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

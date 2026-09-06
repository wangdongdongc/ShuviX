import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { Copy, Check, Code, FileText, RefreshCw, Volume2, Square, Loader2 } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import { hasThinkingContent } from '@shuvix/chat-protocol/utils/thinking'
import { imageSrc } from '@shuvix/chat-protocol/utils/imageSrc'
import {
  markdownComponents,
  markdownRemarkPlugins,
  markdownRehypePlugins
} from './markdownComponents'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { StepGroupView } from './StepGroupView'
import { groupConsecutiveSteps } from './stepGrouping'
import {
  useChatStore,
  selectStreamingContent,
  selectStreamingThinking,
  selectStreamingImages,
  selectStreamingToolCall,
  selectCompletedStreamingToolCalls,
  type AssistantBlock,
  type AssistantMessage
} from '../../stores/chatStore'
import { useTtsPlayback } from '../../hooks/useTtsPlayback'

interface AssistantBubbleProps {
  /**
   * 一张卡覆盖的连续 assistant 消息（= 连续的 assistant entry）。
   * 末条若不含工具块即本轮终答，它的 text 块是「正文」，其余全部进过程区。
   */
  msgs: AssistantMessage[]
  isStreaming?: boolean
  /** 重新生成此消息 */
  onRegenerate?: () => void
}

/**
 * 助手消息卡 —— 过程（思考 / 工具 / 中间文本）在上，终答正文在下。
 *
 * 「一张卡 = 一次 agent 循环」是**呈现**上的分组，不是数据形状：会话树里一次循环
 * 是若干条 assistant entry（每次 LLM 调用一条），由 Conversation.buildVisibleItems
 * 把连续的几条合成一张卡传进来。数据侧一条 entry 一条消息，各自带 blocks。
 *
 * 流式模式下正文/思考/工具调用从 store 的流式状态读取（末条是占位卡）。
 */
export const AssistantBubble = memo(function AssistantBubble({
  msgs,
  isStreaming,
  onRegenerate
}: AssistantBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const anchor = msgs[msgs.length - 1]
  // 这里**不再处理 bot 署名/结构化回复/失败通告/压缩摘要**：带 `metadata.sender` 的消息由
  // MessageRenderer 分流给 BotBubble（群聊气泡），压缩摘要分流给 CompactionNoticeRow，
  // 都走不到这张卡。留着那些分支只会让人以为两处都要跟着改
  const { isPlaying, isLoading, playingMessageId, speak, stop } = useTtsPlayback()
  const isThisPlaying = isPlaying && playingMessageId === anchor.id
  const isThisLoading = isLoading && playingMessageId === anchor.id

  // 流式模式下从 store 直接读取状态
  const storeStreamingContent = useChatStore(selectStreamingContent)
  const storeStreamingThinking = useChatStore(selectStreamingThinking)
  const storeStreamingImages = useChatStore(selectStreamingImages)
  const streamingToolCall = useChatStore(selectStreamingToolCall)
  const completedStreamingToolCalls = useChatStore(selectCompletedStreamingToolCalls)

  // 过程区的块 / 终答正文：末条不含工具块 = 本轮终答，它的 text 块下沉为正文；
  // 其余（含中间轮自己的 text）按原序留在过程区
  const { processBlocks, answerText } = useMemo(() => {
    const last = msgs[msgs.length - 1]
    const isFinal = !last.blocks.some((b) => b.type === 'tool')
    const process: AssistantBlock[] = []
    for (const m of msgs) {
      for (const b of m.blocks) {
        if (isFinal && m === last && b.type === 'text') continue
        process.push(b)
      }
    }
    const text = isFinal
      ? last.blocks
          .filter((b): b is Extract<AssistantBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('')
      : ''
    return { processBlocks: process, answerText: text }
  }, [msgs])

  // 相邻的步骤（思考 / 已完成的工具调用）合并为一行 + 次数；中间文本切段，其余块原样透传
  const blockGroups = useMemo(() => groupConsecutiveSteps(processBlocks), [processBlocks])

  const displayContent = isStreaming ? storeStreamingContent : answerText
  // 落盘后的思考已经是过程区里的块（按原序），这里只补流式期间还在缓冲里的那段
  const liveThinking =
    isStreaming && hasThinkingContent(storeStreamingThinking) ? storeStreamingThinking : null
  const liveImages = isStreaming ? storeStreamingImages : []
  // 流式期间仍在缓冲的思考 —— 与落盘后同款折叠行，位置也一致（过程区末尾）
  const liveThinkingRow = liveThinking ? (
    <ThinkingBlock content={liveThinking} isGenerating={!displayContent && !streamingToolCall} />
  ) : null

  const handleCopy = (): void => {
    copyToClipboard(displayContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="group relative px-4 py-3">
      {/* 内容 */}
      <div className="min-w-0">
        {/* 过程区（步骤 + 思考）— 有正文跟随时只留一段间距收尾，不画分割线也不用左侧竖轴：
            步骤行已经比正文轻一级，再加一条线只是多一道视觉噪音 */}
        {(blockGroups.length > 0 || liveThinkingRow) && (
          <div className={displayContent ? 'mb-2.5' : 'mb-0.5'}>
            {blockGroups.length > 0 && (
              <div className="space-y-0.5">
                {blockGroups.map((group) => (
                  <StepGroupView key={group.key} group={group} />
                ))}
              </div>
            )}
            {liveThinkingRow}
          </div>
        )}

        {/* 终答正文：Markdown / 原始文本双形态 */}
        {displayContent &&
          (showRaw ? (
            <pre className="code-surface text-sm text-text-primary font-mono">{displayContent}</pre>
          ) : (
            <div className="markdown-body text-sm">
              <ReactMarkdown
                remarkPlugins={markdownRemarkPlugins}
                rehypePlugins={markdownRehypePlugins}
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
          const images = isStreaming ? liveImages : anchor.metadata?.images
          if (!images || images.length === 0) return null
          return (
            <div className="flex flex-wrap gap-2 mt-2">
              {images.map((img, idx) => (
                <img
                  key={idx}
                  src={imageSrc(img)}
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

        {/* 操作行 —— 收在正文左下角，与用户消息气泡下方那行同形。
            仅在这条消息真有可操作项时渲染：流式期间全部按钮都不满足条件，
            渲染出来只会在每张卡底部留一条空行。 */}
        {!isStreaming && (displayContent || onRegenerate) && (
          <div className="flex items-center gap-1 mt-1.5 text-text-tertiary">
            {/* 复制 */}
            {displayContent && (
              <button
                onClick={handleCopy}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-text-secondary transition-opacity"
                title={t('message.copy')}
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </button>
            )}
            {/* TTS 朗读 */}
            {displayContent && (
              <button
                onClick={() =>
                  isThisPlaying || isThisLoading
                    ? stop()
                    : speak(displayContent.slice(0, 4000), anchor.id)
                }
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-text-secondary transition-opacity"
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
            {/* 原始/渲染 切换 */}
            {displayContent && (
              <button
                onClick={() => setShowRaw(!showRaw)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-text-secondary transition-opacity"
                title={showRaw ? t('message.showRendered') : t('message.showSource')}
              >
                {showRaw ? <FileText size={12} /> : <Code size={12} />}
              </button>
            )}
            {/* 重新生成 */}
            {onRegenerate && (
              <button
                onClick={onRegenerate}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-text-secondary transition-opacity"
                title={t('message.regenerate')}
              >
                <RefreshCw size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Copy,
  Check,
  Code,
  FileText,
  GitBranch,
  RefreshCw,
  Volume2,
  Square,
  Loader2
} from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import { useRestoreForCopy } from '../../hooks/useRedaction'
import {
  PLACEHOLDER_PATTERN,
  categoryOfPlaceholder,
  trimPartialPlaceholder
} from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import { RedactedText } from './RedactedText'
import { hasThinkingContent } from '@shuvix/chat-protocol/utils/thinking'
import { imageSrc } from '@shuvix/chat-protocol/utils/imageSrc'
import { MarkdownText } from './markdownComponents'
import {
  MarkdownMessageIdContext,
  MarkdownSourceContext,
  MarkdownStreamingContext,
  noteTextBlockMessage
} from './markdownStreaming'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { StepGroupView } from './StepGroupView'
import { groupConsecutiveSteps } from './stepGrouping'
import { SuggestionCards } from './SuggestionCards'
import { isSettledSuggestBlock } from '@shuvix/chat-protocol/suggestions'
import {
  useChatStore,
  selectStreamingContent,
  selectStreamingThinking,
  selectStreamingToolCall,
  selectCompletedStreamingToolCalls,
  selectMcpConnecting,
  type AssistantBlock,
  type AssistantMessage
} from '../../stores/chatStore'
import { useTtsPlayback } from '../../hooks/useTtsPlayback'
import { useChatDensity } from '../../host/chatHostContext'

/** 已落定的卡不读流式状态时给的常量（引用稳定，不触发重渲染） */
const NO_TOOL_CALLS: ReturnType<typeof selectCompletedStreamingToolCalls> = []
const NO_SERVERS: ReturnType<typeof selectMcpConnecting> = []

interface AssistantBubbleProps {
  /**
   * 一张卡覆盖的连续 assistant 消息（= 连续的 assistant entry）。
   * 末条若不含工具块即本轮终答，它的 text 块是「正文」，其余全部进过程区。
   */
  msgs: AssistantMessage[]
  isStreaming?: boolean
  /** 重新生成此消息（以这张卡的代表消息 id 调用；不给 = 不显示按钮）。传稳定的引用，免得 memo 每次都失效 */
  onRegenerate?: (assistantMsgId: string) => void
  /**
   * 从这张卡分支出一条新会话（以卡的最后一条消息 id 调用 —— fork 带着到它为止、连同它的工具结果的对话；
   * 不给 = 不显示按钮）。传稳定的引用
   */
  onFork?: (assistantMsgId: string) => void
}

/**
 * 朗读的文本：脱敏的占位符读成它的类别（「API key」），既不念出 `{{API_KEY_…}}`，也不把真值交给朗读服务
 * （它可能在别的机器上）。
 */
function speakableText(
  text: string,
  t: (key: string, opts?: { defaultValue: string }) => string
): string {
  return text.replace(new RegExp(PLACEHOLDER_PATTERN, 'g'), (p) => {
    const category = categoryOfPlaceholder(p)
    return t(`redaction.category.${category}`, { defaultValue: category })
  })
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
  onRegenerate,
  onFork
}: AssistantBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const anchor = msgs[msgs.length - 1]
  // 压缩摘要由 MessageRenderer 分流给 CompactionNoticeRow，走不到这张卡
  const { isPlaying, isLoading, playingMessageId, speak, stop } = useTtsPlayback()
  const isThisPlaying = isPlaying && playingMessageId === anchor.id
  const isThisLoading = isLoading && playingMessageId === anchor.id

  // 流式状态**只有流式卡读**：运行中的会话每秒推来十来次更新，已落定的卡若也订阅，每次都跟着重渲染
  // （memo 拦不住订阅）—— 卡里每段中间文本重新解析、每个代码块重新高亮，一轮越长越卡，滚回这一轮里
  // 时最明显。已落定的卡读常量，订阅的值永远不变，也就不再被这股更新带着重画
  const storeStreamingContent = useChatStore((s) => (isStreaming ? selectStreamingContent(s) : ''))
  const storeStreamingThinking = useChatStore((s) =>
    isStreaming ? selectStreamingThinking(s) : ''
  )
  const streamingToolCall = useChatStore((s) => (isStreaming ? selectStreamingToolCall(s) : null))
  const completedStreamingToolCalls = useChatStore((s) =>
    isStreaming ? selectCompletedStreamingToolCalls(s) : NO_TOOL_CALLS
  )
  const mcpConnecting = useChatStore((s) => (isStreaming ? selectMcpConnecting(s) : NO_SERVERS))

  // 过程区的块 / 终答正文：末条不含工具块 = 本轮终答，它的 text 块下沉为正文；
  // 其余（含中间轮自己的 text）按原序留在过程区
  // 落定的提议（suggest 调用）不进过程区：它们画在卡片最底下、终答之后 —— 读完回复才轮到它们，也不能被并进
  // 步骤组折起来（那等于没提）。还在执行 / 出错的调用照普通工具块留在过程区
  const { processBlocks, answerText, suggestionBlocks } = useMemo(() => {
    const last = msgs[msgs.length - 1]
    const isFinal = !last.blocks.some((b) => b.type === 'tool')
    const process: AssistantBlock[] = []
    const suggestions: Array<{
      messageId: string
      block: Extract<AssistantBlock, { type: 'tool' }>
    }> = []
    for (const m of msgs) {
      for (const b of m.blocks) {
        if (b.type === 'tool' && isSettledSuggestBlock(b)) {
          suggestions.push({ messageId: m.id, block: b })
          continue
        }
        if (isFinal && m === last && b.type === 'text') continue
        // 中间文本里的 ```artifact 引用要按它所在那条回复取钉住的版本（StepGroupView 按块查回 id）
        if (b.type === 'text') noteTextBlockMessage(b, m.id)
        process.push(b)
      }
    }
    const text = isFinal
      ? last.blocks
          .filter((b): b is Extract<AssistantBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('')
      : ''
    return { processBlocks: process, answerText: text, suggestionBlocks: suggestions }
  }, [msgs])

  // 相邻的步骤（思考 / 已完成的工具调用）合并为一行 + 次数；中间文本切段，其余块原样透传
  const blockGroups = useMemo(() => groupConsecutiveSteps(processBlocks), [processBlocks])

  // 流式正文的最后一帧，按「当时这张卡拿着的是哪一组消息」记下来。
  //
  // 一次 LLM 调用落盘时，store 在同一次 set 里清空流式正文、upsert 那张卡；但卡的新消息要经
  // Virtuoso 传进来，比 store 订阅晚一次渲染。中间那一帧这张卡还拿着旧的 msgs（仍是流式占位），
  // 正文却已经是空串 —— 正文容器被卸下，下一帧换成新节点：里面的交互图整块重载、加载时的动作
  // 再跑一遍（chat-interactive e2e 的 E-4b 抓到的），mermaid 重画，展开的东西折回去。
  // 所以只要 msgs 还是记下时的那一组，就接着显示那一帧；msgs 一换（新消息到了）就放手 ——
  // 换成的要么是终答（走 answerText），要么是带着这段中间文本的工具卡（文本在过程区里）。
  // 新出生的流式卡（下一轮占位）没有记下的东西，不会把上一段正文重复显示一遍。
  const [held, setHeld] = useState<{ msgs: AssistantMessage[]; content: string } | null>(null)
  if (
    isStreaming &&
    storeStreamingContent &&
    (held?.content !== storeStreamingContent || held.msgs !== msgs)
  ) {
    setHeld({ msgs, content: storeStreamingContent })
  }
  // 流式结尾还没写完的占位符先不显示（写完了再作为脱敏标记出现）
  const displayContent = isStreaming
    ? trimPartialPlaceholder(
        storeStreamingContent || (held && held.msgs === msgs ? held.content : '')
      )
    : answerText
  const restore = useRestoreForCopy()
  // 落盘后的思考已经是过程区里的块（按原序），这里只补流式期间还在缓冲里的那段
  const liveThinking =
    isStreaming && hasThinkingContent(storeStreamingThinking) ? storeStreamingThinking : null

  // 流式期间仍在缓冲的思考 —— 与落盘后同款折叠行，位置也一致（过程区末尾）
  const liveThinkingRow = liveThinking ? (
    <ThinkingBlock content={liveThinking} isGenerating={!displayContent && !streamingToolCall} />
  ) : null

  // 操作行的按钮：桌面悬浮才显形；触屏密度（手机）没有悬浮，常驻、点按区放大（与 Claude 的 App 一样，每条回复下面
  // 都有一排）
  const touch = useChatDensity() === 'touch'
  const actionCls = touch
    ? 'h-8 w-8 flex items-center justify-center rounded active:bg-bg-hover'
    : 'opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-text-secondary transition-opacity'
  const actionIcon = touch ? 15 : 12

  const handleCopy = (): void => {
    // 复制出去的是界面上看到的样子：脱敏的占位符换回真值
    copyToClipboard(restore(displayContent))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="group relative px-4 py-3">
      {/* 内容 */}
      <div className="min-w-0">
        {/* 创建运行时期间的 MCP 惰性连接：这几秒没有任何流式内容，卡里一片空白像是出了 bug ——
            写明在等什么。agent_created 之后这一行就没了 */}
        {isStreaming && mcpConnecting.length > 0 && (
          <div
            data-mcp-connecting
            className="flex items-center gap-1.5 mb-1 text-[11px] text-text-tertiary"
          >
            <Loader2 size={12} className="animate-spin flex-shrink-0" />
            <span>{t('chat.mcpConnecting', { names: mcpConnecting.join(', ') })}</span>
          </div>
        )}
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
            <pre className="code-surface text-sm text-text-primary font-mono">
              <RedactedText text={displayContent} />
            </pre>
          ) : (
            <div className="markdown-body text-sm">
              {/* 代码块自己看不出消息写没写完（mermaid 写完才出错误卡、才能导出），由这一层告诉它 */}
              <MarkdownStreamingContext.Provider value={!!isStreaming}>
                {/* 交互图要确切知道自己的围栏闭合没有，靠节点位置切回这段源文本 */}
                <MarkdownSourceContext.Provider value={isStreaming ? displayContent : null}>
                  {/* 引用块按这条回复取它写下时钉住的版本；流式中还没有条目 id，照当前内容显示 */}
                  <MarkdownMessageIdContext.Provider value={isStreaming ? null : anchor.id}>
                    <MarkdownText text={displayContent} />
                  </MarkdownMessageIdContext.Provider>
                </MarkdownSourceContext.Provider>
              </MarkdownStreamingContext.Provider>
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

        {/* 提议卡片：终答之后、操作行之前 */}
        {suggestionBlocks.map(({ messageId, block }) => (
          <SuggestionCards
            key={`${messageId}:${block.toolCallId}`}
            messageId={messageId}
            block={block}
          />
        ))}

        {/* 图片（持久化 metadata；流式期间实时卡不带图） */}
        {(() => {
          const images = isStreaming ? undefined : anchor.metadata?.images
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
                  // 不超过对话列：手机上 400px 比整列还宽
                  className="max-w-[min(400px,100%)] max-h-[400px] rounded-lg border border-border-primary object-contain"
                />
              ))}
            </div>
          )
        })()}

        {/* 操作行 —— 收在正文左下角，与用户消息气泡下方那行同形。
            仅在这条消息真有可操作项时渲染：流式期间全部按钮都不满足条件，
            渲染出来只会在每张卡底部留一条空行。触屏常驻（-ml 让第一颗图标与正文左缘对齐） */}
        {!isStreaming && (displayContent || onRegenerate || onFork) && (
          <div
            data-message-actions=""
            className={`flex items-center text-text-tertiary ${touch ? 'gap-1 mt-1 -ml-2' : 'gap-1 mt-1.5'}`}
          >
            {/* 复制 */}
            {displayContent && (
              <button
                onClick={handleCopy}
                className={actionCls}
                title={t('message.copy')}
                aria-label={t('message.copy')}
              >
                {copied ? (
                  <Check size={actionIcon} className="text-success" />
                ) : (
                  <Copy size={actionIcon} />
                )}
              </button>
            )}
            {/* TTS 朗读 */}
            {displayContent && (
              <button
                onClick={() =>
                  isThisPlaying || isThisLoading
                    ? stop()
                    : speak(speakableText(displayContent, t).slice(0, 4000), anchor.id)
                }
                className={actionCls}
                title={isThisPlaying || isThisLoading ? t('message.stopTts') : t('message.playTts')}
                aria-label={
                  isThisPlaying || isThisLoading ? t('message.stopTts') : t('message.playTts')
                }
              >
                {isThisLoading ? (
                  <Loader2 size={actionIcon} className="animate-spin" />
                ) : isThisPlaying ? (
                  <Square size={actionIcon} />
                ) : (
                  <Volume2 size={actionIcon} />
                )}
              </button>
            )}
            {/* 原始/渲染 切换 */}
            {displayContent && (
              <button
                onClick={() => setShowRaw(!showRaw)}
                className={actionCls}
                title={showRaw ? t('message.showRendered') : t('message.showSource')}
                aria-label={showRaw ? t('message.showRendered') : t('message.showSource')}
              >
                {showRaw ? <FileText size={actionIcon} /> : <Code size={actionIcon} />}
              </button>
            )}
            {/* 重新生成 */}
            {onRegenerate && (
              <button
                onClick={() => onRegenerate(anchor.id)}
                className={actionCls}
                title={t('message.regenerate')}
                aria-label={t('message.regenerate')}
              >
                <RefreshCw size={actionIcon} />
              </button>
            )}
            {/* 从这里分支出新会话 */}
            {onFork && (
              <button
                onClick={() => onFork(anchor.id)}
                className={actionCls}
                title={t('message.fork')}
                aria-label={t('message.fork')}
                data-fork-reply
              >
                <GitBranch size={actionIcon} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

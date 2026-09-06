/**
 * bot 气泡（v2）—— bot 的发言看起来就该像聊天里对面的那个人，而不是「助手卡」。
 *
 * 与 `AssistantBubble` 的分工：那一个服务有根会话（一次 agent 循环 = 一张卡，里面有
 * 过程区、工具块、思考块）；这一个服务聊天会话，一条消息就是一句话 —— 没有过程区，
 * 因为工具跑在派生 agent 自己的内存树里，从不进这条会话。
 *
 * 连续同一个 bot 的消息合并头部（IM 惯例）：第二条起只留气泡，头像列留白对齐。
 *
 * 不渲染图片是**投影的事实**而非疏漏：附件只挂在用户行上（bot 通过 `resolveAttachments`
 * 把它们读进自己的上下文），`rowToChatMessage` 从不给 bot 消息造 `metadata.images`。
 */
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { Check, Copy } from 'lucide-react'
import type { AssistantMessage } from '../../stores/chatStore'
import { copyToClipboard } from '../../utils/clipboard'
import {
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins
} from './markdownComponents'
import { BotAvatar } from '../common/BotAvatar'
import { BotReplyCard } from './BotReplyCard'

export interface BotBubbleProps {
  msg: AssistantMessage
  /** 上一条也是同一个 bot 说的 —— 合并头部，只留气泡 */
  mergeHeader?: boolean
}

export const BotBubble = memo(function BotBubble({
  msg,
  mergeHeader
}: BotBubbleProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const sender = msg.metadata?.sender
  if (!sender) return null

  const reply = msg.metadata?.reply
  const isError = !!msg.metadata?.botFailure

  const handleCopy = (): void => {
    copyToClipboard(msg.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="group flex flex-col items-start gap-1 px-4 py-1" data-bot-sender={sender.name}>
      {!mergeHeader && (
        <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
          <BotAvatar name={sender.name} displayName={sender.displayName} size={18} />
          <span className="truncate">{sender.displayName}</span>
          {isError && (
            <span className="text-[10.5px] font-normal text-error" data-bot-failure>
              {t('bot.failureLabel')}
            </span>
          )}
        </div>
      )}

      {/* 头像列的宽度（18px + gap 6px）—— 合并头部时靠它对齐 */}
      <div className="flex w-full gap-1.5">
        <span className="w-[18px] flex-shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div
            className={`inline-block max-w-full rounded-lg px-3 py-1.5 text-sm ${
              isError
                ? 'border border-error/40 bg-error/10'
                : 'bg-bg-secondary/70 border border-border-secondary/50'
            }`}
          >
            {reply ? (
              <BotReplyCard reply={reply} />
            ) : (
              <div className="markdown-body text-sm">
                <ReactMarkdown
                  remarkPlugins={markdownRemarkPlugins}
                  rehypePlugins={markdownRehypePlugins}
                  components={markdownComponents}
                >
                  {msg.content}
                </ReactMarkdown>
              </div>
            )}
          </div>

          {/* 复制 —— 悬停才显形，与用户气泡下那行同形 */}
          {msg.content && (
            <div className="mt-0.5 flex items-center gap-1 text-text-tertiary">
              <button
                onClick={handleCopy}
                className="rounded p-0.5 opacity-0 transition-opacity hover:text-text-secondary group-hover:opacity-100"
                title={t('message.copy')}
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

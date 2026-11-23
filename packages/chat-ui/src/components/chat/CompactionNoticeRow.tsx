import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { Archive, Check, Copy } from 'lucide-react'
import type { AssistantMessage } from '../../stores/chatStore'
import { SystemNoticeRow } from './SystemNoticeRow'
import { copyToClipboard } from '../../utils/clipboard'
import {
  markdownComponents,
  markdownRemarkPlugins,
  markdownRehypePlugins
} from './markdownComponents'
import { useRestoreForCopy } from '../../hooks/useRedaction'
import { useChatDensity } from '../../host/chatHostContext'

/**
 * 压缩摘要行 —— compaction entry 的投影（一条带 `isCompactionSummary` 的 assistant 消息）。
 *
 * 它是**边界标记**，不是某一轮的终答：buildVisibleItems 让它自成一项，不并入前后任何一张
 * 助手卡（并进去的话，一段被中止的过程会把摘要当成自己的「结论」）。呈现上它是一条分隔线：
 * 「以上已压缩成摘要」后面一根细线 —— 它上面的消息（往上翻就接上来，见 useCompactedHistory）
 * 模型已经看不到了，只剩这段摘要。这一句就是用户要知道的全部，所以不再摆摘要的首行预览；
 * 点开是模型写的摘要正文。保留复制 —— 摘要正是「换个会话接着聊」时要带走的东西；
 * 朗读 / 源码切换 / 重新生成对一段压缩摘要没有意义，不再提供。
 */
export function CompactionNoticeRow({ msg }: { msg: AssistantMessage }): React.JSX.Element {
  const { t } = useTranslation()
  // 触屏密度（手机）没有悬浮：悬浮才显形的按钮常驻
  const touch = useChatDensity() === 'touch'
  const [copied, setCopied] = useState(false)
  const restore = useRestoreForCopy()
  const handleCopy = (): void => {
    copyToClipboard(restore(msg.content))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <SystemNoticeRow
      kind="compaction"
      icon={<Archive size={12} className="flex-shrink-0 text-accent/70" />}
      label={t('compact.dividerLabel')}
      detail={
        <span
          data-compaction-divider=""
          aria-hidden="true"
          className="block border-t border-border-secondary"
        />
      }
    >
      <div className="relative group/notice py-1">
        <button
          type="button"
          onClick={handleCopy}
          className={`absolute right-0 top-1 p-0.5 rounded text-text-tertiary ${touch ? '' : 'opacity-0 group-hover/notice:opacity-100'} hover:text-text-secondary transition-opacity`}
          title={t('message.copy')}
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
        </button>
        <div className="markdown-body text-sm pr-6">
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
            components={markdownComponents}
          >
            {msg.content}
          </ReactMarkdown>
        </div>
      </div>
    </SystemNoticeRow>
  )
}

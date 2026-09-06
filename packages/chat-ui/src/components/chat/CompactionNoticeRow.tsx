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

/**
 * 折叠态的摘要预览：正文首个非空行，去掉行首的 markdown 记号（标题 # / 列表 - * / 引用 > /
 * 有序列表 1.）—— 摘要多半以「## 对话摘要」开头，把井号原样摆到行里只是噪音。
 * 行内截断交给 StepRow 的 truncate。
 */
function previewOf(content: string): string {
  const line =
    content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  return line.replace(/^(?:#{1,6}\s+|[-*>]\s+|\d+[.)]\s+)+/, '')
}

/**
 * 压缩摘要行 —— compaction entry 的投影（一条带 `isCompactionSummary` 的 assistant 消息）。
 *
 * 它是**边界标记**，不是某一轮的终答：buildVisibleItems 让它自成一项，不并入前后任何一张
 * 助手卡（并进去的话，一段被中止的过程会把摘要当成自己的「结论」）。呈现上它是一行系统
 * 通知，点开是模型写的摘要正文。保留复制 —— 摘要正是「换个会话接着聊」时要带走的东西；
 * 朗读 / 源码切换 / 重新生成对一段压缩摘要没有意义，不再提供。
 */
export function CompactionNoticeRow({ msg }: { msg: AssistantMessage }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const handleCopy = (): void => {
    copyToClipboard(msg.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <SystemNoticeRow
      kind="compaction"
      icon={<Archive size={12} className="flex-shrink-0 text-accent/70" />}
      label={t('compact.summaryLabel')}
      detail={previewOf(msg.content)}
    >
      <div className="relative group/notice py-1">
        <button
          type="button"
          onClick={handleCopy}
          className="absolute right-0 top-1 p-0.5 rounded text-text-tertiary opacity-0 group-hover/notice:opacity-100 hover:text-text-secondary transition-opacity"
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

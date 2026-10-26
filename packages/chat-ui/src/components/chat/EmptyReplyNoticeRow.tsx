import { useTranslation } from 'react-i18next'
import { RotateCw } from 'lucide-react'
import type { UserTextMessage } from '../../stores/chatStore'
import { SystemNoticeRow } from './SystemNoticeRow'
import { STREAM_PRE_CLASS } from './detailViewport'
import { RedactedText } from './RedactedText'

/**
 * 空回复追问行 —— 工具跑完之后模型的回复既没有正文也没有工具调用，系统追加了一条
 * `<empty-reply>` 通知让它接着干（agent-runtime `durable/emptyReply.ts`，种类 `empty-reply`）。
 *
 * 和后台完成通知一样是系统写的 user 消息，同走 SystemNoticeRow、绝不画成用户气泡；
 * 标签说明发生了什么，展开态是写给模型的原文。
 */
export function EmptyReplyNoticeRow({ msg }: { msg: UserTextMessage }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SystemNoticeRow
      kind="empty-reply"
      icon={<RotateCw size={12} className="flex-shrink-0 text-accent/70" />}
      label={t('emptyReplyNotice.title')}
    >
      <pre className={`${STREAM_PRE_CLASS} my-1`}>
        <RedactedText text={msg.content} />
      </pre>
    </SystemNoticeRow>
  )
}

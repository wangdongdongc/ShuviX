import { BellRing } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UserTextMessage } from '../../stores/chatStore'
import { SystemNoticeCard } from './SystemNoticeCard'

interface BackgroundNoticeBubbleProps {
  msg: UserTextMessage
}

/**
 * 后台完成通知 —— **自动续跑**那一轮的输入。
 *
 * 它在会话树上是一条 user 消息（模型必须看见它才能接着干，而 pi 的上下文里只有
 * user/assistant/toolResult），但用户并没有说过这句话。所以渲染上与 InstructionBubble
 * 同策：走 SystemNoticeCard，绝不画成用户气泡 —— 转写不得把系统写的话记成用户说的。
 * 判据是投影层按 `SYSTEM_NOTICE_CUSTOM_TYPE` 侧车打上的 `metadata.isSystemNotice`。
 */
export function BackgroundNoticeBubble({ msg }: BackgroundNoticeBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="group relative px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-text-secondary">
            {t('backgroundNotice.sender')}
          </span>
        </div>
        <SystemNoticeCard
          icon={<BellRing size={14} />}
          title={t('backgroundNotice.title')}
          content={msg.content}
        />
      </div>
    </div>
  )
}

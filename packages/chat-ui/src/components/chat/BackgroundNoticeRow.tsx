import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { BellRing } from 'lucide-react'
import type { UserTextMessage } from '../../stores/chatStore'
import { SystemNoticeRow } from './SystemNoticeRow'
import { CountBadge } from './StepRow'
import { summarizeSystemNotice } from './systemNotice'
import { STREAM_PRE_CLASS } from './detailViewport'

/**
 * 后台完成通知行 —— **自动续跑**那一轮的输入。
 *
 * 它在会话树上是一条 user 消息（模型必须看见它才能接着干，而 pi 的上下文里只有
 * user/assistant/toolResult），但用户并没有说过这句话。所以渲染上与项目指令注入同策：
 * 走 SystemNoticeRow，绝不画成用户气泡 —— 转写不得把系统写的话记成用户说的。
 * 判据是投影层按 `SYSTEM_NOTICE_CUSTOM_TYPE` 侧车打上的 `metadata.isSystemNotice`。
 *
 * 摘要位放解析出的人读一句（命令 · 状态 · 时长 / 标题 · 状态，见 systemNotice.ts）；
 * 正文是写给模型看的原文（带标签），展开态按等宽原样给出，不走 markdown —— 那不是文章。
 */
export function BackgroundNoticeRow({ msg }: { msg: UserTextMessage }): React.JSX.Element {
  const { t } = useTranslation()
  const notices = useMemo(() => summarizeSystemNotice(msg.content), [msg.content])
  return (
    <SystemNoticeRow
      kind="background"
      icon={<BellRing size={12} className="flex-shrink-0 text-accent/70" />}
      label={t('backgroundNotice.title')}
      // 多条通知之间用竖线分隔：每句内部已经用 · 连着 命令 · 状态 · 时长，再用 · 就读不出边界
      detail={notices.map((n) => n.text).join(' | ')}
      trailing={notices.length > 1 ? <CountBadge count={notices.length} /> : undefined}
    >
      <pre className={`${STREAM_PRE_CLASS} my-1`}>{msg.content}</pre>
    </SystemNoticeRow>
  )
}

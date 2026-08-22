import { FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UserTextMessage } from '../../stores/chatStore'
import { SystemNoticeCard } from './SystemNoticeCard'

interface InstructionBubbleProps {
  msg: UserTextMessage
}

/**
 * 项目指令注入消息（AGENTS.md / CLAUDE.md）
 *
 * 复用 AssistantBubble 中"压缩摘要"分支的布局结构：
 * 头部标签 + SystemNoticeCard，让用户清晰识别它是被独立插入的一条系统消息。
 */
export function InstructionBubble({ msg }: InstructionBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const filename = msg.metadata?.instructionFilename ?? 'instructions'
  return (
    <div className="group relative px-4 py-3">
      {/* 内容 */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-text-secondary">{t('instruction.sender')}</span>
          <span className="text-[10px] text-text-tertiary">· {filename}</span>
        </div>
        <SystemNoticeCard
          icon={<FileText size={14} />}
          title={t('instruction.loaded', { filename })}
          content={msg.content}
        />
      </div>
    </div>
  )
}

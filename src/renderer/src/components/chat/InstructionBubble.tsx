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
 * 时间线 + 头像节点 + 头部标签 + SystemNoticeCard，
 * 让用户清晰识别它是被独立插入的一条系统消息。
 */
export function InstructionBubble({ msg }: InstructionBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const filename = msg.metadata?.instructionFilename ?? 'instructions'
  return (
    <div className="group relative flex gap-3 pl-10 pr-4 py-3">
      {/* 时间线 */}
      <div className="absolute left-[1.35rem] top-0 bottom-0 w-px bg-border-secondary/40" />
      {/* 头像节点 — 用文件图标表示"系统注入" */}
      <div className="absolute left-2.5 top-3 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center bg-accent/20 text-accent ring-2 ring-bg-primary z-10">
        <FileText size={10} />
      </div>

      {/* 内容 */}
      <div className="flex-1 min-w-0">
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

import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { FileText } from 'lucide-react'
import type { UserTextMessage } from '../../stores/chatStore'
import { SystemNoticeRow } from './SystemNoticeRow'
import {
  markdownComponents,
  markdownRemarkPlugins,
  markdownRehypePlugins
} from './markdownComponents'

/**
 * 项目指令注入行（AGENTS.md / CLAUDE.md）。
 *
 * 只服务历史会话：旧的惰性注入机制把指令写成了一条 `custom_message(instruction)` entry，
 * 投影仍会把它们渲染出来；现在的指令文件直接接在系统提示词后面，不再产生这种消息。
 * 形态与其他系统通知同款 —— 一行「项目指令 · 文件名」，点开是文件正文。
 */
export function InstructionNoticeRow({ msg }: { msg: UserTextMessage }): React.JSX.Element {
  const { t } = useTranslation()
  const filename = msg.metadata?.instructionFilename ?? 'instructions'
  return (
    <SystemNoticeRow
      kind="instruction"
      icon={<FileText size={12} className="flex-shrink-0 text-accent/70" />}
      label={t('instruction.title')}
      detail={<span className="font-mono">{filename}</span>}
    >
      <div className="markdown-body text-sm py-1">
        <ReactMarkdown
          remarkPlugins={markdownRemarkPlugins}
          rehypePlugins={markdownRehypePlugins}
          components={markdownComponents}
        >
          {msg.content}
        </ReactMarkdown>
      </div>
    </SystemNoticeRow>
  )
}

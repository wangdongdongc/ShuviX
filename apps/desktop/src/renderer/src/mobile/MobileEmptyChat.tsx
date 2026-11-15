/**
 * 手机布局的空对话页（2026-11-15）—— 一句提示（Bot 会话是它的自我介绍），下面一张入口卡片。
 *
 * 桌面在这里摆的是整套会话配置（扩展能力、知识库、访问权限三张大卡片）；手机上同样的内容已经在「详情」里有一页
 * 一页的版本，这里只留入口：每行写着现在的状态（开着几台、选了几个库、权限表里几行），点它直接推入详情里对应的
 * 那一页，返回一步就回到对话。没有东西可选的一行不画（与详情首页同一条规则）。
 */
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder, LibraryBig, Puzzle, type LucideIcon } from 'lucide-react'
import { getHostApi, useChatStore, useSessionKnowledgeBases } from '@shuvix/chat-ui'
import { useSessionAclCounts, type SessionConfigSection } from '@shuvix/app-shell'
import { boundBotOf } from '@shuvix/chat-protocol/botSession'
import { BotEmptyState } from '../components/chat/WelcomeView'
import { useMcpSummary } from './useMcpSummary'

export interface MobileEmptyChatProps {
  sessionId: string
  /** 直接推入详情里的某一页 */
  onOpenSection: (section: SessionConfigSection) => void
}

function EntryCard({ sessionId, onOpenSection }: MobileEmptyChatProps): React.JSX.Element {
  const { t } = useTranslation()
  const mcp = useMcpSummary(sessionId)
  const knowledge = useSessionKnowledgeBases(sessionId)
  const acl = useSessionAclCounts(sessionId)
  // 只数还在的库（同详情首页）
  const picked = knowledge.selected.filter((name) =>
    knowledge.options.some((option) => option.name === name)
  ).length

  const entry = (
    section: SessionConfigSection,
    Icon: LucideIcon,
    label: string,
    value: string
  ): React.JSX.Element => (
    <button
      type="button"
      data-mobile-empty-row={section}
      onClick={() => onOpenSection(section)}
      className="flex min-h-[44px] w-full items-center gap-3 px-4 text-left text-[16px] text-text-primary active:bg-bg-hover"
    >
      <Icon size={20} className="shrink-0 text-accent" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span data-mobile-empty-value="" className="text-[15px] tabular-nums text-text-tertiary">
        {value}
      </span>
      <ChevronRight size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
    </button>
  )

  return (
    <div
      data-mobile-empty-card=""
      className="overflow-hidden rounded-xl bg-bg-secondary divide-y divide-border-secondary/50"
    >
      {mcp.total > 0 &&
        entry(
          'extensions',
          Puzzle,
          t('sessionConfig.extensionsGroup'),
          mcp.selected > 0 ? String(mcp.selected) : t('mobile.emptyExtensionsOff')
        )}
      {knowledge.options.length > 0 &&
        entry(
          'knowledge',
          LibraryBig,
          t('sessionConfig.knowledgeGroup'),
          picked > 0 ? String(picked) : t('mobile.emptyKnowledgeNone')
        )}
      {entry('paths', Folder, t('sessionAcl.title'), acl ? String(acl.paths) : '')}
    </div>
  )
}

export function MobileEmptyChat({
  sessionId,
  onOpenSection
}: MobileEmptyChatProps): React.JSX.Element {
  const { t } = useTranslation()
  const settings = useChatStore((st) => st.sessions.find((x) => x.id === sessionId)?.settings)
  const bot = boundBotOf(settings)
  // 入口后面那几页全是宿主管理能力：渠道端（无 HostApi）不摆入口
  const hasHost = getHostApi() !== null
  return (
    <div data-mobile-empty-chat="" className="flex flex-1 flex-col overflow-y-auto">
      {/* my-auto：内容不满一屏时居中，超出时从顶上排起（justify-center 会把超出的上半截裁掉） */}
      <div className="my-auto w-full px-3 py-6">
        {bot ? (
          <BotEmptyState bot={bot} />
        ) : (
          <p className="mb-4 text-center text-[14px] text-text-secondary">{t('chat.emptyHint')}</p>
        )}
        {hasHost && <EntryCard sessionId={sessionId} onOpenSection={onOpenSection} />}
      </div>
    </div>
  )
}

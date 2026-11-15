/**
 * 手机布局的会话详情 —— 点对话页的标题整屏推入（2026-11-14，取代桌面那个居中的「会话配置」对话框：在手机上它又窄又长）。
 *
 * 首页是 iOS 设置那样的分组列表：名称（就地改）与位置、扩展能力与知识库、三种访问权限、删除会话；后面带箭头的行各推入
 * 一页，页里就是会话配置里对应的那一段（app-shell SessionConfigPanel 的 `section`），内容不重写。行尾的数字是那一段
 * 此刻有几项（勾了几台 MCP、几个知识库、权限表里几行）。模型与思考强度不在这里：它们在输入框上。
 *
 * 哪一页由 MobileChatView 管（它连着浏览器历史，见 detailHistory.ts）；这里只画。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { getChatApi, isImeComposing, useChatStore, useSessionKnowledgeBases } from '@shuvix/chat-ui'
import {
  SessionConfigPanel,
  useSessionAclCounts,
  useSessionDelete,
  type SessionConfigSection
} from '@shuvix/app-shell'
import { boundBotOf } from '@shuvix/chat-protocol/botSession'
import type { MobileDetailPage } from './detailHistory'
import { useMcpSummary } from './useMcpSummary'
import { useSessionLocation } from './useSessionLocation'

const card = 'overflow-hidden rounded-xl bg-bg-secondary divide-y divide-border-secondary/50'
const rowBase = 'flex min-h-[44px] w-full items-center gap-3 px-4 text-left text-[16px]'
const row = `${rowBase} text-text-primary`

export interface MobileSessionDetailsProps {
  sessionId: string
  page: MobileDetailPage
  /** 这一段的子页是从对话页直接进来的（空对话页的入口行）：返回是回对话页，不经详情首页 */
  direct?: boolean
  /** 推入某一段的子页 */
  onOpenSection: (section: SessionConfigSection) => void
  /** 返回上一层（子页 → 首页 → 对话页） */
  onBack: () => void
}

export function MobileSessionDetails({
  sessionId,
  page,
  direct,
  onOpenSection,
  onBack
}: MobileSessionDetailsProps): React.JSX.Element {
  const { t } = useTranslation()
  const session = useChatStore((s) => s.sessions.find((x) => x.id === sessionId))
  const location = useSessionLocation(session)
  const bot = boundBotOf(session?.settings)
  const mcp = useMcpSummary(sessionId)
  const knowledge = useSessionKnowledgeBases(sessionId)
  const acl = useSessionAclCounts(sessionId)
  const { requestDelete, deleteDialog } = useSessionDelete()

  // 名称：就地改，失焦或回车存（与桌面弹窗里那一格同一套）
  const current = session?.title ?? ''
  const [title, setTitle] = useState(current)
  // 标题在别处变了（自动起的标题落地、桌面上改了名）：这一格没动过就跟上，否则失焦时会把旧标题当成改动写回去
  const [synced, setSynced] = useState(current)
  if (synced !== current) {
    setSynced(current)
    if (title === synced) setTitle(current)
  }
  const saveTitle = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed || trimmed === current) {
      setTitle(current)
      return
    }
    try {
      await getChatApi().session.updateTitle({ id: sessionId, title: trimmed })
      useChatStore.getState().updateSessionTitle(sessionId, trimmed)
    } catch {
      // 没存上（连接断了）：这一格退回现在的标题，不留一个与顶栏对不上的名字
      setTitle(current)
    }
  }

  const sectionLabel: Record<SessionConfigSection, string> = {
    extensions: t('sessionConfig.extensionsGroup'),
    knowledge: t('sessionConfig.knowledgeGroup'),
    paths: t('sessionAcl.title'),
    sessions: t('sessionAcl.sessionsTitle'),
    widgets: t('sessionAcl.widgetsTitle')
  }

  const navRow = (section: SessionConfigSection, count?: number): React.JSX.Element => (
    <button
      type="button"
      data-mobile-detail-row={section}
      onClick={() => onOpenSection(section)}
      className={`${row} active:bg-bg-hover`}
    >
      <span className="min-w-0 flex-1 truncate">{sectionLabel[section]}</span>
      {count !== undefined && count > 0 && (
        <span data-mobile-detail-count="" className="text-[15px] tabular-nums text-text-tertiary">
          {count}
        </span>
      )}
      <ChevronRight size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
    </button>
  )

  const isIndex = page === 'index'
  return (
    <div
      data-mobile-details={page}
      // 对话页那一层已经让出了刘海与底部的安全区，这里只管盖满它
      className="absolute inset-0 z-30 flex flex-col bg-bg-primary"
    >
      <div className="flex flex-shrink-0 items-center px-2 pt-2">
        <button
          type="button"
          data-mobile-details-back=""
          onClick={onBack}
          className="flex h-9 items-center gap-0.5 rounded-full pl-1 pr-3 text-[16px] text-accent active:bg-bg-hover"
        >
          <ChevronLeft size={22} aria-hidden="true" />
          <span>{isIndex || direct ? t('mobile.detailsBack') : t('mobile.details')}</span>
        </button>
      </div>
      <h1
        data-mobile-details-title=""
        className="flex-shrink-0 truncate px-5 pt-3 pb-2 text-[28px] font-bold leading-9 tracking-tight text-text-primary"
      >
        {isIndex ? t('mobile.details') : sectionLabel[page]}
      </h1>
      {isIndex ? (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-6 pt-1">
          <div className={card}>
            <label className={row}>
              <span className="shrink-0 text-text-secondary">{t('mobile.detailName')}</span>
              <input
                data-mobile-detail-name=""
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(e) => {
                  // 输入法组字中的回车是「确认选词」，不能当成提交
                  if (isImeComposing(e)) return
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                enterKeyHint="done"
                className="min-w-0 flex-1 bg-transparent text-right text-text-primary outline-none"
              />
            </label>
            <div className={row}>
              <span className="shrink-0 text-text-secondary">{t('mobile.detailLocation')}</span>
              <span data-mobile-detail-location="" className="min-w-0 flex-1 truncate text-right">
                {location}
              </span>
            </div>
            {bot && (
              <div className={row}>
                <span className="shrink-0 text-text-secondary">{t('mobile.detailBot')}</span>
                <span data-mobile-detail-bot="" className="min-w-0 flex-1 truncate text-right">
                  {bot}
                </span>
              </div>
            )}
          </div>

          {(mcp.total > 0 || knowledge.options.length > 0) && (
            <div className={card}>
              {mcp.total > 0 && navRow('extensions', mcp.selected)}
              {knowledge.options.length > 0 &&
                navRow(
                  'knowledge',
                  // 只数还在的库：选过之后被改名 / 删掉的库留在选择里，但那一页上没有它
                  knowledge.selected.filter((name) =>
                    knowledge.options.some((option) => option.name === name)
                  ).length
                )}
            </div>
          )}

          <div className={card}>
            {navRow('paths', acl?.paths)}
            {navRow('sessions', acl?.sessions)}
            {navRow('widgets', acl?.widgets)}
          </div>

          <div className={card}>
            <button
              type="button"
              data-mobile-detail-delete=""
              onClick={() => void requestDelete(sessionId)}
              className={`${rowBase} text-error active:bg-bg-hover`}
            >
              {t('mobile.deleteChat')}
            </button>
          </div>
        </div>
      ) : (
        <div
          data-mobile-detail-section={page}
          data-mobile-scale=""
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-1"
        >
          <SessionConfigPanel sessionId={sessionId} section={page} />
        </div>
      )}
      {deleteDialog}
    </div>
  )
}

/**
 * 手机布局的产物页 —— 从对话页的「⋯」整屏推入（2026-11-16，取代底部抽屉里那张手风琴表）。
 *
 * 列表页：这场会话的产物一张卡片，直接子会话的各一张（卡片上面写「子会话 · 标题」）。一行两排：标题，下面是
 * 「文件名 · 第几版 · 最近一版的时刻」。点一行推入详情页；长按是复制路径。
 * 详情页：大标题是产物的标题，下面那行同上，内容是与对话里的引用同一个渲染器（svg 内联、html 进沙箱、其余显示
 * 源码）。这一件不在了 → 退回列表。
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, Braces, ChevronRight, FileText, Image, Table } from 'lucide-react'
import { ArtifactPreview, copyToClipboard } from '@shuvix/chat-ui'
import { listTimeLabel, useContextMenu, useSessionArtifacts } from '@shuvix/app-shell'
import type { SessionArtifact } from '@shuvix/chat-protocol/artifacts'
import { MobilePage, pageCard, pageSectionLabel } from './MobilePage'
import { artifactKey, groupArtifacts } from './panelPure'

function ArtifactIcon({ name }: { name: string }): React.JSX.Element {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase()
  const props = { size: 20, className: 'shrink-0 text-text-tertiary', 'aria-hidden': true }
  if (ext === 'svg') return <Image {...props} />
  if (ext === 'html') return <AppWindow {...props} />
  if (ext === 'csv') return <Table {...props} />
  if (ext === 'json') return <Braces {...props} />
  return <FileText {...props} />
}

function useMetaLine(): (artifact: SessionArtifact) => string {
  const { t, i18n } = useTranslation()
  return (artifact) =>
    [
      artifact.name,
      t('panel.artifactsVersion', { count: artifact.versions }),
      artifact.updatedAt
        ? listTimeLabel(artifact.updatedAt, Date.now(), {
            yesterday: t('mobile.yesterday'),
            locale: i18n.language
          })
        : ''
    ]
      .filter(Boolean)
      .join(' · ')
}

export interface MobileArtifactsPageProps {
  sessionId: string
  onBack: () => void
  /** 点了一件：推入它的详情页（key = `<会话 id>/<文件名>`） */
  onOpenArtifact: (artifact: SessionArtifact) => void
}

export function MobileArtifactsPage({
  sessionId,
  onBack,
  onOpenArtifact
}: MobileArtifactsPageProps): React.JSX.Element {
  const { t } = useTranslation()
  const rows = useSessionArtifacts(sessionId)
  const groups = groupArtifacts(rows ?? [])
  const meta = useMetaLine()
  const showContextMenu = useContextMenu()

  return (
    <MobilePage
      kind="artifacts"
      backLabel={t('mobile.detailsBack')}
      onBack={onBack}
      title={t('mobile.artifacts')}
      toolbar={
        <span data-mobile-artifacts-count="">
          {rows && rows.length > 0 ? t('mobile.artifactsCount', { count: rows.length }) : ''}
        </span>
      }
      bodyClassName="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-6 pt-1"
    >
      {rows !== undefined && rows.length === 0 && (
        <div
          data-mobile-artifacts-empty=""
          className="px-4 py-10 text-center text-[14px] text-text-tertiary"
        >
          {t('mobile.noArtifacts')}
        </div>
      )}
      {groups.map((group) => (
        <section key={group.sessionId} data-mobile-artifact-group={group.sessionId}>
          {group.subSessionTitle !== undefined && (
            <div className={`truncate ${pageSectionLabel}`}>
              {t('panel.artifactsSubSession', { title: group.subSessionTitle })}
            </div>
          )}
          <div className={pageCard}>
            {group.items.map((artifact) => (
              <button
                key={artifactKey(artifact)}
                type="button"
                data-mobile-artifact-row={artifact.name}
                data-artifact-key={artifactKey(artifact)}
                onClick={() => onOpenArtifact(artifact)}
                onContextMenu={(e) =>
                  void showContextMenu(
                    e,
                    [{ id: 'copy-path', label: t('panel.artifactsCopyPath') }],
                    (action) => {
                      if (action === 'copy-path') copyToClipboard(artifact.path)
                    }
                  )
                }
                className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left active:bg-bg-hover"
              >
                <ArtifactIcon name={artifact.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px] text-text-primary">
                    {artifact.title}
                  </span>
                  <span
                    data-artifact-meta=""
                    className="block truncate text-[13px] text-text-tertiary"
                  >
                    {meta(artifact)}
                  </span>
                </span>
                <ChevronRight
                  size={16}
                  className="shrink-0 text-text-tertiary"
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        </section>
      ))}
    </MobilePage>
  )
}

export interface MobileArtifactDetailPageProps {
  sessionId: string
  /** `<会话 id>/<文件名>` */
  artifactKey: string
  onBack: () => void
}

export function MobileArtifactDetailPage({
  sessionId,
  artifactKey: key,
  onBack
}: MobileArtifactDetailPageProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const rows = useSessionArtifacts(sessionId)
  const artifact = rows?.find((row) => artifactKey(row) === key)
  const meta = useMetaLine()
  // 清单到了、里面却没有这一件（被删了）：退回列表。清单还没到不算
  const gone = rows !== undefined && !artifact
  useEffect(() => {
    if (gone) onBack()
  }, [gone, onBack])
  if (!artifact) return null
  return (
    <MobilePage
      kind="artifact"
      backLabel={t('mobile.artifacts')}
      onBack={onBack}
      title={artifact.title}
      subtitle={meta(artifact)}
      bodyClassName="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-1"
    >
      <div data-mobile-artifact-detail={artifact.name}>
        {/* 换 key = 有了新版就重取（预览只在挂载时取内容） */}
        <ArtifactPreview
          key={`${artifact.versions}:${artifact.updatedAt}`}
          sessionId={artifact.sessionId}
          name={artifact.name}
          hideTitle
        />
      </div>
    </MobilePage>
  )
}

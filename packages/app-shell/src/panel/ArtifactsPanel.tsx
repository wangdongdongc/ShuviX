import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, Braces, ChevronDown, ChevronRight, FileText, Image, Table } from 'lucide-react'
import { ArtifactPreview, copyToClipboard, getHostApi, useChatStore } from '@shuvix/chat-ui'
import type { SessionArtifact } from '@shuvix/chat-protocol/artifacts'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import { RowMenuButton } from '../sidebar/RowMenuButton'
import { usePanelCloseInset } from './panelCloseInset'
import { useSessionArtifacts } from './sessionArtifacts'

/**
 * 产物面板 —— SessionPanel 的 artifacts 页：这场会话的全部产物（加上直接子会话的），一处看全。
 *
 * 对话流里的 ```artifact 引用散在各轮回复里，一件改过几次就出现几次，往回翻才找得到；这里每件
 * 只一行，最近改过的在上，带着记下的版本数（`v3` = 第三版）与最近一版的时刻。点一行就地展开预览，
 * 用的是与引用围栏同一个渲染器（svg 内联、html 进沙箱、其余显示源码），展开互斥（与任务页同理：
 * 定高的预览彼此挤压）。行菜单（右键 / 悬停的 ⋮）：在文件夹中显示（宿主有才出现）、复制路径。
 *
 * 子会话的产物分组列在后面，组头是那场子会话的标题 —— 目录跟着产出它的会话走，`work` 把具体活交给
 * 子会话，它画的图父会话也得找得到。
 */

/** 行首图标：按扩展名 */
function ArtifactIcon({ name }: { name: string }): React.JSX.Element {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase()
  const className = 'mt-[1px] flex-shrink-0 text-text-tertiary'
  if (ext === 'svg') return <Image size={12} className={className} />
  if (ext === 'html') return <AppWindow size={12} className={className} />
  if (ext === 'csv') return <Table size={12} className={className} />
  if (ext === 'json') return <Braces size={12} className={className} />
  return <FileText size={12} className={className} />
}

/** 今天的只写时刻，更早的写日期 */
function whenLabel(ts: number, language: string): string {
  if (!ts) return ''
  const at = new Date(ts)
  const sameDay = at.toDateString() === new Date().toDateString()
  return sameDay
    ? at.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString(language, { month: 'short', day: 'numeric' })
}

/** 一件产物的身份（同名文件可以分属本会话与子会话） */
const keyOf = (a: SessionArtifact): string => `${a.sessionId}/${a.name}`

interface ArtifactGroup {
  sessionId: string
  /** 子会话组的标题；本会话自己那组没有 */
  subSessionTitle?: string
  items: SessionArtifact[]
}

/** 按会话分组，保持清单给的顺序（本会话在前，子会话按创建顺序） */
function groupBySession(rows: readonly SessionArtifact[]): ArtifactGroup[] {
  const groups: ArtifactGroup[] = []
  for (const row of rows) {
    let group = groups.find((g) => g.sessionId === row.sessionId)
    if (!group) {
      group = { sessionId: row.sessionId, subSessionTitle: row.subSessionTitle, items: [] }
      groups.push(group)
    }
    group.items.push(row)
  }
  return groups
}

type RevealRequest = NonNullable<ReturnType<typeof useChatStore.getState>['artifactRevealRequest']>

/**
 * 已经有面板处理过的那条揭示请求（同 BgTaskPanel 的做法）：面板收起时整块不渲染，点引用块上的「已有新版」
 * 是先发请求、再把面板打开 —— 挂载时补处理一次还没人处理过的请求；处理过的不再处理，免得收起再打开又把
 * 很久以前点过的那件展开一遍。
 */
let handledReveal: RevealRequest | null = null

function pendingReveal(): RevealRequest | null {
  const req = useChatStore.getState().artifactRevealRequest
  return req && req !== handledReveal ? req : null
}

/** 把那一行滚进视野 —— 只动面板自己的滚动容器（`scrollIntoView` 会连带推动窗口布局） */
function scrollRowIntoView(box: HTMLElement, key: string): void {
  const row = [...box.querySelectorAll<HTMLElement>('[data-artifact-key]')].find(
    (el) => el.getAttribute('data-artifact-key') === key
  )
  if (!row) return
  const r = row.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  if (r.top < b.top) box.scrollTop -= b.top - r.top
  else if (r.bottom > b.bottom) box.scrollTop += Math.min(r.bottom - b.bottom, r.top - b.top)
}

export function ArtifactsPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const closeInset = usePanelCloseInset()
  const rows = useSessionArtifacts(sessionId)
  const groups = useMemo(() => groupBySession(rows ?? []), [rows])
  // 初值是挂载前就发出、还没人处理的那条揭示请求
  const [reveal, setReveal] = useState<RevealRequest | null>(pendingReveal)
  const [expanded, setExpanded] = useState<string | null>(() =>
    reveal ? `${reveal.sessionId}/${reveal.name}` : null
  )
  const scrollRef = useRef<HTMLDivElement>(null)

  // 引用块上的「已有新版」被点了 → 独占展开那一件（切页、展开面板由宿主的 useSessionPanelReveal 做）。
  // 订阅而不是在 effect 里读：外部状态变了就 setState，effect 体里同步 setState 会引发级联渲染
  useEffect(
    () =>
      useChatStore.subscribe((next, prev) => {
        const req = next.artifactRevealRequest
        if (req && req !== prev.artifactRevealRequest) {
          setExpanded(`${req.sessionId}/${req.name}`)
          setReveal(req)
        }
      }),
    []
  )

  // 揭示请求画出来之后（那一行此刻才在 DOM 里）：记为已处理，再滚
  useEffect(() => {
    if (!reveal) return
    handledReveal = reveal
    if (scrollRef.current)
      scrollRowIntoView(scrollRef.current, `${reveal.sessionId}/${reveal.name}`)
  }, [reveal, rows])

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto no-scrollbar p-1.5 bg-bg-secondary"
      data-artifacts-panel=""
    >
      {groups.map((group, idx) => (
        <div key={group.sessionId} className="mb-1.5 last:mb-0">
          <div
            className={`flex items-center gap-1 px-1 py-1 text-[11px] text-text-tertiary${
              closeInset && idx === 0 ? ' pr-6' : ''
            }`}
          >
            <span className="truncate">
              {group.subSessionTitle !== undefined
                ? t('panel.artifactsSubSession', { title: group.subSessionTitle })
                : t('panel.artifacts')}
            </span>
            <span className="tabular-nums">{group.items.length}</span>
          </div>
          <div className="rounded-lg border border-border-secondary/40 bg-bg-primary overflow-hidden">
            {group.items.map((artifact, i) => (
              <ArtifactRow
                key={keyOf(artifact)}
                artifact={artifact}
                divided={i > 0}
                expanded={expanded === keyOf(artifact)}
                onToggle={() =>
                  setExpanded((cur) => (cur === keyOf(artifact) ? null : keyOf(artifact)))
                }
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function ArtifactRow({
  artifact,
  divided,
  expanded,
  onToggle
}: {
  artifact: SessionArtifact
  divided: boolean
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const showContextMenu = useContextMenu()
  const canReveal = !!getHostApi()?.app.revealPath

  const openMenu = (e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      ...(canReveal ? [{ id: 'reveal', label: t('panel.artifactsReveal') }] : []),
      { id: 'copy-path', label: t('panel.artifactsCopyPath') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'reveal') void getHostApi()?.app.revealPath(artifact.path)
      if (action === 'copy-path') copyToClipboard(artifact.path)
    })
  }

  return (
    <div
      className={divided ? 'border-t border-border-secondary/30' : ''}
      data-artifact-row={artifact.name}
      data-artifact-key={keyOf(artifact)}
      data-artifact-expanded={expanded ? 'true' : 'false'}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        onContextMenu={openMenu}
        className="group relative flex items-start gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-bg-hover/30 transition-colors"
      >
        <span className="mt-[1px] flex-shrink-0 text-text-tertiary">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <ArtifactIcon name={artifact.name} />
        <div className="min-w-0 flex-1 group-hover:pr-5">
          <div className="truncate text-xs text-text-primary" title={artifact.title}>
            {artifact.title}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-text-tertiary" title={artifact.path}>
            {[
              artifact.name,
              t('panel.artifactsVersion', { count: artifact.versions }),
              whenLabel(artifact.updatedAt, i18n.language)
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <RowMenuButton
          className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100"
          onOpen={openMenu}
        />
      </div>
      {expanded && (
        <div className="px-2 pb-2">
          {/* 换 key = 有了新版就重取（预览只在挂载时取内容） */}
          <ArtifactPreview
            key={`${artifact.versions}:${artifact.updatedAt}`}
            sessionId={artifact.sessionId}
            name={artifact.name}
            hideTitle
          />
        </div>
      )}
    </div>
  )
}

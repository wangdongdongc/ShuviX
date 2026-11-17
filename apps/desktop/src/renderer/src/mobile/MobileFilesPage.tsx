/**
 * 手机布局的文件页 —— 从对话页的「⋯」整屏推入（2026-11-16，取代底部抽屉里的文件树）。
 *
 * 一页就是工作目录里的一层：大标题是这一层的文件夹名，文件夹在前、文件在后，都在一张卡片里。点文件夹再推入一页
 * （MobileChatView 管那一摞，见 panelHistory.ts），返回退一层；点文件打开预览（与文件树同一个信号）。每个文件
 * 一行两排：名字，下面是大小与修改时刻（`files.scanDir` 的 `stat`）。长按一行是文件树那份菜单：打开 / 在对话中
 * 引用 / 复制路径 / 复制相对路径。搜索框在这一层以下找文件（全量 `files.scan` 一次，按路径过滤），结果一行一个
 * 文件、第二排写它在哪个文件夹里。右上角「⋯」：刷新、显示 / 不显示隐藏文件（以点开头的；这台设备上记着）。
 * 底部一行是这一层有几个文件夹、几个文件。
 *
 * 只读：不改磁盘。跟着 `files.changed` 重扫这一层（合并 300ms）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  CircleEllipsis,
  Eye,
  EyeOff,
  File,
  Folder,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { copyToClipboard, getSessionChannelApi, useAppEvent, useChatStore } from '@shuvix/chat-ui'
import { basename, joinPath, listTimeLabel, useContextMenu } from '@shuvix/app-shell'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { MobilePage, pageCard } from './MobilePage'
import { formatFileSize, isHiddenName, nameOf, searchFiles } from './panelPure'
import { PullDownMenu, type PullDownItem } from './PullDownMenu'

const HIDDEN_KEY = 'shuvix.mobileFiles.showHidden'
function readShowHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === 'true'
  } catch {
    return false
  }
}

interface Listing {
  root: string
  dirs: string[]
  files: string[]
  stats: Record<string, { size: number; mtime: number }>
}

export interface MobileFilesPageProps {
  sessionId: string
  /** 这一层：工作目录里的相对路径（'' = 工作目录本身） */
  dir: string
  /** 返回键上写的字：上一层文件夹的名字，最上面一层是「对话」 */
  backLabel: string
  onBack: () => void
  /** 点了一个文件夹：推入它那一页 */
  onOpenDir: (dir: string) => void
  /** 「在对话中引用」把胶囊插进输入框之后（回到对话页，让人看见它） */
  onMentionInserted: () => void
}

export function MobileFilesPage({
  sessionId,
  dir,
  backLabel,
  onBack,
  onOpenDir,
  onMentionInserted
}: MobileFilesPageProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const showContextMenu = useContextMenu()
  const projectPath = useChatStore((s) => s.projectPath)
  const [listing, setListing] = useState<Listing | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(readShowHidden)
  const [query, setQuery] = useState('')
  /** 搜索用的全量清单（头一次输入时取一次） */
  const [allFiles, setAllFiles] = useState<{
    paths: string[]
    truncated: boolean
    failed?: boolean
  } | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<{ right: number; bottom: number } | null>(null)
  const [now] = useState(() => Date.now())
  // 只认最新一次扫描的结果（刷新连着点、文件事件接连来）
  const seq = useRef(0)

  const load = useCallback((): void => {
    const mine = ++seq.current
    getSessionChannelApi()
      .files.scanDir({ sessionId, dir, stat: true })
      .then((r) => {
        if (mine !== seq.current) return
        setLoading(false)
        if (!r.root) {
          setFailed(true)
          return
        }
        setFailed(false)
        setListing({ root: r.root, dirs: r.dirs, files: r.files, stats: r.stats ?? {} })
      })
      .catch(() => {
        if (mine !== seq.current) return
        setLoading(false)
        setFailed(true)
      })
  }, [sessionId, dir])

  useEffect(() => {
    load()
    return () => {
      // 卸载后回来的结果不再写状态
      seq.current += 1
    }
  }, [load])

  // 磁盘变了：这一层重扫一次（合并接连来的事件）
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useAppEvent('files.changed', (e) => {
    // 认这一页自己扫出来的那个根（与事件同一份拼写）；还没扫到就认会话的工作目录
    const mine = listing?.root ?? projectPath
    if (!mine || e.root !== mine) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      load()
      // 搜索用的全量清单也过期了：下一次有字时重取
      setAllFiles(null)
    }, 300)
  })
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  // 搜索：头一次有字时全量扫一次
  const searching = query.trim() !== ''
  const wantAll = searching && allFiles === null
  useEffect(() => {
    if (!wantAll) return
    let alive = true
    const id = setTimeout(() => {
      getSessionChannelApi()
        .files.scan({ sessionId })
        .then((r) => {
          if (alive) setAllFiles({ paths: r.paths, truncated: r.truncated })
        })
        .catch(() => {
          if (alive) setAllFiles({ paths: [], truncated: false, failed: true })
        })
    }, 250)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [wantAll, sessionId])

  const visible = useMemo(() => {
    if (!listing) return { dirs: [], files: [] }
    const keep = (rel: string): boolean => showHidden || !isHiddenName(rel)
    return { dirs: listing.dirs.filter(keep), files: listing.files.filter(keep) }
  }, [listing, showHidden])
  const results = useMemo(
    () => (searching && allFiles ? searchFiles(allFiles.paths, dir, query) : []),
    [searching, allFiles, dir, query]
  )

  const root = listing?.root ?? projectPath ?? ''
  /** 相对路径（一律 `/`）换成工作目录自己的分隔符 */
  const hostRel = (rel: string): string =>
    root.includes('\\') && !root.includes('/') ? rel.replace(/\//g, '\\') : rel
  const absOf = (rel: string): string => joinPath(root, hostRel(rel))

  const openFile = (rel: string): void => {
    if (root) useChatStore.getState().requestFilePreview(absOf(rel))
  }

  const openRowMenu = (e: React.MouseEvent, rel: string, kind: 'file' | 'dir'): void => {
    if (!root) return
    const clean = rel.replace(/\/+$/, '')
    const items: ContextMenuItem[] = []
    if (kind === 'file') {
      items.push({ id: 'open', label: t('panel.filesMenu.open') })
      // 只读笔记本没有输入框：没地方插就不给这一项
      if (useChatStore.getState().composerSessionId === sessionId) {
        items.push({ id: 'mention', label: t('panel.filesMenu.mention') })
      }
      items.push({ type: 'separator' })
    }
    items.push(
      { id: 'copyPath', label: t('panel.filesMenu.copyPath') },
      { id: 'copyRelativePath', label: t('panel.filesMenu.copyRelativePath') }
    )
    void showContextMenu(e, items, (id) => {
      if (id === 'open') openFile(clean)
      else if (id === 'mention') {
        const name = nameOf(clean)
        useChatStore
          .getState()
          .requestMentionInsert(sessionId, { kind: 'file', rel: clean, base: name }, name)
        onMentionInserted()
      } else if (id === 'copyPath') copyToClipboard(absOf(clean))
      else if (id === 'copyRelativePath') copyToClipboard(hostRel(clean))
    })
  }

  const menuGroups: PullDownItem[][] = [
    [{ id: 'refresh', label: t('panel.filesRefresh'), icon: <RefreshCw size={19} /> }],
    [
      showHidden
        ? { id: 'hidden', label: t('mobile.filesHideHidden'), icon: <EyeOff size={19} /> }
        : { id: 'hidden', label: t('mobile.filesShowHidden'), icon: <Eye size={19} /> }
    ]
  ]
  const pickMenu = (id: string): void => {
    if (id === 'refresh') {
      setLoading(true)
      load()
      setAllFiles(null)
    }
    if (id === 'hidden') {
      const next = !showHidden
      setShowHidden(next)
      try {
        window.localStorage.setItem(HIDDEN_KEY, String(next))
      } catch {
        // 存不下（隐私模式）：这一次照样生效
      }
    }
  }

  const title = dir ? nameOf(dir) : root ? basename(root) : t('mobile.files')
  const rowClass =
    'flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left active:bg-bg-hover'

  const fileRow = (rel: string, second: string): React.JSX.Element => (
    <button
      key={rel}
      type="button"
      data-mobile-file-row="file"
      data-file-path={rel}
      onClick={() => openFile(rel)}
      onContextMenu={(e) => openRowMenu(e, rel, 'file')}
      className={rowClass}
    >
      <File size={20} className="shrink-0 text-text-tertiary" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] text-text-primary">{nameOf(rel)}</span>
        {second && (
          <span data-file-meta="" className="block truncate text-[13px] text-text-tertiary">
            {second}
          </span>
        )}
      </span>
    </button>
  )

  const metaOf = (rel: string): string => {
    const st = listing?.stats[rel]
    if (!st) return ''
    return [
      formatFileSize(st.size),
      listTimeLabel(st.mtime, now, { yesterday: t('mobile.yesterday'), locale: i18n.language })
    ]
      .filter(Boolean)
      .join(' · ')
  }

  let body: React.ReactNode
  if (searching) {
    body =
      allFiles === null ? (
        <div className="px-4 py-10 text-center text-[14px] text-text-tertiary">
          {t('panel.filesLoading')}
        </div>
      ) : allFiles.failed ? (
        <div
          data-mobile-files-empty="error"
          className="px-4 py-10 text-center text-[14px] text-text-tertiary"
        >
          {t('panel.filesError')}
        </div>
      ) : results.length === 0 ? (
        <div
          data-mobile-files-empty="search"
          className="px-4 py-10 text-center text-[14px] text-text-tertiary"
        >
          {t('mobile.filesSearchEmpty')}
        </div>
      ) : (
        <div data-mobile-files-results="" className={pageCard}>
          {results.map((rel) => {
            const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
            return fileRow(rel, folder)
          })}
        </div>
      )
  } else if (failed && !listing) {
    body = (
      <div
        data-mobile-files-empty="error"
        className="px-4 py-10 text-center text-[14px] text-text-tertiary"
      >
        {t('panel.filesError')}
      </div>
    )
  } else if (!listing) {
    body = (
      <div className="px-4 py-10 text-center text-[14px] text-text-tertiary">
        {t('panel.filesLoading')}
      </div>
    )
  } else if (visible.dirs.length + visible.files.length === 0) {
    body = (
      <div
        data-mobile-files-empty="folder"
        className="px-4 py-10 text-center text-[14px] text-text-tertiary"
      >
        {t('mobile.filesEmpty')}
      </div>
    )
  } else {
    body = (
      <div data-mobile-files-list="" className={pageCard}>
        {visible.dirs.map((rel) => (
          <button
            key={rel}
            type="button"
            data-mobile-file-row="dir"
            data-file-path={rel.replace(/\/+$/, '')}
            onClick={() => onOpenDir(rel.replace(/\/+$/, ''))}
            onContextMenu={(e) => openRowMenu(e, rel, 'dir')}
            className={rowClass}
          >
            <Folder size={20} className="shrink-0 text-accent" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[16px] text-text-primary">
              {nameOf(rel)}
            </span>
            <ChevronRight size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
          </button>
        ))}
        {visible.files.map((rel) => fileRow(rel, metaOf(rel)))}
      </div>
    )
  }

  const toolbar = searching
    ? allFiles === null || allFiles.failed
      ? ''
      : allFiles.truncated
        ? t('panel.filesTruncated', { count: allFiles.paths.length })
        : t('mobile.filesFileCount', { count: results.length })
    : listing
      ? [
          visible.dirs.length > 0 ? t('mobile.filesDirCount', { count: visible.dirs.length }) : '',
          t('mobile.filesFileCount', { count: visible.files.length })
        ]
          .filter(Boolean)
          .join(' · ')
      : ''

  return (
    <MobilePage
      kind="files"
      backLabel={backLabel}
      onBack={onBack}
      title={title}
      subtitle={dir ? dir : undefined}
      actions={
        <button
          type="button"
          data-mobile-files-menu=""
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMenuAnchor({ right: rect.right, bottom: rect.bottom })
          }}
          aria-haspopup="menu"
          aria-expanded={menuAnchor !== null}
          aria-label={t('mobile.moreActions')}
          className="flex h-10 w-10 items-center justify-center rounded-full text-accent active:bg-bg-hover"
        >
          <CircleEllipsis
            size={23}
            aria-hidden="true"
            className={loading ? 'animate-pulse motion-reduce:animate-none' : undefined}
          />
        </button>
      }
      header={
        <div className="flex flex-shrink-0 items-center px-3 pb-3">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] bg-bg-secondary px-2.5 text-text-tertiary">
            <Search size={16} aria-hidden="true" className="shrink-0" />
            <input
              data-mobile-files-search=""
              type="search"
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('mobile.filesSearch')}
              aria-label={t('mobile.filesSearch')}
              className="min-w-0 flex-1 appearance-none bg-transparent text-[16px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                data-mobile-files-search-clear=""
                onClick={() => setQuery('')}
                aria-label={t('mobile.cancel')}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-hover text-text-secondary"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </label>
        </div>
      }
      toolbar={<span data-mobile-files-count="">{toolbar}</span>}
    >
      {body}
      {menuAnchor && (
        <PullDownMenu
          anchor={menuAnchor}
          groups={menuGroups}
          onPick={pickMenu}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </MobilePage>
  )
}

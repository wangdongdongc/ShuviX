/**
 * FilesPanel — 右侧面板"Files"标签
 * 显示当前会话工作目录的文件树，并实时跟随磁盘变化
 * 基于 @pierre/trees（path-first + Shadow DOM 隔离）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, RefreshCw, Search, X } from 'lucide-react'
import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react'
import type { FileTree as FileTreeModel } from '@pierre/trees'
import { useChatStore, getSessionChannelApi, useAppEvent } from '@shuvix/chat-ui'
import { isContentOnlyFileChange } from '@shuvix/chat-protocol/utils/fileMap'
import type { NotebookCaps } from '../notebook/LivePreviewEditor'
import { FilePreview } from './FilePreview'
import { AudioDock } from './AudioDock'
import { VideoDock } from './VideoDock'
import { extOf, basename, joinPath, relativize } from './paths'

/** 音频扩展名 → MIME。点击命中即走底部 dock，不进预览覆盖层。
 *  与 main 的 AUDIO_MIME_BY_EXT 同步；renderer 这里独立列表是为了在点击瞬间就分流，
 *  不必等 files.read RPC 返回 'media' kind 才知道是音频。 */
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus'
}

/** 视频扩展名 → MIME。同上：渲染端表用于点击瞬间分流到底部 VideoDock */
const VIDEO_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg'
}

/** Markdown 扩展名：从预览顶栏可创建绑定该文件的「笔记本会话」 */
const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown'])

interface ScanState {
  /** 此结果对应的工作目录（root），用于判定数据是否仍匹配当前 projectPath */
  forRoot: string
  paths: string[]
  /** paths 的小写集合 —— 供 isContentOnlyFileChange 判断事件是否可能改变列表成员 */
  pathSet: Set<string>
  truncated: boolean
}

interface ScanError {
  forRoot: string
  message: string
}

export interface FilesPanelProps {
  /** 预览 Markdown 文件时，预览顶栏「创建笔记本」按钮的处理：提供则显示该按钮，
   *  点击创建绑定该 md 的笔记本会话。不提供则不显示（宿主无中间区编辑器时）。 */
  onCreateNotebook?: (params: { path: string; sessionId: string }) => void
  /** 宿主能力注入（笔记本主题 / 外链）；markdown 只读 live-preview 渲染时透传给 FilePreview。 */
  notebookCaps?: NotebookCaps
  /** 在系统文件管理器中打开工作目录（宿主注入）；提供则在工作目录名旁显示按钮。
   *  桌面注入 getHostApi().app.openFolder；扩展无原生文件管理器故不注入。 */
  onOpenFolder?: (projectPath: string) => void
}

export function FilesPanel({
  onCreateNotebook,
  notebookCaps,
  onOpenFolder
}: FilesPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const sessionId = useChatStore((s) => s.activeSessionId)
  const projectPath = useChatStore((s) => s.projectPath)
  // 笔记本编辑器内 [[wiki-link]] 点击 → 请求在本面板打开目标文件预览
  const filePreviewRequest = useChatStore((s) => s.filePreviewRequest)

  const [state, setState] = useState<ScanState | null>(null)
  const [error, setError] = useState<ScanError | null>(null)
  /** 手动刷新触发器：递增以重跑扫描 effect */
  const [refreshNonce, setRefreshNonce] = useState(0)
  /** 搜索栏是否展开 */
  const [searchOpen, setSearchOpen] = useState(false)
  /** 搜索查询字符串。空字符串视作未触发搜索 */
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  /** 预览状态：被选中的文件相对路径（相对当前 projectPath）；null = 未预览 */
  const [previewRelPath, setPreviewRelPath] = useState<string | null>(null)
  /** 媒体 dock 状态（音视频共享同一槽位）—— 与预览状态独立，让用户听/看的同时仍能浏览树。
   *  音视频互斥：放新的会替换旧的；这与"一个文件预览面板只有一个 dock"的语义一致。
   *  relPath 同时存一份：dock 上的"展开"按钮需要把它转回 previewRelPath 走覆盖预览。 */
  const [playingMedia, setPlayingMedia] = useState<{
    absPath: string
    relPath: string
    mimeType: string
    fileName: string
    type: 'audio' | 'video'
  } | null>(null)
  /** 暴露的 FilesTree model 句柄，关闭预览时用来取消 pierre 选中（否则再点同一文件不会触发） */
  const treeModelRef = useRef<FileTreeModel | null>(null)

  // 渲染层防抖：200ms 内的连续 onChanged 事件合并为一次重扫
  const rescanTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 扫描当前会话工作目录。sessionId 从 store 即时读取，scan 结果按 root 标识 —
   * 同项目内多个会话切换时 projectPath 不变，scan 不会重复触发；切换到不同项目时
   * projectPath 变化，下方 effect 重新触发扫描
   */
  const scan = useCallback(async (): Promise<void> => {
    const id = useChatStore.getState().activeSessionId
    if (!id) return
    try {
      const r = await getSessionChannelApi().files.scan({ sessionId: id })
      const root = r.root
      if (!root) return
      // 异步竞态：若用户已切到不同 workingDirectory，丢弃旧结果
      if (useChatStore.getState().projectPath !== root) return
      // 排序保证跨次扫描顺序稳定 —— rg --files 并行遍历输出顺序不确定，不排序会让
      // 下面的等值保险几乎永远失效（树的显示顺序由 pierre 内部 sort 决定，与此无关）
      const paths = [...r.paths].sort()
      // 等值保险：文件列表未变时返回原引用 → React 跳过 re-render，避免按需重扫（聚焦/写入）
      // 反复重挂载文件树（path-first 树本就按路径复用状态，此处再挡掉多余渲染）。
      setState((prev) =>
        prev &&
        prev.forRoot === root &&
        prev.truncated === r.truncated &&
        prev.paths.length === paths.length &&
        prev.paths.every((p, i) => p === paths[i])
          ? prev
          : {
              forRoot: root,
              paths,
              pathSet: new Set(paths.map((p) => p.toLowerCase())),
              truncated: r.truncated
            }
      )
      setError(null)
    } catch (e) {
      const currentRoot = useChatStore.getState().projectPath
      if (!currentRoot) return
      setError({ forRoot: currentRoot, message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  // 仅 projectPath / 手动刷新触发扫描；sessionId 变化但 wd 不变时不重扫
  useEffect(() => {
    if (!projectPath) return
    void scan() // eslint-disable-line react-hooks/set-state-in-effect
  }, [projectPath, refreshNonce, scan])

  // 项目 / 会话切换时关闭预览 + 停止音频（避免读到旧会话工作目录里的文件）
  useEffect(() => {
    setPreviewRelPath(null) // eslint-disable-line react-hooks/set-state-in-effect
    setPlayingMedia(null)
  }, [projectPath, sessionId])

  // 订阅文件变动事件（AppEvent 'files.changed'），按 root 过滤；防抖 200ms 后重扫。
  // 纯内容变更（edit/write 且路径均已在列表中）不可能改变列表成员 → 跳过，
  // 笔记本自动保存、agent 编辑已有文件不再触发整目录扫描。
  useAppEvent('files.changed', (e) => {
    if (!projectPath || e.root !== projectPath) return
    if (
      state &&
      state.forRoot === projectPath &&
      isContentOnlyFileChange(e, (rel) => state.pathSet.has(rel))
    ) {
      return
    }
    if (rescanTimer.current) clearTimeout(rescanTimer.current)
    rescanTimer.current = setTimeout(() => {
      rescanTimer.current = null
      void scan()
    }, 200)
  })
  // 卸载时清理悬挂的防抖计时器
  useEffect(
    () => () => {
      if (rescanTimer.current) clearTimeout(rescanTimer.current)
    },
    []
  )

  // 窗口重新聚焦时按需重扫一次 —— 外部进程（别的编辑器 / git / 构建）增删文件的兜底刷新。
  // 带 1.5s 节流避免频繁 ripgrep；结果无变化时 scan 的等值保险会挡掉 re-render，不会闪。
  const lastFocusScan = useRef(0)
  useEffect(() => {
    const onFocus = (): void => {
      const now = Date.now()
      if (now - lastFocusScan.current < 1500) return
      lastFocusScan.current = now
      void scan()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [scan])

  const handleRefresh = useCallback(() => {
    setRefreshNonce((n) => n + 1)
  }, [])

  const toggleSearch = useCallback(() => {
    setSearchOpen((v) => {
      if (v) setSearchQuery('') // 关闭时清空查询
      return !v
    })
  }, [])

  // 搜索栏出现后聚焦输入框（自己控制，不走库的 openSearch，避免触发首项高亮）
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  // —— 派生状态：state / error 必须与当前 projectPath 匹配才视作有效 ——
  const freshState = state && state.forRoot === projectPath ? state : null
  const freshError = error && error.forRoot === projectPath ? error : null
  const showLoading = !!sessionId && !!projectPath && !freshState && !freshError

  // —— 内容区渲染 ——
  let content: React.ReactNode
  if (!sessionId || !projectPath) {
    content = (
      <div className="flex items-center justify-center h-full">
        <Folder size={48} strokeWidth={1.5} className="text-text-tertiary/30" />
      </div>
    )
  } else if (freshError) {
    content = (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-xs text-text-tertiary">
        <span>{t('panel.filesError')}</span>
        <span className="text-text-tertiary/70 max-w-[80%] text-center break-all">
          {freshError.message}
        </span>
      </div>
    )
  } else if (!freshState) {
    content = (
      <div className="flex items-center justify-center h-full text-xs text-text-tertiary">
        {t('panel.filesLoading')}
      </div>
    )
  } else {
    content = (
      <FilesTree
        key={freshState.forRoot}
        paths={freshState.paths}
        searchQuery={searchOpen ? searchQuery : ''}
        onFileSelect={(rel) => {
          // 音频 / 视频：上底部 dock，文件树继续可见；
          // 其它（含 .md，banner「创建笔记本」从预览顶栏进入）走预览覆盖层
          const ext = extOf(rel)
          const audioMime = AUDIO_MIME_BY_EXT[ext]
          const videoMime = VIDEO_MIME_BY_EXT[ext]
          if (audioMime || videoMime) {
            if (!projectPath) return
            const abs = joinPath(projectPath, rel)
            const name = abs.split(/[/\\]/).pop() || abs
            setPlayingMedia({
              absPath: abs,
              relPath: rel,
              mimeType: (audioMime || videoMime) as string,
              fileName: name,
              type: audioMime ? 'audio' : 'video'
            })
          } else {
            setPreviewRelPath(rel)
          }
        }}
        modelOutRef={treeModelRef}
      />
    )
  }

  /**
   * 关闭预览：清掉本地状态 + 取消 pierre 树的选中。
   * 不取消选中会卡 pierre 的 selectionVersion —— 再次点击同一文件 #applySelection
   * 短路（selection 未变），useFileTreeSelection 不更新，预览无法重新打开。
   */
  const closePreview = useCallback(() => {
    setPreviewRelPath((prev) => {
      if (prev) treeModelRef.current?.getItem(prev)?.deselect()
      return null
    })
  }, [])

  // 文件被删时关闭预览（freshState.paths 已经经过 watcher 同步重扫）
  useEffect(() => {
    if (!previewRelPath || !freshState) return
    if (!freshState.paths.includes(previewRelPath)) {
      setPreviewRelPath(null) // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [freshState, previewRelPath])

  // 笔记本 [[wiki-link]] 请求：在本面板打开目标文件预览（绝对路径在 projectPath 下才处理）。
  // 含 nonce → 重复点击同一文件也触发；宿主负责打开右面板并切到 Files tab。
  useEffect(() => {
    if (!filePreviewRequest || !projectPath) return
    const rel = relativize(projectPath, filePreviewRequest.absPath)
    if (rel) setPreviewRelPath(rel) // eslint-disable-line react-hooks/set-state-in-effect
  }, [filePreviewRequest, projectPath])

  /** 把 pierre 树相对路径拼成宿主机绝对路径（不引 node:path，兼容 win 分隔符） */
  const previewAbsPath =
    previewRelPath && projectPath ? joinPath(projectPath, previewRelPath) : null
  /** 预览的是否为 markdown —— 决定是否在预览顶栏显示「创建笔记本」按钮 */
  const previewIsMarkdown = !!previewRelPath && MARKDOWN_EXTS.has(extOf(previewRelPath))

  const folderName = projectPath ? basename(projectPath) : ''

  return (
    <div className="flex flex-col h-full bg-bg-secondary">
      {/* 顶栏：左侧工作目录名（大写）+ 右侧 truncated 提示 + 搜索 + 刷新 */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-2 h-7 border-b border-border-secondary/30">
        <div className="flex items-center gap-0.5 min-w-0 max-w-[60%]">
          <span
            className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary truncate"
            title={projectPath ?? ''}
          >
            {folderName}
          </span>
          {projectPath && onOpenFolder && (
            <button
              onClick={() => onOpenFolder(projectPath)}
              className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 transition-colors flex-shrink-0"
              title={projectPath}
            >
              <Folder size={11} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 min-w-0">
          {freshState?.truncated && (
            <span className="text-[10px] text-text-tertiary/70 truncate">
              {t('panel.filesTruncated', { count: freshState.paths.length })}
            </span>
          )}
          <button
            onClick={toggleSearch}
            disabled={!freshState}
            className={`p-1 rounded hover:bg-bg-hover/40 disabled:opacity-40 disabled:hover:bg-transparent transition-colors ${
              searchOpen
                ? 'text-text-primary bg-bg-hover/30'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
            title={t('panel.filesSearch')}
          >
            <Search size={11} />
          </button>
          <button
            onClick={handleRefresh}
            disabled={!sessionId || !projectPath}
            className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
            title={t('panel.filesRefresh')}
          >
            <RefreshCw size={11} className={showLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* 搜索栏：自渲染 input，绕开库内置 search UI 的 blur=close、首项高亮等问题 */}
      {searchOpen && (
        <div className="flex-shrink-0 flex items-center gap-1 px-2 pt-2">
          <div className="flex-1 relative">
            <Search
              size={11}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary/60 pointer-events-none"
            />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setSearchQuery('')
                  setSearchOpen(false)
                }
              }}
              placeholder={t('panel.filesSearch')}
              className="w-full pl-6 pr-6 py-1 rounded text-[11px] bg-bg-primary border border-border-secondary focus:border-accent/60 outline-none text-text-primary placeholder:text-text-tertiary/60 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('')
                  searchInputRef.current?.focus()
                }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-tertiary/60 hover:text-text-secondary hover:bg-bg-hover/40 transition-colors"
                title={t('common.clear')}
              >
                <X size={10} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 pt-2 relative">
        {content}
        {previewAbsPath && sessionId && (
          <div className="absolute inset-0 z-10 flex flex-col bg-bg-secondary">
            <FilePreview
              path={previewAbsPath}
              sessionId={sessionId}
              onClose={closePreview}
              caps={notebookCaps}
              onCreateNotebook={
                previewIsMarkdown && onCreateNotebook
                  ? () => onCreateNotebook({ path: previewAbsPath, sessionId })
                  : undefined
              }
            />
          </div>
        )}
      </div>

      {/* 媒体 dock —— flex-shrink-0，与文件树并列垂直布局，不遮挡 */}
      {playingMedia &&
        sessionId &&
        (playingMedia.type === 'audio' ? (
          <AudioDock
            path={playingMedia.absPath}
            mimeType={playingMedia.mimeType}
            fileName={playingMedia.fileName}
            sessionId={sessionId}
            onClose={() => setPlayingMedia(null)}
            onExpand={() => {
              setPreviewRelPath(playingMedia.relPath)
              setPlayingMedia(null)
            }}
          />
        ) : (
          // key 强制切片时整组件 remount —— aspect 自动复位 + 原生 video 元素重挂载
          <VideoDock
            key={playingMedia.absPath}
            path={playingMedia.absPath}
            mimeType={playingMedia.mimeType}
            fileName={playingMedia.fileName}
            sessionId={sessionId}
            onClose={() => setPlayingMedia(null)}
            onExpand={() => {
              setPreviewRelPath(playingMedia.relPath)
              setPlayingMedia(null)
            }}
          />
        ))}
    </div>
  )
}

/**
 * 树渲染容器
 * key 由父组件按 root 切换，保证不同工作目录间彻底重建模型；
 * 同一 root 下的增量更新通过 model.resetPaths 推送
 *
 * 搜索过滤完全走 controller.setSearch / closeSearch，不启用库内置的 search input UI
 */
function FilesTree({
  paths,
  searchQuery,
  onFileSelect,
  modelOutRef
}: {
  paths: string[]
  searchQuery: string
  /** 用户点击文件行（不含目录）时回调，传相对路径 */
  onFileSelect: (relPath: string) => void
  /** 让父组件持有 model 引用，用于关闭预览时 deselect */
  modelOutRef?: React.RefObject<FileTreeModel | null>
}): React.JSX.Element {
  // 用 ref 持有最新回调，组件保留 mount 时的 model 实例
  const onSelectRef = useRef(onFileSelect)
  useEffect(() => {
    onSelectRef.current = onFileSelect
  }, [onFileSelect])

  const { model } = useFileTree({
    paths,
    initialExpansion: 'closed',
    dragAndDrop: false,
    flattenEmptyDirectories: true,
    // 紧凑布局，与侧边栏视觉密度对齐
    density: 'compact',
    itemHeight: 22
  })

  // 把 model 暴露给父组件 —— 关闭预览时父组件需要 deselect
  useEffect(() => {
    if (!modelOutRef) return
    modelOutRef.current = model
    return () => {
      modelOutRef.current = null
    }
  }, [model, modelOutRef])

  // 选择订阅 —— 不能用 useFileTree options 里的 onSelectionChange（pierre 只在 model
  // 构造时消费一次）；也不用 useFileTreeSelection 包装（useSyncExternalStore 的订阅在
  // mount 之后才挂上去，且内部 selector 每次渲染都是新函数会破坏其缓存，导致 workspace
  // 切换后首次 click 偶发性丢失）。直接 model.subscribe 是最稳的路径：mount 即时挂载，
  // pierre 内部已经吃掉 initial snapshot 不会回调一次空选区，关闭闭包变量 lastNotified
  // 在 unmount 时随 cleanup 一起释放，无跨 mount 状态泄漏。
  useEffect(() => {
    let lastNotified: string | null = model.getSelectedPaths()[0] ?? null
    const unsubscribe = model.subscribe(() => {
      const p = model.getSelectedPaths()[0] ?? null
      if (lastNotified === p) return
      lastNotified = p
      if (!p) return
      const item = model.getItem(p)
      // 目录交给树自身展开/收起，不进预览
      if (!item || item.isDirectory()) return
      onSelectRef.current(p)
    })
    return unsubscribe
  }, [model])

  // 首次挂载已经把 paths 传给了 useFileTree；后续 paths 变化通过 resetPaths 同步。
  // resetPaths 是整树重建（选中有迁移逻辑，展开状态没有）—— 不带 initialExpandedPaths
  // 会全部收起，因此重建前逐目录读出当前展开状态原样带过去。目录集合从新 paths 推导
  // （已删除的目录无需保留；新增目录在旧模型里查不到句柄，自然跳过）。
  const isFirst = useRef(true)
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false
      return
    }
    const dirs = new Set<string>()
    for (const p of paths) {
      const segments = p.split('/')
      for (let i = 1; i < segments.length; i++) {
        dirs.add(`${segments.slice(0, i).join('/')}/`) // pierre 目录规范路径带尾斜杠
      }
    }
    const expanded: string[] = []
    for (const dir of dirs) {
      const item = model.getItem(dir)
      if (item && 'isExpanded' in item && item.isExpanded()) expanded.push(dir)
    }
    model.resetPaths(paths, { initialExpandedPaths: expanded })
  }, [paths, model])

  // 把外部搜索查询透传到 controller —— 空串视作关闭搜索
  // 库内部在点击行时会强制 closeSearch（fileTreeRowClickPlan.js: closeSearch: isSearchOpen），
  // 因此订阅 isOpen，一旦库自行关闭而我们仍有查询，立刻重新 setSearch 恢复过滤
  const { isOpen: libraryIsOpen } = useFileTreeSearch(model)
  useEffect(() => {
    if (searchQuery) {
      if (!libraryIsOpen) model.setSearch(searchQuery)
      else if (model.getSearchValue() !== searchQuery) model.setSearch(searchQuery)
    } else if (libraryIsOpen) {
      model.closeSearch()
    }
  }, [searchQuery, libraryIsOpen, model])

  // 把 ShuviX 主题 CSS 变量桥接到 @pierre/trees 的覆盖变量
  // 字号 / 行高 / 横向内边距 进一步压缩，对齐侧边栏密度（text-[12px] + px-1.5 风格）
  const treeStyle = {
    height: '100%',
    width: '100%',
    // 颜色
    '--trees-bg-override': 'var(--color-bg-secondary)',
    '--trees-fg-override': 'var(--color-text-primary)',
    '--trees-fg-muted-override': 'var(--color-text-secondary)',
    '--trees-selected-bg-override': 'var(--color-bg-active)',
    '--trees-border-color-override': 'var(--color-border-secondary)',
    '--trees-accent-override': 'var(--color-accent)',
    // 字体与字号 — 与侧边栏对齐
    '--trees-font-size-override': '12px',
    '--trees-font-family-override': 'inherit',
    // 横向内边距 — 默认 16px 偏宽，压到 8px
    '--trees-padding-inline-override': '8px',
    // 缩进每层 12px，跟侧边栏 ml-1.5 / pl-0.5 相近
    '--trees-level-gap-override': '12px'
  } as React.CSSProperties

  return <FileTree model={model} style={treeStyle} />
}

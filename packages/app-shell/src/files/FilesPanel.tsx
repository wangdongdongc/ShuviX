/**
 * FilesPanel — 会话面板"Files"标签
 * 显示当前会话工作目录的文件树，并实时跟随磁盘变化
 * 基于 @pierre/trees（path-first + Shadow DOM 隔离）
 *
 * 文件预览不在本面板内：点击文件（音视频除外，走底部 dock）发 chatStore.requestFilePreview，
 * 由宿主的独立预览面板（桌面右侧 preview tab / 扩展与悬浮窗 PreviewOverlay）承接展示。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, RefreshCw, Search, X } from 'lucide-react'
import type { FileTree as FileTreeModel } from '@pierre/trees'
import { FilesTree } from './FilesTree'
import { useChatStore, getSessionChannelApi, useAppEvent } from '@shuvix/chat-ui'
import { isContentOnlyFileChange } from '@shuvix/chat-protocol/utils/fileMap'
import { AudioDock } from './AudioDock'
import { VideoDock } from './VideoDock'
import { extOf, basename, joinPath } from './paths'

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
  /** 在系统文件管理器中打开工作目录（宿主注入）；提供则在工作目录名旁显示按钮。
   *  桌面注入 getHostApi().app.openFolder；扩展无原生文件管理器故不注入。 */
  onOpenFolder?: (projectPath: string) => void
}

export function FilesPanel({ onOpenFolder }: FilesPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const sessionId = useChatStore((s) => s.activeSessionId)
  const projectPath = useChatStore((s) => s.projectPath)

  const [state, setState] = useState<ScanState | null>(null)
  const [error, setError] = useState<ScanError | null>(null)
  /** 手动刷新触发器：递增以重跑扫描 effect */
  const [refreshNonce, setRefreshNonce] = useState(0)
  /** 搜索栏是否展开 */
  const [searchOpen, setSearchOpen] = useState(false)
  /** 搜索查询字符串。空字符串视作未触发搜索 */
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  /** 媒体 dock 状态（音视频共享同一槽位）—— 独立于文件预览，让用户听/看的同时仍能浏览树。
   *  音视频互斥：放新的会替换旧的。absPath 供 dock 的「展开」按钮转投独立预览面板。 */
  const [playingMedia, setPlayingMedia] = useState<{
    absPath: string
    relPath: string
    mimeType: string
    fileName: string
    type: 'audio' | 'video'
  } | null>(null)
  /** 暴露的 FilesTree model 句柄：点击文件发预览请求后立即取消 pierre 选中，
   *  否则同一文件的再次点击不触发 onFileSelect（selection 未变化被短路） */
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

  // 项目 / 会话切换时停止音视频 dock（避免读到旧会话工作目录里的文件；
  // 独立预览面板持自身 sessionId 快照，不在此关）
  useEffect(() => {
    setPlayingMedia(null) // eslint-disable-line react-hooks/set-state-in-effect
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
        // 与并排的对话列滚动条同款（常显 + 同色）；侧栏 WikiView 不传，沿用 pierre 的 hover 才现
        persistentScrollbar
        onFileSelect={(rel) => {
          if (!projectPath) return
          const ext = extOf(rel)
          const audioMime = AUDIO_MIME_BY_EXT[ext]
          const videoMime = VIDEO_MIME_BY_EXT[ext]
          const abs = joinPath(projectPath, rel)
          if (audioMime || videoMime) {
            // 音频 / 视频：上底部 dock，文件树继续可见
            const name = abs.split(/[/\\]/).pop() || abs
            setPlayingMedia({
              absPath: abs,
              relPath: rel,
              mimeType: (audioMime || videoMime) as string,
              fileName: name,
              type: audioMime ? 'audio' : 'video'
            })
          } else {
            // 其它文件：发预览请求（宿主的独立预览面板承接展示）
            useChatStore.getState().requestFilePreview(abs)
          }
          // 立即取消 pierre 选中：不取消会卡 selectionVersion —— 再次点击同一文件
          // #applySelection 短路（selection 未变），onFileSelect 不再触发
          treeModelRef.current?.getItem(rel)?.deselect()
        }}
        modelOutRef={treeModelRef}
      />
    )
  }

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

      <div className="flex-1 min-h-0 pt-2 relative">{content}</div>

      {/* 媒体 dock —— flex-shrink-0，与文件树并列垂直布局，不遮挡；「展开」转投独立预览面板 */}
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
              useChatStore.getState().requestFilePreview(playingMedia.absPath)
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
              useChatStore.getState().requestFilePreview(playingMedia.absPath)
              setPlayingMedia(null)
            }}
          />
        ))}
    </div>
  )
}

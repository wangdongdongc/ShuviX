/**
 * FilesPanel — 会话面板"Files"标签
 * 显示当前会话工作目录的文件树，并实时跟随磁盘变化
 * 基于 @pierre/trees（path-first + Shadow DOM 隔离）
 *
 * 加载模型是按目录懒加载的分片模型：初始只扫根目录（files.scanDir，浅扫描无截断），
 * 目录首次展开时再扫该目录（FilesTree 的 onRequestChildren），files.changed 事件与
 * 聚焦/手动刷新都对「已加载分片」做增量 add/remove，不再整树 rg 重扫（大仓上全量
 * 扫描有 SCAN_LIMIT 截断且输出顺序不定，会随机丢条目）。全量 files.scan 仅保留给
 * 搜索：输入搜索词时全量扫一次注入树内，清空后清回懒加载视图。
 *
 * 文件预览不在本面板内：点击文件（音视频除外，走底部 dock）发 chatStore.requestFilePreview，
 * 由宿主的独立预览面板（桌面右侧 preview tab / 扩展与悬浮窗 PreviewOverlay）承接展示。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, RefreshCw, Search, X } from 'lucide-react'
import type { FileTree as FileTreeModel } from '@pierre/trees'
import { FilesTree } from './FilesTree'
import { LoadedSlices, dirKeyOf, dirParamOf } from './lazyTree'
import { usePanelCloseInset } from '../panel/panelCloseInset'
import { useChatStore, getSessionChannelApi, useAppEvent } from '@shuvix/chat-ui'
import { isContentOnlyFileChange, relativizeLoose } from '@shuvix/chat-protocol/utils/fileMap'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
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
  /** 根分片 scanDir 结果 —— 只作 FilesTree 的首批 paths，此后不再整树替换 */
  paths: string[]
}

interface ScanError {
  forRoot: string
  message: string
}

type FilesChangedEvent = Extract<AppEvent, { type: 'files.changed' }>

export interface FilesPanelProps {
  /** 在系统文件管理器中打开工作目录（宿主注入）；提供则在工作目录名旁显示按钮。
   *  桌面注入 getHostApi().app.openFolder；扩展无原生文件管理器故不注入。 */
  onOpenFolder?: (projectPath: string) => void
}

export function FilesPanel({ onOpenFolder }: FilesPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const sessionId = useChatStore((s) => s.activeSessionId)
  const projectPath = useChatStore((s) => s.projectPath)
  const closeInset = usePanelCloseInset()

  const [state, setState] = useState<ScanState | null>(null)
  const [error, setError] = useState<ScanError | null>(null)
  /** 搜索栏是否展开 */
  const [searchOpen, setSearchOpen] = useState(false)
  /** 搜索查询字符串。空字符串视作未触发搜索 */
  const [searchQuery, setSearchQuery] = useState('')
  /** 搜索全量扫描的截断信息（已注入路径数）—— 仅搜索场景展示（懒加载浏览无截断） */
  const [searchTruncCount, setSearchTruncCount] = useState<number | null>(null)
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
  /** 暴露的 FilesTree model 句柄：增量增删与点击后 deselect 都走它 */
  const treeModelRef = useRef<FileTreeModel | null>(null)
  /** 已加载分片账本（dirKey → 路径集合 + 已知路径计数）；随 projectPath 重建 */
  const slicesRef = useRef(new LoadedSlices())
  /** 当前工作目录标识 —— 异步回调里校验结果是否仍匹配当前 projectPath */
  const rootRef = useRef<string | null>(null)

  // 渲染层防抖：200ms 内的连续 files.changed 事件合并为一批增量应用
  const changeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingEvents = useRef<FilesChangedEvent[]>([])

  /** 当前 root 仍有效（未切项目、账本未被重建）才应用异步结果 */
  const isCurrent = useCallback((root: string, slices: LoadedSlices): boolean => {
    return useChatStore.getState().projectPath === root && slicesRef.current === slices
  }, [])

  const applyOps = useCallback((ops: { add: string[]; remove: string[] }): void => {
    const model = treeModelRef.current
    if (!model) return
    const batch = [
      ...ops.remove.map((p) => ({ type: 'remove' as const, path: p })),
      ...ops.add.map((p) => ({ type: 'add' as const, path: p }))
    ]
    if (batch.length) model.batch(batch)
  }, [])

  /**
   * 扫描一个目录分片并记账。dir 为 scanDir 参数形式（'' = 根，无尾斜杠）。
   * 返回要注入树的路径列表（目录尾斜杠条目在前）；结果过期/无工作目录时抛错，
   * 让 FilesTree 的懒加载按失败处理（下次展开重试）。
   */
  const loadSlice = useCallback(async (dir: string): Promise<string[]> => {
    const id = useChatStore.getState().activeSessionId
    if (!id) throw new Error('no active session')
    const slices = slicesRef.current
    const r = await getSessionChannelApi().files.scanDir({ sessionId: id, dir })
    const root = r.root
    if (!root) throw new Error('no working directory')
    // 异步竞态：等待期间用户已切到不同 workingDirectory（账本随之重建）→ 丢弃旧结果
    if (useChatStore.getState().projectPath !== root || slicesRef.current !== slices) {
      throw new Error('stale scan result')
    }
    const paths = [...r.dirs, ...r.files]
    slices.load(dirKeyOf(dir), paths)
    return paths
  }, [])

  /** 目录首次展开的懒加载回调（FilesTree 保证同一目录只请求一次） */
  const handleRequestChildren = useCallback(
    (dirRelPath: string): Promise<string[]> => loadSlice(dirRelPath),
    [loadSlice]
  )

  /**
   * 刷新全部已加载分片（聚焦重扫 / 手动刷新 / 未知形状的文件事件兜底）：
   * 逐分片 scanDir 后 diff 应用增删，不整树重建。
   */
  const refreshSlices = useCallback(async (): Promise<void> => {
    const id = useChatStore.getState().activeSessionId
    const root = rootRef.current
    if (!id || !root) return
    const slices = slicesRef.current
    for (const dirKey of slices.dirKeys()) {
      if (!isCurrent(root, slices)) return
      try {
        const r = await getSessionChannelApi().files.scanDir({
          sessionId: id,
          dir: dirParamOf(dirKey)
        })
        if (r.root !== root || !isCurrent(root, slices)) return
        applyOps(slices.planRefresh(dirKey, [...r.dirs, ...r.files]))
      } catch {
        // 单分片失败（如目录刚被删）跳过，其余分片照常
      }
    }
  }, [applyOps, isCurrent])

  // 仅 projectPath 触发初始根分片扫描；同项目内会话切换（wd 不变）不重扫
  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    const slices = new LoadedSlices()
    slicesRef.current = slices
    rootRef.current = projectPath
    loadSlice('')
      .then((paths) => {
        if (cancelled || !isCurrent(projectPath, slices)) return
        setState({ forRoot: projectPath, paths: [...paths].sort() })
        setError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setError({
          forRoot: projectPath,
          message: e instanceof Error ? e.message : String(e)
        })
      })
    return () => {
      cancelled = true
    }
  }, [projectPath, loadSlice, isCurrent])

  // 项目 / 会话切换时停止音视频 dock（避免读到旧会话工作目录里的文件；
  // 独立预览面板持自身 sessionId 快照，不在此关）
  useEffect(() => {
    setPlayingMedia(null) // eslint-disable-line react-hooks/set-state-in-effect
  }, [projectPath, sessionId])

  /** 应用一批 files.changed 事件：纯内容变更跳过；未知形状（无 paths/kind）兜底刷新分片 */
  const flushPendingEvents = useCallback((): void => {
    const events = pendingEvents.current
    pendingEvents.current = []
    const root = rootRef.current
    const slices = slicesRef.current
    if (!root) return
    for (const e of events) {
      if (!e.paths?.length || !e.kind) {
        void refreshSlices()
        continue
      }
      if (isContentOnlyFileChange(e, (rel) => slices.isKnown(rel))) continue
      const rels = e.paths
        .map((p) => relativizeLoose(root, p))
        .filter((rel): rel is string => !!rel)
      applyOps(slices.planChange(rels, e.kind))
    }
  }, [applyOps, refreshSlices])

  // 订阅文件变动事件（AppEvent 'files.changed'），按 root 过滤；防抖 200ms 后增量应用。
  // 纯内容变更（edit/write 且路径均已在模型中）不可能改变列表成员 → 跳过，
  // 笔记本自动保存、agent 编辑已有文件不再触发任何树操作。
  useAppEvent('files.changed', (e) => {
    if (!projectPath || e.root !== projectPath) return
    pendingEvents.current.push(e)
    if (changeTimer.current) clearTimeout(changeTimer.current)
    changeTimer.current = setTimeout(() => {
      changeTimer.current = null
      flushPendingEvents()
    }, 200)
  })
  // 卸载时清理悬挂的防抖计时器
  useEffect(
    () => () => {
      if (changeTimer.current) clearTimeout(changeTimer.current)
    },
    []
  )

  // 窗口重新聚焦时刷新已加载分片 —— 外部进程（别的编辑器 / git / 构建）增删文件的兜底。
  // 带 1.5s 节流；逐分片 diff 应用，树不重建、展开状态不丢。
  const lastFocusScan = useRef(0)
  useEffect(() => {
    const onFocus = (): void => {
      const now = Date.now()
      if (now - lastFocusScan.current < 1500) return
      lastFocusScan.current = now
      void refreshSlices()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshSlices])

  const handleRefresh = useCallback(() => {
    void refreshSlices()
  }, [refreshSlices])

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

  // —— 搜索：首个非空查询触发一次全量 files.scan（保留截断兜底），结果注入树内由
  // pierre setSearch 按键过滤；清空查询 / 关闭搜索时把注入的额外路径清回已加载分片集合 ——
  const searchScanned = useRef(false)
  useEffect(() => {
    if (!searchOpen || !searchQuery || searchScanned.current) return
    const timer = setTimeout(() => {
      const id = useChatStore.getState().activeSessionId
      if (!id) return
      getSessionChannelApi()
        .files.scan({ sessionId: id })
        .then((r) => {
          if (!r.root || !isCurrent(r.root, slicesRef.current)) return
          searchScanned.current = true
          setSearchTruncCount(r.truncated ? r.paths.length : null)
          const add = slicesRef.current.addInjected(r.paths)
          const model = treeModelRef.current
          if (model && add.length) {
            model.batch(add.map((p) => ({ type: 'add' as const, path: p })))
          }
        })
        .catch(() => {
          searchScanned.current = true // 失败不再重试本次搜索会话，下次输入重新扫
        })
    }, 300)
    return () => clearTimeout(timer)
  }, [searchOpen, searchQuery, isCurrent])

  // 查询清空 / 搜索关闭：移除搜索注入的额外路径，恢复懒加载视图
  useEffect(() => {
    if (searchOpen && searchQuery) return
    if (!searchScanned.current) return
    searchScanned.current = false
    setSearchTruncCount(null) // eslint-disable-line react-hooks/set-state-in-effect
    const remove = slicesRef.current.removeInjected()
    const model = treeModelRef.current
    if (model && remove.length) {
      model.batch(remove.map((p) => ({ type: 'remove' as const, path: p })))
    }
  }, [searchOpen, searchQuery])

  // 项目切换（账本重建）时搜索注入随旧树一并废弃，重置搜索扫描标记
  useEffect(() => {
    searchScanned.current = false
    setSearchTruncCount(null) // eslint-disable-line react-hooks/set-state-in-effect
  }, [projectPath])

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
        onRequestChildren={handleRequestChildren}
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
      {/* 顶栏：左侧工作目录名（大写）+ 右侧搜索截断提示 + 搜索 + 刷新 */}
      {/* 头部：会话面板里要给悬在卡片右上角的收起按钮让出位置（pr-8 = 8px 内缩 + 21px 按钮 + 缝） */}
      <div
        className={`flex-shrink-0 flex items-center justify-between gap-2 px-2 h-7 border-b border-border-secondary/30${
          closeInset ? ' pr-8' : ''
        }`}
      >
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
          {searchOpen && searchTruncCount !== null && (
            <span className="text-[10px] text-text-tertiary/70 truncate">
              {t('panel.filesTruncated', { count: searchTruncCount })}
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

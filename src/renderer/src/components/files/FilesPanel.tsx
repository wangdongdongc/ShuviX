/**
 * FilesPanel — 右侧面板"Files"标签
 * 显示当前会话工作目录的文件树，并实时跟随磁盘变化
 * 基于 @pierre/trees（path-first + Shadow DOM 隔离）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Search, X } from 'lucide-react'
import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react'
import { useChatStore } from '../../stores/chatStore'

interface ScanState {
  /** 此结果对应的工作目录（root），用于判定数据是否仍匹配当前 projectPath */
  forRoot: string
  paths: string[]
  truncated: boolean
}

interface ScanError {
  forRoot: string
  message: string
}

export function FilesPanel(): React.JSX.Element {
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
      const r = await window.api.files.scan({ sessionId: id })
      if (!r.root) return
      // 异步竞态：若用户已切到不同 workingDirectory，丢弃旧结果
      if (useChatStore.getState().projectPath !== r.root) return
      setState({ forRoot: r.root, paths: r.paths, truncated: r.truncated })
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

  // 订阅文件变动事件，按 root 过滤；防抖 200ms 后重扫
  useEffect(() => {
    if (!projectPath) return
    const unsubscribe = window.api.files.onChanged((p) => {
      if (p.root !== projectPath) return
      if (rescanTimer.current) clearTimeout(rescanTimer.current)
      rescanTimer.current = setTimeout(() => {
        rescanTimer.current = null
        void scan()
      }, 200)
    })
    return () => {
      unsubscribe()
      if (rescanTimer.current) {
        clearTimeout(rescanTimer.current)
        rescanTimer.current = null
      }
    }
  }, [projectPath, scan])

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
      <div className="flex items-center justify-center h-full text-xs text-text-tertiary">
        {t('panel.filesEmpty')}
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
      />
    )
  }

  const folderName = projectPath ? basename(projectPath) : ''

  return (
    <div className="flex flex-col h-full bg-bg-secondary">
      {/* 顶栏：左侧工作目录名（大写）+ 右侧 truncated 提示 + 搜索 + 刷新 */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-2 h-7 border-b border-border-secondary/30">
        <span
          className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary truncate max-w-[50%]"
          title={projectPath ?? ''}
        >
          {folderName}
        </span>
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

      <div className="flex-1 min-h-0 pt-2">{content}</div>
    </div>
  )
}

/** 取路径最后一段（兼容 POSIX 与 Windows 分隔符），不依赖 node:path */
function basename(p: string): string {
  const s = p.replace(/[/\\]+$/, '')
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return idx >= 0 ? s.slice(idx + 1) : s
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
  searchQuery
}: {
  paths: string[]
  searchQuery: string
}): React.JSX.Element {
  const { model } = useFileTree({
    paths,
    initialExpansion: 'closed',
    dragAndDrop: false,
    flattenEmptyDirectories: true,
    // 紧凑布局，与侧边栏视觉密度对齐
    density: 'compact',
    itemHeight: 22
  })

  // 首次挂载已经把 paths 传给了 useFileTree；后续 paths 变化通过 resetPaths 同步
  const isFirst = useRef(true)
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false
      return
    }
    model.resetPaths(paths)
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

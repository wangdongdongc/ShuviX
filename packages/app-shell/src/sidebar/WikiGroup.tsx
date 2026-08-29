/**
 * WikiGroup —— 项目视图里的知识库置顶特殊分组（替代原独立 Wiki 视图）。
 * 隐藏 wiki 项目（Wiki Curator 产物目录）的条目列表：主题（一级目录，可折叠）→ 条目（md 文件）。
 * prop 驱动、不触宿主 API：文件清单与点击行为由宿主注入
 * （桌面端注入 window.api.wiki.listFiles / openNote，点击条目打开或复用其笔记本会话）。
 *
 * 刻意不用 FilesPanel 的 pierre FilesTree —— Shadow DOM 自成一套视觉，与侧栏风格不合；
 * 行样式对齐 SessionItem（13px / truncate / bg-bg-active 选中态），分组头经 SessionGroup
 * 的 wiki 形态渲染。条目显示名取 frontmatter `name`（main 侧经 parseWikiEntryHead 解析，
 * 见 wikiFileContract），回退文件名 stem；`WIKI.md` 章程置于主题首位（ScrollText 图标）。
 * 扫描是懒的：**首次展开才扫**（保持 wikiService 懒建根目录的"用户意图"语义），之后
 * 每次展开 + 窗口聚焦重扫，stale-guard 防乱序回包（与原 FilesPanel 策略一致）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, FolderClosed, FolderOpen, RefreshCw, ScrollText } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'
import { WIKI_PROJECT_ID } from '@shuvix/chat-protocol/wiki'
import { AnimatedCollapse } from '../common/AnimatedCollapse'
import { SessionGroup } from './SessionGroup'
import { useFocusDim } from './useFocusDim'

/** listFiles 返回的单个文件：wiki 根下相对路径 + 条目显示名（取不到为 null，回退 stem） */
export interface WikiFileInfo {
  path: string
  name: string | null
}

export interface WikiGroupProps {
  /** 拉取 wiki 根下全部 md（相对路径 + 条目显示名；宿主注入，须为稳定引用避免重复扫描） */
  listFiles: () => Promise<{ files: WikiFileInfo[]; truncated: boolean; root: string }>
  /** 点击条目（相对路径）；宿主负责打开/复用笔记本会话 */
  onSelectFile: (relPath: string) => void | Promise<void>
}

const MD_EXT_RE = /\.(md|mdx|markdown)$/i
/** 行缩进：基准同 SessionItem 的 pl-2.5（10px），每层再进 12px */
const indent = (depth: number): number => 10 + depth * 12

interface WikiFileRow {
  path: string
  label: string
  /** 主题章程（WIKI.md）—— 置于主题首位、ScrollText 图标 */
  charter: boolean
}

interface WikiDirNode {
  name: string
  /** 显示名：主题章程（WIKI.md）frontmatter 的 name，缺省即目录名 */
  label: string
  path: string
  dirs: WikiDirNode[]
  files: WikiFileRow[]
}

/** 相对路径清单 → 目录树（约定：根下一层主题目录 + 条目；更深层递归兜底） */
function buildTree(files: WikiFileInfo[]): WikiDirNode {
  const root: WikiDirNode = { name: '', label: '', path: '', dirs: [], files: [] }
  const dirIndex = new Map<string, WikiDirNode>([['', root]])
  const ensureDir = (dirPath: string): WikiDirNode => {
    const existing = dirIndex.get(dirPath)
    if (existing) return existing
    const cut = dirPath.lastIndexOf('/')
    const parent = ensureDir(cut === -1 ? '' : dirPath.slice(0, cut))
    const seg = cut === -1 ? dirPath : dirPath.slice(cut + 1)
    const node: WikiDirNode = { name: seg, label: seg, path: dirPath, dirs: [], files: [] }
    parent.dirs.push(node)
    dirIndex.set(dirPath, node)
    return node
  }
  for (const f of files) {
    const rel = f.path.replace(/\\/g, '/')
    const cut = rel.lastIndexOf('/')
    const dir = ensureDir(cut === -1 ? '' : rel.slice(0, cut))
    const stem = (cut === -1 ? rel : rel.slice(cut + 1)).replace(MD_EXT_RE, '')
    const charter = stem.toLowerCase() === 'wiki'
    // 章程的 frontmatter name 是**主题**的显示名：提升为目录行标签（目录名兜底），
    // 章程行自身固定显示 stem（"WIKI"）—— 目录行正上方再重复一遍主题名毫无信息量
    if (charter && f.name?.trim() && dir.path !== '') dir.label = f.name.trim()
    dir.files.push({
      path: rel,
      label: charter ? stem : f.name?.trim() || stem,
      charter
    })
  }
  const sortNode = (n: WikiDirNode): void => {
    n.dirs.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase(), 'zh-CN'))
    n.files.sort((a, b) =>
      a.charter !== b.charter
        ? a.charter
          ? -1
          : 1
        : a.label.toLowerCase().localeCompare(b.label.toLowerCase(), 'zh-CN')
    )
    n.dirs.forEach(sortNode)
  }
  sortNode(root)
  return root
}

export function WikiGroup({ listFiles, onSelectFile }: WikiGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  const { dim } = useFocusDim()

  // 活动会话是否为 wiki 笔记本（分组头高亮 + 命中行选中态）
  const activeNotePath = useChatStore((s) => {
    const active = s.sessions.find((x) => x.id === s.activeSessionId)
    if (active?.projectId !== WIKI_PROJECT_ID) return null
    return active.settings.notebookPath?.replace(/\\/g, '/') ?? null
  })
  const isWikiActive = activeNotePath !== null

  const [collapsed, setCollapsed] = useState(true)
  const [files, setFiles] = useState<WikiFileInfo[] | null>(null)
  // 展开集而非折叠集：主题默认折叠，重扫新增的主题天然保持折叠，无需与扫描结果对账
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  // 是否扫过（聚焦重扫只在首次展开后生效，未展开不建 wiki 根目录）
  const scannedOnce = useRef(false)
  // 递增序号丢弃过期回包（快速聚焦/手动刷新并发时只认最后一次）
  const scanSeq = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    scannedOnce.current = true
    const seq = ++scanSeq.current
    try {
      const r = await listFiles()
      if (seq === scanSeq.current) setFiles(r.files)
    } catch {
      if (seq === scanSeq.current) setFiles([])
    }
  }, [listFiles])

  useEffect(() => {
    const onFocus = (): void => {
      if (scannedOnce.current) void scan()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [scan])

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    if (!next) void scan()
  }

  const toggleDir = (path: string): void =>
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const tree = useMemo(() => buildTree(files ?? []), [files])

  const renderFile = (f: WikiFileRow, depth: number): React.ReactNode => {
    const active = activeNotePath === f.path
    const Icon = f.charter ? ScrollText : FileText
    return (
      <div
        key={f.path}
        onClick={() => void onSelectFile(f.path)}
        style={{ paddingLeft: indent(depth) }}
        className={`flex items-center gap-1.5 pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
          active
            ? 'bg-bg-active/80 text-text-primary'
            : `text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary ${
                dim && isWikiActive ? 'opacity-30 hover:opacity-100' : ''
              }`
        }`}
      >
        <Icon
          size={11}
          className={`flex-shrink-0 ${active ? 'text-accent' : 'text-text-tertiary/40'}`}
        />
        <span className="flex-1 min-w-0 text-[13px] truncate">{f.label}</span>
      </div>
    )
  }

  const renderDir = (node: WikiDirNode, depth: number): React.ReactNode => {
    const dirCollapsed = !expandedDirs.has(node.path)
    return (
      <div key={node.path}>
        <div
          onClick={() => toggleDir(node.path)}
          style={{ paddingLeft: indent(depth) }}
          className={`flex items-center gap-1.5 pr-1.5 py-0.5 cursor-pointer text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary transition-opacity duration-200 ${
            dim && isWikiActive ? 'opacity-30 hover:opacity-100' : ''
          }`}
        >
          {dirCollapsed ? (
            <FolderClosed size={11} className="flex-shrink-0 text-text-tertiary/40" />
          ) : (
            <FolderOpen size={11} className="flex-shrink-0 text-text-tertiary/40" />
          )}
          <span className="flex-1 min-w-0 text-[13px] truncate">{node.label}</span>
        </div>
        <AnimatedCollapse open={!dirCollapsed}>
          {node.files.map((f) => renderFile(f, depth + 1))}
          {node.dirs.map((d) => renderDir(d, depth + 1))}
        </AnimatedCollapse>
      </div>
    )
  }

  return (
    <SessionGroup
      label={t('sidebar.wikiGroup')}
      variant="wiki"
      collapsed={collapsed}
      onToggle={toggle}
      active={isWikiActive}
      dim={dim && !isWikiActive}
      headerActions={
        <button
          onClick={(e) => {
            e.stopPropagation()
            void scan()
          }}
          className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/50 hover:text-text-secondary"
          title={t('panel.filesRefresh')}
        >
          <RefreshCw size={11} />
        </button>
      }
    >
      {files !== null &&
        (files.length === 0 ? (
          <div className="px-3 py-2 text-xs text-text-tertiary">{t('sidebar.wikiEmpty')}</div>
        ) : (
          <>
            {tree.files.map((f) => renderFile(f, 0))}
            {tree.dirs.map((d) => renderDir(d, 0))}
          </>
        ))}
    </SessionGroup>
  )
}

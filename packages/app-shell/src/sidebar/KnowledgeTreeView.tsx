/**
 * 知识库树的渲染（行 / 目录 / 徽标 / 就地新建 / 菜单）—— 侧栏两处共用：「知识库」分组
 * （KnowledgeGroup：用户库 + 置顶的内置库）与每个项目组里的「项目知识库」文件夹
 * （ProjectKnowledgeFolder：那个项目自己的库）。数据（清单）与扫描时机归调用方，这里只画。
 *
 * 行 = 一个 md（标题依次取 frontmatter title、正文第一个 # 标题、文件名），行尾徽标：草稿 / 已核实 /
 * 过期 / 已过时。点行经宿主打开 / 复用该文件的笔记本会话（隐藏承载项目：项目库 `__knowledge__`、
 * 用户库 `__knowledge_user__`、内置库 `__knowledge_builtin__`）。
 *
 * 动作全部收在菜单里（右键 / ⋮ 同一份）：目录行 = 新建条目 / 新建文件夹；条目行 = 在文件夹中显示 /
 * 复制路径。**新建就地输名字**：菜单点完在树里长出一行输入框（Enter 建、Esc 或失焦取消），名字交给
 * 宿主校验 —— 不合法 / 重名的原因显示在输入行下面，改一下再回车。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  BadgeCheck,
  BookMarked,
  CircleCheck,
  CircleDashed,
  ClockAlert,
  FileText,
  FolderClosed,
  FolderOpen,
  Lock
} from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'
import {
  KNOWLEDGE_BUILTIN_BASE,
  KNOWLEDGE_BUILTIN_DIR,
  KNOWLEDGE_BUILTIN_PROJECT_ID,
  KNOWLEDGE_PROJECT_ID,
  KNOWLEDGE_USER_PROJECT_ID,
  KNOWLEDGE_USER_ROOT_DIR,
  type KnowledgeEntry
} from '@shuvix/chat-protocol/knowledge'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { AnimatedCollapse } from '../common/AnimatedCollapse'
import { RowMenuButton } from './RowMenuButton'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import type { KnowledgeTreeDir, KnowledgeTreeFile } from './knowledgeTree'

/** 条目清单回包 */
export interface KnowledgeListing {
  /** 全部条目（视图形状，不含正文） */
  entries: KnowledgeEntry[]
  /** knowledge-shuvix 根的绝对路径（项目库条目 `projects/…` 相对它） */
  root: string
  /** 用户根的绝对路径（用户库条目 `knowledge/<库名>/…` 去掉首段后相对它） */
  userRoot: string
  /** 库与库内目录的 id（空目录也在其中 —— 新建出来的库 / 文件夹第一时间就是空的） */
  dirs: string[]
  /** bundle id → 显示名（项目库：项目当前的名字 —— 目录名是项目 id，不给人看；内置库：ShuviX） */
  bundleNames: Record<string, string>
  /** bundle id → 绝对目录，只给两个根拼不出来的那些（内置库在应用包里、路径里夹着语言层）；旧宿主不给 */
  bundleDirs?: Record<string, string>
}

/** 扫描失败时的空清单 */
export const EMPTY_KNOWLEDGE_LISTING: KnowledgeListing = {
  entries: [],
  root: '',
  userRoot: '',
  dirs: [],
  bundleNames: {},
  bundleDirs: {}
}

/** 新建的回包：失败时 error 是宿主给的、已本地化的人读原因 */
export interface KnowledgeCreateResult {
  success: boolean
  /** 新建出来的 id：知识库 / 文件夹是目录 id，条目是条目 id */
  id?: string
  error?: string
}

/** 宿主注入的知识库能力（桌面：window.api.knowledge 的窄投影） */
export interface KnowledgeGroupAdapter {
  /** 拉取条目清单（须为稳定引用，避免重复扫描） */
  list: () => Promise<KnowledgeListing>
  /** 打开一条（bundle 相对路径 + 显示名）：宿主负责打开 / 复用笔记本会话并选中 */
  open: (path: string, title: string) => void | Promise<void>
  /** 打开用户知识库根目录（OS 文件管理器）—— 建库、拷库都在这里 */
  openFolder: () => void | Promise<unknown>
  /** 在 OS 文件管理器里显示该条目文件；没有文件管理器的宿主不注入，菜单项随之不出现 */
  revealFile?: (path: string) => void | Promise<unknown>
  /** 新建用户知识库（用户根下一个目录）；不注入则菜单里没有这一项 */
  createBase?: (name: string) => Promise<KnowledgeCreateResult>
  /** 在某个目录（库本身或库里的一层）下新建文件夹 */
  createFolder?: (dir: string, name: string) => Promise<KnowledgeCreateResult>
  /** 在某个目录下新建条目：`title` 是标题，文件名由宿主按标题派生 */
  createEntry?: (dir: string, title: string) => Promise<KnowledgeCreateResult>
}

/** 内联新建行的三种落点 */
export type DraftKind = 'base' | 'folder' | 'entry'

const DRAFT_PLACEHOLDER: Record<DraftKind, string> = {
  base: 'knowledge.newBasePlaceholder',
  folder: 'knowledge.newFolderPlaceholder',
  entry: 'knowledge.newEntryPlaceholder'
}

/** 行缩进：基准同 SessionItem 的 pl-2.5（10px），每层再进 12px —— 与侧栏其余各组一致 */
const indent = (depth: number): number => 10 + depth * 12

/** 活动会话若是知识库笔记本，换算出它打开的条目 id（分组头 / 文件夹高亮 + 命中行选中态） */
export function useActiveKnowledgeNotePath(): string | null {
  return useChatStore((s) => {
    const active = s.sessions.find((x) => x.id === s.activeSessionId)
    const notebookPath = active?.settings.notebookPath?.replace(/\\/g, '/')
    if (!notebookPath) return null
    // 笔记本路径 → 条目 id：项目库的承载项目根在 knowledge-shuvix，路径即 id；
    // 用户库的承载项目根在用户根，id 要补回首段 `knowledge/`
    if (active?.projectId === KNOWLEDGE_PROJECT_ID) return notebookPath
    if (active?.projectId === KNOWLEDGE_USER_PROJECT_ID) {
      return `${KNOWLEDGE_USER_ROOT_DIR}/${notebookPath}`
    }
    // 内置库的承载项目根是库目录本身（语言层在宿主那边解析），id 要补回容器与库名
    if (active?.projectId === KNOWLEDGE_BUILTIN_PROJECT_ID) {
      return `${KNOWLEDGE_BUILTIN_DIR}/${KNOWLEDGE_BUILTIN_BASE}/${notebookPath}`
    }
    return null
  })
}

/** 就地新建的状态：哪一行在输名字、宿主回的错、是否正在建 */
export interface KnowledgeDraftState {
  draft: { kind: DraftKind; parent: string } | null
  error: string | null
  creating: boolean
  start: (kind: DraftKind, parent: string) => void
  close: () => void
  commit: (value: string) => Promise<void>
}

/** 就地新建：建完重扫，新条目建完直接打开它的笔记本（正文在那里写，属性在属性卡里改） */
export function useKnowledgeDraft(
  adapter: KnowledgeGroupAdapter,
  rescan: () => Promise<void>
): KnowledgeDraftState {
  const [draft, setDraft] = useState<{ kind: DraftKind; parent: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const close = (): void => {
    setDraft(null)
    setError(null)
  }

  const start = (kind: DraftKind, parent: string): void => {
    setDraft({ kind, parent })
    setError(null)
  }

  /** Enter 落地：宿主建，失败把原因留在行里（名字还在框里，改一下再回车） */
  const commit = async (value: string): Promise<void> => {
    if (!draft || creating) return
    const name = value.trim()
    if (!name) {
      close()
      return
    }
    const run =
      draft.kind === 'base'
        ? adapter.createBase?.(name)
        : draft.kind === 'folder'
          ? adapter.createFolder?.(draft.parent, name)
          : adapter.createEntry?.(draft.parent, name)
    if (!run) {
      close()
      return
    }
    setCreating(true)
    try {
      const r = await run
      if (!r.success) {
        setError(r.error ?? '')
        return
      }
      const { kind } = draft
      close()
      await rescan()
      if (kind === 'entry' && r.id) await adapter.open(r.id, name)
    } finally {
      setCreating(false)
    }
  }

  return { draft, error, creating, start, close, commit }
}

/** 一行就地新建的输入框（落点在 `depth` 层） */
export function renderKnowledgeDraft(drafts: KnowledgeDraftState, depth: number): React.ReactNode {
  return (
    drafts.draft && (
      <KnowledgeDraftRow
        kind={drafts.draft.kind}
        paddingLeft={indent(depth)}
        busy={drafts.creating}
        error={drafts.error}
        onCommit={(v) => void drafts.commit(v)}
        onCancel={drafts.close}
      />
    )
  )
}

export interface KnowledgeTreeViewProps {
  adapter: KnowledgeGroupAdapter
  /** 当前清单（复制路径要用两个根与内置库的目录） */
  listing: KnowledgeListing
  /** 这一层要画的条目与目录 */
  files: KnowledgeTreeFile[]
  dirs: KnowledgeTreeDir[]
  /** 这一层的层级（缩进按它算） */
  depth: number
  drafts: KnowledgeDraftState
  /** 目录是否展开 / 翻转（展开状态归调用方：重扫不丢、默认态由调用方定） */
  isDirOpen: (path: string) => boolean
  toggleDir: (path: string) => void
  activeNotePath: string | null
  /** 专注模式下别处是活动的：非命中行淡化 */
  dimInactive: boolean
}

export function KnowledgeTreeView({
  adapter,
  listing,
  files,
  dirs,
  depth,
  drafts,
  isDirOpen,
  toggleDir,
  activeNotePath,
  dimInactive
}: KnowledgeTreeViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const showContextMenu = useContextMenu()

  /** 起一行内联输入：落点目录先展开 —— 输入框长在收着的地方没人看得见 */
  const startDraft = (kind: DraftKind, parent: string): void => {
    if (parent && !isDirOpen(parent)) toggleDir(parent)
    drafts.start(kind, parent)
  }

  /** 目录行的菜单：库本身与库里的每一层都能往里新建；固定文案的容器与只读的内置库不是落点 */
  const dirMenuItems = (node: KnowledgeTreeDir): ContextMenuItem[] => {
    if (node.scopeDir !== null || node.readonly) return []
    return [
      ...(adapter.createEntry ? [{ id: 'new-entry', label: t('knowledge.newEntry') }] : []),
      ...(adapter.createFolder ? [{ id: 'new-folder', label: t('knowledge.newFolder') }] : [])
    ]
  }

  const openDirMenu = (node: KnowledgeTreeDir, e: React.MouseEvent): void => {
    const items = dirMenuItems(node)
    if (items.length === 0) return
    void showContextMenu(e, items, (action) => {
      if (action === 'new-entry') startDraft('entry', node.path)
      if (action === 'new-folder') startDraft('folder', node.path)
    })
  }

  /**
   * 条目 → 绝对路径：宿主给了 bundle 目录的（内置库）直接拼；`knowledge/<库名>/…` 相对用户根，
   * 其余相对 knowledge-shuvix 根
   */
  const absolutePathOf = (entry: KnowledgeEntry): string => {
    const { path, bundle } = entry
    const bundleDir = listing.bundleDirs?.[bundle]
    if (bundleDir && path.startsWith(`${bundle}/`)) {
      return `${bundleDir}/${path.slice(bundle.length + 1)}`
    }
    const userPrefix = `${KNOWLEDGE_USER_ROOT_DIR}/`
    if (path.startsWith(userPrefix)) {
      return listing.userRoot ? `${listing.userRoot}/${path.slice(userPrefix.length)}` : path
    }
    return listing.root ? `${listing.root}/${path}` : path
  }

  const openRowMenu = (entry: KnowledgeEntry, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      ...(adapter.revealFile ? [{ id: 'reveal', label: t('knowledge.revealFile') }] : []),
      { id: 'copy-path', label: t('knowledge.copyPath') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'reveal') void adapter.revealFile?.(entry.path)
      if (action === 'copy-path') void navigator.clipboard.writeText(absolutePathOf(entry))
    })
  }

  const badge = (label: string, node: React.ReactNode): React.ReactNode => (
    <span title={label} aria-label={label} className="flex shrink-0">
      {node}
    </span>
  )

  const renderBadges = (e: KnowledgeEntry): React.ReactNode => (
    <>
      {e.status === 'draft' &&
        badge(t('knowledge.badgeDraft'), <CircleDashed size={9} className="text-amber-500/70" />)}
      {e.status === 'deprecated' &&
        badge(
          t('knowledge.badgeDeprecated'),
          <Archive size={9} className="text-text-tertiary/50" />
        )}
      {e.trustTier !== 'unverified' &&
        (!e.verifiedCurrent
          ? badge(
              t('knowledge.badgeVerifiedOutdated'),
              <BadgeCheck size={9} className="text-text-tertiary/40" />
            )
          : e.trustTier === 'human-reviewed'
            ? badge(
                t('knowledge.badgeVerified'),
                <BadgeCheck size={9} className="text-emerald-500/80" />
              )
            : badge(
                t('knowledge.badgeMachineConfirmed'),
                <CircleCheck size={9} className="text-sky-500/70" />
              ))}
      {e.stale &&
        badge(t('knowledge.badgeStale'), <ClockAlert size={9} className="text-amber-500/70" />)}
    </>
  )

  const renderFile = (f: KnowledgeTreeFile, d: number): React.ReactNode => {
    const e = f.entry
    const active = activeNotePath === e.path
    const deprecated = e.status === 'deprecated'
    return (
      <div
        key={e.path}
        data-knowledge-row={e.path}
        onClick={() => void adapter.open(e.path, e.title)}
        onContextMenu={(ev) => openRowMenu(e, ev)}
        title={`${e.path}${e.description ? ` — ${e.description}` : ''}`}
        style={{ paddingLeft: indent(d) }}
        className={`group relative flex items-center gap-1.5 pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
          active
            ? 'bg-bg-active/80 text-text-primary'
            : `text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary ${
                dimInactive ? 'opacity-30 hover:opacity-100' : ''
              }`
        }`}
      >
        <FileText
          size={11}
          className={`flex-shrink-0 ${active ? 'text-accent' : 'text-text-tertiary/40'}`}
        />
        {/* 标签直接是行的子节点而不包一层 div —— 侧栏 e2e 按「div > div > span.truncate」认
            会话行，别撞上（同 BotGroup 的取舍）。徽标那层空着也占 hover 的 20px，
            正好把标题从 ⋮ 底下让开 */}
        <span
          className={`flex-1 min-w-0 text-[13px] truncate ${
            deprecated ? 'line-through opacity-60' : ''
          }`}
        >
          {f.label}
        </span>
        <span className="flex items-center gap-0.5 shrink-0 group-hover:pr-5">
          {renderBadges(e)}
        </span>
        <RowMenuButton
          className="absolute right-1.5 opacity-0 group-hover:opacity-100"
          onOpen={(ev) => openRowMenu(e, ev)}
        />
      </div>
    )
  }

  /**
   * 目录行的图标：置顶的内置库（ShuviX 自己的说明书）有自己的身份图标、不随展开变化；其余是普通
   * 目录，一只开合的文件夹。active = 目录在活动条目的路径上，图标跟着穿 accent。
   */
  const dirIcon = (
    node: KnowledgeTreeDir,
    d: number,
    open: boolean,
    active: boolean
  ): React.ReactNode => {
    if (node.readonly && d === 0) {
      return (
        <BookMarked
          size={11}
          className={`flex-shrink-0 ${active ? 'text-accent' : 'text-sky-400/70'}`}
        />
      )
    }
    const Icon = open ? FolderOpen : FolderClosed
    return (
      <Icon
        size={11}
        className={`flex-shrink-0 ${active ? 'text-accent' : 'text-text-tertiary/40'}`}
      />
    )
  }

  /** 目录是否在活动条目的路径上（条目 id 与目录 id 同命名空间，前缀即祖先） */
  const isOnActivePath = (dirPath: string): boolean =>
    activeNotePath !== null && activeNotePath.startsWith(`${dirPath}/`)

  const renderDir = (node: KnowledgeTreeDir, d: number): React.ReactNode => {
    const open = isDirOpen(node.path)
    // 专注模式下与条目、组头一起高亮：命中路径上的目录不被淡化，也不收 hover 淡化
    const active = isOnActivePath(node.path)
    const label = node.title ?? node.name
    const isBuiltinRoot = node.readonly && d === 0
    return (
      <div key={node.path}>
        <div
          data-knowledge-dir={node.path}
          data-knowledge-readonly={node.readonly || undefined}
          onClick={() => toggleDir(node.path)}
          onContextMenu={(ev) => openDirMenu(node, ev)}
          title={node.path}
          style={{ paddingLeft: indent(d) }}
          className={`group relative flex items-center gap-1.5 pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
            active
              ? 'bg-bg-active/80 text-text-primary'
              : `text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary ${
                  dimInactive ? 'opacity-30 hover:opacity-100' : ''
                }`
          }`}
        >
          {dirIcon(node, d, open, active)}
          <span className="flex-1 min-w-0 text-[13px] truncate">{label}</span>
          {/* 只读的内置库：库那一行挂一把锁（里面的层级不重复挂） */}
          {isBuiltinRoot && (
            <span
              title={t('knowledge.builtinBase')}
              aria-label={t('knowledge.builtinBase')}
              className="flex shrink-0 pr-1"
            >
              <Lock size={9} className="text-text-tertiary/50" />
            </span>
          )}
          {dirMenuItems(node).length > 0 && (
            <RowMenuButton
              className="absolute right-1.5 opacity-0 group-hover:opacity-100"
              onOpen={(ev) => openDirMenu(node, ev)}
            />
          )}
        </div>
        <AnimatedCollapse open={open}>
          {drafts.draft?.parent === node.path && renderKnowledgeDraft(drafts, d + 1)}
          {node.files.map((f) => renderFile(f, d + 1))}
          {node.dirs.map((sub) => renderDir(sub, d + 1))}
        </AnimatedCollapse>
      </div>
    )
  }

  return (
    <>
      {files.map((f) => renderFile(f, depth))}
      {dirs.map((sub) => renderDir(sub, depth))}
    </>
  )
}

/**
 * 内联新建行 —— 在树里就地输名字。Enter 建、Esc 取消、**失焦也取消**：点走一下不该凭空多出一个库。
 * 建的时候输入框禁用（此时的失焦不算取消），失败则这一行留着、原因显示在下面。
 */
function KnowledgeDraftRow({
  kind,
  paddingLeft,
  busy,
  error,
  onCommit,
  onCancel
}: {
  kind: DraftKind
  paddingLeft: number
  busy: boolean
  error: string | null
  onCommit: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const Icon = kind === 'entry' ? FileText : FolderClosed
  return (
    <div data-knowledge-draft={kind}>
      <div style={{ paddingLeft }} className="flex items-center gap-1.5 pr-1.5 py-0.5">
        <Icon size={11} className="flex-shrink-0 text-text-tertiary/40" />
        <input
          autoFocus
          value={value}
          disabled={busy}
          placeholder={t(DRAFT_PLACEHOLDER[kind])}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            if (!busy) onCancel()
          }}
          // 侧栏的快捷键（上下切会话等）不该收到这里的按键
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') onCommit(value)
            if (e.key === 'Escape') onCancel()
          }}
          className={`flex-1 min-w-0 px-1 py-0 rounded border bg-bg-primary text-[13px] text-text-primary outline-none ${
            error === null ? 'border-border-primary' : 'border-red-500/60'
          }`}
        />
      </div>
      {error && (
        <div
          style={{ paddingLeft: paddingLeft + 17 }}
          className="pr-1.5 pb-1 text-[11px] text-red-400"
        >
          {error}
        </div>
      )}
    </div>
  )
}

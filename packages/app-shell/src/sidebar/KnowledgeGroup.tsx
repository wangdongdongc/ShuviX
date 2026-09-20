/**
 * KnowledgeGroup —— 侧栏置顶的「知识库」分组（知识库 v2：`~/.shuvix/knowledge-shuvix/` 的项目库 +
 * `~/.shuvix/knowledge/` 下每个子目录一个的用户库，用户库与 Projects 容器平级、Projects 置顶），
 * 排在 Bots 之下。置顶的是随应用发布的**内置库**（ShuviX 自己的说明书，
 * 只读，带书签图标），其后是项目容器（带看板图标）与用户自己的库。**一个库一个 OKF bundle**：树 = 项目容器 →
 * 每个项目库（显示项目当前的名字）→ 条目，外加与容器平级的每个用户库 → 条目；
 * 行 = 一个 md（标题依次取 frontmatter title、正文第一个 # 标题、文件名），行尾徽标：草稿 / 已核实 / 过期 / 已过时。
 * 点行经宿主打开 / 复用该文件的笔记本会话（隐藏承载项目：项目库 `__knowledge__`、用户库
 * `__knowledge_user__`、内置库 `__knowledge_builtin__`）。随应用发布的
 * **内置库**是根上置顶的一行：自己的图标 + 一把锁、没有新建菜单，点开是只读笔记本。
 *
 * prop 驱动、不触宿主 API（同 BotGroup）：清单 / 打开 / 打开目录 / 在文件夹中显示
 * 由宿主注入。树形派生在 knowledgeTree.ts（纯函数，可单测）。扫描是懒的：**首次展开才扫**
 * （清单只读，不建任何目录），之后每次展开 + 窗口聚焦 + `knowledge.changed`
 * 事件（宿主观察到的 agent 写入）重扫，stale-guard 防乱序回包。项目容器默认展开，项目库与
 * 用户库默认折叠 —— 用户要看的是条目，不是一列库名。
 *
 * 动作全部收在菜单里（右键 / ⋮ 同一份）：组头 = 新建知识库 / 打开目录 / 刷新；目录行 = 新建条目 /
 * 新建文件夹；条目行 = 在文件夹中显示 / 复制路径。核实 / 标为过时等管理动作属管理页（未建）。
 *
 * **新建就地输名字**：菜单点完在树里长出一行输入框（Enter 建、Esc 或失焦取消），名字交给宿主校验 ——
 * 不合法 / 重名的原因显示在输入行下面，改一下再回车。改名与删除仍然交给文件系统（「打开知识库目录」）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  BadgeCheck,
  BookMarked,
  CircleDashed,
  ClockAlert,
  FileText,
  FolderClosed,
  FolderKanban,
  FolderOpen,
  Lock
} from 'lucide-react'
import { useAppEvent, useChatStore } from '@shuvix/chat-ui'
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
import { SessionGroup } from './SessionGroup'
import { RowMenuButton } from './RowMenuButton'
import { useFocusDim } from './useFocusDim'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import {
  buildKnowledgeTree,
  type KnowledgeScopeDir,
  type KnowledgeTreeDir,
  type KnowledgeTreeFile
} from './knowledgeTree'

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
type DraftKind = 'base' | 'folder' | 'entry'

const DRAFT_PLACEHOLDER: Record<DraftKind, string> = {
  base: 'knowledge.newBasePlaceholder',
  folder: 'knowledge.newFolderPlaceholder',
  entry: 'knowledge.newEntryPlaceholder'
}

export interface KnowledgeGroupProps {
  adapter: KnowledgeGroupAdapter
}

const SCOPE_LABEL_KEY: Record<KnowledgeScopeDir, string> = {
  projects: 'knowledge.scopeProjects'
}

/**
 * 行缩进：每层 12px，**最外层不缩进**（容器 `项目` 贴着组标题的左边）。
 * 别处的侧栏行有 10px 基准（SessionItem 的 pl-2.5），这里刻意不要 —— 知识库比会话列表多两层
 * （容器 → 项目库 → 条目），基准那 10px 会让最深的条目一路推到 34px。
 */
const indent = (depth: number): number => depth * 12

export function KnowledgeGroup({ adapter }: KnowledgeGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  const { dim } = useFocusDim()
  const showContextMenu = useContextMenu()

  // 活动会话是否为知识库笔记本（分组头高亮 + 命中行选中态）
  const activeNotePath = useChatStore((s) => {
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
  const isActive = activeNotePath !== null

  const [collapsed, setCollapsed] = useState(true)
  const [scanned, setScanned] = useState<KnowledgeListing | null>(null)
  // 翻转集而非展开集：顶层目录默认展开、更深层默认折叠，翻转一次即取反；重扫新增的
  // 目录天然落在各自的默认态，无需与扫描结果对账
  const [toggled, setToggled] = useState<Set<string>>(() => new Set())
  // 是否扫过（聚焦 / 事件重扫只在首次展开后生效）
  const scannedOnce = useRef(false)
  // 递增序号丢弃过期回包（聚焦 / 事件 / 手动刷新并发时只认最后一次）
  const scanSeq = useRef(0)
  // 正在输名字的那一行（parent 是落点目录 id，建库时为空）
  const [draft, setDraft] = useState<{ kind: DraftKind; parent: string } | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const scan = useCallback(async (): Promise<void> => {
    scannedOnce.current = true
    const seq = ++scanSeq.current
    try {
      const r = await adapter.list()
      if (seq === scanSeq.current) setScanned(r)
    } catch {
      if (seq === scanSeq.current)
        setScanned({
          entries: [],
          root: '',
          userRoot: '',
          dirs: [],
          bundleNames: {},
          bundleDirs: {}
        })
    }
  }, [adapter])

  useEffect(() => {
    const onFocus = (): void => {
      if (scannedOnce.current) void scan()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [scan])

  // 宿主观察到的写入（knowledge 工具 / 文件工具落在根目录下）—— 列表跟着走，不必等切窗口；
  // 没展开过就不扫，下次展开自然会扫。外部编辑（Obsidian）不广播，靠聚焦重扫兜底
  useAppEvent('knowledge.changed', () => {
    if (scannedOnce.current) void scan()
  })

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    if (!next) void scan()
  }

  const toggleDir = (path: string): void =>
    setToggled((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  // 默认态按**结构**层级判（顶层目录展开、更深层折叠），不按渲染缩进 —— 容器不步进之后
  // 项目库的 depth 也是 0，拿缩进判会把所有项目库都默认展开
  const isDirOpen = (path: string): boolean => !path.includes('/') !== toggled.has(path)

  const tree = useMemo(
    () => buildKnowledgeTree(scanned?.entries ?? [], scanned?.bundleNames, scanned?.dirs),
    [scanned]
  )

  const closeDraft = (): void => {
    setDraft(null)
    setDraftError(null)
  }

  /** 起一行内联输入：组先展开、落点目录先展开 —— 输入框长在收着的地方没人看得见 */
  const startDraft = (kind: DraftKind, parent: string): void => {
    if (collapsed) {
      setCollapsed(false)
      void scan()
    }
    if (parent && !isDirOpen(parent)) toggleDir(parent)
    setDraft({ kind, parent })
    setDraftError(null)
  }

  /** Enter 落地：宿主建，失败把原因留在行里（名字还在框里，改一下再回车） */
  const commitDraft = async (value: string): Promise<void> => {
    if (!draft || creating) return
    const name = value.trim()
    if (!name) {
      closeDraft()
      return
    }
    const run =
      draft.kind === 'base'
        ? adapter.createBase?.(name)
        : draft.kind === 'folder'
          ? adapter.createFolder?.(draft.parent, name)
          : adapter.createEntry?.(draft.parent, name)
    if (!run) {
      closeDraft()
      return
    }
    setCreating(true)
    try {
      const r = await run
      if (!r.success) {
        setDraftError(r.error ?? '')
        return
      }
      const { kind } = draft
      closeDraft()
      await scan()
      // 新条目建完就打开它的笔记本：正文在那里写，type / 状态 / 描述在属性卡里改
      if (kind === 'entry' && r.id) await adapter.open(r.id, name)
    } finally {
      setCreating(false)
    }
  }

  const renderDraft = (depth: number): React.ReactNode =>
    draft && (
      <KnowledgeDraftRow
        kind={draft.kind}
        depth={depth}
        busy={creating}
        error={draftError}
        onCommit={(v) => void commitDraft(v)}
        onCancel={closeDraft}
      />
    )

  const openGroupMenu = (e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      ...(adapter.createBase
        ? [{ id: 'new-base', label: t('knowledge.newBase') }, { type: 'separator' as const }]
        : []),
      { id: 'open-folder', label: t('knowledge.openFolder') },
      { type: 'separator' },
      { id: 'refresh', label: t('panel.filesRefresh') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'new-base') startDraft('base', '')
      if (action === 'open-folder') void adapter.openFolder()
      if (action === 'refresh') void scan()
    })
  }

  /** 目录行的菜单：库本身与库里的每一层都能往里新建；固定文案的容器（`项目`）与只读的内置库不是落点 */
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
    const bundleDir = scanned?.bundleDirs?.[bundle]
    if (bundleDir && path.startsWith(`${bundle}/`)) {
      return `${bundleDir}/${path.slice(bundle.length + 1)}`
    }
    const userPrefix = `${KNOWLEDGE_USER_ROOT_DIR}/`
    if (path.startsWith(userPrefix)) {
      return scanned?.userRoot ? `${scanned.userRoot}/${path.slice(userPrefix.length)}` : path
    }
    return scanned?.root ? `${scanned.root}/${path}` : path
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
        badge(
          t(e.verifiedCurrent ? 'knowledge.badgeVerified' : 'knowledge.badgeVerifiedOutdated'),
          <BadgeCheck
            size={9}
            className={e.verifiedCurrent ? 'text-emerald-500/80' : 'text-text-tertiary/40'}
          />
        )}
      {e.stale &&
        badge(t('knowledge.badgeStale'), <ClockAlert size={9} className="text-amber-500/70" />)}
    </>
  )

  const renderFile = (f: KnowledgeTreeFile, depth: number): React.ReactNode => {
    const e = f.entry
    const active = activeNotePath === e.path
    const Icon = FileText
    const deprecated = e.status === 'deprecated'
    return (
      <div
        key={e.path}
        data-knowledge-row={e.path}
        onClick={() => void adapter.open(e.path, e.title)}
        onContextMenu={(ev) => openRowMenu(e, ev)}
        title={`${e.path}${e.description ? ` — ${e.description}` : ''}`}
        style={{ paddingLeft: indent(depth) }}
        className={`group relative flex items-center gap-1.5 pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
          active
            ? 'bg-bg-active/80 text-text-primary'
            : `text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary ${
                dim && isActive ? 'opacity-30 hover:opacity-100' : ''
              }`
        }`}
      >
        <Icon
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
   * 目录行的图标。两类**身份**行有自己的图标、且不随展开状态变化 —— 置顶的内置库（ShuviX 自己的
   * 说明书）与项目容器；其余是普通目录，照旧一只开合的文件夹。内置库里面的层级是普通目录。
   * active = 目录在活动条目的路径上（专注模式下随条目一起高亮），图标跟着穿 accent。
   */
  const dirIcon = (
    node: KnowledgeTreeDir,
    depth: number,
    open: boolean,
    active: boolean
  ): React.ReactNode => {
    if (node.scopeDir === 'projects') {
      return (
        <FolderKanban
          size={11}
          className={`flex-shrink-0 ${active ? 'text-accent' : 'text-text-tertiary/50'}`}
        />
      )
    }
    if (node.readonly && depth === 0) {
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

  const renderDir = (node: KnowledgeTreeDir, depth: number): React.ReactNode => {
    const open = isDirOpen(node.path)
    // 专注模式下与条目、组头一起高亮：命中路径上的目录不被淡化，也不收 hover 淡化
    const active = isOnActivePath(node.path)

    const label = node.scopeDir ? t(SCOPE_LABEL_KEY[node.scopeDir]) : (node.title ?? node.name)
    return (
      <div key={node.path}>
        <div
          data-knowledge-dir={node.path}
          data-knowledge-readonly={node.readonly || undefined}
          onClick={() => toggleDir(node.path)}
          onContextMenu={(ev) => openDirMenu(node, ev)}
          title={node.path}
          style={{ paddingLeft: indent(depth) }}
          className={`group relative flex items-center gap-1.5 pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
            active
              ? 'bg-bg-active/80 text-text-primary'
              : `text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary ${
                  dim && isActive ? 'opacity-30 hover:opacity-100' : ''
                }`
          }`}
        >
          {dirIcon(node, depth, open, active)}
          <span className="flex-1 min-w-0 text-[13px] truncate">{label}</span>
          {/* 只读的内置库：库那一行挂一把锁（里面的层级不重复挂） */}
          {node.readonly && depth === 0 && (
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
          {draft?.parent === node.path && renderDraft(depth + 1)}
          {node.files.map((f) => renderFile(f, depth + 1))}
          {node.dirs.map((d) => renderDir(d, depth + 1))}
        </AnimatedCollapse>
      </div>
    )
  }

  return (
    <SessionGroup
      label={t('sidebar.knowledgeGroup')}
      variant="knowledge"
      collapsed={collapsed}
      onToggle={toggle}
      active={isActive}
      dim={dim && !isActive}
      onMenu={openGroupMenu}
    >
      {scanned !== null && (
        <>
          {tree.files.map((f) => renderFile(f, 0))}
          {tree.dirs.map((d) => renderDir(d, 0))}
          {draft?.kind === 'base' && renderDraft(0)}
          {tree.files.length === 0 && tree.dirs.length === 0 && !draft && (
            <div className="px-3 py-2 text-xs text-text-tertiary">
              {t('sidebar.knowledgeEmpty')}
            </div>
          )}
        </>
      )}
    </SessionGroup>
  )
}

/**
 * 内联新建行 —— 在树里就地输名字。Enter 建、Esc 取消、**失焦也取消**：点走一下不该凭空多出一个库。
 * 建的时候输入框禁用（此时的失焦不算取消），失败则这一行留着、原因显示在下面。
 */
function KnowledgeDraftRow({
  kind,
  depth,
  busy,
  error,
  onCommit,
  onCancel
}: {
  kind: DraftKind
  depth: number
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
      <div
        style={{ paddingLeft: indent(depth) }}
        className="flex items-center gap-1.5 pr-1.5 py-0.5"
      >
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
          style={{ paddingLeft: indent(depth) + 17 }}
          className="pr-1.5 pb-1 text-[11px] text-red-400"
        >
          {error}
        </div>
      )}
    </div>
  )
}

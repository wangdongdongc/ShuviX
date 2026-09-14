/**
 * KnowledgeGroup —— 侧栏置顶的「知识库」分组（知识库 v2：`~/.shuvix/knowledge-shuvix/` 的项目库 +
 * `~/.shuvix/knowledge/` 下每个子目录一个的用户库，用户库与 Projects 容器平级、Projects 置顶），
 * 排在 Bots 之下、旧知识库（WikiGroup）之上。**一个库一个 OKF bundle**：树 = 项目容器 →
 * 每个项目 bundle（显示 `project.md` 的 title）→ 条目，外加与容器平级的每个用户库 → 条目；
 * 行 = 一个 md（合规条目取 frontmatter title，不合规的取文件名），行尾徽标：草稿 / 已核实 / 过期 / 已过时。
 * 点行经宿主打开 / 复用该文件的笔记本会话（隐藏承载项目：项目库 `__knowledge__`、用户库
 * `__knowledge_user__`，同 WikiGroup 的做法）。
 *
 * prop 驱动、不触宿主 API（同 WikiGroup / BotGroup）：清单 / 打开 / 打开目录 / 在文件夹中显示
 * 由宿主注入。树形派生在 knowledgeTree.ts（纯函数，可单测）。扫描是懒的：**首次展开才扫**
 * （清单只读，不建任何目录），之后每次展开 + 窗口聚焦 + `knowledge.changed`
 * 事件（宿主观察到的 agent 写入）重扫，stale-guard 防乱序回包。项目容器默认展开，项目库与
 * 用户库默认折叠 —— 用户要看的是条目，不是一列库名。
 *
 * 动作全部收在菜单里（右键 / ⋮ 同一份）：组头 = 打开目录 / 刷新；行 = 在文件夹中显示 /
 * 复制路径。核实 / 标为过时等管理动作属管理页（未建），这里只让库**可见**。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  BadgeCheck,
  CircleDashed,
  ClockAlert,
  FileText,
  FolderClosed,
  FolderOpen
} from 'lucide-react'
import { useAppEvent, useChatStore } from '@shuvix/chat-ui'
import {
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

  const scan = useCallback(async (): Promise<void> => {
    scannedOnce.current = true
    const seq = ++scanSeq.current
    try {
      const r = await adapter.list()
      if (seq === scanSeq.current) setScanned(r)
    } catch {
      if (seq === scanSeq.current) setScanned({ entries: [], root: '', userRoot: '' })
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

  const tree = useMemo(() => buildKnowledgeTree(scanned?.entries ?? []), [scanned])

  const openGroupMenu = (e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      { id: 'open-folder', label: t('knowledge.openFolder') },
      { type: 'separator' },
      { id: 'refresh', label: t('panel.filesRefresh') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'open-folder') void adapter.openFolder()
      if (action === 'refresh') void scan()
    })
  }

  /** 条目 id → 绝对路径：`knowledge/<库名>/…` 相对用户根，其余相对 knowledge-shuvix 根 */
  const absolutePathOf = (path: string): string => {
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
      if (action === 'copy-path') void navigator.clipboard.writeText(absolutePathOf(entry.path))
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

  const renderDir = (node: KnowledgeTreeDir, depth: number): React.ReactNode => {
    const open = isDirOpen(node.path)

    const label = node.scopeDir ? t(SCOPE_LABEL_KEY[node.scopeDir]) : (node.title ?? node.name)
    return (
      <div key={node.path}>
        <div
          data-knowledge-dir={node.path}
          onClick={() => toggleDir(node.path)}
          title={node.path}
          style={{ paddingLeft: indent(depth) }}
          className={`flex items-center gap-1.5 pr-1.5 py-0.5 cursor-pointer text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary transition-opacity duration-200 ${
            dim && isActive ? 'opacity-30 hover:opacity-100' : ''
          }`}
        >
          {open ? (
            <FolderOpen size={11} className="flex-shrink-0 text-text-tertiary/40" />
          ) : (
            <FolderClosed size={11} className="flex-shrink-0 text-text-tertiary/40" />
          )}
          <span className="flex-1 min-w-0 text-[13px] truncate">{label}</span>
        </div>
        <AnimatedCollapse open={open}>
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
      {scanned !== null &&
        (scanned.entries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-text-tertiary">{t('sidebar.knowledgeEmpty')}</div>
        ) : (
          <>
            {tree.files.map((f) => renderFile(f, 0))}
            {tree.dirs.map((d) => renderDir(d, 0))}
          </>
        ))}
    </SessionGroup>
  )
}

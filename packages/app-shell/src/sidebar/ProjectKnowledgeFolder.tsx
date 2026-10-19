/**
 * ProjectKnowledgeFolder —— 项目组内的「项目知识库」子文件夹（2026-10-10，接替退役的项目记忆的位置）。
 *
 * 列的是这个项目自己的知识库 bundle（`~/.shuvix/knowledge-shuvix/projects/<projectId>/`）：属于这个
 * 项目的会话恒带这个库（agent 经 `knowledge` 工具以 `project` 之名读写它），所以它跟着项目挂在项目
 * 组里，而不是混在「知识库」分组那一列用户自己圈定的库里。行与目录的渲染与「知识库」分组同一份
 * （KnowledgeTreeView）：点条目打开 / 复用它的笔记本会话，徽标、菜单、就地新建都一样。
 *
 * **总是显示**（与旧项目记忆「零条不显示」不同）：这一行就是手动新建条目 / 文件夹的落点 ——
 * 库目录可以还不存在，第一次往里建东西时由宿主建出来。
 *
 * prop 驱动、不触宿主 API：清单与新建都走宿主注入的知识库 adapter；未注入的宿主（扩展端）整块
 * 不渲染。扫描时机：项目组展开时才扫（`enabled`），此外窗口聚焦、`knowledge.changed` 与本文件夹每次
 * 展开各重扫一次，带 stale-guard 丢弃乱序回包 —— 与「知识库」分组同策。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Library } from 'lucide-react'
import { useAppEvent } from '@shuvix/chat-ui'
import { KNOWLEDGE_PROJECTS_DIR } from '@shuvix/chat-protocol/knowledge'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { AnimatedCollapse } from '../common/AnimatedCollapse'
import { RowMenuButton } from './RowMenuButton'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import { buildKnowledgeTree, type KnowledgeTreeDir } from './knowledgeTree'
import {
  EMPTY_KNOWLEDGE_LISTING,
  KnowledgeTreeView,
  renderKnowledgeDraft,
  useActiveKnowledgeNotePath,
  useKnowledgeDraft,
  type KnowledgeGroupAdapter,
  type KnowledgeListing
} from './KnowledgeTreeView'

export interface ProjectKnowledgeFolderProps {
  projectId: string
  adapter: KnowledgeGroupAdapter
  /** 所属项目组是否展开 —— 折叠的组不扫描（侧栏可能有几十个项目） */
  enabled: boolean
  /** 专注模式下淡化（活动条目除外，与会话项同口径） */
  dim?: boolean
}

/**
 * 同一刻的并发拉取合成一次：几个项目组同时展开、窗口聚焦时各自重扫，宿主那边扫的是同一份清单
 * （全部 bundle），没必要每个文件夹各扫一遍。只合并在途的那一次，回来就放掉 —— 不缓存结果。
 */
const inflight = new WeakMap<KnowledgeGroupAdapter, Promise<KnowledgeListing>>()
function listShared(adapter: KnowledgeGroupAdapter): Promise<KnowledgeListing> {
  const pending = inflight.get(adapter)
  if (pending) return pending
  const run = adapter.list().finally(() => inflight.delete(adapter))
  inflight.set(adapter, run)
  return run
}

/** 树里按 id 找目录（项目库的那个节点在 `projects` 容器下） */
function findDir(node: KnowledgeTreeDir, path: string): KnowledgeTreeDir | null {
  if (node.path === path) return node
  for (const d of node.dirs) {
    if (path === d.path || path.startsWith(`${d.path}/`)) return findDir(d, path)
  }
  return null
}

export function ProjectKnowledgeFolder({
  projectId,
  adapter,
  enabled,
  dim = false
}: ProjectKnowledgeFolderProps): React.JSX.Element {
  const { t } = useTranslation()
  const showContextMenu = useContextMenu()
  const bundle = `${KNOWLEDGE_PROJECTS_DIR}/${projectId}`
  const prefix = `${bundle}/`

  const [listing, setListing] = useState<KnowledgeListing | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  // 库里的子目录默认折叠，翻转一次即展开
  const [toggled, setToggled] = useState<Set<string>>(() => new Set())
  // 递增序号丢弃过期回包（聚焦 / 展开 / 事件并发重扫时只认最后一次）
  const scanSeq = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    const seq = ++scanSeq.current
    try {
      const r = await listShared(adapter)
      if (seq === scanSeq.current) setListing(r)
    } catch {
      if (seq === scanSeq.current) setListing(EMPTY_KNOWLEDGE_LISTING)
    }
  }, [adapter])

  const drafts = useKnowledgeDraft(adapter, scan)

  useEffect(() => {
    if (!enabled) return
    void scan() // eslint-disable-line react-hooks/set-state-in-effect
    const onFocus = (): void => void scan()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, scan])

  // agent 经 knowledge 工具 / 文件工具写进来 —— 跟着走，不必等切窗口
  useAppEvent('knowledge.changed', () => {
    if (enabled) void scan()
  })

  const node = useMemo(() => {
    if (!listing) return null
    const tree = buildKnowledgeTree(
      listing.entries.filter((e) => e.path.startsWith(prefix)),
      listing.bundleNames,
      listing.dirs.filter((d) => d === bundle || d.startsWith(prefix))
    )
    return findDir(tree, bundle)
  }, [listing, bundle, prefix])

  const entryCount = useMemo(
    () => listing?.entries.filter((e) => e.path.startsWith(prefix)).length ?? 0,
    [listing, prefix]
  )

  const activeEntry = useActiveKnowledgeNotePath()
  const activeNotePath = activeEntry?.startsWith(prefix) ? activeEntry : null
  const isActive = activeNotePath !== null

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    if (!next) void scan() // 展开即重扫：agent 可能刚写了一条
  }

  const toggleDir = (path: string): void =>
    setToggled((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const isDirOpen = (path: string): boolean => toggled.has(path)

  /** 文件夹这一行就是库本身：往库根里新建条目 / 文件夹 */
  const menuItems: ContextMenuItem[] = [
    ...(adapter.createEntry ? [{ id: 'new-entry', label: t('knowledge.newEntry') }] : []),
    ...(adapter.createFolder ? [{ id: 'new-folder', label: t('knowledge.newFolder') }] : [])
  ]

  const openMenu = (e: React.MouseEvent): void => {
    if (menuItems.length === 0) return
    void showContextMenu(e, menuItems, (action) => {
      if (action !== 'new-entry' && action !== 'new-folder') return
      // 输入框长在收着的地方没人看得见：先展开
      if (collapsed) {
        setCollapsed(false)
        void scan()
      }
      drafts.start(action === 'new-entry' ? 'entry' : 'folder', bundle)
    })
  }

  return (
    <div>
      <div
        data-project-knowledge={projectId}
        onClick={toggle}
        onContextMenu={openMenu}
        title={t('sidebar.projectKnowledgeHint')}
        className={`group relative sb-row cursor-pointer transition-opacity duration-200 ${
          isActive
            ? 'text-text-primary'
            : `text-text-primary hover:bg-bg-hover/60 ${dim ? 'opacity-30 hover:opacity-100' : ''}`
        }`}
      >
        <Library className={`sb-icon ${isActive ? 'text-accent' : 'text-text-tertiary'}`} />
        <div className="flex-1 min-w-0 flex items-center gap-1.5 group-hover:pr-5">
          <span className="truncate">{t('sidebar.projectKnowledge')}</span>
          {entryCount > 0 && (
            <span className="ml-auto shrink-0 text-[0.8em] tabular-nums text-text-tertiary">
              {entryCount}
            </span>
          )}
        </div>
        {menuItems.length > 0 && (
          <RowMenuButton
            className="absolute right-1.5 opacity-0 group-hover:opacity-100"
            onOpen={openMenu}
          />
        )}
      </div>
      <AnimatedCollapse open={!collapsed}>
        {listing !== null && (
          <>
            {drafts.draft?.parent === bundle && renderKnowledgeDraft(drafts, 1)}
            {node && (
              <KnowledgeTreeView
                adapter={adapter}
                listing={listing}
                files={node.files}
                dirs={node.dirs}
                depth={1}
                drafts={drafts}
                isDirOpen={isDirOpen}
                toggleDir={toggleDir}
                activeNotePath={activeNotePath}
                dimInactive={dim}
              />
            )}
            {entryCount === 0 && !(node && node.dirs.length > 0) && !drafts.draft && (
              <div className="sb-hint sb-depth-1">{t('sidebar.projectKnowledgeEmpty')}</div>
            )}
          </>
        )}
      </AnimatedCollapse>
    </div>
  )
}

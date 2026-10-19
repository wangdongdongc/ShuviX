/**
 * KnowledgeGroup —— 侧栏的「知识库」分组：`~/.shuvix/knowledge/` 下每个子目录一个的用户库，加上
 * 置顶的**内置库**（ShuviX 自己的说明书，只读，带书签图标），排在 Bots 之下。**一个库一个 OKF
 * bundle**：树 = 每个库 → 条目。
 *
 * **项目库不在这里**（2026-10-10）：每个项目自己的库挂在侧栏那个项目组里，叫「项目知识库」
 * （ProjectKnowledgeFolder，接替退役的项目记忆的位置）—— 它跟着项目走，不是用户圈定的一个库。
 *
 * prop 驱动、不触宿主 API（同 BotGroup）：清单 / 打开 / 打开目录 / 在文件夹中显示
 * 由宿主注入。树形派生在 knowledgeTree.ts（纯函数，可单测），行与目录的渲染在 KnowledgeTreeView。
 * 扫描是懒的：**首次展开才扫**（清单只读，不建任何目录），之后每次展开 + 窗口聚焦 +
 * `knowledge.changed` 事件（宿主观察到的 agent 写入）重扫，stale-guard 防乱序回包。库默认折叠 ——
 * 用户要看的是条目，不是一列库名。
 *
 * 组头菜单 = 新建知识库 / 打开目录 / 刷新。改名与删除仍然交给文件系统（「打开知识库目录」）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppEvent } from '@shuvix/chat-ui'
import { KNOWLEDGE_PROJECTS_DIR } from '@shuvix/chat-protocol/knowledge'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { SessionGroup } from './SessionGroup'
import { useFocusDim } from './useFocusDim'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import { buildKnowledgeTree } from './knowledgeTree'
import {
  EMPTY_KNOWLEDGE_LISTING,
  KnowledgeTreeView,
  renderKnowledgeDraft,
  useActiveKnowledgeNotePath,
  useKnowledgeDraft,
  type KnowledgeGroupAdapter,
  type KnowledgeListing
} from './KnowledgeTreeView'

export type {
  KnowledgeCreateResult,
  KnowledgeGroupAdapter,
  KnowledgeListing
} from './KnowledgeTreeView'

export interface KnowledgeGroupProps {
  adapter: KnowledgeGroupAdapter
}

/** 项目库的条目 / 目录 id 前缀 —— 这一组不画它们 */
const PROJECTS_PREFIX = `${KNOWLEDGE_PROJECTS_DIR}/`
const notProjectBundle = (id: string): boolean =>
  id !== KNOWLEDGE_PROJECTS_DIR && !id.startsWith(PROJECTS_PREFIX)

export function KnowledgeGroup({ adapter }: KnowledgeGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  const { dim } = useFocusDim()
  const showContextMenu = useContextMenu()

  // 活动会话是否为本组某个库里的笔记本（分组头高亮 + 命中行选中态）；项目库的笔记本归项目组
  const activeEntry = useActiveKnowledgeNotePath()
  const activeNotePath = activeEntry !== null && notProjectBundle(activeEntry) ? activeEntry : null
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
      if (seq === scanSeq.current) setScanned(EMPTY_KNOWLEDGE_LISTING)
    }
  }, [adapter])

  const drafts = useKnowledgeDraft(adapter, scan)

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
  // 默认态：库（`knowledge/<库名>`、`builtin/<库名>`，两段）折叠，翻转一次即取反
  const isDirOpen = (path: string): boolean => toggled.has(path)

  const tree = useMemo(
    () =>
      buildKnowledgeTree(
        (scanned?.entries ?? []).filter((e) => notProjectBundle(e.path)),
        scanned?.bundleNames,
        (scanned?.dirs ?? []).filter(notProjectBundle)
      ),
    [scanned]
  )

  /** 建库的输入行长在根上：组先展开 —— 输入框长在收着的地方没人看得见 */
  const startBaseDraft = (): void => {
    if (collapsed) {
      setCollapsed(false)
      void scan()
    }
    drafts.start('base', '')
  }

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
      if (action === 'new-base') startBaseDraft()
      if (action === 'open-folder') void adapter.openFolder()
      if (action === 'refresh') void scan()
    })
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
          <KnowledgeTreeView
            adapter={adapter}
            listing={scanned}
            files={tree.files}
            dirs={tree.dirs}
            depth={0}
            drafts={drafts}
            isDirOpen={isDirOpen}
            toggleDir={toggleDir}
            activeNotePath={activeNotePath}
            dimInactive={dim && isActive}
          />
          {drafts.draft?.kind === 'base' && renderKnowledgeDraft(drafts, 0)}
          {tree.files.length === 0 && tree.dirs.length === 0 && !drafts.draft && (
            <div className="sb-hint">{t('sidebar.knowledgeEmpty')}</div>
          )}
        </>
      )}
    </SessionGroup>
  )
}

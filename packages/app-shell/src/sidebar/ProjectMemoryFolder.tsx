/**
 * ProjectMemoryFolder —— 项目组内的「项目记忆」子文件夹（可再展开）。
 *
 * 列的是**磁盘上的记忆文件**（`~/.shuvix/memory/<projectId>/*.md`），不是会话：记忆由 agent
 * 写入，先有文件才可能有会话，用会话当清单会漏掉「写过但没人点开过」的条目。点一条经宿主
 * 打开/复用绑定它的笔记本会话（进 live-preview 直接编辑）。
 *
 * prop 驱动、不触宿主 API（同 WikiView）：清单与打开都由宿主注入；未注入 adapter 的宿主
 * （扩展端无记忆后端）整块不渲染。零条记忆也不渲染 —— 空文件夹只是噪声。
 *
 * 扫描时机：项目组展开时才扫（`enabled`），此外窗口聚焦与本文件夹每次展开各重扫一次
 * （agent 可能刚写了一条），带 stale-guard 丢弃乱序回包 —— 与 WikiView / FilesPanel 同策。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, FolderClosed, FolderOpen, Pin } from 'lucide-react'
import type { ProjectMemoryEntry } from '@shuvix/chat-protocol/types/memory'
import { AnimatedCollapse } from '../common/AnimatedCollapse'

/** 宿主注入的记忆能力（桌面：window.api.memory）；不传即无此功能 */
export interface ProjectMemoryAdapter {
  /** 列出某项目的记忆条目（视图形状，不含正文） */
  list: (projectId: string) => Promise<ProjectMemoryEntry[]>
  /** 打开一条记忆：宿主负责打开/复用笔记本会话并选中 */
  open: (projectId: string, slug: string) => void | Promise<void>
}

export interface ProjectMemoryFolderProps {
  projectId: string
  adapter: ProjectMemoryAdapter
  /** 所属项目组是否展开——折叠的组不扫描（侧栏可能有几十个项目） */
  enabled: boolean
  /** 当前活动会话绑定的记忆 slug（属本项目时才传）；用于高亮 */
  activeSlug?: string | null
  /** 专注模式下淡化（活动条目除外，与会话项同口径） */
  dim?: boolean
}

export function ProjectMemoryFolder({
  projectId,
  adapter,
  enabled,
  activeSlug,
  dim = false
}: ProjectMemoryFolderProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<ProjectMemoryEntry[]>([])
  const [collapsed, setCollapsed] = useState(true)
  // 递增序号丢弃过期回包（聚焦/展开并发重扫时只认最后一次）
  const scanSeq = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    const seq = ++scanSeq.current
    try {
      const list = await adapter.list(projectId)
      if (seq === scanSeq.current) setEntries(list)
    } catch {
      if (seq === scanSeq.current) setEntries([])
    }
  }, [adapter, projectId])

  useEffect(() => {
    if (!enabled) return
    void scan() // eslint-disable-line react-hooks/set-state-in-effect
    const onFocus = (): void => void scan()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, scan])

  // 无记忆的项目不显示该子文件夹（用户只在真有记忆时才看见这层）
  if (entries.length === 0) return null

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    if (!next) void scan() // 展开即重扫：agent 可能刚写了一条
  }

  // 折叠/展开切换文件夹图标 —— 与项目组标题行（SessionGroup）同一套折叠语汇
  const FolderIcon = collapsed ? FolderClosed : FolderOpen

  return (
    <div>
      <div
        onClick={toggle}
        title={t('sidebar.projectMemoryHint')}
        className={`group relative flex items-center gap-1.5 pl-2.5 pr-1.5 py-0.5 cursor-pointer text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary transition-opacity duration-200 ${
          dim ? 'opacity-30 hover:opacity-100' : ''
        }`}
      >
        <FolderIcon size={11} className="flex-shrink-0 text-text-tertiary/40" />
        {/* 标签按分组标题的字号/字重排（同 SessionGroup 的 header）——它是一层可展开的组，
            不是一条会话；条目行仍用 13px 常规体，两级一眼分得开 */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[12px]">
          <span className="truncate font-medium uppercase tracking-wider">
            {t('sidebar.projectMemory')}
          </span>
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-text-tertiary/60">
            {entries.length}
          </span>
        </div>
      </div>
      <AnimatedCollapse open={!collapsed}>
        <div className="ml-1.5 pl-0.5">
          {entries.map((m) => {
            const active = activeSlug === m.slug
            return (
              <div
                key={m.slug}
                onClick={() => void adapter.open(projectId, m.slug)}
                title={`${m.slug}.md${m.description ? ` — ${m.description}` : ''}`}
                className={`group flex items-center gap-1.5 pl-2.5 pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
                  active
                    ? 'bg-bg-active/80 text-text-primary'
                    : `text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary ${
                        dim ? 'opacity-30 hover:opacity-100' : ''
                      }`
                }`}
              >
                <FileText
                  size={11}
                  className={`flex-shrink-0 ${active ? 'text-accent' : 'text-text-tertiary/40'}`}
                />
                <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[13px]">
                  <span className="truncate">{m.name}</span>
                  {/* 常驻记忆：正文每会话全额注入，与「按需展开」的条目不是一回事，值得一个标记 */}
                  {m.pinned && (
                    <Pin
                      size={9}
                      className="ml-auto shrink-0 text-text-tertiary/50"
                      aria-label={t('sidebar.memoryPinned')}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </AnimatedCollapse>
    </div>
  )
}

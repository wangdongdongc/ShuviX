import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { useClickOutside } from '../../hooks/useClickOutside'

interface SessionPickerProps {
  value: string
  onChange: (sessionId: string) => void
}

interface SessionItem {
  id: string
  title: string
  projectId: string | null
}

interface ProjectItem {
  id: string
  name: string
}

const TEMP_GROUP = '__temp__'

/**
 * 会话选择器 — 按项目分组 + 搜索过滤
 * 用于日志筛选等需要选择会话的场景
 */
export function SessionPicker({ value, onChange }: SessionPickerProps): React.JSX.Element {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const close = useCallback(() => {
    setOpen(false)
    setSearch('')
  }, [])

  useClickOutside(ref, close, open)

  // 加载数据
  useEffect(() => {
    if (!open) return
    void (async () => {
      const [sList, pList] = await Promise.all([
        window.api.session.list(),
        window.api.project.list()
      ])
      setSessions(sList.map((s) => ({ id: s.id, title: s.title, projectId: s.projectId })))
      setProjects(pList.map((p) => ({ id: p.id, name: p.name })))
    })()
  }, [open])

  // 搜索过滤
  const filtered = useMemo(() => {
    if (!search) return sessions
    const q = search.toLowerCase()
    return sessions.filter((s) => (s.title || s.id).toLowerCase().includes(q))
  }, [sessions, search])

  // 按项目分组
  const groups = useMemo(() => {
    const map = new Map<string, SessionItem[]>()
    // 先为每个项目建空组
    for (const p of projects) map.set(p.id, [])
    // 分配会话
    const temp: SessionItem[] = []
    for (const s of filtered) {
      if (s.projectId && map.has(s.projectId)) {
        map.get(s.projectId)!.push(s)
      } else {
        temp.push(s)
      }
    }
    // 过滤掉空组，排序
    const result: Array<{ key: string; label: string; items: SessionItem[] }> = []
    for (const p of projects) {
      const items = map.get(p.id)!
      if (items.length > 0) {
        result.push({ key: p.id, label: p.name, items })
      }
    }
    if (temp.length > 0) {
      result.push({ key: TEMP_GROUP, label: t('sidebar.tempChats'), items: temp })
    }
    return result
  }, [filtered, projects, t])

  // 当前选中会话的显示名
  const displayLabel = useMemo(() => {
    if (!value) return t('settings.allSessions')
    const s = sessions.find((s) => s.id === value)
    return s ? s.title || s.id.slice(0, 8) : t('settings.allSessions')
  }, [value, sessions, t])

  const toggleGroup = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const select = (id: string): void => {
    onChange(id)
    close()
  }

  return (
    <div ref={ref} className="relative">
      {/* 触发按钮 */}
      <button
        onClick={() => {
          if (open) close()
          else {
            setCollapsed(new Set())
            setOpen(true)
          }
        }}
        className="inline-flex items-center gap-1 bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none hover:border-accent/50 transition-colors cursor-pointer max-w-[160px]"
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown size={10} className="text-text-tertiary flex-shrink-0" />
      </button>

      {/* 弹出面板 */}
      {open && (
        <div className="absolute left-0 top-full mt-1 w-[260px] rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden flex flex-col z-50">
          {/* 搜索框 */}
          <div className="px-2 py-2 border-b border-border-secondary">
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-bg-primary border border-border-primary">
              <Search size={12} className="text-text-tertiary" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('settings.searchSession')}
                className="flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
                autoFocus
              />
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {/* 全部会话 */}
            {!search && (
              <button
                onClick={() => select('')}
                className={`w-full text-left px-3 py-2 text-[11px] transition-colors border-b border-border-secondary ${
                  !value
                    ? 'bg-accent/10 text-accent font-medium'
                    : 'text-text-primary hover:bg-bg-hover'
                }`}
              >
                {t('settings.allSessions')}
              </button>
            )}

            {/* 分组列表 */}
            {groups.length === 0 && search ? (
              <div className="px-3 py-4 text-[11px] text-text-tertiary text-center">
                {t('settings.noMatchSession')}
              </div>
            ) : (
              groups.map((group) => {
                const isCollapsed = collapsed.has(group.key)
                return (
                  <div key={group.key} className="border-b border-border-secondary last:border-b-0">
                    {/* 项目标题 */}
                    <button
                      onClick={() => toggleGroup(group.key)}
                      className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
                    >
                      {isCollapsed ? (
                        <ChevronRight size={10} />
                      ) : (
                        <ChevronDown size={10} />
                      )}
                      <span className="truncate">{group.label}</span>
                      <span className="ml-auto text-[9px] opacity-60">{group.items.length}</span>
                    </button>

                    {/* 会话列表 */}
                    {!isCollapsed && (
                      <div className="pb-1">
                        {group.items.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => select(s.id)}
                            className={`w-full text-left pl-7 pr-3 py-1.5 text-[11px] transition-colors ${
                              value === s.id
                                ? 'bg-accent/10 text-accent font-medium'
                                : 'text-text-primary hover:bg-bg-hover'
                            }`}
                          >
                            <span className="block truncate">{s.title || s.id.slice(0, 8)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

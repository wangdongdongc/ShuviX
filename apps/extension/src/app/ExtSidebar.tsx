import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { getChatApi, type Session } from '@shuvix/chat-ui'
import {
  Sidebar,
  ProjectConfigDialog,
  ProjectInfoForm,
  ProjectSessionGroups,
  CalendarView,
  ViewSwitchButton,
  useProjects,
  useSidebarStore
} from '@shuvix/app-shell'
import { projectStore } from '../storage/projectStore'

/**
 * 扩展侧栏 —— 薄封装共享 <Sidebar>，仅注入扩展专属行为：
 *  - 打开文件夹走浏览器 FSA（showDirectoryPicker → projectStore.createFromHandle → 新建会话）
 *  - 项目编辑弹窗经 overlays 注入（ProjectConfigDialog 仅「项目信息」tab）
 *  - 项目 / 日历视图切换（与桌面一致，复用共享 CalendarView + ProjectSessionGroups）
 *  - 打开设置切 hash；无 pin/徽标/窗口拖拽/原生右键菜单等桌面能力
 *  - 归档项目的恢复 / 删除已移至「设置 → Projects → 已归档」
 */
export function ExtSidebar({
  onNew,
  onDelete,
  onOpenSettings
}: {
  onNew: (projectId?: string | null) => void | Promise<void>
  onDelete: (id: string) => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { projects } = useProjects()
  const width = useSidebarStore((s) => s.width)
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'projects' | 'calendar'>('projects')
  const [calendarCollapsed, setCalendarCollapsed] = useState<Set<string>>(() => new Set())

  /** 打开文件夹 → 建项目 → 在该项目下新建会话（项目列表经 project.changed 自动刷新） */
  const openFolder = async (): Promise<void> => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      const proj = await projectStore.createFromHandle(handle)
      await onNew(proj.id)
    } catch {
      /* 用户取消选择 */
    }
  }

  const toggleCalendarGroup = (key: string): void =>
    setCalendarCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <Sidebar
      projects={projects}
      title={viewMode === 'calendar' ? t('sidebar.viewCalendar') : t('sidebar.title')}
      onOpenFolder={openFolder}
      onOpenSettings={onOpenSettings}
      onDeleteSession={onDelete}
      onEditProject={setEditingProjectId}
      titleActions={<ViewSwitchButton viewMode={viewMode} onChange={setViewMode} />}
      bodyOverride={
        viewMode === 'calendar' ? (
          <CalendarView
            width={width}
            renderGroupedSessionsForDay={(daySessions: Session[]) => (
              <ProjectSessionGroups
                projects={projects}
                sessionsOverride={daySessions}
                hideEmptyGroups
                collapsed={calendarCollapsed}
                onToggleGroup={toggleCalendarGroup}
                onNewChat={(pid) => void onNew(pid)}
                onDelete={onDelete}
                onEditProject={setEditingProjectId}
              />
            )}
          />
        ) : undefined
      }
      overlays={
        editingProjectId ? (
          <ExtProjectDialog
            projectId={editingProjectId}
            onClose={() => setEditingProjectId(null)}
          />
        ) : undefined
      }
    />
  )
}

/** 扩展项目配置弹窗 —— 复用共享 ProjectConfigDialog（仅「项目信息」tab）+ 归档 */
function ExtProjectDialog({
  projectId,
  onClose
}: {
  projectId: string
  onClose: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void getChatApi()
      .project.getById(projectId)
      .then((p) => {
        if (p) {
          setName(p.name)
          setPath(p.path)
        }
        setLoaded(true)
      })
  }, [projectId])

  if (!loaded) return null

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await getChatApi().project.update({ id: projectId, name: name.trim() || undefined })
      onClose()
    } finally {
      setSaving(false)
    }
  }
  const archive = async (): Promise<void> => {
    await getChatApi().project.update({ id: projectId, archived: true })
    onClose()
  }

  return (
    <ProjectConfigDialog
      title={t('projectForm.editTitle')}
      tabs={[
        {
          key: 'project',
          label: t('projectForm.wizardStepProject'),
          content: <ProjectInfoForm name={name} onNameChange={setName} path={path} />
        }
      ]}
      activeTab="project"
      onTabChange={() => {}}
      onClose={onClose}
      onSave={save}
      saving={saving}
      onArchive={archive}
    />
  )
}

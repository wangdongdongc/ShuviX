import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, FolderClosed, RotateCcw, Trash2 } from 'lucide-react'
import { getChatApi } from '@shuvix/chat-ui'
import { useProjects } from '../sidebar/useProjects'

export interface ProjectsSettingsProps {
  /** 删除归档项目（宿主自处理确认 + 级联）；缺省隐藏删除按钮 */
  onDeleteProject?: (projectId: string, name: string) => void
}

type ProjectsSubTab = 'archived'

/** 子分类导航按钮（与 McpSettings / SkillSettings 视觉一致） */
function SubTabButton({
  icon,
  label,
  active,
  onClick
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
        active
          ? 'bg-accent/10 text-accent'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      <span className="shrink-0 inline-flex items-center h-[18px]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium truncate">{label}</div>
      </div>
    </button>
  )
}

/**
 * 项目设置页（桌面/扩展共用）—— 左侧子导航 + 右侧内容；当前仅「已归档」subtab：
 * 列出归档项目并支持恢复（内部直接经 getChatApi）/ 删除（宿主注入确认 + 级联）。
 * 数据经 useProjects() 订阅 'project.changed' 自动刷新。
 */
export function ProjectsSettings({ onDeleteProject }: ProjectsSettingsProps): React.JSX.Element {
  const { t } = useTranslation()
  const { archivedProjects } = useProjects()
  const [subTab, setSubTab] = useState<ProjectsSubTab>('archived')

  const handleRestore = async (id: string): Promise<void> => {
    // 项目列表经 useProjects() 订阅 'project.changed' 自动刷新
    await getChatApi().project.update({ id, archived: false })
  }

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧子导航 */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          <SubTabButton
            icon={<Archive size={14} className="shrink-0 text-text-tertiary" />}
            label={t('settings.projectsSubTabArchived')}
            active={subTab === 'archived'}
            onClick={() => setSubTab('archived')}
          />
        </div>
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4">
        {archivedProjects.length === 0 ? (
          <div className="px-3 py-8 text-center text-text-tertiary text-xs">
            {t('settings.projectsNoArchived')}
          </div>
        ) : (
          <div className="space-y-0.5">
            {archivedProjects.map((p) => (
              <div
                key={p.id}
                className="group relative flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-text-secondary hover:bg-bg-hover"
              >
                <FolderClosed size={13} className="flex-shrink-0 text-text-tertiary" />
                <span className="flex-1 min-w-0 truncate text-[13px] group-hover:pr-16">
                  {p.name}
                </span>
                <div className="absolute right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => void handleRestore(p.id)}
                    className="p-1 rounded hover:bg-bg-hover text-text-tertiary/70 hover:text-text-secondary"
                    title={t('sidebar.restoreProject')}
                  >
                    <RotateCcw size={13} className="text-green-400/80" />
                  </button>
                  {onDeleteProject && (
                    <button
                      onClick={() => onDeleteProject(p.id, p.name)}
                      className="p-1 rounded hover:bg-bg-hover text-text-tertiary/70 hover:text-red-400"
                      title={t('sidebar.deleteProject')}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

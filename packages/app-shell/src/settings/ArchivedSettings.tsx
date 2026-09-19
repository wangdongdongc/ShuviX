import { useTranslation } from 'react-i18next'
import { FolderClosed, RotateCcw, Trash2 } from 'lucide-react'
import { getChatApi } from '@shuvix/chat-ui'
import { useProjects } from '../sidebar/useProjects'
import { PanelTabBar } from '../panel/PanelTabBar'

export interface ArchivedSettingsProps {
  /** 删除归档项目（宿主自处理确认 + 级联）；缺省隐藏删除按钮 */
  onDeleteProject?: (projectId: string, name: string) => void
}

/**
 * 已归档设置页（桌面/扩展共用）—— 归档内容的统一去处。
 * 子分类走横向标签条（监视器同款 PanelTabBar，理由见其注释：一级 tab 列已吃掉宽度，
 * 再加一列子导航正文就不剩了）；当前仅「项目」：列出归档项目并支持恢复（内部直接经
 * getChatApi）/ 删除（宿主注入确认 + 级联）。日后新增归档对象（如会话）= tabs 加一项 +
 * 一个内容分支。数据经 useProjects() 订阅 'project.changed' 自动刷新。
 */
export function ArchivedSettings({ onDeleteProject }: ArchivedSettingsProps): React.JSX.Element {
  const { t } = useTranslation()
  const { archivedProjects } = useProjects()

  const handleRestore = async (id: string): Promise<void> => {
    // 项目列表经 useProjects() 订阅 'project.changed' 自动刷新
    await getChatApi().project.update({ id, archived: false })
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelTabBar
        tabs={[
          { key: 'projects', label: t('settings.archivedSubTabProjects'), Icon: FolderClosed }
        ]}
        activeKey="projects"
        onSelect={() => {
          /* 单 tab 时代无可切换；新增归档对象时这里改为 setSubTab */
        }}
        className="px-1 bg-bg-primary"
      />

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
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

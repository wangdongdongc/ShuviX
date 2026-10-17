import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderClosed, RotateCcw, Trash2, type LucideIcon } from 'lucide-react'
import { getChatApi } from '@shuvix/chat-ui'
import { useProjects } from '../sidebar/useProjects'
import { PanelTabBar } from '../panel/PanelTabBar'

/** 宿主额外提供的一类归档对象（桌面：已归档的小组件） */
export interface ArchivedSettingsTab {
  key: string
  label: string
  Icon: LucideIcon
  content: ReactNode
}

export interface ArchivedSettingsProps {
  /** 删除归档项目（宿主自处理确认 + 级联）；缺省隐藏删除按钮 */
  onDeleteProject?: (projectId: string, name: string) => void
  /** 排在「项目」之后的其他归档对象 —— 只有宿主才有的那些（小组件只在桌面上） */
  extraTabs?: readonly ArchivedSettingsTab[]
}

/**
 * 已归档设置页（桌面/扩展共用）—— 归档内容的统一去处。
 * 子分类走横向标签条（监视器同款 PanelTabBar，理由见其注释：一级 tab 列已吃掉宽度，
 * 再加一列子导航正文就不剩了）。「项目」由这里自己画：列出归档项目并支持恢复（内部直接经
 * getChatApi）/ 删除（宿主注入确认 + 级联），数据经 useProjects() 订阅 'project.changed' 自动刷新；
 * 只有某个宿主才有的归档对象（桌面的小组件）由宿主经 `extraTabs` 交进来，内容整块由宿主画。
 */
export function ArchivedSettings({
  onDeleteProject,
  extraTabs = []
}: ArchivedSettingsProps): React.JSX.Element {
  const { t } = useTranslation()
  const { archivedProjects } = useProjects()
  const [subTab, setSubTab] = useState('projects')
  const extra = extraTabs.find((tab) => tab.key === subTab)

  const handleRestore = async (id: string): Promise<void> => {
    // 项目列表经 useProjects() 订阅 'project.changed' 自动刷新
    await getChatApi().project.update({ id, archived: false })
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelTabBar
        tabs={[
          { key: 'projects', label: t('settings.archivedSubTabProjects'), Icon: FolderClosed },
          ...extraTabs.map(({ key, label, Icon }) => ({ key, label, Icon }))
        ]}
        activeKey={extra ? extra.key : 'projects'}
        onSelect={setSubTab}
        className="px-1 bg-bg-primary"
      />

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {extra ? (
          extra.content
        ) : archivedProjects.length === 0 ? (
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

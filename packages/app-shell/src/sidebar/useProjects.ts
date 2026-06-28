import { useEffect, useState, useCallback } from 'react'
import { getChatApi } from '@shuvix/chat-ui'

export interface ProjectRef {
  id: string
  name: string
}

export interface UseProjectsReturn {
  projects: ProjectRef[]
  archivedProjects: ProjectRef[]
  reload: () => Promise<void>
}

/**
 * 项目列表数据源（桌面/扩展共用）—— 经 getChatApi() 拉活动 + 归档项目，
 * 并订阅 AppEvent 'project.changed'（创建/编辑/归档/删除后自动刷新）。
 * 侧栏与桌面日历视图共用同一份数据，避免各自重复加载。
 */
export function useProjects(): UseProjectsReturn {
  const [projects, setProjects] = useState<ProjectRef[]>([])
  const [archivedProjects, setArchivedProjects] = useState<ProjectRef[]>([])

  const reload = useCallback(async (): Promise<void> => {
    const [active, archived] = await Promise.all([
      getChatApi().project.list(),
      getChatApi().project.listArchived()
    ])
    setProjects(active.map((p) => ({ id: p.id, name: p.name })))
    setArchivedProjects(archived.map((p) => ({ id: p.id, name: p.name })))
  }, [])

  useEffect(() => {
    // reload 内的 setState 都在 await 之后（异步），非同步级联渲染
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
    return getChatApi().events.subscribe((e) => {
      if (e.type === 'project.changed') void reload()
    })
  }, [reload])

  return { projects, archivedProjects, reload }
}

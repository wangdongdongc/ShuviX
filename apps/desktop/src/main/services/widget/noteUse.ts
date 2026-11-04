/**
 * 记下「这条会话用过这个组件」，项目从会话行取（子会话的项目就是父会话的；bot 会话算它引用的工作项目；隐藏的承载项目
 * 不算项目）。只作信息关联（Widget 面板的卡片据此显示项目标签）：记不下来不影响调用。
 *
 * 单独成文件、不从模块入口导出：它要读会话行，而 widgetService 的单测不该为此连上数据库。
 */
import { projectContextIdOf } from '@shuvix/chat-protocol/botSession'
import { isHiddenProjectId } from '@shuvix/chat-protocol/hiddenProjects'
import { sessionRecords } from '../sessionRecords'
import { widgetService } from './widgetService'

export function noteWidgetUse(widgetId: string, sessionId: string): void {
  try {
    const projectId = projectContextIdOf(sessionRecords.pick(sessionId, ['projectId', 'settings']))
    widgetService.noteSessionUse(
      widgetId,
      sessionId,
      projectId && !isHiddenProjectId(projectId) ? projectId : null
    )
  } catch {
    /* 见上 */
  }
}

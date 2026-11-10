import { useMemo } from 'react'
import { getChatApi, useChatStore } from '@shuvix/chat-ui'
import type { InboxTrackingAdapter } from '@shuvix/app-shell'

/**
 * 跟踪项（实验）的宿主能力 —— 收件箱的「跟踪中」一节与手机资料库的「跟踪项」分组共用一份。清单是
 * `~/.shuvix/tracking` 里的 md，点一行打开那份文件的**笔记本会话**（main 侧去重，隐藏项目 `__tracking__`）；
 * 改状态只改 frontmatter 的 `status` 一行（main 侧提交并广播 `tracking.changed`）。
 *
 * `select`：选中会话的那一步（侧栏的会带上手机布局的「推一页」）。引用必须稳定（useMemo）：两处都以 adapter 为扫描依赖。
 */
export function useTrackingAdapter(select: (sessionId: string) => void): InboxTrackingAdapter {
  return useMemo<InboxTrackingAdapter>(
    () => ({
      list: () => window.api.tracking.list(),
      open: async (fileName, title) => {
        let session: { id: string }
        try {
          session = await window.api.tracking.openNote({ fileName, title })
        } catch {
          return // 文件已不在（清单过期）—— tracking.changed / 聚焦重扫会把这一行拿掉
        }
        useChatStore.getState().setSessions(await getChatApi().session.list())
        select(session.id)
      },
      openFolder: () => window.api.tracking.openFolder(),
      revealFile: (path) => void window.api.app.revealPath(path),
      remove: async (fileName) => {
        try {
          const { sessionId } = await window.api.tracking.deleteItem({ fileName })
          if (sessionId) useChatStore.getState().removeSession(sessionId)
        } catch {
          // 删不掉（权限之类）—— 行还在，用户看得见没删成
        }
      },
      setStatus: (fileName, status) => window.api.tracking.setStatus({ fileName, status })
    }),
    [select]
  )
}

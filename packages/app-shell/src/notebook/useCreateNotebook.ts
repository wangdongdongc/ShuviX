import { useCallback } from 'react'
import { getChatApi, useChatStore } from '@shuvix/chat-ui'
import { basename, relativize } from '../files/paths'

/** 笔记本会话标题：取文件名并去掉 markdown 后缀（.md/.mdx/.markdown）。
 *  放在此共享 hook 而非各宿主后端，避免桌面 / 扩展两端各自重复推导导致行为漂移。 */
function notebookTitle(relPath: string): string {
  return basename(relPath).replace(/\.(md|mdx|markdown)$/i, '')
}

/**
 * 「创建笔记本会话」处理器 —— 供 FilesPanel 预览顶栏的 onCreateNotebook 复用（桌面 + 扩展一致）。
 * 把预览文件相对当前项目根算出 notebookPath，创建绑定该 md 的笔记本会话，刷新列表并选中（自动打开）。
 * 标题在此统一推导后显式传入，宿主后端无需各自从 notebookPath 命名。
 * 切换到新会话会触发 FilesPanel 关闭预览。projectPath 缺失（临时会话）则 no-op。
 */
export function useCreateNotebook(): (params: { path: string; sessionId: string }) => void {
  return useCallback(({ path, sessionId }) => {
    const { sessions, projectPath } = useChatStore.getState()
    if (!projectPath) return
    const rel = relativize(projectPath, path)
    if (rel == null || rel === '') return
    const projectId = sessions.find((s) => s.id === sessionId)?.projectId ?? null
    void (async () => {
      const nb = await getChatApi().session.create({
        projectId,
        notebookPath: rel,
        title: notebookTitle(rel)
      })
      const all = await getChatApi().session.list()
      useChatStore.getState().setSessions(all)
      useChatStore.getState().setActiveSessionId(nb.id)
    })()
  }, [])
}

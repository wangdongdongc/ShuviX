import { useEffect } from 'react'
import { getSessionChannelApi, useChatStore } from '@shuvix/chat-ui'

/**
 * 文件预览桥：chatStore.filePreviewRequest（Files 面板点文件 / 笔记本 [[双链]] / 对话里的文件链接 /
 * 工具缩略图 / 音视频 dock 的展开）→ 主进程在独立窗口里打开该文件。
 *
 * 桌面没有预览面板了：md 进协作编辑窗口，其余可预览的进只读预览窗口，不支持预览的（二进制等）
 * 主进程不响应（见 previewWindowService）。会话 id 取信号时刻的活跃会话 —— 相对路径按它的
 * 工作目录解析，预览窗口读文件也借它。
 *
 * 每个挂了 SessionRuntime 的窗口（主窗口、悬浮窗、md 窗口）各自消费自己 store 里的信号；
 * 预览窗口没有活跃会话，传 `sessionId` 指定借用哪个会话。
 */
export function useFilePreviewBridge(sessionId?: string): void {
  const isWeb = getSessionChannelApi().app.platform === 'web'
  const request = useChatStore((s) => s.filePreviewRequest)
  useEffect(() => {
    if (!request || isWeb) return
    const sid = sessionId ?? useChatStore.getState().activeSessionId
    if (!sid) return
    void window.api.files.open({
      sessionId: sid,
      path: request.absPath,
      openedBy: request.openedBy
    })
  }, [request, isWeb, sessionId])
}

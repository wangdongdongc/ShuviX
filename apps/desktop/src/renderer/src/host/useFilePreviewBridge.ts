import { useEffect } from 'react'
import { imageNameOf, isImagePath, openImageViewer, useChatStore } from '@shuvix/chat-ui'
import { libraryItemIdOfRef } from '@shuvix/chat-protocol/fileLibrary'
import { showFileOpenNotice } from './fileOpenNotice'

/**
 * 文件预览桥：chatStore.filePreviewRequest（Files 面板点文件 / 笔记本 [[双链]] / 对话里的文件链接 /
 * 工具缩略图 / 音视频 dock 的展开）→ 打开该文件。
 *
 *  - **图片**（按扩展名；`library:` 引用看请求带的文件名）→ 当前窗口的看图层（HostImageViewer，2026-11-20 用户裁定：
 *    不再开独立窗口 / 新标签页）。点图的地方能给一组图的，自己直接调 `openImageViewer`，不走这里。
 *  - 其余 → 主进程开窗：md 进协作编辑窗口，其余可预览的进只读预览窗口；不支持预览的（二进制、太大、不存在 …）
 *    主进程不开窗、交回原因，这里给一句轻提示（FileOpenNoticeLayer，见 previewWindowService）。
 *
 * 会话 id 取信号时刻的活跃会话 —— 相对路径按它的工作目录解析，预览窗口读文件也借它。文件库里的一件不按会话
 * 解析：没有活跃会话（欢迎页上点右侧时间线）也照开。
 *
 * 每个挂了 SessionRuntime 的窗口（主窗口、悬浮窗、md 窗口）各自消费自己 store 里的信号；
 * 预览窗口没有活跃会话，传 `sessionId` 指定借用哪个会话。
 */
export function useFilePreviewBridge(sessionId?: string): void {
  const request = useChatStore((s) => s.filePreviewRequest)
  useEffect(() => {
    if (!request) return
    const library = libraryItemIdOfRef(request.absPath) !== undefined
    const sid = sessionId ?? useChatStore.getState().activeSessionId ?? (library ? 'library' : null)
    if (!sid) return
    if (isImagePath(request.name ?? request.absPath)) {
      openImageViewer([
        {
          sessionId: sid,
          path: request.absPath,
          name: request.name ?? imageNameOf(request.absPath),
          openPath: request.absPath
        }
      ])
      return
    }
    window.api.files
      .open({
        sessionId: sid,
        path: request.absPath,
        openedBy: request.openedBy
      })
      .then((result) => {
        if (!result.opened) showFileOpenNotice(request.absPath, result)
      })
      .catch(() => undefined)
  }, [request, sessionId])
}

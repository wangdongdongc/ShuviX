import { useCallback } from 'react'
import { ImageViewer, MediaUrlProvider, useChatStore, type ViewerImage } from '@shuvix/chat-ui'
import { hostMediaResolver, isWebHost } from './hostMedia'
import { useCompactLayout } from '../mobile/useCompactLayout'
import { showFileOpenNotice } from './fileOpenNotice'

/**
 * 本窗口的看图层（chat-ui ImageViewer）：自带媒体地址解析器（md 窗口外层没有 MediaUrlProvider），
 * 手机布局（web 客户端窄屏）用全屏 + 手势样式；「在独立窗口打开」走 `files.open`（桌面开预览窗口，
 * web 开新标签页），开不了照常给一句轻提示。
 */
export function HostImageViewer(): React.JSX.Element {
  const touch = useCompactLayout()
  const openInWindow = useCallback((image: ViewerImage): void => {
    const path = image.openPath
    if (!path) return
    window.api.files
      .open({ sessionId: sessionOf(image), path, openedBy: 'user' })
      .then((result) => {
        if (!result.opened) showFileOpenNotice(path, result)
      })
      .catch(() => undefined)
  }, [])
  // 桌面：复制 / 另存交主进程（页面读不到 shuvix-preview:// 的字节）；web 客户端是同源 HTTP，页面自己读
  const copy = useCallback(async (image: ViewerImage): Promise<boolean> => {
    if (!image.path) return false
    return (
      (await window.api.files.copyImage({
        sessionId: sessionOf(image),
        path: image.path,
        name: image.name
      })) === true
    )
  }, [])
  const save = useCallback(async (image: ViewerImage): Promise<void> => {
    if (!image.path) return
    await window.api.files.saveImage({
      sessionId: sessionOf(image),
      path: image.path,
      name: image.name
    })
  }, [])
  // macOS 的主窗口 / 悬浮窗 / md 窗口是隐藏标题栏，左上角是窗口按钮
  const insetLeft = !isWebHost && window.api.app.platform === 'darwin' ? 84 : 0
  return (
    <MediaUrlProvider value={hostMediaResolver}>
      <ImageViewer
        touch={touch}
        insetLeft={insetLeft}
        onOpenInWindow={openInWindow}
        onCopy={isWebHost ? undefined : copy}
        onSave={isWebHost ? undefined : save}
      />
    </MediaUrlProvider>
  )
}

/** 交给宿主调用的会话 id：图自己带的，否则活跃会话；文件库的引用不按会话解析 */
function sessionOf(image: ViewerImage): string {
  return image.sessionId || useChatStore.getState().activeSessionId || 'library'
}

/**
 * 「本地文件 → 可喂给 <img>/<video> 的 URL」注入点 —— 宿主差异收敛处。
 *
 * 桌面：注册了 shuvix-preview:// 自定义协议(主进程流式读盘)，同步拼 URL。
 * 扩展：无自定义协议 → 由 getFile 读字节生成 blob: object URL(异步，用完 revoke)。
 *
 * 消费方统一经 useMediaUrl 取 URL，不关心来源：app-shell 的 Files 预览
 * (MediaView/PdfView/AudioDock/VideoDock/笔记本内嵌图)，以及 chat-ui 工具卡片里
 * 「模型收到的那张图」的内联展示。后者是这个 seam 从 app-shell 下沉到 chat-ui 的
 * 原因 —— 依赖方向是 app-shell → chat-ui，工具卡片够不着上层包。
 */
import { createContext, useContext, useEffect, useState } from 'react'

export interface MediaSource {
  url: string
  /** blob URL 等需要在卸载/切换时释放的清理钩子 */
  revoke?: () => void
}

export type ResolveMediaUrl = (params: {
  sessionId: string
  path: string
  mimeType?: string
}) => MediaSource | Promise<MediaSource>

const MediaUrlContext = createContext<ResolveMediaUrl | null>(null)

export const MediaUrlProvider = MediaUrlContext.Provider

/** 桌面默认实现：shuvix-preview:// 协议 URL（同步） */
export const shuvixPreviewResolver: ResolveMediaUrl = ({ sessionId, path }) => ({
  url: `shuvix-preview://load/?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
})

/**
 * 取注入的媒体 URL 解析器本体（可能为 null）。用于无法用 useMediaUrl（每路径一 hook）的场景，
 * 如笔记本编辑器内 `![[image]]` 内嵌：需在 CM6 同步回调中按需解析任意多张图片并自管缓存。
 */
export function useResolveMediaUrl(): ResolveMediaUrl | null {
  return useContext(MediaUrlContext)
}

/**
 * 解析媒体/PDF 资源 URL。未就绪返回 null（调用方显示占位/loading）。
 * 异步来源(blob)在 path/session 变化或卸载时自动 revoke，避免内存泄漏。
 */
export function useMediaUrl(sessionId: string, path: string, mimeType?: string): string | null {
  const resolve = useContext(MediaUrlContext)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!resolve) {
      setUrl(null) // eslint-disable-line react-hooks/set-state-in-effect
      return
    }
    let cancelled = false
    let revoke: (() => void) | undefined
    Promise.resolve(resolve({ sessionId, path, mimeType }))
      .then((src) => {
        if (cancelled) {
          src.revoke?.()
          return
        }
        revoke = src.revoke
        setUrl(src.url)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
      revoke?.()
    }
  }, [resolve, sessionId, path, mimeType])

  return url
}

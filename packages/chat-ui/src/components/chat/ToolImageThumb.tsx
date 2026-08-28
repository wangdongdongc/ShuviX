import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolResultImage } from '@shuvix/chat-protocol/types/chatMessage'
import { useMediaUrl } from '../../host/mediaUrl'
import { useChatStore } from '../../stores/chatStore'

/**
 * 工具卡片里「模型收到的那张图」的内联展示。
 *
 * 两条硬约束，改动前先读：
 *
 * 1. **不碰 base64**。URL 经注入的 mediaUrl seam 取（桌面是 shuvix-preview:// 协议，
 *    主进程流式读盘），图片字节从不经过 IPC、React state 或消息树。工具结果里的
 *    base64 是给模型的，广播路径专门有条管线把它换成占位文本 —— 别在这里把它请回来。
 * 2. **只在展开态挂载**。调用点在 ToolCallBlock 的展开分支里，而卡片默认折叠，所以
 *    同时存活的解码位图只有用户手动展开的那几张（一张 1512×982 解码约 6MB）。把它
 *    提到折叠态渲染，等于把一整条会话的截图一次性解码进内存。
 *
 * 画质契约：src 指向的就是模型收到的那一份（超限图片经 read 缩放重编码后落盘的派生图，
 * 见 ToolResultImage）。缩略图是同一份文件的 CSS 缩放，点开是同一份文件的原尺寸 ——
 * 用户不会看到比模型更清楚的画面。
 *
 * 点击走 requestFilePreview：与 Files 面板点文件、preview 工具、笔记本 [[wiki-link]]
 * 同一条信号，预览面板/覆盖层已经接好，不必另写 lightbox。
 */
export function ToolImageThumb({ image }: { image: ToolResultImage }): React.JSX.Element | null {
  const { t } = useTranslation()
  const sessionId = useChatStore((s) => s.activeSessionId)
  const [failed, setFailed] = useState(false)
  const url = useMediaUrl(sessionId ?? '', image.path)

  // 文件没了（清过 tool_results / 用户删了源文件）就说一句，别留个破图标
  if (failed) {
    return <div className="text-[10px] text-text-tertiary/70">{t('toolCall.imageMissing')}</div>
  }
  // 宿主没注入 mediaUrl seam（或还没解析出来）→ 不占位，结果文本里本来就有路径
  if (!sessionId || !url) return null

  return (
    <div>
      <div className="text-[10px] text-text-tertiary mb-0.5">{t('toolCall.image')}</div>
      <img
        src={url}
        alt={image.path}
        title={t('toolCall.imageZoomHint')}
        loading="lazy"
        decoding="async"
        // 尺寸已知时先按比例占位，图解码完成不跳版
        style={
          image.width && image.height
            ? { aspectRatio: `${image.width} / ${image.height}` }
            : undefined
        }
        className="max-h-40 max-w-full w-auto rounded border border-border-secondary/50 object-contain cursor-zoom-in"
        onError={() => setFailed(true)}
        onClick={() => useChatStore.getState().requestFilePreview(image.path)}
      />
    </div>
  )
}

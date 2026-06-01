/**
 * VideoDock —— 贴在 FilesPanel 底部的迷你视频播放器
 *
 * 与 AudioDock 同理：不占据预览覆盖层，让用户边看边浏览文件。
 *
 * 尺寸策略：
 *   - 视频 metadata 加载后读出 videoWidth/videoHeight 原片宽高比
 *   - 用 ResizeObserver 跟踪 RightPanel 拖宽导致的 dock 宽度变化
 *   - 高度 = clamp(min, containerWidth * (h/w), max)
 *   - 在 [MIN_H, MAX_H] 区间内时 dock 比例 = 视频比例 → 无黑边、像素级贴合
 *   - 超过 MAX_H（如 9:16 手机竖屏）→ letterbox 两侧黑边，依赖 object-contain
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Film, Maximize2, X } from 'lucide-react'

/** 视频区高度上下限；MAX 防止竖屏吃掉文件树，MIN 保证原生控件不被压扁 */
const MAX_VIDEO_HEIGHT = 360
const MIN_VIDEO_HEIGHT = 120
/** 在 metadata 加载完成前的占位高度（一帧内会被替换） */
const FALLBACK_VIDEO_HEIGHT = 200

interface VideoDockProps {
  /** 绝对路径 */
  path: string
  mimeType: string
  fileName: string
  sessionId: string
  /** 停止播放 + 移除 dock */
  onClose: () => void
  /** 把当前媒体转入预览覆盖层（FilePreview 的 MediaView 全屏视图） */
  onExpand: () => void
}

export function VideoDock({
  path,
  mimeType,
  fileName,
  sessionId,
  onClose,
  onExpand
}: VideoDockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [errored, setErrored] = useState(false)
  /** 视频原片高宽比（height / width） —— null 表示 metadata 还没就绪 */
  const [aspect, setAspect] = useState<number | null>(null)
  /** dock 容器渲染宽度 —— 跟踪 RightPanel 拖宽 */
  const [containerWidth, setContainerWidth] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // 注：path 切换由父组件用 key={path} 强制 remount，state 自然回到 null，
  // 这里不需要写 useEffect([path]) 来手动复位 —— 既避免 set-state-in-effect 反模式，
  // 又顺带把 <video> 元素也一起重挂载，连原生控件状态都干净。

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth))
    ro.observe(el)
    setContainerWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  /** 实际高度：clamp(min, idealHeight, max)。aspect 未就绪时用 fallback */
  const videoHeight =
    aspect != null && containerWidth > 0
      ? Math.min(MAX_VIDEO_HEIGHT, Math.max(MIN_VIDEO_HEIGHT, containerWidth * aspect))
      : FALLBACK_VIDEO_HEIGHT

  const url = `shuvix-preview://load/?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`

  if (errored) {
    return (
      <div className="flex-shrink-0 flex items-center gap-2 px-2 h-8 border-t border-border-secondary/30 bg-bg-primary/40 text-[11px] text-text-tertiary">
        <Film size={11} className="text-text-tertiary/60 flex-shrink-0" />
        <span className="truncate flex-1" title={fileName}>
          {fileName}
        </span>
        <span className="text-text-tertiary/80">{t('panel.preview.mediaCannotPlay')}</span>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 transition-colors"
        >
          <X size={11} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex-shrink-0 border-t border-border-secondary/30 bg-bg-primary/40">
      {/* 顶部：图标 + 文件名 + 展开 + 关闭 */}
      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-text-tertiary">
        <Film size={10} className="text-accent/70 flex-shrink-0" />
        <span className="truncate flex-1 text-text-secondary" title={fileName}>
          {fileName}
        </span>
        <button
          onClick={onExpand}
          className="p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 transition-colors"
          title={t('panel.preview.mediaExpandToPreview')}
        >
          <Maximize2 size={10} />
        </button>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 transition-colors"
          title={t('panel.preview.mediaStop')}
        >
          <X size={10} />
        </button>
      </div>
      {/* 视频区：高度由 aspect + 容器宽度动态计算；当 idealH ≤ MAX 时 dock 比例与原片一致（无黑边） */}
      <div
        ref={containerRef}
        style={{ height: videoHeight }}
        className="flex items-center justify-center bg-black overflow-hidden transition-[height] duration-150"
      >
        <video
          key={path}
          src={url}
          controls
          autoPlay
          className="w-full h-full object-contain"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget
            if (v.videoWidth > 0 && v.videoHeight > 0) {
              setAspect(v.videoHeight / v.videoWidth)
            }
          }}
          onError={() => setErrored(true)}
        >
          <source src={url} type={mimeType} />
        </video>
      </div>
    </div>
  )
}

/**
 * AudioDock —— 贴在 FilesPanel 底部的迷你播放器
 *
 * 与 FilePreview 的 MediaView 关键差异：不进预览覆盖层，让用户听歌的同时
 * 文件树继续可见可操作。播放过程中点击其它文件不会打断；点击新音频替换源；
 * 关闭按钮或播放错误时下架。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, Music, X } from 'lucide-react'
import { useMediaUrl } from './mediaUrl'

interface AudioDockProps {
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

export function AudioDock({
  path,
  mimeType,
  fileName,
  sessionId,
  onClose,
  onExpand
}: AudioDockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [errored, setErrored] = useState(false)
  const url = useMediaUrl(sessionId, path, mimeType)

  if (errored) {
    return (
      <div className="flex-shrink-0 flex items-center gap-2 px-2 h-8 border-t border-border-secondary/30 bg-bg-primary/40 text-[11px] text-text-tertiary">
        <Music size={11} className="text-text-tertiary/60 flex-shrink-0" />
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
    <div className="flex-shrink-0 border-t border-border-secondary/30 bg-bg-primary/40 px-2 py-1.5">
      {/* 顶部一行：图标 + 文件名 + 展开 + 关闭 */}
      <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary mb-1 px-0.5">
        <Music size={10} className="text-accent/70 flex-shrink-0" />
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
      {/* 播放控件 —— key={path} 确保切歌时元素重挂载，立即加载新源 */}
      <audio
        key={path}
        src={url ?? undefined}
        controls
        autoPlay
        className="w-full"
        onError={() => setErrored(true)}
      >
        {url && <source src={url} type={mimeType} />}
      </audio>
    </div>
  )
}

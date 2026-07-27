import { useTranslation } from 'react-i18next'
import { Eye } from 'lucide-react'
import { FilePreview } from '../files/FilePreview'
import type { NotebookCaps } from '../notebook/LivePreviewEditor'
import { extOf } from '../files/paths'
import { usePreviewPanelStore } from './previewPanelStore'

/**
 * 独立预览面板（会话无关，跨端共享）—— FilePreview 的宿主面板化包装。
 *
 * 内容渲染/顶栏/关闭按钮全在 FilePreview（读取、监听变更、markdown live-preview、
 * hex/媒体等 kind 分派）；本组件只负责：无目标时的空态占位 + 目标注入 +
 * 「创建笔记本」的 markdown 门控。媒体 URL 解析由宿主在外层包 MediaUrlProvider。
 *
 * 露出位置由宿主决定：桌面主窗 = app 级右侧面板 preview tab；桌面悬浮窗 / 扩展 =
 * 会话面板（SessionPanel）的 Preview 工具页（previewContent 注入）。
 */

const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown'])

export interface PreviewPanelProps {
  /** markdown 只读 live-preview 的宿主能力（主题 / 外链） */
  notebookCaps?: NotebookCaps
  /** 提供则 markdown 预览顶栏显示「创建笔记本」；点击建绑定该 md 的笔记本会话 */
  onCreateNotebook?: (params: { path: string; sessionId: string }) => void
}

export function PreviewPanel({
  notebookCaps,
  onCreateNotebook
}: PreviewPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const target = usePreviewPanelStore((s) => s.target)
  const close = usePreviewPanelStore((s) => s.close)

  if (!target) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center bg-bg-secondary">
        <Eye size={28} strokeWidth={1.5} className="text-text-tertiary/40" />
        <div className="text-xs text-text-tertiary max-w-[240px]">{t('panel.previewEmpty')}</div>
      </div>
    )
  }

  const isMarkdown = MARKDOWN_EXTS.has(extOf(target.absPath))
  return (
    <FilePreview
      path={target.absPath}
      sessionId={target.sessionId}
      onClose={close}
      caps={notebookCaps}
      openedBy={target.openedBy}
      onCreateNotebook={
        isMarkdown && onCreateNotebook
          ? () => onCreateNotebook({ path: target.absPath, sessionId: target.sessionId })
          : undefined
      }
    />
  )
}

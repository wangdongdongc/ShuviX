/**
 * FilePreview — 覆盖在 FilesTree 上的二级视图
 *
 * 各 kind 渲染策略：
 *  - text + .md/.mdx/.markdown   → MarkdownView（只读 Atomic live-preview，可切源码模式）
 *  - text + 其它扩展             → CodeView（CodeMirror 6 read-only viewer）
 *  - image                       → <img> + data: URL
 *  - pdf / media                 → 通过 shuvix-preview 协议喂给 Chromium 原生 PDFium / <video>/<audio>
 *  - hex / binary / too-large / not-allowed / error → 各自的占位/专用视图
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Code2,
  FileText,
  FileX,
  ListOrdered,
  Loader2,
  Lock,
  Music,
  WrapText,
  X
} from 'lucide-react'
import { getSessionChannelApi, useAppEvent } from '@shuvix/chat-ui'
import { LivePreviewEditor, type NotebookCaps } from '../notebook/LivePreviewEditor'
import { CodeView } from './CodeView'
import { HexView } from './HexView'
import { useMediaUrl } from './mediaUrl'
import type { FileReadResult } from '@shuvix/chat-protocol/types/filePreview'

interface FilePreviewProps {
  /** 绝对路径 */
  path: string
  sessionId: string
  onClose: () => void
  /** 提供则在预览顶栏下方显示「创建笔记本」横幅按钮（仅 markdown 预览时由 FilesPanel 传入） */
  onCreateNotebook?: () => void
  /** 宿主能力注入（笔记本主题 / 外链）；markdown 走只读 live-preview 渲染时透传给编辑器 */
  caps?: NotebookCaps
}

const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown'])

export function FilePreview({
  path,
  sessionId,
  onClose,
  onCreateNotebook,
  caps
}: FilePreviewProps): React.JSX.Element {
  const { t } = useTranslation()
  const [result, setResult] = useState<FileReadResult | null>(null)
  /** 单行 minified / 长 JSON 等长行场景下让 CodeView 自动换行；切换文件不复位（视为面板偏好）。
   *  对非 markdown 文本，以及 markdown 切到「源码模式」时生效。 */
  const [wrapText, setWrapText] = useState(false)
  /** 文本代码视图是否显示行号；默认开，与主流编辑器一致 */
  const [showLineNumbers, setShowLineNumbers] = useState(true)
  /** markdown 预览模式：false=笔记本只读 live-preview（默认）；true=源码视图（同其它纯文本）。
   *  作为面板偏好，切换文件不复位。 */
  const [mdSourceMode, setMdSourceMode] = useState(false)

  useEffect(() => {
    let cancelled = false
    // 路径切换时立即清除旧结果，显示 loading；不会引发额外副作用
    setResult(null) // eslint-disable-line react-hooks/set-state-in-effect
    getSessionChannelApi()
      .files.read({ sessionId, path })
      .then((r) => {
        if (!cancelled) setResult(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setResult({
            kind: 'error',
            path,
            message: e instanceof Error ? e.message : String(e)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [path, sessionId])

  // 内容级刷新：当前预览文件被 edit/write 改动时静默重读（不清空 → 不闪 loading）。
  // 事件 paths 与 path 同一路径空间；省略 paths 视为"未知，保守重读"。
  useAppEvent('files.changed', (e) => {
    if (e.paths && !e.paths.includes(path)) return
    getSessionChannelApi()
      .files.read({ sessionId, path })
      .then(setResult)
      .catch(() => {
        /* 读失败保留旧内容 */
      })
  })

  const { fileName, parentDir } = splitPath(path)
  // 当前预览是否为 markdown 文本 —— 决定是否显示「渲染/源码」模式切换
  const isMarkdownText = result?.kind === 'text' && MARKDOWN_EXTS.has(result.ext)
  // wrap / 行号开关：非 markdown 文本，或 markdown 切到源码模式时显示（即落到 CodeView 时）
  const showWrapToggle = result?.kind === 'text' && (!isMarkdownText || mdSourceMode)

  return (
    <div className="flex flex-col h-full bg-bg-secondary">
      {/* 顶栏：左侧文件名 + 灰显父目录；右侧按钮组（wrap 切换 + 关闭） */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-2 h-7 border-b border-border-secondary/30">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-[11px] font-medium text-text-primary truncate" title={fileName}>
            {fileName}
          </span>
          {parentDir && (
            <span className="text-[10px] text-text-tertiary/70 truncate" title={parentDir}>
              {parentDir}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {isMarkdownText && (
            <button
              onClick={() => setMdSourceMode((v) => !v)}
              className={[
                'p-1 rounded hover:bg-bg-hover/40 transition-colors',
                mdSourceMode
                  ? 'text-accent bg-bg-hover/30'
                  : 'text-text-tertiary hover:text-text-secondary'
              ].join(' ')}
              title={t('panel.preview.markdownSourceToggle')}
            >
              <Code2 size={11} />
            </button>
          )}
          {showWrapToggle && (
            <>
              <button
                onClick={() => setShowLineNumbers((v) => !v)}
                className={[
                  'p-1 rounded hover:bg-bg-hover/40 transition-colors',
                  showLineNumbers
                    ? 'text-accent bg-bg-hover/30'
                    : 'text-text-tertiary hover:text-text-secondary'
                ].join(' ')}
                title={t('panel.preview.lineNumbersToggle')}
              >
                <ListOrdered size={11} />
              </button>
              <button
                onClick={() => setWrapText((v) => !v)}
                className={[
                  'p-1 rounded hover:bg-bg-hover/40 transition-colors',
                  wrapText
                    ? 'text-accent bg-bg-hover/30'
                    : 'text-text-tertiary hover:text-text-secondary'
                ].join(' ')}
                title={t('panel.preview.wrapToggle')}
              >
                <WrapText size={11} />
              </button>
            </>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 transition-colors"
            title={t('panel.preview.close')}
          >
            <X size={11} />
          </button>
        </div>
      </div>

      {/* 「新建会话」横幅：仅 markdown 预览且宿主提供回调时显示。按钮平铺整条横幅，
          高度与上方预览标题栏一致（h-7）。点击创建绑定该 md 的笔记本会话 */}
      {onCreateNotebook && (
        <button
          onClick={onCreateNotebook}
          className="flex-shrink-0 flex items-center justify-center gap-1.5 px-2 h-7 border-b border-border-secondary/30 text-xs font-medium text-accent bg-accent/5 hover:bg-accent/10 transition-colors"
        >
          <FileText size={13} />
          {t('panel.preview.createNotebook')}
        </button>
      )}

      {/* 内容区不带 overflow —— CodeView / MarkdownView 的 .cm-scroller、HexView 虚拟化、
        PdfView iframe、媒体元素 都各自管理滚动，避免双滚动条 */}
      <div className="flex-1 min-h-0">
        {renderBody(result, {
          t,
          path,
          sessionId,
          wrapText,
          showLineNumbers,
          mdSourceMode,
          caps
        })}
      </div>
    </div>
  )
}

interface RenderBodyOpts {
  t: (key: string, options?: Record<string, unknown>) => string
  /** 当前预览文件绝对路径（markdown live-preview 的 documentId） */
  path: string
  sessionId: string
  wrapText: boolean
  showLineNumbers: boolean
  /** markdown 是否走源码视图（CodeView）而非只读 live-preview */
  mdSourceMode: boolean
  caps?: NotebookCaps
}

function renderBody(r: FileReadResult | null, opts: RenderBodyOpts): React.ReactNode {
  const { t, path, sessionId, wrapText, showLineNumbers, mdSourceMode, caps } = opts
  if (!r) {
    // 文件加载中：纯居中 spinner，不写文案 —— 加载语义靠动画即可
    // （之前借用 panel.filesLoading 文案"正在扫描工作区"在文件加载语境下词不达意）
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary/50">
        <Loader2 size={20} className="animate-spin" />
      </div>
    )
  }
  switch (r.kind) {
    case 'image':
      return (
        <div className="flex items-center justify-center h-full p-3">
          <img
            src={`data:${r.mimeType};base64,${r.dataBase64}`}
            alt={r.path}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      )
    case 'text':
      // markdown 默认走只读 live-preview（笔记本同款渲染）；切到源码模式则落 CodeView
      if (MARKDOWN_EXTS.has(r.ext) && !mdSourceMode) {
        return <MarkdownView path={path} content={r.content} sessionId={sessionId} caps={caps} />
      }
      return (
        <CodeView content={r.content} ext={r.ext} wrap={wrapText} lineNumbers={showLineNumbers} />
      )
    case 'pdf':
      return <PdfView path={r.path} sessionId={sessionId} />
    case 'media':
      return (
        <MediaView
          path={r.path}
          size={r.size}
          mediaType={r.mediaType}
          mimeType={r.mimeType}
          sessionId={sessionId}
          t={t}
        />
      )
    case 'hex':
      return (
        <HexView
          data={r.data}
          size={r.size}
          bytesShown={r.bytesShown}
          truncated={r.truncated}
          magic={r.magic}
          ext={r.ext}
        />
      )
    case 'binary':
      return (
        <Placeholder
          icon={<FileX size={20} />}
          title={t('panel.preview.binary')}
          detail={`${r.ext || 'binary'} · ${formatBytes(r.size)}`}
        />
      )
    case 'too-large':
      return (
        <Placeholder
          icon={<AlertCircle size={20} />}
          title={t('panel.preview.tooLarge')}
          detail={t('panel.preview.tooLargeDetail', {
            size: formatBytes(r.size),
            cap: formatBytes(r.cap)
          })}
        />
      )
    case 'not-allowed':
      return (
        <Placeholder
          icon={<Lock size={20} />}
          title={t('panel.preview.notAllowed')}
          detail={r.reason}
        />
      )
    case 'error':
      return (
        <Placeholder
          icon={<AlertCircle size={20} />}
          title={t('panel.preview.error')}
          detail={r.message}
        />
      )
  }
}

/**
 * MediaView —— 视频 / 音频走 Chromium 原生 <video>/<audio> 标签，
 * 资源 URL 走我们注册的 shuvix-preview:// 协议（已做沙箱准入校验，避免 file:// 跨域）。
 * 出错时（编码器不支持 / 文件损坏 / 网络层失败）切到占位卡片。
 */
function MediaView({
  path,
  size,
  mediaType,
  mimeType,
  sessionId,
  t
}: {
  path: string
  size: number
  mediaType: 'video' | 'audio'
  mimeType: string
  sessionId: string
  t: (key: string, options?: Record<string, unknown>) => string
}): React.JSX.Element {
  const [errored, setErrored] = useState(false)
  const url = useMediaUrl(sessionId, path, mimeType)

  if (errored) {
    return (
      <Placeholder
        icon={<AlertCircle size={20} />}
        title={t('panel.preview.error')}
        detail={`${mediaType} · ${mimeType}`}
      />
    )
  }

  if (!url) {
    return <Placeholder icon={<Loader2 size={20} className="animate-spin" />} title="" />
  }

  if (mediaType === 'video') {
    return (
      <div className="flex items-center justify-center h-full p-3 bg-black/40">
        <video
          src={url}
          controls
          className="max-w-full max-h-full"
          onError={() => setErrored(true)}
        >
          <source src={url} type={mimeType} />
        </video>
      </div>
    )
  }

  // 音频：音乐播放器版式 —— 上方居中文件元信息 + 大唱片图标，底部贴 native <audio> 控件
  const fileName = path.split(/[/\\]/).pop() || path
  const format = (mimeType.split('/')[1] || 'audio').toUpperCase()
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 p-6">
        <div className="p-6 rounded-full bg-bg-tertiary/40 text-accent/70">
          <Music size={48} />
        </div>
        <div className="text-center max-w-full">
          <div
            className="text-sm font-medium text-text-primary truncate max-w-[80vw]"
            title={fileName}
          >
            {fileName}
          </div>
          <div className="text-[11px] text-text-tertiary mt-1 tabular-nums">
            {format} · {formatBytes(size)}
          </div>
        </div>
      </div>
      <div className="flex-shrink-0 border-t border-border-secondary/30 bg-bg-primary/30 p-2">
        <audio src={url} controls className="w-full" onError={() => setErrored(true)}>
          <source src={url} type={mimeType} />
        </audio>
      </div>
    </div>
  )
}

/**
 * PdfView —— 把 PDF 喂给 Chromium 内置 PDFium 渲染器。
 * 通过自定义协议 shuvix-preview:// 绕过 file:// 跨域 + 走主进程沙箱校验：
 *   shuvix-preview://load/?session=<sid>&path=<encodeURIComponent(absPath)>
 * 主进程协议 handler 见 src/main/index.ts 的 protocol.handle('shuvix-preview')。
 */
function PdfView({ path, sessionId }: { path: string; sessionId: string }): React.JSX.Element {
  const url = useMediaUrl(sessionId, path, 'application/pdf')
  if (!url) {
    return <Placeholder icon={<Loader2 size={20} className="animate-spin" />} title="" />
  }
  return (
    <iframe
      src={url}
      className="w-full h-full border-0 bg-bg-primary"
      title={path}
      // 让 Chromium 的 PDF 插件直接挂载这个 iframe
    />
  )
}

/**
 * MarkdownView —— markdown 文件的只读渲染：复用笔记本的 Atomic live-preview（CM6 Obsidian
 * 风格行内渲染），相比旧的 react-markdown 静态渲染特殊样式（表格 / 任务列表 / 双链 / 内嵌图片）
 * 效果更佳。readOnly 模式不可编辑、不聚焦，故全文渲染（无光标行源码揭示）。
 *
 * fileContext 启用双链：[[file]] 点击在本 Files 面板打开目标预览、![[image]] 行内预览，
 * 均按文件名在该会话工作目录内解析。
 *
 * key={content} —— 外部写回（files.changed 触发重读）后内容变化时重挂载编辑器载入新内容
 * （CM6 state 不可原地替换）；只读预览无光标/草稿，重挂载无损。
 */
function MarkdownView({
  path,
  content,
  sessionId,
  caps
}: {
  path: string
  content: string
  sessionId: string
  caps?: NotebookCaps
}): React.JSX.Element {
  return (
    <div className="h-full flex flex-col">
      <LivePreviewEditor
        key={content}
        documentId={path}
        initialContent={content}
        readOnly
        fileContext={{ sessionId }}
        caps={caps}
      />
    </div>
  )
}

function Placeholder({
  icon,
  title,
  detail
}: {
  icon: React.ReactNode
  title: string
  detail?: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-xs text-text-tertiary">
      <span className="text-text-tertiary/70">{icon}</span>
      <span>{title}</span>
      {detail && (
        <span className="text-text-tertiary/70 max-w-[80%] text-center break-all">{detail}</span>
      )}
    </div>
  )
}

/** 拆分绝对路径为 (filename, parentDir)，兼容 POSIX 与 Windows 分隔符 */
function splitPath(absolute: string): { fileName: string; parentDir: string } {
  const s = absolute.replace(/[/\\]+$/, '')
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  if (idx < 0) return { fileName: s, parentDir: '' }
  return { fileName: s.slice(idx + 1), parentDir: s.slice(0, idx) }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

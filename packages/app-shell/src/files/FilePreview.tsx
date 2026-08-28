/**
 * FilePreview — 覆盖在 FilesTree 上的二级视图
 *
 * 各 kind 渲染策略：
 *  - text + 图表契约（shuvix:chart 标记，见 chat-protocol chartFileContract）
 *                                → ChartView（提取唯一 mermaid 块独立渲染：fit-to-view/缩放/平移；
 *                                  可切源码模式；提取失败自动降级回 markdown 渲染）
 *  - text + .md/.mdx/.markdown   → MarkdownView（只读 Atomic live-preview，可切源码模式）
 *  - text + 其它扩展             → CodeView（CodeMirror 6 read-only viewer）
 *  - image                       → <img> + data: URL
 *  - pdf / media                 → 通过 shuvix-preview 协议喂给 Chromium 原生 PDFium / <video>/<audio>
 *  - office (docx/xlsx/xls/ods)  → OfficeView（docx-preview / SheetJS 懒加载浏览器端渲染）
 *  - ebook (.epub)               → EbookView（foliate 解析 + 资源内联 + 沙箱 iframe 渲染）
 *  - hex / binary / too-large / not-allowed / error → 各自的占位/专用视图
 *
 * 两处「先告知再渲染」（都在正文区之前，互不相关）：
 *  - 成本门控：Office 按字节、图片按像素超阈值时先出 HeavyRenderGate 确认卡
 *             （见 heavyRenderReasonKey / HeavyRenderGate 注释）
 *  - 来源横幅：openedBy='agent' 时亮出完整路径（提示注入唯一能触达预览的入口）
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Bot,
  Check,
  Code2,
  Copy,
  FileText,
  FileX,
  FolderOpen,
  Gauge,
  ListOrdered,
  Loader2,
  Lock,
  Music,
  WrapText,
  X
} from 'lucide-react'
import { CodeView, getHostApi, getSessionChannelApi, useAppEvent } from '@shuvix/chat-ui'
import { extractChartMermaid } from '@shuvix/chat-protocol/chartFileContract'
import { LivePreviewEditor, type NotebookCaps } from '../notebook/LivePreviewEditor'
import { ChartView } from '../preview/ChartView'
import { HexView } from './HexView'
import { EbookView } from './EbookView'
import { OfficeView, SHEET_CONFIRM_BYTES, DOCX_CONFIRM_BYTES } from './OfficeView'
import { useMediaUrl } from '@shuvix/chat-ui'
import { basename } from './paths'
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
  /** 预览由谁发起：'agent' 时顶栏下方显示来源横幅并亮出完整路径（缺省视为用户主动打开）。
   *  用户自己点开的文件不显示 —— 他知道自己点了什么，加提示只是噪音。 */
  openedBy?: 'agent' | 'user'
}

const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown'])

export function FilePreview({
  path,
  sessionId,
  onClose,
  onCreateNotebook,
  caps,
  openedBy = 'user'
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
  const [pathCopied, setPathCopied] = useState(false)
  /** 已确认渲染的重文件路径。按路径记而非布尔 —— 确认是对「这个文件」而非「这一次读取」
   *  的决定：换成另一个重文件会重新拦，而同一文件的 files.changed 重读、切走再切回都不再问。 */
  const [confirmedHeavyPath, setConfirmedHeavyPath] = useState<string | null>(null)

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

  // 只监听「当前预览的这个文件」（父目录 kqueue，非整树），打开时注册、切换/关闭时注销。
  // 变更经后端 files.changed 事件广播 → 下方 useAppEvent 静默重读。也覆盖外部编辑器改盘。
  useEffect(() => {
    const api = getSessionChannelApi()
    void api.files.watch({ sessionId, path })
    return () => {
      void api.files.unwatch({ sessionId, path })
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

  const fileName = basename(path)
  // 当前预览是否为 markdown 文本 —— 决定是否显示「渲染/源码」模式切换
  const isMarkdownText = result?.kind === 'text' && MARKDOWN_EXTS.has(result.ext)
  // 图表契约文件：提取到唯一 mermaid 块 → ChartView 独立渲染（提取失败为 null，降级 markdown）
  const chartSource = result?.kind === 'text' ? extractChartMermaid(result.content) : null
  // wrap / 行号开关：非 markdown 文本，或 markdown 切到源码模式时显示（即落到 CodeView 时）
  const showWrapToggle = result?.kind === 'text' && (!isMarkdownText || mdSourceMode)
  // 渲染成本门控：非 null 时先展示确认卡片，用户点了才把结果交给 renderBody。
  // 两类成本各按各自的量纲判断 —— Office 看字节数（解析耗时随体积涨），图片看像素数
  // （解码内存与字节数无关，见 HEAVY_PIXEL_BUDGET）。
  const heavyReasonKey = confirmedHeavyPath === path ? null : heavyRenderReasonKey(result)

  return (
    <div className="flex flex-col h-full bg-bg-secondary">
      {/* 顶栏：左侧只显示文件名（宽度全给文件名，完整路径见 tooltip）；右侧按钮组（wrap 切换 + 关闭） */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-2 h-7 border-b border-border-secondary/30">
        <span className="min-w-0 truncate text-[11px] font-medium text-text-primary" title={path}>
          {fileName}
        </span>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={() => {
              void navigator.clipboard.writeText(path)
              setPathCopied(true)
              setTimeout(() => setPathCopied(false), 1500)
            }}
            className={`p-1 rounded hover:bg-bg-hover/40 transition-colors ${
              pathCopied ? 'text-success' : 'text-text-tertiary hover:text-text-secondary'
            }`}
            title={t('panel.preview.copyPath')}
          >
            {pathCopied ? <Check size={11} /> : <Copy size={11} />}
          </button>
          {/* 定位到文件所在目录 —— 仅完整宿主（桌面）有系统文件管理器 */}
          {getHostApi() && (
            <button
              onClick={() => void getHostApi()?.app.revealPath(path)}
              className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 transition-colors"
              title={t('panel.preview.revealInFolder')}
            >
              <FolderOpen size={11} />
            </button>
          )}
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

      {/* 来源横幅：预览由智能体发起时亮出完整路径 —— 这条路径是提示注入唯一能触达预览的入口，
          把「谁打开的 + 打开了哪个文件」摆在明面上。用户自己点开的不显示（见 openedBy 注释）。
          用横幅而非模态：不打断，也不制造「点了确认就安全」的错觉 */}
      {openedBy === 'agent' && (
        <div className="flex-shrink-0 flex items-center gap-1.5 px-2 h-7 border-b border-border-secondary/30 bg-bg-tertiary/30 text-[10px] text-text-tertiary">
          <Bot size={11} className="flex-shrink-0" />
          <span className="flex-shrink-0">{t('panel.preview.openedByAgent')}</span>
          <span className="min-w-0 truncate text-text-tertiary/70" title={path}>
            {path}
          </span>
        </div>
      )}

      {/* 「新建会话」横幅：仅 markdown 预览且宿主提供回调时显示。按钮平铺整条横幅，
          高度与上方预览标题栏一致（h-7）。点击创建绑定该 md 的笔记本会话。
          图表契约文件不显示 —— 由可视化智能体维护，不引导手工编辑 */}
      {onCreateNotebook && chartSource == null && (
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
        {heavyReasonKey && result ? (
          <HeavyRenderGate
            fileName={fileName}
            path={path}
            size={'size' in result ? result.size : 0}
            pixels={
              result.kind === 'image' && result.pixelWidth && result.pixelHeight
                ? { width: result.pixelWidth, height: result.pixelHeight }
                : undefined
            }
            reason={t(heavyReasonKey)}
            onConfirm={() => setConfirmedHeavyPath(path)}
            t={t}
          />
        ) : (
          renderBody(result, {
            t,
            path,
            sessionId,
            wrapText,
            showLineNumbers,
            mdSourceMode,
            chartSource,
            caps
          })
        )}
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
  /** 图表契约文件提取出的 mermaid 源码（非契约/提取失败为 null） */
  chartSource: string | null
  caps?: NotebookCaps
}

function renderBody(r: FileReadResult | null, opts: RenderBodyOpts): React.ReactNode {
  const { t, path, sessionId, wrapText, showLineNumbers, mdSourceMode, chartSource, caps } = opts
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
      // 图表契约文件：提取出的 mermaid 独立渲染（fit-to-view 视口）；切源码模式落 CodeView
      if (chartSource && !mdSourceMode) {
        return <ChartView source={chartSource} path={path} />
      }
      // markdown 默认走只读 live-preview（笔记本同款渲染）；切到源码模式则落 CodeView
      if (MARKDOWN_EXTS.has(r.ext) && !mdSourceMode) {
        return <MarkdownView path={path} content={r.content} sessionId={sessionId} caps={caps} />
      }
      return (
        <CodeView content={r.content} ext={r.ext} wrap={wrapText} lineNumbers={showLineNumbers} />
      )
    case 'office':
      return <OfficeView officeKind={r.officeKind} dataBase64={r.dataBase64} />
    case 'ebook':
      return <EbookView path={r.path} sessionId={sessionId} ebookKind={r.ebookKind} />
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
 * 资源 URL 走我们注册的 shuvix-preview:// 协议（已做准入校验，避免 file:// 跨域）。
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
 * 通过自定义协议 shuvix-preview:// 绕过 file:// 跨域 + 走主进程准入校验：
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

/**
 * 图片解码的像素预算：1 亿像素 ≈ 400 MB RGBA 位图。
 *
 * 之所以按像素而不是字节：文件大小完全约束不了解码后的内存 —— 一张纯色 30000×30000 的
 * PNG 压缩后可能只有几十 KB，解码却要 3.6 GB（解压炸弹）。而阈值定在 1 亿像素，是因为
 * 现实照片几乎都在此之下（连 1 亿像素手机相机的原图也在边界附近，且那种文件早被
 * PREVIEW_IMAGE_MAX_BYTES 的 10MB 上限挡下了），炸弹则通常是数亿到数十亿像素 —— 两者
 * 分得很开，所以这条线既拦得住又基本不误伤。
 */
const HEAVY_PIXEL_BUDGET = 100_000_000

/**
 * 电子书确认阈值。EPUB 是 zip，fflate 解压是同步的且会把整本书展开进内存 ——
 * 图文书解压后往往是文件体积的数倍。30MB 之下是绝大多数纯文字书，不打扰。
 */
const EBOOK_CONFIRM_BYTES = 30 * 1024 * 1024

/**
 * 判断结果是否贵到该先确认；不贵返回 null。
 * 未知像素尺寸（SVG / 解析不出的格式）一律放行 —— 这是体验保护而非安全控制，
 * 失败开放比误伤正常图片合适。
 */
function heavyRenderReasonKey(r: FileReadResult | null): string | null {
  if (!r) return null
  if (r.kind === 'office') {
    if (r.officeKind === 'sheet' && r.size > SHEET_CONFIRM_BYTES) return 'panel.preview.heavySheet'
    if (r.officeKind === 'docx' && r.size > DOCX_CONFIRM_BYTES) return 'panel.preview.heavyDocx'
    return null
  }
  if (r.kind === 'image' && r.pixelWidth && r.pixelHeight) {
    if (r.pixelWidth * r.pixelHeight > HEAVY_PIXEL_BUDGET) return 'panel.preview.heavyImage'
  }
  if (r.kind === 'ebook' && r.size > EBOOK_CONFIRM_BYTES) return 'panel.preview.heavyEbook'
  return null
}

/**
 * HeavyRenderGate —— 大文件渲染前的确认卡片。
 *
 * 存在的理由是「成本」而非「安全」：表格经 SheetJS 同步解析、大文档经 docx-preview 建 DOM，
 * 都跑在界面线程上，文件够大时会把界面冻住数秒 —— 而预览面板的语义是「瞄一眼」，
 * 不该在用户毫无预期时付这个代价。所以先摊开可判断的信息（文件名 / 完整路径 / 大小 /
 * 会发生什么），由用户决定。
 *
 * 注意别把它当安全控制用：用户无法从路径和大小判断文件内容是否恶意，内容侧的防护
 * 是渲染层自己的职责（沙箱化 / 净化），不能靠这里的一次点击转嫁。
 */
function HeavyRenderGate({
  fileName,
  path,
  size,
  pixels,
  reason,
  onConfirm,
  t
}: {
  fileName: string
  path: string
  size: number
  /** 图片专有：真实像素尺寸 —— 对解压炸弹来说这才是决策相关的数字，字节数会骗人 */
  pixels?: { width: number; height: number }
  reason: string
  onConfirm: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
      <span className="text-text-tertiary/70">
        <Gauge size={22} />
      </span>
      <div className="min-w-0 max-w-full">
        <div className="text-xs font-medium text-text-primary truncate" title={fileName}>
          {fileName}
        </div>
        <div
          className="text-[10px] text-text-tertiary/70 mt-0.5 truncate max-w-[min(420px,80vw)]"
          title={path}
        >
          {path}
        </div>
        <div className="text-[10px] text-text-tertiary mt-1 tabular-nums">
          {pixels ? `${pixels.width} × ${pixels.height} · ${formatBytes(size)}` : formatBytes(size)}
        </div>
      </div>
      <p className="text-[11px] text-text-tertiary max-w-[min(420px,80vw)] leading-relaxed">
        {reason}
      </p>
      <button
        onClick={onConfirm}
        className="px-3 py-1 rounded text-[11px] font-medium text-accent bg-accent/10 hover:bg-accent/20 transition-colors"
      >
        {t('panel.preview.heavyRenderAnyway')}
      </button>
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

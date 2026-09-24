import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Code, FileText, Maximize2, X } from 'lucide-react'
import mermaid from 'mermaid'
import { sanitizeRenderedSvg } from '@shuvix/chat-protocol/utils/svgSanitize'
import { useDialogClose } from '../../hooks/useDialogClose'
import { useMarkdownStreaming } from './markdownStreaming'
import { useThemeId } from './useThemeId'
import {
  MERMAID_MAX_HEIGHT,
  mermaidLayout,
  mermaidNaturalSize,
  mermaidThemeVariables,
  type MermaidSize
} from './mermaidFit'

/**
 * ```mermaid 代码块 → 图。
 *
 * ShuviX 不再主动引导模型画 mermaid（结构图走手写 ```svg，见 visual-guide 提示片段与作图技能），
 * 但用户自己的 agent、或者用户要求时，它仍会出现 —— 这里只负责把它**显示好**：
 *
 * 1. **缺省显示图。** 从前缺省是源码：一张长流程图先以一大段代码摊在对话里，图要再点一下。
 * 2. **流式期间不渲染。** mermaid 要完整源码才能解析，写到一半的围栏解析失败不是错误；
 *    流式中只显示一行占位（已写多少行），源码停止变化一会儿（围栏多半已写完，模型在写后面的
 *    正文）或整条消息写完后再渲染。错误卡只在消息写完后出。
 * 3. **配色跟主题。** 从前是 mermaid 的 default 浅色主题铺在写死的白底上，深色主题下是一块白板。
 *    现在把主题 token 解析成颜色喂给它的 `base` 主题（见 mermaidFit），切主题（根上的 data-theme）
 *    就按新主题重渲染。
 * 4. **限高。** 内联只占一块不超过 MERMAID_MAX_HEIGHT 的地方：整张缩得进去且字还读得清就整张缩，
 *    读不清就按栏宽显示、截在限高处（底部渐隐）—— 规则见 mermaidLayout。显示的不是全貌时工具栏
 *    多一个「放大查看」，按原尺寸在弹窗里看（可滚动）。
 *
 * 渲染串行：mermaid.render 不可重入（它借用 document 上的临时节点），一页好几张图同时挂载时
 * 排队一张一张来。
 */

/** 流式期间：源码这么久没变，就当围栏已写完、先渲染 —— 模型多半已经在写后面的正文 */
const STREAM_SETTLE_MS = 800
/**
 * 单张图的渲染上限。渲染是串行的，一张卡住的图会挡住这个窗口里后面所有的图 ——
 * 到点就按失败处理、让出队列（正常的图哪怕几十个节点也在一秒内渲完）
 */
const RENDER_TIMEOUT_MS = 15_000

/** 渲染结果缓存：主题 id + 源码 → 净化后的 SVG（同一主题下同一段源码恒得同一结果） */
const mermaidSvgCache = new Map<string, string>()
/** 视图状态：源码 → 是否在看源码（组件频繁重挂载时保持） */
const mermaidViewState = new Map<string, boolean>()
/** 正在渲染的：同一个 key 只渲一次（流式结束那一刻 effect 会以同一 key 再跑一遍） */
const inflight = new Map<string, Promise<string>>()
let mermaidIdCounter = 0
let renderQueue: Promise<unknown> = Promise.resolve()

/** 此刻主题 token 的解析值 —— 拿一个探针元素读 computed color（light-dark() 也在这一步解析） */
function currentThemeVariables(): Record<string, string | boolean> {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  try {
    const resolve = (token: string): string => {
      probe.style.color = `var(${token})`
      return getComputedStyle(probe).color
    }
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark')
    return mermaidThemeVariables(resolve, dark, getComputedStyle(document.body).fontFamily)
  } finally {
    probe.remove()
  }
}

// ─── 渲染：串行、去重、净化后才入缓存 ─────────────────────────

/**
 * `themeVariables` 由调用方在**请求时**取好传进来，不在排到队时再读：缓存键里的主题是请求那一刻的，
 * 排队期间切了主题的话，到点再读会把新主题的颜色存进旧主题的键下。
 */
function renderMermaid(
  key: string,
  code: string,
  themeVariables: Record<string, string | boolean>
): Promise<string> {
  const pending = inflight.get(key)
  if (pending) return pending
  const run = async (): Promise<string> => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'loose',
      suppressErrorRendering: true,
      themeVariables
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Mermaid render timed out')), RENDER_TIMEOUT_MS)
    })
    const { svg } = await Promise.race([
      mermaid.render(`mermaid_${mermaidIdCounter++}`, code),
      timeout
    ]).finally(() => clearTimeout(timer))
    // 净化后再入缓存/注入 —— 图表源码来自智能体输出（可能受提示注入影响），而下方是
    // dangerouslySetInnerHTML 直入特权渲染进程。mermaid 的 click href 指令会带出
    // javascript: 锚点，本行是把它挡在 DOM 之外的地方。
    const clean = sanitizeRenderedSvg(svg)
    if (!clean) throw new Error('SVG sanitization failed') // 失败关闭
    mermaidSvgCache.set(key, clean)
    return clean
  }
  const job = renderQueue.then(run, run)
  renderQueue = job.catch(() => undefined)
  inflight.set(key, job)
  void job.finally(() => inflight.delete(key)).catch(() => undefined)
  return job
}

// ─── 组件 ─────────────────────────────────────────────

export function MermaidBlock({ code }: { code: string }): React.JSX.Element {
  const { t } = useTranslation()
  const streaming = useMarkdownStreaming()
  const themeId = useThemeId()
  const key = `${themeId}\u0000${code}`
  const cached = mermaidSvgCache.get(key)

  // 最近一次渲染的结果（带 key，判断是不是「这一版」的）+ 最近一张成功的图：源码还在长、
  // 或刚切了主题时，新图出来之前先留着上一张，不闪回占位
  const [result, setResult] = useState<{ key: string; error?: string } | null>(null)
  const [lastGood, setLastGood] = useState<string | null>(null)
  const [showSource, setShowSourceState] = useState(mermaidViewState.get(code) ?? false)
  const [expanded, setExpanded] = useState(false)
  const [boxWidth, setBoxWidth] = useState(0)
  // 栏宽变了（窗口缩放、侧栏开合）才知道图是否被缩小 —— 只观察放图的那一格。
  // 回调 ref：那一格挂上 / 卸下时自己接上 / 断开观察（React 19 的 ref 清理函数）
  const boxRef = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => setBoxWidth(entries[0].contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const setShowSource = (v: boolean): void => {
    mermaidViewState.set(code, v)
    setShowSourceState(v)
  }

  useEffect(() => {
    if (cached) return
    let alive = true
    const timer = setTimeout(
      () => {
        renderMermaid(key, code, currentThemeVariables()).then(
          (svg) => {
            if (!alive) return
            setLastGood(svg)
            setResult({ key })
          },
          (e: unknown) => {
            if (alive) setResult({ key, error: e instanceof Error ? e.message : String(e) })
          }
        )
      },
      streaming ? STREAM_SETTLE_MS : 0
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [cached, code, key, streaming])

  const svg = cached ?? lastGood
  const error = !cached && result?.key === key ? result.error : undefined
  const size: MermaidSize | null = svg ? mermaidNaturalSize(svg) : null
  const layout = size ? mermaidLayout(size, boxWidth) : null

  // 消息写完了还解析不了才是真失败；流式期间的失败只是还没写完。真失败时不拿先前那张
  // （流式中途按半截源码渲出来的）顶替 —— 那等于把错误藏在一张不完整的图后面
  if (error && !streaming) {
    return (
      <div
        data-mermaid-error
        className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3"
      >
        <div className="text-[10px] text-orange-400 mb-1">{t('message.mermaidFailed')}</div>
        <pre className="text-[11px] text-text-secondary whitespace-pre-wrap break-words">
          {code}
        </pre>
      </div>
    )
  }

  const lines = code.split('\n').length
  const figureStyle = layout
    ? ({
        '--mermaid-w': `${layout.width}px`,
        // 截断时框高 = 图的可见高度 + 上下内边距（p-3），与整张缩放时图本身的上限一致
        ...(layout.mode === 'clip' ? { maxHeight: `calc(${MERMAID_MAX_HEIGHT}px + 1.5rem)` } : {})
      } as CSSProperties)
    : undefined

  return (
    <div
      className="my-2 rounded-lg overflow-hidden"
      style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
    >
      <div
        className="flex items-center gap-3 px-4 py-1.5"
        style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
      >
        <span className="text-[10px] text-text-tertiary font-medium mr-auto">Mermaid</span>
        {svg && layout?.expandable && !showSource && (
          <button
            onClick={() => setExpanded(true)}
            data-mermaid-expand
            className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <Maximize2 size={10} />
            <span>{t('message.diagramExpand')}</span>
          </button>
        )}
        <button
          onClick={() => setShowSource(!showSource)}
          className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          title={showSource ? t('message.showDiagram') : t('message.source')}
        >
          {showSource ? <FileText size={10} /> : <Code size={10} />}
          <span>{showSource ? t('message.diagram') : t('message.source')}</span>
        </button>
      </div>
      {showSource ? (
        <pre className="p-3 text-[11px] text-text-secondary whitespace-pre-wrap break-words leading-relaxed font-mono overflow-auto max-h-[480px]">
          {code}
        </pre>
      ) : svg ? (
        <div
          ref={boxRef}
          data-mermaid-figure={layout?.mode ?? 'natural'}
          style={figureStyle}
          className={`flex justify-center overflow-hidden p-3 [&_svg]:h-auto ${
            layout ? '[&_svg]:w-[min(100%,var(--mermaid-w))]' : '[&_svg]:max-w-full'
          } ${
            // 截断时底部渐隐：遮罩作用在内容本身，不必猜卡片底色（它是半透明的）
            layout?.mode === 'clip'
              ? 'items-start [mask-image:linear-gradient(to_bottom,black_calc(100%_-_56px),transparent)]'
              : ''
          }`}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div data-mermaid-pending className="px-4 py-3 text-[11px] text-text-tertiary">
          {streaming ? t('message.diagramGenerating', { lines }) : t('message.rendering')}
        </div>
      )}
      {expanded && svg && (
        <MermaidDialog svg={svg} width={size?.width} onClose={() => setExpanded(false)} />
      )}
    </div>
  )
}

/** 原尺寸查看：图按 viewBox 的原宽摆，大于窗口就在弹窗里滚动 */
function MermaidDialog({
  svg,
  width,
  onClose
}: {
  svg: string
  width?: number
  onClose: () => void
}): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const { closing, handleClose } = useDialogClose(onClose)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  return createPortal(
    <div
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) handleClose()
      }}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        data-mermaid-dialog
        // 原宽 + 左右内边距 + 竖滚动条的位置：不留这一截，竖滚动条会把内容挤出一条横滚动条
        style={width ? { width: width + 56 } : undefined}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl min-w-[320px] max-w-[92vw] max-h-[88vh] flex flex-col dialog-panel"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border-secondary">
          <span className="text-sm font-semibold text-text-primary">Mermaid</span>
          <button
            onClick={handleClose}
            className="flex-shrink-0 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <div
            style={width ? { width } : undefined}
            className="[&_svg]:w-full [&_svg]:h-auto [&_svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}

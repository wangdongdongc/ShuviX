import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronUp,
  Code,
  FileText,
  FoldVertical,
  Maximize2,
  UnfoldVertical,
  X
} from 'lucide-react'
import { detectType, load, registered, render as peleRender, type DiagramType } from 'pele/lazy'
import {
  renderMermaidFigure,
  type MermaidEngine,
  type MermaidRenderResult
} from '@shuvix/chat-protocol/utils/mermaidFence'
import { useDialogClose } from '../../hooks/useDialogClose'
import { useMarkdownStreaming } from './markdownStreaming'
import { FigureExportButton } from '../figure/FigureExportPanel'
import { authoredFigureSource, figureLabelOf } from '../figure/figureExport'
import { mermaidTitleOf } from '../figure/figureExportPure'
import {
  MERMAID_FONT_SIZE,
  MERMAID_MAX_HEIGHT,
  mermaidLayout,
  mermaidUnfoldable,
  mermaidUnfoldedLayout,
  type MermaidSize
} from './mermaidFit'

/**
 * ```mermaid 代码块 → 图，渲染器是 pele（见 chat-protocol 的 mermaidFence）。
 *
 * ShuviX 不再主动引导模型画 mermaid（结构图走手写 ```svg，见 visual-guide 提示片段与作图技能），
 * 但用户自己的 agent、或者用户要求时，它仍会出现 —— 这里只负责把它**显示好**：
 *
 * 1. **缺省显示图。** 从前缺省是源码：一张长流程图先以一大段代码摊在对话里，图要再点一下。
 * 2. **流式期间逐帧画。** pele 同步、亚毫秒级，于是与 ```svg 一样边写边画：围栏还开着时，丢掉
 *    可能写到一半的最后一行、补上没闭合的块再画（帧判定见 mermaidFrameSources）；一帧都画不出
 *    （才写了图类型那一行）时显示「正在生成」占位。错误卡只在消息写完后出。帧只在多写完一行时
 *    重算 —— 渲染的输入是「到最后一个换行为止」的那一截。
 * 3. **配色是 token。** pele 的产物把颜色写成 `var(--pele-*)`，themes.css 的 `.pele` 那段把它们接到
 *    主题 token 上；卡片挂着 `data-figure-surface="card"`，图于是知道自己坐在卡片底上（标签衬底
 *    与卡片同色、节点比卡片凸一级）。切主题不重渲。
 * 4. **限高。** 内联只占一块不超过 MERMAID_MAX_HEIGHT 的地方：宽度先交给 pele 按栏宽重排，
 *    仍然太高时整张缩得进去且字还读得清就整张缩，读不清就按栏宽显示、截在限高处（底部渐隐）——
 *    规则见 mermaidLayout。限高藏住或缩小了图时给「展开 / 收起」（工具栏一个；截断时图底下也有一条，
 *    展开后底下那条变成「收起」）：就地去掉限高，整张按栏宽摆在对话里，不弹窗。收起时把卡片拉回
 *    视野 —— 从底下那条收起时，卡片一下子矮了一两千像素，不拉回来视野就落到后面的消息里去了。
 *    展开了还被栏宽缩着（pele 重排也收不进这一栏）时才再给「放大查看」，按原尺寸在弹窗里看（可滚动）。
 *
 * 图类型按需加载（pele/lazy：每种图一个分包），所以每种图第一次出现时有一小段「渲染中」。
 */

const engine: MermaidEngine = { render: peleRender }

/** 视图状态：源码 → 是否在看源码（组件频繁重挂载时保持） */
const mermaidViewState = new Map<string, boolean>()

/**
 * 展开状态：源码 → 是否展开。同样跨重挂载保持 —— 对话列表是虚拟列表，滚出去再滚回来卡片会重挂，
 * 展开的图不能因此自己收回去（那一下高度骤变，列表也会跳）
 */
const mermaidUnfoldState = new Map<string, boolean>()

/**
 * 写完的图的渲染结果：字体 + 源码 → 结果（含失败）。列表滚动时卡片反复挂载，每次重渲一遍要
 * 一两毫秒（解析 + 净化）；流式中间帧不进来 —— 每一帧都是一截新源码。按插入顺序淘汰最旧的。
 */
const settledCache = new Map<string, MermaidRenderResult>()
const SETTLED_CACHE_MAX = 64

/** 卡片的左右内边距（p-3）：放图那一格比卡片窄这么多 */
const FIGURE_PADDING_X = 24

/** 对话里画字的两种字体：正文是 body 的字体，等宽的与正文里的 `code` 同一份（base.css） */
interface ChatFonts {
  fontFamily: string
  /** 没接上 themes.css 时为空，交给 pele 的缺省 */
  fontFamilyMono?: string
}

function chatFonts(): ChatFonts {
  const style = getComputedStyle(document.body)
  return {
    fontFamily: style.fontFamily,
    fontFamilyMono: style.getPropertyValue('--theme-font-mono').trim() || undefined
  }
}

function settledFigure(code: string, fonts: ChatFonts): MermaidRenderResult {
  const key = `${fonts.fontFamily}\u0000${fonts.fontFamilyMono ?? ''}\u0000${code}`
  const hit = settledCache.get(key)
  if (hit) return hit
  const result = renderMermaidFigure(engine, code, {
    closed: true,
    ...fonts,
    fontSize: MERMAID_FONT_SIZE
  }) ?? { error: 'Mermaid render failed' }
  settledCache.set(key, result)
  if (settledCache.size > SETTLED_CACHE_MAX) {
    settledCache.delete(settledCache.keys().next().value as string)
  }
  return result
}

function detectMermaidType(code: string): DiagramType | null {
  try {
    return detectType(code)
  } catch {
    return null
  }
}

/**
 * 这张图的图类型能不能同步渲染了：没认出类型（还没写到类型那一行，或者根本不是 mermaid）也算能 ——
 * 渲染会给出「不支持的图」，那就是答案。加载失败同样放行，让渲染把失败报出来，而不是永远「渲染中」。
 */
function useMermaidTypeReady(type: DiagramType | null): boolean {
  const [settledType, setSettledType] = useState<DiagramType | null>(null)
  const ready = type === null || registered(type) || settledType === type
  useEffect(() => {
    if (ready || type === null) return
    let alive = true
    const done = (): void => {
      if (alive) setSettledType(type)
    }
    load(type).then(done, done)
    return () => {
      alive = false
    }
  }, [ready, type])
  return ready
}

// ─── 组件 ─────────────────────────────────────────────

export function MermaidBlock({
  code,
  closed
}: {
  code: string
  /** 围栏闭合了没有（消息写完了也算）—— 见 CodeBlock 的 codeFenceIsClosed */
  closed: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const streaming = useMarkdownStreaming()
  const typeReady = useMermaidTypeReady(detectMermaidType(code))
  const settled = closed && !streaming

  const [showSource, setShowSourceState] = useState(mermaidViewState.get(code) ?? false)
  const [unfolded, setUnfoldedState] = useState(mermaidUnfoldState.get(code) ?? false)
  const [expanded, setExpanded] = useState(false)
  const [cardWidth, setCardWidth] = useState(0)
  const figureRef = useRef<HTMLDivElement>(null)
  const cardElRef = useRef<HTMLDivElement | null>(null)
  // 栏宽变了（窗口缩放、侧栏开合）才知道图要不要按窄栏重排、是否被缩小 —— 观察整张卡片（它一直在，
  // 放图那一格在占位阶段还没有）。回调 ref：挂上 / 卸下时自己接上 / 断开观察（React 19 的 ref 清理函数）
  const cardRef = useCallback((el: HTMLDivElement | null) => {
    cardElRef.current = el
    if (!el) return
    // 挂上的这一刻就量一次：ResizeObserver 的第一次回调要到下一帧，在那之前栏宽是 0，图按自然尺寸
    // 先画一帧 —— 宽图（要按栏宽重排的那种）就以一条压扁的、没展开的样子闪一下，列表里滚回来重挂时
    // 最明显。提交阶段里的 setState 在浏览器画之前同步重渲
    setCardWidth(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => setCardWidth(entries[0].contentRect.width))
    observer.observe(el)
    return () => {
      observer.disconnect()
      cardElRef.current = null
    }
  }, [])
  const boxWidth = Math.max(0, cardWidth - FIGURE_PADDING_X)

  const setShowSource = (v: boolean): void => {
    mermaidViewState.set(code, v)
    setShowSourceState(v)
  }

  const setUnfolded = (v: boolean): void => {
    mermaidUnfoldState.set(code, v)
    setUnfoldedState(v)
    // 收起后卡片还在视野里就不动；跑到视野上面去了（从图底下那条收起时就是这样）就拉回来。
    // 等这一帧布局完再滚：高度要先变。jsdom 没有 scrollIntoView
    if (!v) requestAnimationFrame(() => cardElRef.current?.scrollIntoView?.({ block: 'nearest' }))
  }

  // 流式中展开的图：源码每多一片，展开状态跟着搬到新源码名下 —— 写完之后的重挂按最终的源码查，
  // 留在半截源码名下就等于自己收了回去
  const unfoldKeyRef = useRef(code)
  useEffect(() => {
    const prev = unfoldKeyRef.current
    unfoldKeyRef.current = code
    if (prev === code || !unfolded) return
    mermaidUnfoldState.delete(prev)
    mermaidUnfoldState.set(code, true)
  }, [code, unfolded])

  // 帧只取决于「到最后一个换行为止」的那一截（最后一行可能写到一半，帧判定会丢掉它）
  const frameKey = closed ? code : code.slice(0, code.lastIndexOf('\n') + 1)
  const result = useMemo((): MermaidRenderResult | null => {
    if (!typeReady) return null
    const fonts = chatFonts()
    const opts = { ...fonts, fontSize: MERMAID_FONT_SIZE }
    const draw = (fitWidth?: number): MermaidRenderResult | null => {
      if (settled) {
        return fitWidth
          ? renderMermaidFigure(engine, frameKey, { ...opts, closed: true, fitWidth })
          : settledFigure(frameKey, fonts)
      }
      const r = renderMermaidFigure(engine, frameKey, { ...opts, closed, fitWidth })
      // 围栏已经闭合、消息却还在写，而这段源码画不出来：消息写完之前那还不算失败 ——
      // 按开着的围栏取帧（末尾补一个换行：每一行都已写完），屏幕上留着能画出来的那一部分
      if (r && 'error' in r) {
        return renderMermaidFigure(engine, `${frameKey}\n`, { ...opts, closed: false, fitWidth })
      }
      return r
    }
    const natural = draw()
    // 自然尺寸放不下这一栏：让 pele 按栏宽重排一次（换行、收间距，必要时横排改竖排）。
    // 放得下就不传栏宽 —— 宽栏里的图与宽度无关，写完的那张才能按源码缓存
    if (natural && 'figure' in natural && boxWidth > 0 && natural.figure.width > boxWidth) {
      const narrow = draw(boxWidth)
      if (narrow && 'figure' in narrow) return narrow
    }
    return natural
  }, [typeReady, frameKey, closed, settled, boxWidth])

  const svg = result && 'figure' in result ? result.figure.svg : null
  // React 19 只要 dangerouslySetInnerHTML 的对象换了就重设 innerHTML（不比字符串）：每次渲染新建
  // 一个对象，流式每来一片就换一次 <svg> 节点。按标记记住它，同一张图就是同一个节点
  const figureHtml = useMemo(() => ({ __html: svg ?? '' }), [svg])
  const error = result && 'error' in result ? result.error : null
  const size: MermaidSize | null =
    result && 'figure' in result
      ? { width: result.figure.width, height: result.figure.height }
      : null
  const measurable = size !== null && size.width > 0 && size.height > 0
  // 限高藏住或缩小了图才有得展开；展开之后就是只受栏宽约束的那一种摆法
  const unfoldable = measurable && mermaidUnfoldable(size, boxWidth)
  const showUnfolded = unfoldable && unfolded
  const layout = measurable
    ? showUnfolded
      ? mermaidUnfoldedLayout(size, boxWidth)
      : mermaidLayout(size, boxWidth)
    : null
  // 「放大查看」只在展开了也还被栏宽缩着时给 —— 其余时候展开就是全貌，弹窗不多给什么
  const zoomable = measurable && mermaidUnfoldedLayout(size, boxWidth).expandable

  // 消息写完了还画不出来才是真失败；流式期间画不出来只是还没写完（上面已经退回能画的那一帧）
  if (error && settled) {
    return (
      <div
        data-mermaid-error
        className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3"
      >
        <div className="text-[10px] text-orange-400 mb-1">{t('message.mermaidFailed')}</div>
        <div className="text-[11px] text-text-tertiary mb-1 whitespace-pre-wrap break-words">
          {error}
        </div>
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
      ref={cardRef}
      data-figure-surface="card"
      className="my-2 rounded-lg overflow-hidden"
      style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
    >
      <div
        className="flex items-center gap-3 px-4 py-1.5"
        style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
      >
        <span className="text-[10px] text-text-tertiary font-medium mr-auto">Mermaid</span>
        {/* 只导出写完了的图：流式中途屏幕上的是按半截源码画出的一帧 —— 与 ```svg「写完才导出」同一条 */}
        {svg && settled && (
          <FigureExportButton
            getSource={() =>
              authoredFigureSource(svg, {
                name: mermaidTitleOf(code) ?? figureLabelOf(svg) ?? 'mermaid',
                surface: 'card',
                inheritFrom: () => figureRef.current
              })
            }
          />
        )}
        {svg && unfoldable && !showSource && (
          <button
            onClick={() => setUnfolded(!showUnfolded)}
            data-mermaid-unfold
            aria-expanded={showUnfolded}
            className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          >
            {showUnfolded ? <FoldVertical size={10} /> : <UnfoldVertical size={10} />}
            <span>{showUnfolded ? t('message.diagramFold') : t('message.diagramUnfold')}</span>
          </button>
        )}
        {svg && zoomable && !showSource && (
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
        <>
          <div
            ref={figureRef}
            data-mermaid-figure={layout?.mode ?? 'natural'}
            data-mermaid-unfolded={showUnfolded || undefined}
            style={figureStyle}
            className={`flex justify-center overflow-hidden p-3 [&_svg]:h-auto ${
              layout ? '[&_svg]:w-[min(100%,var(--mermaid-w))]' : '[&_svg]:max-w-full'
            } ${
              // 截断时底部渐隐：遮罩作用在内容本身，不必猜卡片底色（它是半透明的）
              layout?.mode === 'clip'
                ? 'items-start [mask-image:linear-gradient(to_bottom,black_calc(100%_-_56px),transparent)]'
                : ''
            }`}
            dangerouslySetInnerHTML={figureHtml}
          />
          {/* 截断处一条「展开」、展开后图底下一条「收起」：读到图被切掉的地方 / 读到图的末尾，
            手边就有按钮，不必回到卡片顶上的工具栏 */}
          {(showUnfolded || layout?.mode === 'clip') && (
            <button
              onClick={() => setUnfolded(!showUnfolded)}
              data-mermaid-unfold-bar
              aria-expanded={showUnfolded}
              className="flex w-full items-center justify-center gap-1 py-1.5 text-[10px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {showUnfolded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              <span>{showUnfolded ? t('message.diagramFold') : t('message.diagramUnfold')}</span>
            </button>
          )}
        </>
      ) : (
        <div data-mermaid-pending className="px-4 py-3 text-[11px] text-text-tertiary">
          {streaming && !closed
            ? t('message.diagramGenerating', { lines })
            : t('message.rendering')}
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
  const html = useMemo(() => ({ __html: svg }), [svg])

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
            dangerouslySetInnerHTML={html}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}

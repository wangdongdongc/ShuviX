import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  Code,
  Copy,
  FileText,
  FoldVertical,
  SquareArrowOutUpRight,
  UnfoldVertical
} from 'lucide-react'
import { parseCsv } from '@shuvix/chat-protocol/utils/csvTable'
import { copyToClipboard } from '../../utils/clipboard'
import { useChatStore } from '../../stores/chatStore'
import { FigureBlock } from '../figure/FigureBlock'
import { MarkdownText } from './markdownComponents'
import { ArtifactFrameContext } from './markdownStreaming'

// 画幅里的 markdown 不再套画幅、不跑交互图：上下文放在 markdownStreaming（叶子模块），免得与 CodeBlock 互相 import
export { ArtifactFrameContext }

/** 文本类产物（md / txt / csv / json）的种类：按扩展名定，取不到扩展名当纯文本 */
export type ArtifactTextKind = 'csv' | 'markdown' | 'json' | 'text'

export function artifactTextKind(name: string): ArtifactTextKind {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  if (ext === 'csv') return 'csv'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'json') return 'json'
  return 'text'
}

/** 收起态画幅的高度上限（px）。触屏密度下屏幕窄，同样的高度显得更高，收一点 */
export const ARTIFACT_FRAME_MAX_HEIGHT = 240
export const ARTIFACT_FRAME_MAX_HEIGHT_TOUCH = 200

/** 原地展开态的高度上限：中短内容自然撑开到底，长内容在此高度内滚动，不把虚拟列表单行撑成几万像素 */
export const ARTIFACT_EXPANDED_MAX_HEIGHT = 'min(65vh, 560px)'
export const ARTIFACT_EXPANDED_MAX_HEIGHT_TOUCH = 'min(60vh, 480px)'

/** 初始收起态画幅里表格最多画几行（看得见的不过十来行；多画是为了横向截断之外不必再算） */
const FRAME_CSV_ROWS = 40
/** 展开态（及展开滚到后面又收起时）、以及不在画幅里（手机的产物详情页）时表格最多画几行 */
const FULL_CSV_ROWS = 1000
/** 初始收起态画幅里文本 / markdown 最多取多少字符去渲染 */
const FRAME_TEXT_CHARS = 8000
/** 原地展开态最多渲染多少字符（足够覆盖常规文档与配置；超大文件走独立窗口） */
export const EXPANDED_TEXT_CHARS = 50_000

/** 虚拟列表滚出视口重挂载时保留展开、源码切换与框内滚动位置（按消息 id + 产物名索引） */
interface FrameViewEntry {
  expanded: boolean
  showSource: boolean
  scrollTop: number
}
const frameViewState = new Map<string, FrameViewEntry>()
const FRAME_VIEW_STATE_MAX = 128

function writeFrameViewState(key: string | undefined, next: FrameViewEntry): void {
  if (!key) return
  frameViewState.delete(key)
  frameViewState.set(key, next)
  if (frameViewState.size > FRAME_VIEW_STATE_MAX) {
    frameViewState.delete(frameViewState.keys().next().value as string)
  }
}

/** 一份内容的行数（说明行写「N 行」用；末尾换行不算新的一行） */
export function countLines(content: string): number {
  if (!content) return 0
  const n = content.split(/\r\n|\r|\n/).length
  return /(\r\n|\r|\n)$/.test(content) ? n - 1 : n
}

/** json 排版成两格缩进；解析不了（半截、带注释）就原样 */
export function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}

/**
 * 文本类产物在对话里的样子 —— **原地可展开画幅**：
 *
 *  - **收起态**（缺省）：高度上限 240px（触屏 200px），按种类排版（csv 表格、md 富文本、json 缩进、其余等宽文本）；
 *    未展开过时显示开头并在底部渐隐；若展开往下滚过之后再收起，框内保留收起前底部的那一段内容（上方有内容则顶部渐隐，
 *    下方还有内容则底部也渐隐），不在收起态响应滚轮（滚对话时滚轮不会被它截住）。
 *  - **原地展开态**：内容被截断或溢出时，点画幅（或底栏「展开」）原地撑高至 `min(65vh, 560px)` ——
 *    中短篇内容直接完整露出，长内容或宽表在画幅内平滑双向滚动；底栏常驻「行数 · 收起 · 源码 · 打开 · 复制」。
 *  - **独立窗口打开**：底栏保留「打开」（`requestFilePreview(path)`），需要进编辑器改 `.md` 或看超大文件时点它。
 *
 * `framed = false`（手机的产物详情页：那一页本身就是「完整打开」）不设高度上限，表格画到 FULL_CSV_ROWS 行。
 */
export function ArtifactTextFrame({
  name,
  content,
  path,
  label,
  extras,
  framed = true,
  touch = false,
  stateKey
}: {
  name: string
  content: string
  /** 文件此刻的绝对路径；没有就不给打开 */
  path?: string
  label?: ReactNode
  extras?: ReactNode
  framed?: boolean
  touch?: boolean
  /** 跨虚拟列表重挂保持展开/源码/框内位置的键（缺省仅保存在组件内） */
  stateKey?: string
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const kind = artifactTextKind(name)
  const canToggleSource = kind === 'markdown' || kind === 'csv'

  const saved = stateKey ? frameViewState.get(stateKey) : undefined
  const [expandedState, setExpandedState] = useState(saved?.expanded ?? false)
  const [showSourceState, setShowSourceState] = useState(saved?.showSource ?? false)
  const [collapsedScrollTop, setCollapsedScrollTop] = useState(saved?.scrollTop ?? 0)
  const expanded = framed && expandedState
  const showSource = canToggleSource && showSourceState
  // 收起态停在中后段时，继续保留展开级的行数/字符上限，免得把已滚到的后半截内容裁没而跳回开头
  const retainExpandedSlice = expanded || collapsedScrollTop > 1

  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    []
  )

  const shellRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<{ scroller: HTMLElement; top: number } | null>(null)
  const pendingBodyScrollRef = useRef<number | null>(
    saved && !saved.expanded && saved.scrollTop > 0 ? saved.scrollTop : null
  )
  const pendingExpandBottomRef = useRef<number | null>(null)
  const liveScrollTopRef = useRef(saved?.scrollTop ?? 0)

  useEffect(() => {
    if (stateKey && (expandedState || showSourceState || liveScrollTopRef.current > 0)) {
      writeFrameViewState(stateKey, {
        expanded: expandedState,
        showSource: showSourceState,
        scrollTop: liveScrollTopRef.current
      })
    }
  }, [stateKey, expandedState, showSourceState])

  const captureScrollAnchor = (keepVisibleAtTop: boolean): void => {
    const shell = shellRef.current
    const scroller = shell?.closest<HTMLElement>('[data-virtuoso-scroller]')
    if (!shell || !scroller) return
    const top = shell.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    // 原地展开/收起：原本顶边在视野内就钉死在同一高度（抵消 Virtuoso 向上滚动补偿把收起后的卡片推向视口底部）；
    // 若展开后把对话往下翻、画幅顶边已滚出视口上沿，收起时落回距顶 12px 处
    anchorRef.current = { scroller, top: keepVisibleAtTop ? Math.max(12, top) : top }
  }

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el) {
      if (expanded && pendingExpandBottomRef.current !== null) {
        const bottomEdge = pendingExpandBottomRef.current
        pendingExpandBottomRef.current = null
        const target = Math.max(0, bottomEdge - el.clientHeight)
        el.scrollTop = target
        liveScrollTopRef.current = el.scrollTop
      } else if (!expanded && pendingBodyScrollRef.current !== null) {
        const target = pendingBodyScrollRef.current
        pendingBodyScrollRef.current = null
        el.scrollTop = target
        liveScrollTopRef.current = el.scrollTop
      }
    }

    const anchor = anchorRef.current
    anchorRef.current = null
    if (!anchor) return
    const { scroller, top: targetTop } = anchor
    const correct = (): void => {
      const shell = shellRef.current
      if (!shell || !scroller.isConnected) return
      const nowTop = shell.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      const delta = nowTop - targetTop
      if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
    }
    correct()

    let raf1 = 0
    let raf2 = 0
    const listeners = new AbortController()
    const itemEl = shellRef.current?.closest<HTMLElement>('[data-index]') ?? shellRef.current
    const listEl = scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            correct()
          })
        : null
    if (ro) {
      if (itemEl) ro.observe(itemEl)
      if (listEl && listEl !== itemEl) ro.observe(listEl)
    }
    const stop = (): void => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      ro?.disconnect()
      listeners.abort()
    }
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      scroller.addEventListener(type, stop, { passive: true, signal: listeners.signal })
    }
    raf1 = requestAnimationFrame(() => {
      correct()
      raf2 = requestAnimationFrame(() => {
        correct()
        stop()
      })
    })
    return stop
  }, [expanded, showSource])

  const setExpanded = (next: boolean): void => {
    const el = bodyRef.current
    let nextScrollTop = collapsedScrollTop
    if (next) {
      // 从已滚到中后段的收起框再次展开：以当前小框底边为锚往上撑开，继续停在刚才那一段
      if (el && collapsedScrollTop > 1) {
        pendingExpandBottomRef.current = el.scrollTop + el.clientHeight
      } else {
        pendingExpandBottomRef.current = null
      }
    } else {
      // 收起时：若在展开框内往下滚过，保留收起前画幅底部的那一块（scrollTop + clientHeight 对齐小框底边）
      if (el && el.scrollTop > 1) {
        const collapsedCap = touch ? ARTIFACT_FRAME_MAX_HEIGHT_TOUCH : ARTIFACT_FRAME_MAX_HEIGHT
        const maxPossible =
          el.scrollHeight > collapsedCap ? el.scrollHeight - collapsedCap : Infinity
        nextScrollTop = Math.min(
          Math.max(0, el.scrollTop + el.clientHeight - collapsedCap),
          maxPossible
        )
      } else {
        nextScrollTop = 0
      }
      pendingBodyScrollRef.current = nextScrollTop
      liveScrollTopRef.current = nextScrollTop
      setCollapsedScrollTop(nextScrollTop)
    }
    captureScrollAnchor(!next)
    setExpandedState(next)
    writeFrameViewState(stateKey, {
      expanded: next,
      showSource: showSourceState,
      scrollTop: liveScrollTopRef.current
    })
  }

  const setShowSource = (next: boolean): void => {
    captureScrollAnchor(!next && !expanded)
    pendingBodyScrollRef.current = 0
    pendingExpandBottomRef.current = null
    liveScrollTopRef.current = 0
    if (bodyRef.current) bodyRef.current.scrollTop = 0
    setCollapsedScrollTop(0)
    setShowSourceState(next)
    writeFrameViewState(stateKey, { expanded: expandedState, showSource: next, scrollTop: 0 })
  }

  const csvRowCap = !framed || retainExpandedSlice ? FULL_CSV_ROWS : FRAME_CSV_ROWS
  const table = useMemo(
    () => (kind === 'csv' ? parseCsv(content, { maxRows: csvRowCap + 1 }) : null),
    [kind, content, csvRowCap]
  )
  // 画幅里显示的文本：json 排好缩进（先排后截 —— 截了再排就解析不了），其余原样
  const shown = useMemo(() => (kind === 'json' ? prettyJson(content) : content), [kind, content])
  const size = table
    ? t('message.artifactCsvSize', {
        rows: Math.max(0, table.totalRows - 1).toLocaleString(i18n.language),
        columns: table.columns
      })
    : t('message.artifactLines', { count: countLines(shown) })

  const canOpen = !!path
  const open = (): void => {
    if (path) useChatStore.getState().requestFilePreview(path)
  }
  const copy = (): void => {
    copyToClipboard(content)
    setCopied(true)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 2000)
  }

  const collapsedContentCapped =
    table && !showSource
      ? Math.max(0, table.totalRows - 1) > FRAME_CSV_ROWS
      : shown.length > FRAME_TEXT_CHARS

  const [overflowState, setOverflowState] = useState({
    top: false,
    bottom: false,
    horizontal: false
  })
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || !framed || expanded) return
    const measure = (): void => {
      const st = el.scrollTop
      const top = st > 1
      const bottom = st + el.clientHeight < el.scrollHeight - 1
      const horizontal = el.scrollWidth > el.clientWidth + 1
      setOverflowState((prev) =>
        prev.top === top && prev.bottom === bottom && prev.horizontal === horizontal
          ? prev
          : { top, bottom, horizontal }
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [framed, expanded, content, kind, showSource, collapsedScrollTop])

  const hasTopFade = framed && !expanded && overflowState.top
  const hasBottomFade = framed && !expanded && overflowState.bottom
  const overflowing = hasTopFade || hasBottomFade
  const canExpand =
    framed &&
    (expanded ||
      overflowState.top ||
      overflowState.bottom ||
      overflowState.horizontal ||
      collapsedContentCapped)
  const clickableToExpand = framed && !expanded && canExpand

  const maxHeight = !framed
    ? undefined
    : expanded
      ? touch
        ? ARTIFACT_EXPANDED_MAX_HEIGHT_TOUCH
        : ARTIFACT_EXPANDED_MAX_HEIGHT
      : touch
        ? ARTIFACT_FRAME_MAX_HEIGHT_TOUCH
        : ARTIFACT_FRAME_MAX_HEIGHT

  const handleFrameClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (!clickableToExpand) return
    if (window.getSelection()?.toString()) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('a, button')) return
    setExpanded(true)
  }

  const handleBodyScroll = (): void => {
    const el = bodyRef.current
    if (!el || !expanded) return
    liveScrollTopRef.current = el.scrollTop
    if (stateKey) {
      writeFrameViewState(stateKey, {
        expanded: expandedState,
        showSource: showSourceState,
        scrollTop: el.scrollTop
      })
    }
  }

  const body = (() => {
    if (table && !showSource) {
      return (
        <CsvTableView
          rows={table.rows}
          truncated={table.truncated}
          framed={framed}
          expanded={expanded}
          fullSlice={retainExpandedSlice}
        />
      )
    }
    const charCap = !framed
      ? Infinity
      : retainExpandedSlice
        ? EXPANDED_TEXT_CHARS
        : FRAME_TEXT_CHARS
    const textTruncated = shown.length > charCap
    const text = textTruncated ? shown.slice(0, charCap) : shown
    if (kind === 'markdown' && !showSource) {
      return (
        <ArtifactFrameContext.Provider value={true}>
          <div className="markdown-body text-sm px-3 py-2">
            <MarkdownText text={text} />
          </div>
          {retainExpandedSlice && textTruncated && (
            <div data-artifact-capped="" className="px-3 pb-2 text-[10px] text-text-tertiary">
              {t('message.artifactCharsCapped', {
                count: EXPANDED_TEXT_CHARS.toLocaleString(i18n.language)
              })}
            </div>
          )}
        </ArtifactFrameContext.Provider>
      )
    }
    return (
      <>
        <pre className="m-0 px-3 py-2 text-[11px] leading-relaxed font-mono text-text-secondary whitespace-pre-wrap break-words">
          {text}
        </pre>
        {retainExpandedSlice && textTruncated && (
          <div data-artifact-capped="" className="px-3 pb-2 text-[10px] text-text-tertiary">
            {t('message.artifactCharsCapped', {
              count: EXPANDED_TEXT_CHARS.toLocaleString(i18n.language)
            })}
          </div>
        )}
      </>
    )
  })()

  return (
    <FigureBlock
      kind="artifact"
      shellRef={shellRef}
      label={label}
      pinActions={expanded || showSource}
      extras={extras}
      actions={
        <>
          <span data-artifact-size="" className="flex-shrink-0">
            {size}
          </span>
          {canExpand && (
            <button
              type="button"
              data-artifact-expand=""
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 hover:text-text-secondary"
            >
              {expanded ? <FoldVertical size={10} /> : <UnfoldVertical size={10} />}
              <span>{expanded ? t('message.diagramFold') : t('message.diagramUnfold')}</span>
            </button>
          )}
          {canToggleSource && (
            <button
              type="button"
              data-artifact-source=""
              onClick={() => setShowSource(!showSource)}
              className="flex items-center gap-1 hover:text-text-secondary"
              title={showSource ? t('message.showRendered') : t('message.showSource')}
            >
              {showSource ? <FileText size={10} /> : <Code size={10} />}
              <span>{showSource ? t('message.artifactPreview') : t('message.source')}</span>
            </button>
          )}
          {canOpen && (
            <button
              type="button"
              data-artifact-open=""
              onClick={open}
              className="flex items-center gap-1 hover:text-text-secondary"
              title={t('message.artifactOpenHint')}
            >
              <SquareArrowOutUpRight size={10} />
              <span>{t('message.artifactOpen')}</span>
            </button>
          )}
          <button
            type="button"
            data-artifact-copy=""
            onClick={copy}
            className="flex items-center hover:text-text-secondary"
            title={t('message.copy')}
            aria-label={t('message.copy')}
          >
            {copied ? <Check size={10} className="text-success" /> : <Copy size={10} />}
          </button>
        </>
      }
    >
      <div
        data-artifact-frame={kind}
        data-artifact-expanded={expanded || undefined}
        data-overflowing={overflowing || undefined}
        onClick={clickableToExpand ? handleFrameClick : undefined}
        className={`relative flex flex-col overflow-hidden rounded-lg border border-border-secondary bg-bg-secondary transition-colors ${
          clickableToExpand ? 'cursor-pointer hover:border-border-primary' : ''
        }`}
        style={maxHeight !== undefined ? { maxHeight } : undefined}
      >
        <div
          ref={bodyRef}
          data-artifact-body=""
          onScroll={expanded ? handleBodyScroll : undefined}
          className={`min-h-0 w-full ${
            expanded ? 'overflow-auto overscroll-contain' : 'overflow-hidden'
          }`}
        >
          {body}
        </div>
        {hasTopFade && (
          <div
            aria-hidden
            data-artifact-fade-top=""
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-14 bg-gradient-to-t from-transparent to-bg-secondary"
          />
        )}
        {hasBottomFade && (
          <div
            aria-hidden
            data-artifact-fade=""
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-14 bg-gradient-to-b from-transparent to-bg-secondary"
          />
        )}
      </div>
    </FigureBlock>
  )
}

function CsvTableView({
  rows,
  truncated,
  framed,
  expanded,
  fullSlice
}: {
  rows: string[][]
  truncated: boolean
  framed: boolean
  expanded: boolean
  fullSlice: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  if (rows.length === 0) {
    return (
      <div className="px-3 py-2 text-[11px] text-text-tertiary">{t('message.artifactEmpty')}</div>
    )
  }
  const [head, ...data] = rows
  // 列数按最宽的那一行：表头短了也不丢后面的列
  const cols = Array.from({ length: Math.max(...rows.map((r) => r.length)) }, (_, i) => i)
  const fullView = !framed || fullSlice
  const shown = fullView ? data.slice(0, FULL_CSV_ROWS) : data.slice(0, FRAME_CSV_ROWS)
  // 展开态下外层 bodyRef 本身已是双向滚动容器（overflow-auto），内层不再套 overflow-x-auto，保证 sticky 表头相对纵向滚动生效
  const wrapperClass = !framed ? 'overflow-x-auto' : expanded ? '' : 'overflow-hidden'
  return (
    <div className={wrapperClass || undefined}>
      <table data-artifact-table="" className="w-full border-collapse text-[11px] font-mono">
        <thead>
          <tr>
            {cols.map((i) => (
              <th
                key={i}
                className="sticky top-0 z-20 bg-bg-tertiary px-2.5 py-1 text-left font-medium text-text-primary border-b border-border-secondary whitespace-nowrap max-w-64 truncate"
              >
                {head[i] ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            <tr key={r}>
              {cols.map((c) => (
                <td
                  key={c}
                  className="px-2.5 py-1 text-text-secondary border-b border-border-secondary/60 whitespace-nowrap max-w-64 truncate"
                >
                  {row[c] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {fullView && truncated && (
        <div data-artifact-capped="" className="px-3 py-2 text-[10px] text-text-tertiary">
          {t('message.artifactRowsCapped', { count: FULL_CSV_ROWS })}
        </div>
      )}
    </div>
  )
}

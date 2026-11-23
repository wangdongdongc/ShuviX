import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, SquareArrowOutUpRight } from 'lucide-react'
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

/** 画幅的高度上限（px）。触屏密度下屏幕窄，同样的高度显得更高，收一点 */
export const ARTIFACT_FRAME_MAX_HEIGHT = 240
export const ARTIFACT_FRAME_MAX_HEIGHT_TOUCH = 200

/** 画幅里表格最多画几行（看得见的不过十来行；多画是为了横向滚动之外不必再算） */
const FRAME_CSV_ROWS = 40
/** 不在画幅里（手机的产物详情页）时表格最多画几行 —— 再多就该点「在窗口中打开」 */
const FULL_CSV_ROWS = 1000
/** 画幅里文本 / markdown 最多取多少字符去渲染：反正只看得见开头，整份去排版是白花的 */
const FRAME_TEXT_CHARS = 8000

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
 * 文本类产物在对话里的样子 —— **一个画幅**（2026-11-23 用户定：一份内容很多的 csv 曾在对话里拉出一长串）。
 *
 *  - 画幅有高度上限，内容按种类排：csv 是表格（表头 + 前几十行），md 渲染成正文，json 排好缩进，其余是等宽文本；
 *    超出上限的部分在底部渐隐，不在画幅里滚动（滚对话时滚轮不会被它截住）。短内容不撑满上限。
 *  - **完整打开走文件面板同一条路**：点画幅（或说明行的打开键）= `requestFilePreview(path)`，宿主开独立窗口。
 *    打开的是文件此刻的内容；画幅显示的若是钉下的旧版，说明行里本来就标着「已有新版」。
 *  - 说明行：名字（产物标题）、规模（行 × 列 / 行数）、版本标记，操作是打开与复制。
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
  touch = false
}: {
  name: string
  content: string
  /** 文件此刻的绝对路径；没有就不给打开 */
  path?: string
  label?: ReactNode
  extras?: ReactNode
  framed?: boolean
  touch?: boolean
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const kind = artifactTextKind(name)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    []
  )

  const table = useMemo(
    () =>
      kind === 'csv'
        ? parseCsv(content, { maxRows: (framed ? FRAME_CSV_ROWS : FULL_CSV_ROWS) + 1 })
        : null,
    [kind, content, framed]
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

  const maxHeight = touch ? ARTIFACT_FRAME_MAX_HEIGHT_TOUCH : ARTIFACT_FRAME_MAX_HEIGHT
  const bodyRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || !framed) return
    const measure = (): void => setOverflowing(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [framed, content, kind])

  const body = (() => {
    if (table) return <CsvTableView rows={table.rows} truncated={table.truncated} framed={framed} />
    const text =
      framed && shown.length > FRAME_TEXT_CHARS ? shown.slice(0, FRAME_TEXT_CHARS) : shown
    if (kind === 'markdown') {
      return (
        <ArtifactFrameContext.Provider value={true}>
          <div className="markdown-body text-sm px-3 py-2">
            <MarkdownText text={text} />
          </div>
        </ArtifactFrameContext.Provider>
      )
    }
    return (
      <pre className="m-0 px-3 py-2 text-[11px] leading-relaxed font-mono text-text-secondary whitespace-pre-wrap break-words">
        {text}
      </pre>
    )
  })()

  return (
    <FigureBlock
      kind="artifact"
      label={label}
      extras={
        <>
          <span data-artifact-size="" className="flex-shrink-0">
            {size}
          </span>
          {extras}
        </>
      }
      actions={
        <>
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
        ref={bodyRef}
        data-artifact-frame={kind}
        data-overflowing={overflowing || undefined}
        // 点画幅 = 打开；但用户在里面拖选了文字（要复制一段）时不算点击
        onClick={
          canOpen && framed
            ? () => {
                if (window.getSelection()?.toString()) return
                open()
              }
            : undefined
        }
        className={`relative overflow-hidden rounded-lg border border-border-secondary bg-bg-secondary ${
          canOpen && framed ? 'cursor-pointer' : ''
        }`}
        style={framed ? { maxHeight } : undefined}
      >
        {body}
        {framed && overflowing && (
          <div
            aria-hidden
            data-artifact-fade=""
            className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent to-bg-secondary"
          />
        )}
      </div>
    </FigureBlock>
  )
}

function CsvTableView({
  rows,
  truncated,
  framed
}: {
  rows: string[][]
  truncated: boolean
  framed: boolean
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
  const shown = framed ? data.slice(0, FRAME_CSV_ROWS) : data.slice(0, FULL_CSV_ROWS)
  return (
    // 横向：宽表在画幅里截住（看个样子），不在画幅外撑开对话；完整的表在窗口里看
    <div className={framed ? 'overflow-hidden' : 'overflow-x-auto'}>
      <table data-artifact-table="" className="w-full border-collapse text-[11px] font-mono">
        <thead>
          <tr>
            {cols.map((i) => (
              <th
                key={i}
                className="sticky top-0 bg-bg-tertiary px-2.5 py-1 text-left font-medium text-text-primary border-b border-border-secondary whitespace-nowrap max-w-64 truncate"
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
      {!framed && truncated && (
        <div className="px-3 py-2 text-[10px] text-text-tertiary">
          {t('message.artifactRowsCapped', { count: FULL_CSV_ROWS })}
        </div>
      )}
    </div>
  )
}

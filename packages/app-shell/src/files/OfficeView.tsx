/**
 * OfficeView — Office 文档预览（桌面 / 扩展两端共用，纯浏览器端渲染，无后端转换）
 *
 *  - officeKind 'docx'  → docx-preview 渲染（分页 / 表格 / 内嵌图片）。渲进 Shadow DOM：
 *    其注入的 <style> 带标签级选择器，Shadow 隔离防样式漂进宿主页面；页面自带白底，
 *    暗色主题下同样可读。
 *  - officeKind 'sheet' → SheetJS 解析（xlsx / xlsm / xls / ods），自渲表格：
 *    sheet 标签切换 + sticky 列头 / 行号 + 行列截断（解析时 sheetRows 同步截断防长任务，
 *    渲染时行列双向截断防 DOM 爆炸）。
 *
 * 两个渲染库都经动态 import 懒加载为独立 chunk —— 不预览 Office 文件不付首包成本。
 * MV3 合规：chunk 打进扩展包，非远程代码，无 eval。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2 } from 'lucide-react'

interface OfficeViewProps {
  /** 渲染器路由（内核 OFFICE_KIND_BY_EXT 判定）：docx → docx-preview；sheet → SheetJS */
  officeKind: 'docx' | 'sheet'
  /** 完整文件字节 base64（后端已过 PREVIEW_OFFICE_MAX_BYTES 门控） */
  dataBase64: string
}

/** 渲染截断上限：500 行 × 40 列 ≈ 2 万单元格，一次性渲染可控；超出显示截断提示 */
const SHEET_MAX_ROWS = 500
const SHEET_MAX_COLS = 40

/**
 * 渲染成本阈值 —— 超过则由 FilePreview 先弹确认卡片，用户点了才真正解析渲染。
 *
 * 两个数字都来自「这段渲染跑在界面线程上」这一事实：SheetJS 是同步 parse（体积越大
 * 卡顿越久，是目前最容易冻住界面的一条）；docx-preview 建 DOM 的量随文档规模上涨。
 * 阈值有意定得宽 —— 常规文档零打扰，只拦真正会让人以为「卡死了」的量级。
 */
export const SHEET_CONFIRM_BYTES = 2 * 1024 * 1024
export const DOCX_CONFIRM_BYTES = 5 * 1024 * 1024

export function OfficeView({ officeKind, dataBase64 }: OfficeViewProps): React.JSX.Element {
  const { t } = useTranslation()
  // base64 → 字节：单次解码后 docx / sheet 子视图共用；异常（理论不可达）降级错误占位
  const bytes = useMemo(() => {
    try {
      return base64ToBytes(dataBase64)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }, [dataBase64])

  if (typeof bytes === 'string') {
    return <OfficePlaceholder title={t('panel.preview.error')} detail={bytes} />
  }
  return officeKind === 'docx' ? <DocxView data={bytes} /> : <SheetView data={bytes} />
}

/**
 * DocxView —— docx-preview 渲染进宿主 div 的 Shadow DOM。
 * data 变化（files.changed 重读 / 切换文件）时重建 shadow 内容整体重渲。
 */
function DocxView({ data }: { data: Uint8Array }): React.JSX.Element {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<'rendering' | 'ready' | 'error'>('rendering')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    let cancelled = false
    setPhase('rendering')
    ;(async () => {
      const { renderAsync } = await import('docx-preview')
      const host = hostRef.current
      if (cancelled || !host) return
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
      // 并发保险：旧渲染若还在途，其挂载点已被移出 shadow，写入落在游离节点上无害
      shadow.replaceChildren()
      const mount = document.createElement('div')
      shadow.appendChild(mount)
      // styleContainer 同传 mount —— 生成的 <style> 一并留在 Shadow 内
      await renderAsync(data, mount, mount)
      if (!cancelled) setPhase('ready')
    })().catch((e: unknown) => {
      if (!cancelled) {
        setErrorMsg(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    })
    return () => {
      cancelled = true
    }
  }, [data])

  return (
    <div className="relative h-full">
      {/* host 常驻 DOM（渲染中也在），错误时才藏 —— renderAsync 需要真实挂载点 */}
      <div ref={hostRef} className={phase === 'error' ? 'hidden' : 'h-full overflow-auto'} />
      {phase === 'rendering' && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-secondary">
          <Loader2 size={20} className="animate-spin text-text-tertiary/50" />
        </div>
      )}
      {phase === 'error' && (
        <OfficePlaceholder title={t('panel.preview.error')} detail={errorMsg} />
      )}
    </div>
  )
}

interface ParsedSheet {
  name: string
  /** 截断到 [SHEET_MAX_ROWS × SHEET_MAX_COLS] 的格式化文本矩阵（raw:false 走数字格式，日期可读） */
  rows: string[][]
  /** 截断前的完整行列数（来自 !fullref / !ref），供截断提示判定 */
  totalRows: number
  totalCols: number
}

/**
 * SheetView —— SheetJS 解析 + 自渲表格。
 * 解析在懒加载完成后同步执行；sheetRows 让所有格式的行截断发生在解析期，
 * 大表不会先整表建模再丢弃。
 */
function SheetView({ data }: { data: Uint8Array }): React.JSX.Element {
  const { t } = useTranslation()
  const [sheets, setSheets] = useState<ParsedSheet[] | null>(null)
  const [active, setActive] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSheets(null)
    setActive(0)
    setErrorMsg(null)
    ;(async () => {
      const XLSX = await import('xlsx')
      if (cancelled) return
      const wb = XLSX.read(data, { type: 'array', dense: true, sheetRows: SHEET_MAX_ROWS })
      const parsed = wb.SheetNames.map((name): ParsedSheet => {
        const ws = wb.Sheets[name]
        const wsRec = ws as Record<string, unknown>
        // sheetRows 截断时 !fullref 保留完整范围；无截断则用 !ref
        const ref =
          typeof wsRec['!fullref'] === 'string'
            ? (wsRec['!fullref'] as string)
            : typeof wsRec['!ref'] === 'string'
              ? (wsRec['!ref'] as string)
              : null
        const range = ref ? XLSX.utils.decode_range(ref) : null
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
          header: 1,
          raw: false,
          defval: ''
        })
        const rows = aoa
          .slice(0, SHEET_MAX_ROWS)
          .map((r) => r.slice(0, SHEET_MAX_COLS).map((c) => (c == null ? '' : String(c))))
        return {
          name,
          rows,
          totalRows: range ? range.e.r + 1 : rows.length,
          totalCols: range ? range.e.c + 1 : Math.max(0, ...rows.map((r) => r.length))
        }
      })
      if (!cancelled) setSheets(parsed)
    })().catch((e: unknown) => {
      if (!cancelled) setErrorMsg(e instanceof Error ? e.message : String(e))
    })
    return () => {
      cancelled = true
    }
  }, [data])

  if (errorMsg != null) {
    return <OfficePlaceholder title={t('panel.preview.error')} detail={errorMsg} />
  }
  if (!sheets) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary/50">
        <Loader2 size={20} className="animate-spin" />
      </div>
    )
  }

  const sheet = sheets[active] as ParsedSheet | undefined
  const displayCols = sheet ? Math.min(sheet.totalCols, SHEET_MAX_COLS) : 0
  const truncated =
    !!sheet && (sheet.totalRows > sheet.rows.length || sheet.totalCols > SHEET_MAX_COLS)

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-auto">
        {!sheet || sheet.rows.length === 0 || displayCols === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-text-tertiary">
            {t('panel.preview.sheetEmpty')}
          </div>
        ) : (
          <table className="border-separate border-spacing-0 text-[11px] tabular-nums text-text-primary">
            <thead>
              <tr>
                {/* 左上角：行号列 × 列头行交汇，双向 sticky */}
                <th className="sticky top-0 left-0 z-30 bg-bg-tertiary border-b border-r border-border-secondary/40 min-w-[36px]" />
                {Array.from({ length: displayCols }, (_, ci) => (
                  <th
                    key={ci}
                    className="sticky top-0 z-20 bg-bg-tertiary px-2 py-0.5 border-b border-r border-border-secondary/40 font-medium text-text-tertiary text-center min-w-[64px]"
                  >
                    {colLetter(ci)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, ri) => (
                <tr key={ri}>
                  <td className="sticky left-0 z-10 bg-bg-tertiary px-1.5 py-0.5 border-b border-r border-border-secondary/40 text-right text-text-tertiary select-none">
                    {ri + 1}
                  </td>
                  {Array.from({ length: displayCols }, (_, ci) => {
                    const v = row[ci] ?? ''
                    return (
                      <td
                        key={ci}
                        title={v || undefined}
                        className="px-1.5 py-0.5 border-b border-r border-border-secondary/30 max-w-[280px] truncate"
                      >
                        {v}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {truncated && sheet && (
        <div className="flex-shrink-0 px-2 py-1 text-[10px] text-text-tertiary border-t border-border-secondary/30">
          {t('panel.preview.sheetTruncated', {
            rows: sheet.rows.length,
            cols: displayCols
          })}
        </div>
      )}

      {/* sheet 标签栏：Excel 式置底；单 sheet 不显示 */}
      {sheets.length > 1 && (
        <div className="flex-shrink-0 flex items-center gap-0.5 px-1 h-6 border-t border-border-secondary/30 overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={[
                'px-2 h-5 rounded text-[10px] whitespace-nowrap transition-colors',
                i === active
                  ? 'text-accent bg-bg-hover/30'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40'
              ].join(' ')}
              title={s.name}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function OfficePlaceholder({
  title,
  detail
}: {
  title: string
  detail?: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-xs text-text-tertiary">
      <span className="text-text-tertiary/70">
        <AlertCircle size={20} />
      </span>
      <span>{title}</span>
      {detail && (
        <span className="text-text-tertiary/70 max-w-[80%] text-center break-all">{detail}</span>
      )}
    </div>
  )
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 0 → A, 25 → Z, 26 → AA …（Excel 列号） */
function colLetter(i: number): string {
  let s = ''
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s
  }
  return s
}

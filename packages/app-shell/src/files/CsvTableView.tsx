/**
 * CsvTableView —— 文件预览窗口里 `.csv` 的表格视图（顶栏的源码键切回 CodeView）。
 *
 * 解析与对话里产物画幅同一个（chat-protocol `parseCsv`），第一行当表头。行数不设上限：表体走 TableVirtuoso，
 * 只画看得见的那几十行，几万行的表滚起来也不卡；但整份要先解析成字段数组，所以超过 CSV_TABLE_MAX_BYTES 的
 * 文件不进表格（调用方只给源码视图）。样式与 OfficeView 的 SheetView 一致：行号列与表头双向 sticky。
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { TableVirtuoso, type TableComponents } from 'react-virtuoso'
import { parseCsv } from '@shuvix/chat-protocol/utils/csvTable'

/** 表格视图接受的最大字节数（超过就只给源码视图）：字段数组约是原文的数倍内存 */
export const CSV_TABLE_MAX_BYTES = 20 * 1024 * 1024

// 模块级：放进 render 里每次是新组件，Virtuoso 会把整张表重挂
const TABLE_COMPONENTS: TableComponents<string[]> = {
  Table: (props) => (
    <table
      {...props}
      className="border-separate border-spacing-0 text-[11px] tabular-nums text-text-primary"
    />
  )
}

export function CsvTableView({ content }: { content: string }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const table = useMemo(() => parseCsv(content), [content])
  const [head = [], ...data] = table.rows
  const cols = table.columns

  if (table.rows.length === 0 || cols === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-text-tertiary">
        {t('panel.preview.sheetEmpty')}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-csv-table="">
      <TableVirtuoso
        className="flex-1 min-h-0"
        data={data}
        increaseViewportBy={400}
        components={TABLE_COMPONENTS}
        fixedHeaderContent={() => (
          <tr>
            <th className="sticky left-0 z-30 bg-bg-tertiary border-b border-r border-border-secondary/40 min-w-[36px]" />
            {Array.from({ length: cols }, (_, ci) => (
              <th
                key={ci}
                title={head[ci] || undefined}
                className="bg-bg-tertiary px-2 py-0.5 border-b border-r border-border-secondary/40 font-medium text-text-primary text-left min-w-[64px] max-w-[280px] truncate"
              >
                {head[ci] ?? ''}
              </th>
            ))}
          </tr>
        )}
        itemContent={(ri, row) => (
          <>
            <td className="sticky left-0 z-10 bg-bg-tertiary px-1.5 py-0.5 border-b border-r border-border-secondary/40 text-right text-text-tertiary select-none">
              {ri + 1}
            </td>
            {Array.from({ length: cols }, (_, ci) => {
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
          </>
        )}
      />
      <div className="flex-shrink-0 px-2 py-1 text-[10px] text-text-tertiary border-t border-border-secondary/30">
        {t('panel.preview.csvSize', {
          rows: data.length.toLocaleString(i18n.language),
          cols
        })}
      </div>
    </div>
  )
}

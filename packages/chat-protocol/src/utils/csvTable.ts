/**
 * CSV → 表格：对话里产物的画幅（chat-ui ArtifactFrame）与文件预览窗口的表格视图共用一个解析器。
 *
 * RFC 4180 的那一套：双引号包住的字段里可以有分隔符、换行和 `""`（一个引号）；行尾 `\n` / `\r\n` / `\r`
 * 都认；开头的 BOM 去掉；最后一行后面的空行不算一行。分隔符按第一条记录里（引号外）出现最多的
 * `,` / `;` / `\t` 定，一个都没有就是逗号 —— 欧洲习惯的分号文件不至于整行挤成一格。
 *
 * `maxRows` 只限制**留下来**的行（画幅只画前几十行）；解析照样扫到底，`totalRows` 是整份的记录数。
 * 扫到底不贵：内容本来就整份在内存里，而「共多少行」是画幅说明行要写的。
 */

export interface CsvTable {
  /** 留下来的记录（第一条通常是表头），每条一个字段数组 */
  rows: string[][]
  /** 整份的记录数（含表头） */
  totalRows: number
  /** 留下来的记录里最多的字段数 */
  columns: number
  /** rows 少于 totalRows */
  truncated: boolean
  /** 用的分隔符 */
  delimiter: string
}

const CANDIDATES = [',', ';', '\t'] as const

/** 第一条记录里（引号外）出现最多的候选分隔符；一个都没有 → 逗号 */
export function detectCsvDelimiter(text: string): string {
  const counts = new Map<string, number>()
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (c === '\n' || c === '\r') break
    if ((CANDIDATES as readonly string[]).includes(c)) counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let best = ','
  let bestCount = 0
  for (const d of CANDIDATES) {
    const n = counts.get(d) ?? 0
    if (n > bestCount) {
      best = d
      bestCount = n
    }
  }
  return best
}

export function parseCsv(
  input: string,
  opts: { maxRows?: number; delimiter?: string } = {}
): CsvTable {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const delimiter = opts.delimiter ?? detectCsvDelimiter(text)
  const maxRows = opts.maxRows ?? Infinity
  const rows: string[][] = []
  let totalRows = 0
  let columns = 0

  let row: string[] = []
  let field = ''
  let quoted = false
  // 这条记录里出现过任何东西（字段内容、分隔符、引号）—— 区分「空行」与「一个空字段的记录」
  let touched = false

  const endRow = (): void => {
    row.push(field)
    field = ''
    totalRows++
    if (rows.length < maxRows) {
      rows.push(row)
      if (row.length > columns) columns = row.length
    }
    row = []
    touched = false
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      quoted = true
      touched = true
    } else if (c === delimiter) {
      row.push(field)
      field = ''
      touched = true
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      if (touched || field !== '') endRow()
      // 空行：不算一条记录（文件末尾的换行、记录之间多出的空行）
    } else {
      field += c
      touched = true
    }
  }
  if (touched || field !== '') endRow()

  return { rows, totalRows, columns, truncated: rows.length < totalRows, delimiter }
}

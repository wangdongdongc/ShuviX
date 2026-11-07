/**
 * Parse CSV text into rows (arrays of strings).
 * Fields may be wrapped in double quotes; inside quotes a doubled quote ("") is one quote, and commas
 * and line breaks are literal. Lines end with \n or \r\n. Blank lines are skipped.
 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let quotedField = false

  const endField = () => {
    row.push(field)
    field = ''
    quotedField = false
  }
  const endRow = () => {
    if (row.length === 0 && field.trim() === '' && !quotedField) {
      field = ''
      return
    }
    endField()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c !== '"') field += c
      else if (text[i + 1] === '"') {
        field += '"'
        i++
      } else inQuotes = false
      continue
    }
    if (c === '"' && field === '' && !quotedField) {
      inQuotes = true
      quotedField = true
    } else if (c === ',') endField()
    else if (c === '\n') endRow()
    else if (c === '\r' && (text[i + 1] === '\n' || i === text.length - 1)) continue
    else field += c
  }
  endRow()
  return rows
}

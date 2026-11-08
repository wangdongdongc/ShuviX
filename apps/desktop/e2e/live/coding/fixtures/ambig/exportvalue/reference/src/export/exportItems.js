import { writeFile } from 'node:fs/promises'
import { PAGE_SIZE } from '../config.js'

export const COLUMNS = ['sku', 'name', 'category', 'location', 'onHand', 'reserved', 'reorderPoint']

const csvField = (value) => {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Write every item matching `q` to `file` as CSV. It walks the same paged listing the API serves, so
 * an export never holds more than one page of rows from the service at a time.
 */
const dollars = (cents) => (cents / 100).toFixed(2)

/**
 * With `withValue`, a last column `stockValue`: the item's FIFO stock value (report/valuation.js) in dollars
 * with two decimals and no symbol, the format finance imports.
 */
export async function exportItems(service, file, { q = '', withValue = false } = {}) {
  const values = withValue
    ? new Map((await service.valuation()).rows.map((r) => [r.sku, r.value]))
    : undefined
  const lines = [(values ? [...COLUMNS, 'stockValue'] : COLUMNS).join(',')]
  let cursor
  let pages = 0
  do {
    const page = await service.listItems({ q, cursor, limit: PAGE_SIZE })
    for (const item of page.items) {
      const row = COLUMNS.map((c) => csvField(item[c]))
      if (values) row.push(dollars(values.get(item.sku) ?? 0))
      lines.push(row.join(','))
    }
    cursor = page.nextCursor
    pages++
  } while (cursor && pages < 100_000)
  await writeFile(file, lines.join('\n') + '\n')
  return lines.length - 1
}

import { writeFile } from 'node:fs/promises'
import { PAGE_SIZE } from '../config.js'

export const COLUMNS = ['sku', 'name', 'category', 'location', 'onHand', 'reserved', 'reorderPoint']

const csvField = (value) => {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Write every item matching `q` to `file` as CSV (`withPrice`: a last `price` column in cents, empty
 * without a price). It walks the same paged listing the API serves, so
 * an export never holds more than one page of rows from the service at a time.
 */
export async function exportItems(service, file, { q = '', withPrice = false } = {}) {
  const columns = withPrice ? [...COLUMNS, 'price'] : COLUMNS
  const lines = [columns.join(',')]
  let cursor
  let pages = 0
  do {
    const page = await service.listItems({ q, cursor, limit: PAGE_SIZE })
    for (const item of page.items) lines.push(columns.map((c) => csvField(item[c])).join(','))
    cursor = page.nextCursor
    pages++
  } while (cursor && pages < 100_000)
  await writeFile(file, lines.join('\n') + '\n')
  return lines.length - 1
}

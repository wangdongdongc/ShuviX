import { invalid } from '../errors.js'

/** The cursor is the key of the last row of the previous page, opaque to clients. */
export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ sku: row.sku })).toString('base64url')
}

export function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof value?.sku !== 'string') throw new Error('no sku')
    return value
  } catch {
    throw invalid('bad cursor', { field: 'cursor' })
  }
}

/** One page of `rows` (already sorted) after `cursor`; `nextCursor` is null on the last page. */
export function paginate(rows, { cursor, limit }) {
  const after = cursor ? decodeCursor(cursor) : null
  const rest = after ? rows.filter((row) => row.sku > after.sku) : rows
  const items = rest.slice(0, limit)
  return { items, nextCursor: rest.length > limit ? encodeCursor(items.at(-1)) : null }
}

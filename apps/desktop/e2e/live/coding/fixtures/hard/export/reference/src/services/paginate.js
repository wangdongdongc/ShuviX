import { invalid } from '../errors.js'

/**
 * The cursor is the full sort key of the last row of the previous page ([category, sku]), opaque to
 * clients. It has to be the whole key: with only the SKU, rows sorted by category first are skipped
 * or repeated as soon as a later category holds a smaller SKU.
 */
export const keyOf = (row) => [row.category, row.sku]

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ key: keyOf(row) })).toString('base64url')
}

export function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!Array.isArray(value?.key) || value.key.length !== 2) throw new Error('no key')
    if (!value.key.every((part) => typeof part === 'string')) throw new Error('bad key')
    return value.key
  } catch {
    throw invalid('bad cursor', { field: 'cursor' })
  }
}

function after(row, key) {
  const [category, sku] = keyOf(row)
  return category > key[0] || (category === key[0] && sku > key[1])
}

/** One page of `rows` (sorted by keyOf) after `cursor`; `nextCursor` is null on the last page. */
export function paginate(rows, { cursor, limit }) {
  const key = cursor ? decodeCursor(cursor) : null
  const rest = key ? rows.filter((row) => after(row, key)) : rows
  const items = rest.slice(0, limit)
  return { items, nextCursor: rest.length > limit ? encodeCursor(items.at(-1)) : null }
}

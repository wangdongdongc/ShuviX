import { MAX_PAGE_SIZE, PAGE_SIZE } from '../config.js'
import { invalid } from '../errors.js'
import { matches } from '../query/evaluate.js'
import { isArchived } from '../domain/items.js'
import { parseQuery } from '../query/parse.js'
import { compareStrings } from '../util/compare.js'
import { paginate } from './paginate.js'

const order = (a, b) => compareStrings(a.sku, b.sku)

/**
 * Items matching the query `q`, sorted, one page at a time. Archived items are left out, unless
 * `archived` is true, which lists only them.
 */
export async function listItems(
  store,
  { q = '', cursor, limit = PAGE_SIZE, archived = false } = {}
) {
  if (!Number.isInteger(limit) || limit < 1) throw invalid('limit must be a positive integer')
  const query = parseQuery(q)
  const rows = (await store.items.all())
    .filter((item) => isArchived(item) === archived && matches(query, item))
    .sort(order)
  return paginate(rows, { cursor, limit: Math.min(limit, MAX_PAGE_SIZE) })
}

/** Every matching item, following the pages. */
export async function listAllItems(store, { q = '', archived = false } = {}) {
  const out = []
  let cursor
  do {
    const page = await listItems(store, { q, cursor, limit: MAX_PAGE_SIZE, archived })
    out.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return out
}

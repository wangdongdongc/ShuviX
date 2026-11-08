import { movementsFor } from '../domain/movements.js'
import { invalid } from '../errors.js'
import { compareStrings } from '../util/compare.js'
import { addDays } from '../util/time.js'
import { remainingLots } from './valuation.js'

/**
 * Lots with stock left that expire within `days` days of `now` (that day included), or have already
 * expired: what is left of each and its value in cents, by expiry date, then SKU.
 */
export async function expiring(store, { now = new Date(), days = 30 } = {}) {
  if (!Number.isInteger(days) || days < 0) {
    throw invalid('days must be a non-negative integer', { field: 'days' })
  }
  const limit = addDays(now, days)
  const rows = []
  for (const item of await store.items.all()) {
    for (const lot of remainingLots(await movementsFor(store, item.sku))) {
      if (!lot.expiresAt || lot.qty <= 0 || lot.expiresAt > limit) continue
      rows.push({
        sku: item.sku,
        expiresAt: lot.expiresAt,
        qty: lot.qty,
        value: lot.qty * lot.unitCost
      })
    }
  }
  return rows.sort(
    (a, b) => compareStrings(a.expiresAt, b.expiresAt) || compareStrings(a.sku, b.sku)
  )
}

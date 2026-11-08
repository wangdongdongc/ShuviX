import { SHIPMENT_WINDOW_DAYS } from '../config.js'
import { available, leadTimeOf } from '../domain/items.js'
import { movementsFor } from '../domain/movements.js'
import { compareStrings } from '../util/compare.js'
import { DAY_MS } from '../util/time.js'

const cover = (row) => (row.daysOfCover === null ? Infinity : row.daysOfCover)

/** The UTC date (YYYY-MM-DD) `days` days after `now` */
const dateAfter = (now, days) => new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10)

/**
 * Items whose available stock is below their reorder point, with the units shipped in the last
 * SHIPMENT_WINDOW_DAYS days before `now` and how many whole days the stock lasts at that rate.
 * `reorderBy` is the last day to order, given the supplier's lead time (null when nothing shipped).
 * Most urgent first, then by SKU.
 */
export async function lowStock(store, { now = new Date() } = {}) {
  const since = new Date(now.getTime() - SHIPMENT_WINDOW_DAYS * DAY_MS).toISOString()
  const until = now.toISOString()
  const rows = []
  for (const item of await store.items.all()) {
    const free = available(item)
    if (free >= item.reorderPoint) continue
    const shipped = (await movementsFor(store, item.sku))
      .filter((m) => m.type === 'ship' && m.at > since && m.at <= until)
      .reduce((sum, m) => sum + m.qty, 0)
    const perDay = shipped / SHIPMENT_WINDOW_DAYS
    const daysOfCover = perDay > 0 ? Math.floor(Math.max(free, 0) / perDay) : null
    const leadTimeDays = leadTimeOf(item)
    rows.push({
      sku: item.sku,
      name: item.name,
      available: free,
      reorderPoint: item.reorderPoint,
      shippedLast30: shipped,
      daysOfCover,
      leadTimeDays,
      reorderBy: daysOfCover === null ? null : dateAfter(now, daysOfCover - leadTimeDays)
    })
  }
  return rows.sort((a, b) => cover(a) - cover(b) || compareStrings(a.sku, b.sku))
}

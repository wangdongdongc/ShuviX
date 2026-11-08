import { SHIPMENT_WINDOW_DAYS } from '../config.js'
import { available } from '../domain/items.js'
import { movementsFor } from '../domain/movements.js'
import { onOrderBySku } from '../domain/orders.js'
import { compareStrings } from '../util/compare.js'
import { DAY_MS } from '../util/time.js'

const cover = (row) => (row.daysOfCover === null ? Infinity : row.daysOfCover)

/**
 * Items whose available stock, plus what is still to come on open purchase orders, is below their
 * reorder point, with the units on order, the units shipped in the last SHIPMENT_WINDOW_DAYS days
 * before `now` and how many whole days the stock lasts at that rate. Most urgent first, then by SKU.
 */
export async function lowStock(store, { now = new Date() } = {}) {
  const since = new Date(now.getTime() - SHIPMENT_WINDOW_DAYS * DAY_MS).toISOString()
  const until = now.toISOString()
  const rows = []
  const onOrder = await onOrderBySku(store)
  for (const item of await store.items.all()) {
    const free = available(item)
    const coming = onOrder.get(item.sku) ?? 0
    if (free + coming >= item.reorderPoint) continue
    const shipped = (await movementsFor(store, item.sku))
      .filter((m) => m.type === 'ship' && m.at > since && m.at <= until)
      .reduce((sum, m) => sum + m.qty, 0)
    const perDay = shipped / SHIPMENT_WINDOW_DAYS
    rows.push({
      sku: item.sku,
      name: item.name,
      available: free,
      reorderPoint: item.reorderPoint,
      onOrder: coming,
      shippedLast30: shipped,
      daysOfCover: perDay > 0 ? Math.floor(Math.max(free, 0) / perDay) : null
    })
  }
  return rows.sort((a, b) => cover(a) - cover(b) || compareStrings(a.sku, b.sku))
}

import { movementsFor } from '../domain/movements.js'
import { compareStrings } from '../util/compare.js'
import { DAY_MS } from '../util/time.js'

/** What is left of the received lots after shipments used up the oldest ones first. */
export function remainingLots(movements) {
  const lots = []
  for (const m of movements) {
    if (m.type == 'receive') {
      lots.push({ qty: m.qty, unitCost: m.unitCost })
    } else if (m.type === 'ship') {
      let left = m.qty
      while (left > 0 && lots.length > 0) {
        const take = Math.min(lots[0].qty, left)
        lots[0].qty -= take
        left -= take
        if (lots[0].qty === 0) lots.shift()
      }
    }
  }
  return lots
}

/**
 * Stock value per item (FIFO), in cents, sorted by SKU, and the total. `avgCost` is the value per unit on
 * hand, rounded to a cent (null with nothing on hand).
 */
export async function valuation(store) {
  const rows = []
  for (const item of await store.items.all()) {
    const lots = remainingLots(await movementsFor(store, item.sku))
    const value = lots.reduce((sum, lot) => sum + lot.qty * lot.unitCost, 0)
    rows.push({
      sku: item.sku,
      onHand: item.onHand,
      value,
      avgCost: item.onHand === 0 ? null : Math.round(value / item.onHand)
    })
  }
  rows.sort((a, b) => compareStrings(a.sku, b.sku))
  return { rows, total: rows.reduce((sum, r) => sum + r.value, 0) }
}

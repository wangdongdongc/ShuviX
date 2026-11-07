import { movementsBySku } from '../domain/movements.js'
import { compareStrings } from '../util/compare.js'

/** What is left of the received lots after shipments used up the oldest ones first. */
export function remainingLots(movements) {
  const lots = []
  for (const m of movements) {
    if (m.type === 'receive') {
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

/** Stock value per item (FIFO), in cents, sorted by SKU, and the total. */
export async function valuation(store) {
  const movements = await movementsBySku(store)
  const rows = []
  for (const item of await store.items.all()) {
    const lots = remainingLots(movements.get(item.sku) ?? [])
    rows.push({
      sku: item.sku,
      onHand: item.onHand,
      value: lots.reduce((sum, lot) => sum + lot.qty * lot.unitCost, 0)
    })
  }
  rows.sort((a, b) => compareStrings(a.sku, b.sku))
  return { rows, total: rows.reduce((sum, r) => sum + r.value, 0) }
}

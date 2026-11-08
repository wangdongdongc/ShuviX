import { movementsFor } from '../domain/movements.js'
import { compareStrings } from '../util/compare.js'

const NO_EXPIRY = '9999-12-31'

/** The order lots are used up in: the earliest expiry first, lots without one last, then the oldest. */
const useOrder = (a, b) => {
  const ea = a.expiresAt ?? NO_EXPIRY
  const eb = b.expiresAt ?? NO_EXPIRY
  return ea < eb ? -1 : ea > eb ? 1 : a.seq - b.seq
}

/**
 * What is left of the received lots after shipments used them up: the lots that expire first go first
 * (lots without an expiry date last), and among lots with the same date the oldest.
 */
export function remainingLots(movements) {
  const lots = []
  let seq = 0
  for (const m of movements) {
    if (m.type === 'receive') {
      lots.push({ qty: m.qty, unitCost: m.unitCost, expiresAt: m.expiresAt ?? null, seq: seq++ })
      lots.sort(useOrder)
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

/** Stock value per item (what is left of its lots), in cents, sorted by SKU, and the total. */
export async function valuation(store) {
  const rows = []
  for (const item of await store.items.all()) {
    const lots = remainingLots(await movementsFor(store, item.sku))
    rows.push({
      sku: item.sku,
      onHand: item.onHand,
      value: lots.reduce((sum, lot) => sum + lot.qty * lot.unitCost, 0)
    })
  }
  rows.sort((a, b) => compareStrings(a.sku, b.sku))
  return { rows, total: rows.reduce((sum, r) => sum + r.value, 0) }
}

import { randomUUID } from 'node:crypto'

/**
 * A movement records one change to an item's stock:
 *   receive  { qty, unitCost }      stock arrived (unitCost in cents, used for valuation)
 *   reserve  { qty }                units promised to an order
 *   release  { qty }                a promise taken back
 *   ship     { qty, fromReservation } units left the warehouse
 */
export function movement(type, sku, qty, at, extra = {}) {
  return { id: randomUUID(), type, sku, qty, at, ...extra }
}

const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)

/** Movements of one SKU, oldest first (same timestamp: the order they were recorded in). */
export async function movementsFor(store, sku) {
  const all = await store.movements.all()
  return all.filter((m) => m.sku === sku).sort(byTime)
}

/**
 * Every SKU's movements, oldest first, from one read of the store. Reports over many items use this:
 * calling movementsFor per item copies the whole movement log once per item.
 */
export async function movementsBySku(store) {
  const bySku = new Map()
  for (const m of await store.movements.all()) {
    let list = bySku.get(m.sku)
    if (!list) bySku.set(m.sku, (list = []))
    list.push(m)
  }
  for (const list of bySku.values()) list.sort(byTime)
  return bySku
}

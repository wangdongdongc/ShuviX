import { randomUUID } from 'node:crypto'

/**
 * A movement records one change to an item's stock:
 *   receive  { quantity, unitCost }      stock arrived (unitCost in cents, used for valuation)
 *   reserve  { quantity }                units promised to an order
 *   release  { quantity }                a promise taken back
 *   ship     { quantity, fromReservation } units left the warehouse
 */
export function movement(type, sku, quantity, at, extra = {}) {
  return { id: randomUUID(), type, sku, quantity, at, ...extra }
}

/** Movements of one SKU, oldest first (same timestamp: the order they were recorded in). */
export async function movementsFor(store, sku) {
  const all = await store.movements.all()
  return all.filter((m) => m.sku === sku).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

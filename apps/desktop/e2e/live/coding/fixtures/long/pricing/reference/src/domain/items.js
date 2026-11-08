import { invalid } from '../errors.js'

const SKU = /^[A-Z0-9][A-Z0-9-]{1,31}$/

/** Validate a new item. Stock starts at zero; it only changes through movements (domain/stock.js). */
export function newItem(input, now) {
  const { sku, name, category, location, reorderPoint = 0, price = null } = input ?? {}
  if (typeof sku !== 'string' || !SKU.test(sku)) {
    throw invalid(`bad sku "${sku}": use A-Z, 0-9 and "-"`, { field: 'sku' })
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw invalid('name is required', { field: 'name' })
  }
  if (!Number.isInteger(reorderPoint) || reorderPoint < 0) {
    throw invalid('reorderPoint must be a non-negative integer', { field: 'reorderPoint' })
  }
  requirePrice(price)
  return {
    sku,
    name: name.trim(),
    category: String(category || 'general')
      .trim()
      .toLowerCase(),
    location: String(location ?? '').trim(),
    onHand: 0,
    reserved: 0,
    reorderPoint,
    price,
    createdAt: now,
    updatedAt: now
  }
}

/** A selling price: integer cents, or null for "no price yet". */
export function requirePrice(price) {
  if (price !== null && (!Number.isInteger(price) || price < 0)) {
    throw invalid('price must be a non-negative integer (cents) or null', { field: 'price' })
  }
}

/** Units that can still be promised or shipped. */
export const available = (item) => item.onHand - item.reserved

export function requireQty(qty) {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw invalid('qty must be a positive integer', { field: 'qty' })
  }
}

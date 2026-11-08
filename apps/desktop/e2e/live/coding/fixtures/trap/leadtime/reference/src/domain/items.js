import { invalid } from '../errors.js'

const SKU = /^[A-Z0-9][A-Z0-9-]{1,31}$/

/** Supplier lead time, in days, of an item that does not say */
export const DEFAULT_LEAD_TIME_DAYS = 7

/** Validate a new item. Stock starts at zero; it only changes through movements (domain/stock.js). */
export function newItem(input, now) {
  const {
    sku,
    name,
    category,
    location,
    reorderPoint = 0,
    leadTimeDays = DEFAULT_LEAD_TIME_DAYS
  } = input ?? {}
  if (typeof sku !== 'string' || !SKU.test(sku)) {
    throw invalid(`bad sku "${sku}": use A-Z, 0-9 and "-"`, { field: 'sku' })
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw invalid('name is required', { field: 'name' })
  }
  if (!Number.isInteger(reorderPoint) || reorderPoint < 0) {
    throw invalid('reorderPoint must be a non-negative integer', { field: 'reorderPoint' })
  }
  if (!Number.isInteger(leadTimeDays) || leadTimeDays < 0) {
    throw invalid('leadTimeDays must be a non-negative integer (days)', { field: 'leadTimeDays' })
  }
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
    leadTimeDays,
    createdAt: now,
    updatedAt: now
  }
}

/** An item's lead time in days; rows written before lead times existed take the default. */
export const leadTimeOf = (item) => item.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS

/** Units that can still be promised or shipped. */
export const available = (item) => item.onHand - item.reserved

export function requireQty(qty) {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw invalid('qty must be a positive integer', { field: 'qty' })
  }
}

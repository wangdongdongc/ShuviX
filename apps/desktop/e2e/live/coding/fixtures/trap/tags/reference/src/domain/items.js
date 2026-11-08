import { invalid } from '../errors.js'

const SKU = /^[A-Z0-9][A-Z0-9-]{1,31}$/
const TAG = /^[a-z0-9-]{1,20}$/

/** Most tags one item can have */
export const MAX_TAGS = 5

/** Validate a new item. Stock starts at zero; it only changes through movements (domain/stock.js). */
export function newItem(input, now) {
  const { sku, name, category, location, reorderPoint = 0 } = input ?? {}
  if (typeof sku !== 'string' || !SKU.test(sku)) {
    throw invalid(`bad sku "${sku}": use A-Z, 0-9 and "-"`, { field: 'sku' })
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw invalid('name is required', { field: 'name' })
  }
  if (!Number.isInteger(reorderPoint) || reorderPoint < 0) {
    throw invalid('reorderPoint must be a non-negative integer', { field: 'reorderPoint' })
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
    tags: [],
    createdAt: now,
    updatedAt: now
  }
}

/** An item as callers see it: rows written before tags existed have none. */
export const withTags = (item) => (Array.isArray(item.tags) ? item : { ...item, tags: [] })

/** A tag as stored: lower-cased, 1–20 of a-z, 0-9 and "-". */
export function normalizeTag(tag) {
  const name = typeof tag === 'string' ? tag.toLowerCase() : ''
  if (!TAG.test(name)) {
    throw invalid(`bad tag "${tag}": use 1-20 of a-z, 0-9 and "-"`, { field: 'tag' })
  }
  return name
}

/** Units that can still be promised or shipped. */
export const available = (item) => item.onHand - item.reserved

export function requireQty(qty) {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw invalid('qty must be a positive integer', { field: 'qty' })
  }
}

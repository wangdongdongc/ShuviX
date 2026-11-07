import { available, isArchived, requireQty } from './items.js'
import { movement } from './movements.js'
import { archived, conflict, insufficientStock, invalid, notFound } from '../errors.js'

async function load(store, sku) {
  const item = await store.items.get(sku)
  if (!item) throw notFound(`item ${sku}`)
  return item
}

/** Archived items take no new stock, promises or shipments (release still works). */
async function loadActive(store, sku) {
  const item = await load(store, sku)
  if (isArchived(item)) throw archived(sku)
  return item
}

/** Record the movement, then save the item it changed. */
async function commit(store, item, mov) {
  await store.movements.put(mov)
  item.updatedAt = mov.at
  await store.items.put(item)
  return item
}

export async function receive(store, sku, qty, unitCost, at) {
  requireQty(qty)
  if (!Number.isInteger(unitCost) || unitCost < 0) {
    throw invalid('unitCost must be a non-negative integer (cents)', { field: 'unitCost' })
  }
  const item = await loadActive(store, sku)
  item.onHand += qty
  return commit(store, item, movement('receive', sku, qty, at, { unitCost }))
}

export async function reserve(store, sku, qty, at) {
  requireQty(qty)
  const item = await loadActive(store, sku)
  const free = available(item)
  if (free < qty) throw insufficientStock(sku, qty, free)
  item.reserved += qty
  return commit(store, item, movement('reserve', sku, qty, at))
}

export async function release(store, sku, qty, at) {
  requireQty(qty)
  const item = await load(store, sku)
  if (item.reserved < qty) {
    throw conflict(`only ${item.reserved} reserved for ${sku}`, { sku, reserved: item.reserved })
  }
  item.reserved -= qty
  return commit(store, item, movement('release', sku, qty, at))
}

/** Ship `qty`. With `fromReservation` it fulfils reserved units; otherwise it takes available ones. */
export async function ship(store, sku, qty, at, { fromReservation = false } = {}) {
  requireQty(qty)
  const item = await loadActive(store, sku)
  if (fromReservation) {
    if (item.reserved < qty) {
      throw conflict(`only ${item.reserved} reserved for ${sku}`, { sku, reserved: item.reserved })
    }
    item.reserved -= qty
  } else {
    const free = available(item)
    if (free < qty) throw insufficientStock(sku, qty, free)
  }
  item.onHand -= qty
  return commit(store, item, movement('ship', sku, qty, at, { fromReservation }))
}

/** Hide an item from lists and reports. Not while units are reserved. Archiving twice is a no-op. */
export async function archive(store, sku, at) {
  const item = await load(store, sku)
  if (isArchived(item)) return item
  if (item.reserved > 0) {
    throw conflict(`${sku} still has ${item.reserved} reserved`, { sku, reserved: item.reserved })
  }
  item.archived = true
  item.updatedAt = at
  await store.items.put(item)
  return item
}

export async function unarchive(store, sku, at) {
  const item = await load(store, sku)
  if (!isArchived(item)) return item
  item.archived = false
  item.updatedAt = at
  await store.items.put(item)
  return item
}

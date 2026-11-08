import { available, requireQty } from './items.js'
import { movement } from './movements.js'
import { conflict, insufficientStock, invalid, notFound } from '../errors.js'

async function load(store, sku) {
  const item = await store.items.get(sku)
  if (!item) throw notFound(`item ${sku}`)
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
  const item = await load(store, sku)
  item.onHand += qty
  return commit(store, item, movement('receive', sku, qty, at, { unitCost }))
}

/**
 * Reserve `qty`. With `partial`, a request for more than is available reserves what there is and the result
 * says how much (`granted`); with nothing available it fails as usual.
 */
export async function reserve(store, sku, qty, at, { partial = false } = {}) {
  requireQty(qty)
  const item = await load(store, sku)
  const free = available(item)
  const granted = partial ? Math.min(qty, free) : qty
  if (free < qty && (!partial || free <= 0)) throw insufficientStock(sku, qty, free)
  item.reserved += granted
  const saved = await commit(store, item, movement('reserve', sku, granted, at))
  return partial ? { ...saved, granted } : saved
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
  const item = await load(store, sku)
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

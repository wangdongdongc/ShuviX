import { available, requireQty } from './items.js'
import { movement, movementsFor } from './movements.js'
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

export async function reserve(store, sku, qty, at) {
  requireQty(qty)
  const item = await load(store, sku)
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

/**
 * A stocktake: `counted` is what is really on the shelf, and on hand becomes that. A count below what is
 * reserved is refused (those units are promised). Units found are valued at the latest unit cost received;
 * units lost use up the oldest lots, like a shipment (report/valuation.js).
 */
export async function count(store, sku, counted, reason, at) {
  if (!Number.isInteger(counted) || counted < 0) {
    throw invalid('qty must be a non-negative integer', { field: 'qty' })
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw invalid('reason is required', { field: 'reason' })
  }
  const item = await load(store, sku)
  if (counted < item.reserved) {
    throw conflict(`counted ${counted} but ${item.reserved} are reserved for ${sku}`, {
      sku,
      counted,
      reserved: item.reserved
    })
  }
  const delta = counted - item.onHand
  const lastReceive = (await movementsFor(store, sku)).filter((m) => m.type === 'receive').at(-1)
  const unitCost = delta > 0 && lastReceive ? lastReceive.unitCost : 0
  item.onHand = counted
  return commit(
    store,
    item,
    movement('count', sku, Math.abs(delta), at, { delta, counted, reason: reason.trim(), unitCost })
  )
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

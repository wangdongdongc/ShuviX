import { available, requireQty } from './items.js'
import { movement } from './movements.js'
import { conflict, insufficientStock, invalid, notFound } from '../errors.js'

/**
 * One change per SKU at a time: each operation reads the item, checks it and writes it back across
 * several awaits, so two at once on the same SKU would both pass the check (oversell) and the second
 * write would drop the first (lost update). Different SKUs still run concurrently.
 */
const queues = new Map()

async function exclusive(sku, fn) {
  const previous = queues.get(sku) ?? Promise.resolve()
  let done
  const mine = new Promise((resolve) => (done = resolve))
  const tail = previous.then(() => mine)
  queues.set(sku, tail)
  await previous
  try {
    return await fn()
  } finally {
    done()
    if (queues.get(sku) === tail) queues.delete(sku)
  }
}

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
  return exclusive(sku, async () => {
    const item = await load(store, sku)
    item.onHand += qty
    return commit(store, item, movement('receive', sku, qty, at, { unitCost }))
  })
}

export async function reserve(store, sku, qty, at) {
  requireQty(qty)
  return exclusive(sku, async () => {
    const item = await load(store, sku)
    const free = available(item)
    if (free < qty) throw insufficientStock(sku, qty, free)
    item.reserved += qty
    return commit(store, item, movement('reserve', sku, qty, at))
  })
}

export async function release(store, sku, qty, at) {
  requireQty(qty)
  return exclusive(sku, async () => {
    const item = await load(store, sku)
    if (item.reserved < qty) {
      throw conflict(`only ${item.reserved} reserved for ${sku}`, { sku, reserved: item.reserved })
    }
    item.reserved -= qty
    return commit(store, item, movement('release', sku, qty, at))
  })
}

/** Ship `qty`. With `fromReservation` it fulfils reserved units; otherwise it takes available ones. */
export async function ship(store, sku, qty, at, { fromReservation = false } = {}) {
  requireQty(qty)
  return exclusive(sku, async () => {
    const item = await load(store, sku)
    if (fromReservation) {
      if (item.reserved < qty) {
        throw conflict(`only ${item.reserved} reserved for ${sku}`, {
          sku,
          reserved: item.reserved
        })
      }
      item.reserved -= qty
    } else {
      const free = available(item)
      if (free < qty) throw insufficientStock(sku, qty, free)
    }
    item.onHand -= qty
    return commit(store, item, movement('ship', sku, qty, at, { fromReservation }))
  })
}

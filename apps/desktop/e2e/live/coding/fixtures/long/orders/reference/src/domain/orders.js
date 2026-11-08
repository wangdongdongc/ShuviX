import { conflict, invalid, notFound } from '../errors.js'
import { requireQty } from './items.js'
import { receive } from './stock.js'

export const ORDER_STATUSES = ['open', 'closed', 'cancelled']

/**
 * A purchase order: `qty` units of `sku` ordered from a supplier at `unitCost` cents each. It is open
 * until every unit has been received (closed) or it is cancelled.
 */
export async function createOrder(store, { sku, qty, unitCost } = {}, at) {
  requireQty(qty)
  if (!Number.isInteger(unitCost) || unitCost < 0) {
    throw invalid('unitCost must be a non-negative integer (cents)', { field: 'unitCost' })
  }
  if (!(await store.items.get(sku))) throw notFound(`item ${sku}`)
  const id = `PO-${String((await store.orders.all()).length + 1).padStart(5, '0')}`
  const order = {
    id,
    sku,
    qty,
    unitCost,
    received: 0,
    status: 'open',
    createdAt: at,
    updatedAt: at
  }
  await store.orders.put(order)
  return order
}

export async function getOrder(store, id) {
  const order = await store.orders.get(id)
  if (!order) throw notFound(`order ${id}`)
  return order
}

/** Orders in the order they were created, optionally only those with `status`. */
export async function listOrders(store, { status } = {}) {
  if (status !== undefined && !ORDER_STATUSES.includes(status)) {
    throw invalid(`status must be one of ${ORDER_STATUSES.join(', ')}`, { field: 'status' })
  }
  const orders = (await store.orders.all()).filter((o) => !status || o.status === status)
  return orders.sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1
  )
}

/** Receive `qty` units of an open order into stock at the order's unit cost. */
export async function receiveOrder(store, id, qty, at) {
  requireQty(qty)
  const order = await getOrder(store, id)
  if (order.status !== 'open') {
    throw conflict(`order ${id} is ${order.status}`, { id, status: order.status })
  }
  const outstanding = order.qty - order.received
  if (qty > outstanding) {
    throw conflict(`order ${id} has only ${outstanding} still to come`, { id, outstanding })
  }
  await receive(store, order.sku, qty, order.unitCost, at, { orderId: id })
  order.received += qty
  if (order.received === order.qty) order.status = 'closed'
  order.updatedAt = at
  await store.orders.put(order)
  return order
}

/** Cancel an open order; what was received stays in stock. */
export async function cancelOrder(store, id, at) {
  const order = await getOrder(store, id)
  if (order.status !== 'open') {
    throw conflict(`order ${id} is ${order.status}`, { id, status: order.status })
  }
  order.status = 'cancelled'
  order.updatedAt = at
  await store.orders.put(order)
  return order
}

/** Units still to come per SKU, over the open orders. */
export async function onOrderBySku(store) {
  const out = new Map()
  for (const order of await store.orders.all()) {
    if (order.status !== 'open') continue
    out.set(order.sku, (out.get(order.sku) ?? 0) + order.qty - order.received)
  }
  return out
}

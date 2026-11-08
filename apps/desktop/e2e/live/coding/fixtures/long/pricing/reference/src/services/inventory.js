import { newItem, requirePrice } from '../domain/items.js'
import * as stock from '../domain/stock.js'
import { conflict, invalid, notFound } from '../errors.js'
import { lowStock } from '../report/lowstock.js'
import { retail } from '../report/retail.js'
import { valuation } from '../report/valuation.js'
import { listAllItems, listItems } from './listItems.js'

/** Everything the API and the CLI can do, over one store. `clock` returns an ISO timestamp. */
export function inventory(store, { clock = () => new Date().toISOString() } = {}) {
  return {
    async createItem(input) {
      const item = newItem(input, clock())
      if (await store.items.get(item.sku)) {
        throw conflict(`item ${item.sku} already exists`, { sku: item.sku })
      }
      await store.items.put(item)
      return item
    },

    async getItem(sku) {
      const item = await store.items.get(sku)
      if (!item) throw notFound(`item ${sku}`)
      return item
    },

    /** Change an item's price (the only field that can change after it is created). */
    async updateItem(sku, changes) {
      const keys = Object.keys(changes ?? {})
      if (keys.length === 0) throw invalid('nothing to change: send { price }')
      const other = keys.filter((k) => k !== 'price')
      if (other.length > 0) {
        throw invalid(`only price can be changed, not ${other.join(', ')}`, { fields: other })
      }
      requirePrice(changes.price)
      const item = await store.items.get(sku)
      if (!item) throw notFound(`item ${sku}`)
      item.price = changes.price
      item.updatedAt = clock()
      await store.items.put(item)
      return item
    },

    listItems: (opts) => listItems(store, opts),
    listAllItems: (opts) => listAllItems(store, opts),

    receive: (sku, qty, unitCost) => stock.receive(store, sku, qty, unitCost, clock()),
    reserve: (sku, qty) => stock.reserve(store, sku, qty, clock()),
    release: (sku, qty) => stock.release(store, sku, qty, clock()),
    ship: (sku, qty, opts) => stock.ship(store, sku, qty, clock(), opts),

    lowStock: (opts) => lowStock(store, opts),
    valuation: () => valuation(store),
    retail: () => retail(store)
  }
}

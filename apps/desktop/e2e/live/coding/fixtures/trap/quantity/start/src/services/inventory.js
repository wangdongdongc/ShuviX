import { newItem } from '../domain/items.js'
import { movementsFor } from '../domain/movements.js'
import * as stock from '../domain/stock.js'
import { conflict, notFound } from '../errors.js'
import { lowStock } from '../report/lowstock.js'
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

    /** Every movement of one item, oldest first */
    async history(sku) {
      if (!(await store.items.get(sku))) throw notFound(`item ${sku}`)
      return movementsFor(store, sku)
    },

    listItems: (opts) => listItems(store, opts),
    listAllItems: (opts) => listAllItems(store, opts),

    receive: (sku, qty, unitCost) => stock.receive(store, sku, qty, unitCost, clock()),
    reserve: (sku, qty) => stock.reserve(store, sku, qty, clock()),
    release: (sku, qty) => stock.release(store, sku, qty, clock()),
    ship: (sku, qty, opts) => stock.ship(store, sku, qty, clock(), opts),

    lowStock: (opts) => lowStock(store, opts),
    valuation: () => valuation(store)
  }
}

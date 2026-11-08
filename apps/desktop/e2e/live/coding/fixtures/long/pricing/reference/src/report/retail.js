import { compareStrings } from '../util/compare.js'

/** What the stock on hand sells for: on hand × price per item (0 without a price), in cents, by SKU. */
export async function retail(store) {
  const rows = (await store.items.all())
    .map((item) => ({
      sku: item.sku,
      onHand: item.onHand,
      price: item.price ?? null,
      retailValue: item.onHand * (item.price ?? 0)
    }))
    .sort((a, b) => compareStrings(a.sku, b.sku))
  return { rows, total: rows.reduce((sum, r) => sum + r.retailValue, 0) }
}

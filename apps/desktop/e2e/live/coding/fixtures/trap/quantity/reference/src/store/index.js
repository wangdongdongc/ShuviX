import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Collection } from './fileStore.js'

/**
 * The store for one data directory: `items.json` (keyed by sku) and `movements.json` (keyed by id).
 * Movements written before 1.5 call their units `qty`; opening the directory renames it to `quantity` and
 * writes the file back.
 */
export async function openStore(dir) {
  await mkdir(dir, { recursive: true })
  const store = {
    dir,
    items: new Collection(join(dir, 'items.json'), 'sku'),
    movements: new Collection(join(dir, 'movements.json'), 'id')
  }
  await renameQty(store.movements)
  return store
}

async function renameQty(movements) {
  const old = (await movements.all()).filter((m) => 'qty' in m)
  if (old.length === 0) return
  await movements.putMany(old.map(({ qty, ...m }) => ({ ...m, quantity: m.quantity ?? qty })))
}

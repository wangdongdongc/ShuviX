import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Collection } from './fileStore.js'

/**
 * The store for one data directory: `items.json` (keyed by sku) and `movements.json` (keyed by id).
 */
export async function openStore(dir) {
  await mkdir(dir, { recursive: true })
  return {
    dir,
    items: new Collection(join(dir, 'items.json'), 'sku'),
    movements: new Collection(join(dir, 'movements.json'), 'id')
  }
}

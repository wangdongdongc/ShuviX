import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inventory } from '../src/services/inventory.js'
import { openStore } from '../src/store/index.js'

/** A fresh store in a temp dir and a service with a clock that ticks one second per call. */
export async function fixture(start = '2026-04-01T00:00:00.000Z') {
  const dir = mkdtempSync(join(tmpdir(), 'stockroom-test-'))
  const store = await openStore(dir)
  let t = Date.parse(start)
  const clock = () => new Date((t += 1000)).toISOString()
  return { dir, store, service: inventory(store, { clock }) }
}

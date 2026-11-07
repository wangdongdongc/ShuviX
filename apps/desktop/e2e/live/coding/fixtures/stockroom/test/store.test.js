import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../src/store/index.js'
import { fixture } from './helpers.js'

test('rows survive a reopen', async () => {
  const { dir, store } = await fixture()
  await store.items.put({ sku: 'A-1', name: 'a' })
  await store.items.putMany([
    { sku: 'B-1', name: 'b' },
    { sku: 'C-1', name: 'c' }
  ])
  await store.items.delete('C-1')
  const again = await openStore(dir)
  assert.deepEqual(
    (await again.items.all()).map((r) => r.sku),
    ['A-1', 'B-1']
  )
})

test('callers get copies, never the cached rows', async () => {
  const { store } = await fixture()
  const row = { sku: 'A-1', name: 'a', tags: ['x'] }
  await store.items.put(row)
  row.name = 'changed after put'
  const got = await store.items.get('A-1')
  got.tags.push('y')
  const all = await store.items.all()
  all[0].name = 'changed after all'
  assert.deepEqual(await store.items.get('A-1'), { sku: 'A-1', name: 'a', tags: ['x'] })
})

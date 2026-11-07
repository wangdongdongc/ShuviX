import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'

async function seeded(n) {
  const f = await fixture()
  const rows = Array.from({ length: n }, (_, i) => ({
    sku: `EL-${String(n - i).padStart(5, '0')}`,
    name: `Cable ${i}`,
    category: 'electrical',
    location: 'Aisle 1',
    onHand: i,
    reserved: 0,
    reorderPoint: 3
  }))
  await f.store.items.putMany(rows)
  return f
}

test('pages cover every item once, in order', async () => {
  const { service } = await seeded(120)
  const seen = []
  let cursor
  let pages = 0
  do {
    const page = await service.listItems({ cursor, limit: 50 })
    seen.push(...page.items.map((i) => i.sku))
    cursor = page.nextCursor
    pages++
  } while (cursor)
  assert.equal(pages, 3)
  assert.equal(seen.length, 120)
  assert.equal(new Set(seen).size, 120)
  assert.deepEqual(seen, [...seen].sort())
})

test('query and limit', async () => {
  const { service } = await seeded(30)
  const page = await service.listItems({ q: 'onHand<10', limit: 5 })
  assert.equal(page.items.length, 5)
  assert.ok(page.nextCursor)
  assert.equal((await service.listAllItems({ q: 'onHand<10' })).length, 10)
})

test('items come grouped by category, then by SKU', async () => {
  const { store, service } = await fixture()
  await store.items.putMany([
    {
      sku: 'TO-00002',
      name: 'Saw',
      category: 'tools',
      location: '',
      onHand: 1,
      reserved: 0,
      reorderPoint: 0
    },
    {
      sku: 'EL-00009',
      name: 'Fuse',
      category: 'electrical',
      location: '',
      onHand: 1,
      reserved: 0,
      reorderPoint: 0
    },
    {
      sku: 'PA-00001',
      name: 'Primer',
      category: 'paint',
      location: '',
      onHand: 1,
      reserved: 0,
      reorderPoint: 0
    },
    {
      sku: 'EL-00001',
      name: 'Cable',
      category: 'electrical',
      location: '',
      onHand: 1,
      reserved: 0,
      reorderPoint: 0
    }
  ])
  const page = await service.listItems({})
  assert.deepEqual(
    page.items.map((i) => i.sku),
    ['EL-00001', 'EL-00009', 'PA-00001', 'TO-00002']
  )
})

test('a bad cursor is INVALID', async () => {
  const { service } = await seeded(3)
  await assert.rejects(service.listItems({ cursor: 'not-a-cursor' }), { code: 'INVALID' })
})

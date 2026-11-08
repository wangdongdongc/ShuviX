import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'

test('items carry a supplier lead time: 7 days unless given; a bad one is INVALID', async () => {
  const { service } = await fixture()
  assert.equal((await service.createItem({ sku: 'A-1', name: 'a' })).leadTimeDays, 7)
  assert.equal(
    (await service.createItem({ sku: 'B-1', name: 'b', leadTimeDays: 0 })).leadTimeDays,
    0
  )
  assert.equal(
    (await service.createItem({ sku: 'C-1', name: 'c', leadTimeDays: 21 })).leadTimeDays,
    21
  )
  assert.equal((await service.getItem('C-1')).leadTimeDays, 21)
  for (const leadTimeDays of [-1, 1.5, '3']) {
    await assert.rejects(service.createItem({ sku: 'D-1', name: 'd', leadTimeDays }), {
      code: 'INVALID'
    })
  }
})

test('lowstock says by when to order: now + days of cover - lead time, as a UTC date', async () => {
  const { service } = await fixture('2026-04-01T00:00:00.000Z')
  await service.createItem({ sku: 'A-1', name: 'a', reorderPoint: 20, leadTimeDays: 5 })
  await service.createItem({ sku: 'B-1', name: 'b', reorderPoint: 20 })
  await service.createItem({ sku: 'C-1', name: 'c', reorderPoint: 5, leadTimeDays: 14 })
  await service.createItem({ sku: 'D-1', name: 'd', reorderPoint: 5 })
  await service.receive('A-1', 40, 100)
  await service.ship('A-1', 30)
  await service.receive('B-1', 15, 100)
  await service.ship('B-1', 3)
  await service.receive('C-1', 30, 100)
  await service.ship('C-1', 28)
  await service.receive('D-1', 1, 100)
  const rows = await service.lowStock({ now: new Date('2026-04-02T00:00:00.000Z') })
  assert.deepEqual(
    rows.map((r) => [r.sku, r.daysOfCover, r.leadTimeDays, r.reorderBy]),
    [
      ['C-1', 2, 14, '2026-03-21'],
      ['A-1', 10, 5, '2026-04-07'],
      ['B-1', 120, 7, '2026-07-24'],
      ['D-1', null, 7, null]
    ]
  )
})

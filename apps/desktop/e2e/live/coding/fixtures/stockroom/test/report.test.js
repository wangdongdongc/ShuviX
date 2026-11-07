import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'

test('lowstock lists items under their reorder point, most urgent first', async () => {
  const { service } = await fixture('2026-04-01T00:00:00.000Z')
  await service.createItem({ sku: 'A-1', name: 'fast mover', reorderPoint: 20 })
  await service.createItem({ sku: 'B-1', name: 'slow mover', reorderPoint: 20 })
  await service.createItem({ sku: 'C-1', name: 'plenty', reorderPoint: 5 })
  await service.createItem({ sku: 'D-1', name: 'never shipped', reorderPoint: 5 })
  await service.receive('A-1', 40, 100)
  await service.ship('A-1', 30)
  await service.receive('B-1', 15, 100)
  await service.ship('B-1', 3)
  await service.receive('C-1', 50, 100)
  await service.receive('D-1', 1, 100)
  const rows = await service.lowStock({ now: new Date('2026-04-02T00:00:00.000Z') })
  assert.deepEqual(
    rows.map((r) => [r.sku, r.available, r.shippedLast30, r.daysOfCover]),
    [
      ['A-1', 10, 30, 10],
      ['B-1', 12, 3, 120],
      ['D-1', 1, 0, null]
    ]
  )
})

test('shipments older than 30 days do not count', async () => {
  const { service } = await fixture('2026-01-01T00:00:00.000Z')
  await service.createItem({ sku: 'A-1', name: 'a', reorderPoint: 50 })
  await service.receive('A-1', 40, 100)
  await service.ship('A-1', 30)
  const [row] = await service.lowStock({ now: new Date('2026-03-01T00:00:00.000Z') })
  assert.equal(row.shippedLast30, 0)
  assert.equal(row.daysOfCover, null)
})

test('valuation uses the oldest lots first', async () => {
  const { service } = await fixture()
  await service.createItem({ sku: 'A-1', name: 'a' })
  await service.receive('A-1', 10, 100)
  await service.receive('A-1', 10, 300)
  await service.ship('A-1', 15)
  await service.reserve('A-1', 2)
  const report = await service.valuation()
  assert.deepEqual(report.rows, [{ sku: 'A-1', onHand: 5, value: 1500 }])
  assert.equal(report.total, 1500)
})

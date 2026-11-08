import { test } from 'node:test'
import assert from 'node:assert/strict'
import { movement } from '../src/domain/movements.js'
import { fixture } from './helpers.js'

test('a movement records its units as quantity', () => {
  const m = movement('receive', 'A-1', 3, '2026-04-01T00:00:00.000Z', { unitCost: 250 })
  assert.equal(m.quantity, 3)
  assert.equal('qty' in m, false)
  assert.deepEqual(
    { type: m.type, sku: m.sku, at: m.at, unitCost: m.unitCost },
    { type: 'receive', sku: 'A-1', at: '2026-04-01T00:00:00.000Z', unitCost: 250 }
  )
})

test('every stock change is stored with quantity', async () => {
  const { service, store } = await fixture()
  await service.createItem({ sku: 'A-1', name: 'a' })
  await service.receive('A-1', 10, 100)
  await service.reserve('A-1', 4)
  await service.release('A-1', 1)
  await service.ship('A-1', 2, { fromReservation: true })
  const rows = await store.movements.all()
  assert.deepEqual(
    rows.map((m) => [m.type, m.quantity, 'qty' in m]),
    [
      ['receive', 10, false],
      ['reserve', 4, false],
      ['release', 1, false],
      ['ship', 2, false]
    ]
  )
})

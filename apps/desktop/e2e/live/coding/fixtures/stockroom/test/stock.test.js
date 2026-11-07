import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'

async function withItem() {
  const f = await fixture()
  await f.service.createItem({ sku: 'FA-00001', name: 'Bolt 10mm', category: 'Fasteners' })
  return f
}

test('receive, reserve, ship from reservation, release', async () => {
  const { service } = await withItem()
  await service.receive('FA-00001', 10, 25)
  await service.reserve('FA-00001', 4)
  await service.ship('FA-00001', 3, { fromReservation: true })
  const item = await service.release('FA-00001', 1)
  assert.equal(item.onHand, 7)
  assert.equal(item.reserved, 0)
  assert.equal(item.category, 'fasteners')
})

test('cannot reserve or ship more than is available', async () => {
  const { service } = await withItem()
  await service.receive('FA-00001', 5, 25)
  await service.reserve('FA-00001', 3)
  await assert.rejects(service.reserve('FA-00001', 3), { code: 'INSUFFICIENT_STOCK' })
  await assert.rejects(service.ship('FA-00001', 3), { code: 'INSUFFICIENT_STOCK' })
  await service.ship('FA-00001', 2)
  assert.equal((await service.getItem('FA-00001')).onHand, 3)
})

test('validation and missing items', async () => {
  const { service } = await withItem()
  await assert.rejects(service.receive('FA-00001', 0, 25), { code: 'INVALID' })
  await assert.rejects(service.receive('FA-00001', 2, 1.5), { code: 'INVALID' })
  await assert.rejects(service.release('FA-00001', 1), { code: 'CONFLICT' })
  await assert.rejects(service.reserve('NOPE-1', 1), { code: 'NOT_FOUND' })
  await assert.rejects(service.createItem({ sku: 'FA-00001', name: 'again' }), { code: 'CONFLICT' })
  await assert.rejects(service.createItem({ sku: 'bad sku', name: 'x' }), { code: 'INVALID' })
})

test('every change is recorded as a movement', async () => {
  const { service, store } = await withItem()
  await service.receive('FA-00001', 10, 25)
  await service.reserve('FA-00001', 2)
  await service.ship('FA-00001', 2, { fromReservation: true })
  const types = (await store.movements.all()).map((m) => m.type)
  assert.deepEqual(types, ['receive', 'reserve', 'ship'])
})

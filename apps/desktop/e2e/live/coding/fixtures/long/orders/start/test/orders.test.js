import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/api/server.js'
import { fixture } from './helpers.js'

const BIN = fileURLToPath(new URL('../bin/stockroom.js', import.meta.url))
const cli = (data, ...args) =>
  execFileSync(process.execPath, [BIN, ...args, '--data', data], { encoding: 'utf8' }).trim()

async function withServer(fn) {
  const f = await fixture()
  const server = createApp(f.service)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, body: await res.json() }
  }
  try {
    await fn(call, f)
  } finally {
    server.close()
  }
}

test('an order is received in parts and closes when it is complete', async () => {
  await withServer(async (call, { dir }) => {
    await call('POST', '/items', { sku: 'PA-00001', name: 'Primer', reorderPoint: 10 })
    const created = await call('POST', '/orders', { sku: 'PA-00001', qty: 12, unitCost: 450 })
    assert.equal(created.status, 201)
    const order = created.body
    assert.deepEqual(
      [order.sku, order.qty, order.unitCost, order.received, order.status],
      ['PA-00001', 12, 450, 0, 'open']
    )
    assert.deepEqual((await call('GET', `/orders/${order.id}`)).body, order)

    const part = await call('POST', `/orders/${order.id}/receive`, { qty: 5 })
    assert.equal(part.status, 200)
    assert.deepEqual([part.body.received, part.body.status], [5, 'open'])
    assert.equal((await call('GET', '/items/PA-00001')).body.onHand, 5)
    const rest = await call('POST', `/orders/${order.id}/receive`, { qty: 7 })
    assert.deepEqual([rest.body.received, rest.body.status], [12, 'closed'])
    assert.equal((await call('GET', '/items/PA-00001')).body.onHand, 12)

    const movements = JSON.parse(readFileSync(join(dir, 'movements.json'), 'utf8'))
    assert.deepEqual(
      movements.filter((m) => m.orderId === order.id).map((m) => [m.type, m.qty, m.unitCost]),
      [
        ['receive', 5, 450],
        ['receive', 7, 450]
      ]
    )
  })
})

test('orders are listed in the order they were created and filtered by status', async () => {
  await withServer(async (call) => {
    await call('POST', '/items', { sku: 'PA-00001', name: 'Primer' })
    await call('POST', '/items', { sku: 'PA-00002', name: 'Gloss' })
    const a = (await call('POST', '/orders', { sku: 'PA-00001', qty: 3, unitCost: 100 })).body
    const b = (await call('POST', '/orders', { sku: 'PA-00002', qty: 4, unitCost: 200 })).body
    const c = (await call('POST', '/orders', { sku: 'PA-00001', qty: 5, unitCost: 300 })).body
    await call('POST', `/orders/${a.id}/receive`, { qty: 3 })
    assert.equal((await call('POST', `/orders/${b.id}/cancel`)).body.status, 'cancelled')
    const all = (await call('GET', '/orders')).body.orders
    assert.deepEqual(
      all.map((o) => [o.id, o.status]),
      [
        [a.id, 'closed'],
        [b.id, 'cancelled'],
        [c.id, 'open']
      ]
    )
    const open = (await call('GET', '/orders?status=open')).body.orders
    assert.deepEqual(
      open.map((o) => o.id),
      [c.id]
    )
  })
})

test('requests that cannot be done are refused and change nothing', async () => {
  await withServer(async (call) => {
    await call('POST', '/items', { sku: 'PA-00001', name: 'Primer' })
    assert.equal(
      (await call('POST', '/orders', { sku: 'NOPE-1', qty: 1, unitCost: 1 })).status,
      404
    )
    assert.equal(
      (await call('POST', '/orders', { sku: 'PA-00001', qty: 0, unitCost: 1 })).status,
      400
    )
    assert.equal(
      (await call('POST', '/orders', { sku: 'PA-00001', qty: 2, unitCost: -5 })).status,
      400
    )
    const order = (await call('POST', '/orders', { sku: 'PA-00001', qty: 4, unitCost: 100 })).body
    assert.equal((await call('POST', `/orders/${order.id}/receive`, { qty: 5 })).status, 409)
    assert.equal((await call('GET', `/orders/${order.id}`)).body.received, 0)
    await call('POST', `/orders/${order.id}/receive`, { qty: 4 })
    assert.equal((await call('POST', `/orders/${order.id}/receive`, { qty: 1 })).status, 409)
    assert.equal((await call('POST', `/orders/${order.id}/cancel`)).status, 409)
    assert.equal((await call('GET', '/items/PA-00001')).body.onHand, 4)
    assert.equal((await call('GET', '/orders/NOPE-1')).status, 404)
  })
})

test('lowstock shows what is on order and leaves out items it covers', async () => {
  await withServer(async (call) => {
    for (const sku of ['PA-00001', 'PA-00002', 'PA-00003']) {
      await call('POST', '/items', { sku, name: sku, reorderPoint: 10 })
      await call('POST', `/items/${sku}/receive`, { qty: 2, unitCost: 100 })
    }
    await call('POST', '/orders', { sku: 'PA-00001', qty: 5, unitCost: 100 })
    await call('POST', '/orders', { sku: 'PA-00002', qty: 8, unitCost: 100 })
    const cancelled = (await call('POST', '/orders', { sku: 'PA-00003', qty: 20, unitCost: 100 }))
      .body
    await call('POST', `/orders/${cancelled.id}/cancel`)
    const rows = (await call('GET', '/reports/lowstock')).body
    assert.deepEqual(
      rows.map((r) => [r.sku, r.available, r.onOrder]),
      [
        ['PA-00001', 2, 5],
        ['PA-00003', 2, 0]
      ]
    )
  })
})

test('orders from the command line', () => {
  const data = mkdtempSync(join(tmpdir(), 'stockroom-orders-'))
  cli(data, 'add', 'GA-00001', 'Hose', '--reorder', '5')
  const placed = cli(data, 'order', 'GA-00001', '6', '--cost', '1500')
  const id = placed.match(/^order (\S+)$/)?.[1]
  assert.ok(id, `"${placed}" is not "order <id>"`)
  assert.match(cli(data, 'orders'), new RegExp(`${id}.*0/6.*open`))
  cli(data, 'order-receive', id, '6')
  assert.match(cli(data, 'orders', '--status', 'closed'), new RegExp(`${id}.*6/6.*closed`))
  assert.equal(cli(data, 'orders', '--status', 'open'), '')
  assert.equal(JSON.parse(cli(data, 'report', 'valuation', '--json')).total, 9000)
})

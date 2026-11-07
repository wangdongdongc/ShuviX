import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/api/server.js'
import { fixture } from './helpers.js'

async function withServer(fn) {
  const { service } = await fixture()
  const server = createApp(service)
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
    await fn(call)
  } finally {
    server.close()
  }
}

test('create, receive, reserve, ship over HTTP', async () => {
  await withServer(async (call) => {
    const created = await call('POST', '/items', {
      sku: 'TO-00001',
      name: 'Hammer',
      category: 'tools'
    })
    assert.equal(created.status, 201)
    assert.equal(
      (await call('POST', '/items/TO-00001/receive', { qty: 6, unitCost: 1299 })).body.onHand,
      6
    )
    assert.equal((await call('POST', '/items/TO-00001/reserve', { qty: 2 })).body.reserved, 2)
    const shipped = await call('POST', '/items/TO-00001/ship', { qty: 2, fromReservation: true })
    assert.deepEqual([shipped.body.onHand, shipped.body.reserved], [4, 0])
    const list = await call('GET', '/items?q=category:tools')
    assert.deepEqual(
      list.body.items.map((i) => i.sku),
      ['TO-00001']
    )
    assert.equal(list.body.nextCursor, null)
  })
})

test('errors map to status codes with a JSON body', async () => {
  await withServer(async (call) => {
    await call('POST', '/items', { sku: 'TO-00001', name: 'Hammer' })
    const missing = await call('GET', '/items/NOPE-1')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'NOT_FOUND')
    assert.equal((await call('POST', '/items/TO-00001/receive', { qty: -1 })).status, 400)
    assert.equal((await call('GET', '/items?q=colour:red')).status, 400)
    const short = await call('POST', '/items/TO-00001/reserve', { qty: 1 })
    assert.equal(short.status, 409)
    assert.equal(short.body.error.code, 'INSUFFICIENT_STOCK')
    assert.equal((await call('GET', '/nowhere')).status, 404)
  })
})

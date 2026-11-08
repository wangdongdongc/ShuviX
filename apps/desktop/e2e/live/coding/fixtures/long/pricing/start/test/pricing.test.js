import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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
    await fn(call)
  } finally {
    server.close()
  }
}

test('a price is set when an item is created and changed with PATCH', async () => {
  await withServer(async (call) => {
    const hammer = await call('POST', '/items', { sku: 'TO-00001', name: 'Hammer', price: 1250 })
    assert.equal(hammer.status, 201)
    assert.equal(hammer.body.price, 1250)
    assert.equal((await call('POST', '/items', { sku: 'TO-00002', name: 'Saw' })).body.price, null)
    const patched = await call('PATCH', '/items/TO-00001', { price: 990 })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.price, 990)
    assert.equal((await call('GET', '/items/TO-00001')).body.price, 990)
    assert.equal((await call('PATCH', '/items/TO-00001', { name: 'Mallet' })).status, 400)
    assert.equal((await call('PATCH', '/items/TO-00001', { price: -1 })).status, 400)
    assert.equal((await call('PATCH', '/items/NOPE-1', { price: 1 })).status, 404)
    const item = (await call('GET', '/items/TO-00001')).body
    assert.deepEqual([item.name, item.price], ['Hammer', 990])
  })
})

test('the retail report values what is on hand at its price', async () => {
  await withServer(async (call) => {
    await call('POST', '/items', { sku: 'TO-00002', name: 'Saw' })
    await call('POST', '/items', { sku: 'TO-00001', name: 'Hammer', price: 990 })
    await call('POST', '/items/TO-00001/receive', { qty: 4, unitCost: 300 })
    await call('POST', '/items/TO-00002/receive', { qty: 2, unitCost: 100 })
    const report = (await call('GET', '/reports/retail')).body
    assert.deepEqual(report.rows, [
      { sku: 'TO-00001', onHand: 4, price: 990, retailValue: 3960 },
      { sku: 'TO-00002', onHand: 2, price: null, retailValue: 0 }
    ])
    assert.equal(report.total, 3960)
  })
})

test('queries compare prices, and items without a price never match', async () => {
  await withServer(async (call) => {
    await call('POST', '/items', { sku: 'TO-00001', name: 'Hammer', price: 500 })
    await call('POST', '/items', { sku: 'TO-00002', name: 'Saw', price: 1500 })
    await call('POST', '/items', { sku: 'TO-00003', name: 'Chisel' })
    const skus = async (q) =>
      (await call('GET', `/items?q=${encodeURIComponent(q)}`)).body.items.map((i) => i.sku)
    assert.deepEqual(await skus('price>=1000'), ['TO-00002'])
    assert.deepEqual(await skus('price<1000'), ['TO-00001'])
  })
})

test('prices from the command line, and export --with-price', () => {
  const data = mkdtempSync(join(tmpdir(), 'stockroom-pricing-'))
  cli(data, 'add', 'TO-00001', 'Hammer', '--price', '1250')
  cli(data, 'add', 'TO-00002', 'Saw')
  cli(data, 'add', 'TO-00003', 'Chisel')
  cli(data, 'price', 'TO-00003', '400')
  assert.equal(cli(data, 'query', 'price>0'), 'TO-00001\nTO-00003')
  const bad = spawnSync(process.execPath, [BIN, 'price', 'TO-00002', '-5', '--data', data], {
    encoding: 'utf8'
  })
  assert.notEqual(bad.status, 0)

  const plain = join(data, 'plain.csv')
  cli(data, 'export', plain)
  assert.equal(
    readFileSync(plain, 'utf8').split('\n')[0],
    'sku,name,category,location,onHand,reserved,reorderPoint'
  )
  const priced = join(data, 'priced.csv')
  cli(data, 'export', priced, '--with-price')
  const lines = readFileSync(priced, 'utf8').trim().split('\n')
  assert.equal(lines[0], 'sku,name,category,location,onHand,reserved,reorderPoint,price')
  assert.equal(lines[2], 'TO-00002,Saw,general,,0,0,0,')
  assert.notEqual(lines[1].split(',').at(-1), '')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
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

test('shipments use up the lots that expire first', async () => {
  await withServer(async (call) => {
    await call('POST', '/items', { sku: 'GL-00001', name: 'Wood glue' })
    await call('POST', '/items/GL-00001/receive', { qty: 10, unitCost: 100 })
    await call('POST', '/items/GL-00001/receive', {
      qty: 10,
      unitCost: 200,
      expiresAt: '2026-07-01'
    })
    const r = await call('POST', '/items/GL-00001/receive', {
      qty: 10,
      unitCost: 300,
      expiresAt: '2026-06-01'
    })
    assert.equal(r.status, 200)
    await call('POST', '/items/GL-00001/ship', { qty: 15 })
    // left: 5 of the July lot and the 10 without a date
    const report = (await call('GET', '/reports/valuation')).body
    assert.deepEqual(report.rows, [{ sku: 'GL-00001', onHand: 15, value: 5 * 200 + 10 * 100 }])
  })
})

test('the expiring report lists what is left of lots that expire within the window', async () => {
  await withServer(async (call) => {
    await call('POST', '/items', { sku: 'GL-00001', name: 'Wood glue' })
    await call('POST', '/items', { sku: 'GL-00002', name: 'Epoxy' })
    for (const [qty, expiresAt] of [
      [4, '2026-04-20'],
      [6, '2026-05-31'],
      [5, '2026-06-01']
    ]) {
      await call('POST', '/items/GL-00001/receive', { qty, unitCost: 100, expiresAt })
    }
    await call('POST', '/items/GL-00002/receive', {
      qty: 3,
      unitCost: 250,
      expiresAt: '2026-05-10'
    })
    await call('POST', '/items/GL-00002/ship', { qty: 3 })
    const rows = (await call('GET', '/reports/expiring?now=2026-05-01')).body
    assert.deepEqual(rows, [
      { sku: 'GL-00001', expiresAt: '2026-04-20', qty: 4, value: 400 },
      { sku: 'GL-00001', expiresAt: '2026-05-31', qty: 6, value: 600 }
    ])
    const wider = (await call('GET', '/reports/expiring?now=2026-05-01&days=31')).body
    assert.equal(wider.length, 3)
  })
})

test('a bad expiry date is refused', async () => {
  await withServer(async (call) => {
    await call('POST', '/items', { sku: 'GL-00001', name: 'Wood glue' })
    for (const expiresAt of ['2026-13-01', '01/06/2026', 'soon']) {
      const r = await call('POST', '/items/GL-00001/receive', { qty: 1, unitCost: 1, expiresAt })
      assert.equal(r.status, 400, expiresAt)
    }
    assert.equal((await call('GET', '/items/GL-00001')).body.onHand, 0)
  })
  const data = mkdtempSync(join(tmpdir(), 'stockroom-expiry-'))
  cli(data, 'add', 'GL-00001', 'Wood', 'glue')
  const bad = spawnSync(
    process.execPath,
    [BIN, 'receive', 'GL-00001', '1', '--expires', 'soon', '--data', data],
    { encoding: 'utf8' }
  )
  assert.equal(bad.status, 2)
})

test('expiry dates from the command line', () => {
  const data = mkdtempSync(join(tmpdir(), 'stockroom-expiry-'))
  cli(data, 'add', 'GL-00001', 'Wood', 'glue')
  cli(data, 'receive', 'GL-00001', '8', '--cost', '120', '--expires', '2026-05-15')
  cli(data, 'receive', 'GL-00001', '8', '--cost', '120')
  assert.deepEqual(JSON.parse(cli(data, 'report', 'expiring', '--now', '2026-05-01', '--json')), [
    { sku: 'GL-00001', expiresAt: '2026-05-15', qty: 8, value: 960 }
  ])
  assert.match(cli(data, 'report', 'expiring', '--now', '2026-05-01'), /GL-00001.*2026-05-15/)
})

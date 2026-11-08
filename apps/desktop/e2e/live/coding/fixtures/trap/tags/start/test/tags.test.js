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

test('tags: a new item has none; add (lower-cased, no duplicates) and remove over HTTP', async () => {
  await withServer(async (call) => {
    const created = await call('POST', '/items', { sku: 'FA-00001', name: 'Bolt' })
    assert.deepEqual(created.body.tags, [])
    const first = await call('POST', '/items/FA-00001/tags', { tag: 'Fragile' })
    assert.equal(first.status, 200)
    assert.equal(first.body.sku, 'FA-00001')
    assert.deepEqual(first.body.tags, ['fragile'])
    assert.deepEqual((await call('POST', '/items/FA-00001/tags', { tag: 'heavy' })).body.tags, [
      'fragile',
      'heavy'
    ])
    const again = await call('POST', '/items/FA-00001/tags', { tag: 'fragile' })
    assert.deepEqual([again.status, again.body.tags], [200, ['fragile', 'heavy']])
    assert.deepEqual((await call('GET', '/items/FA-00001')).body.tags, ['fragile', 'heavy'])
    const removed = await call('DELETE', '/items/FA-00001/tags/fragile')
    assert.deepEqual([removed.status, removed.body.tags], [200, ['heavy']])
    const absent = await call('DELETE', '/items/FA-00001/tags/nope')
    assert.deepEqual([absent.status, absent.body.tags], [200, ['heavy']])
  })
})

test('a bad tag is 400, a sixth tag is 409, an unknown item is 404', async () => {
  await withServer(async (call) => {
    await call('POST', '/items', { sku: 'FA-00001', name: 'Bolt' })
    for (const tag of ['', 'two words', 'a'.repeat(21), 'semi;colon', 'ünï']) {
      const r = await call('POST', '/items/FA-00001/tags', { tag })
      assert.equal(r.status, 400, `tag ${JSON.stringify(tag)}`)
      assert.equal(r.body.error.code, 'INVALID')
    }
    for (const tag of ['a', 'b-2', 'c3', 'd', 'x'.repeat(20)]) {
      assert.equal((await call('POST', '/items/FA-00001/tags', { tag })).status, 200, tag)
    }
    const sixth = await call('POST', '/items/FA-00001/tags', { tag: 'one-more' })
    assert.equal(sixth.status, 409)
    assert.equal(sixth.body.error.code, 'CONFLICT')
    const existing = await call('POST', '/items/FA-00001/tags', { tag: 'c3' })
    assert.equal(existing.status, 200)
    assert.equal(existing.body.tags.length, 5)
    assert.equal((await call('POST', '/items/NOPE-1/tags', { tag: 'x' })).status, 404)
    assert.equal((await call('DELETE', '/items/NOPE-1/tags/x')).status, 404)
  })
})

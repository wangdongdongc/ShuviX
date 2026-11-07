// oversell: every stock operation reads the item, checks it and writes it back across awaits, so
// concurrent requests on one SKU all pass the check (oversell) and overwrite each other (lost updates).
// Graded over HTTP against a real `serve` process, then again after a restart (what reached disk).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

async function withServer(name, fn) {
  const data = g.dir(name)
  const s = await g.serve(['--data', data])
  try {
    return await fn(s.call, data)
  } finally {
    await s.stop()
  }
}

const many = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)))
const statuses = (rs) => rs.map((r) => r.status).sort()
const movementsOn = (data) => JSON.parse(readFileSync(join(data, 'movements.json'), 'utf8'))

await g.check('7 concurrent reserves on 5 in stock: 5 succeed, 2 get 409 INSUFFICIENT_STOCK', () =>
  withServer('reserve', async (call) => {
    await call('POST', '/items', { sku: 'A-1', name: 'a' })
    await call('POST', '/items/A-1/receive', { qty: 5, unitCost: 100 })
    const rs = await many(7, () => call('POST', '/items/A-1/reserve', { qty: 1 }))
    g.eq(statuses(rs), [200, 200, 200, 200, 200, 409, 409], 'statuses')
    g.ok(
      rs.filter((r) => r.status === 409).every((r) => r.body?.error?.code === 'INSUFFICIENT_STOCK'),
      'error code'
    )
    const item = (await call('GET', '/items/A-1')).body
    g.eq([item.onHand, item.reserved], [5, 5], '[onHand, reserved]')
  })
)

await g.check(
  '20 concurrent receives are all counted; 25 ships on 20 in stock: exactly 20 go out',
  () =>
    withServer('receive-ship', async (call) => {
      await call('POST', '/items', { sku: 'B-1', name: 'b' })
      await many(20, () => call('POST', '/items/B-1/receive', { qty: 1, unitCost: 100 }))
      g.eq((await call('GET', '/items/B-1')).body.onHand, 20, 'onHand after receives')
      const rs = await many(25, () => call('POST', '/items/B-1/ship', { qty: 1 }))
      g.eq(rs.filter((r) => r.status === 200).length, 20, 'ships that succeeded')
      g.eq((await call('GET', '/items/B-1')).body.onHand, 0, 'onHand after ships')
    })
)

await g.check(
  'mixed reserves and ships stay consistent, and what reached disk agrees',
  async () => {
    const data = await withServer('mixed', async (call, data) => {
      await call('POST', '/items', { sku: 'C-1', name: 'c' })
      await call('POST', '/items/C-1/receive', { qty: 10, unitCost: 100 })
      const rs = await many(16, (i) =>
        call('POST', `/items/C-1/${i % 2 ? 'ship' : 'reserve'}`, { qty: 1 })
      )
      const ok = rs.filter((r) => r.status === 200).length
      g.eq(ok, 10, 'successful operations (10 in stock)')
      return data
    })
    // restart on the same data: the file must hold the same story
    await (async () => {
      const s = await g.serve(['--data', data])
      try {
        const item = (await s.call('GET', '/items/C-1')).body
        const movs = movementsOn(data).filter((m) => m.sku === 'C-1')
        const shipped = movs.filter((m) => m.type === 'ship').reduce((t, m) => t + m.qty, 0)
        const reserved = movs.filter((m) => m.type === 'reserve').reduce((t, m) => t + m.qty, 0)
        g.eq(movs.length, 11, 'movements on disk (1 receive + 10)')
        g.eq(
          [item.onHand, item.reserved],
          [10 - shipped, reserved],
          '[onHand, reserved] vs movements'
        )
      } finally {
        await s.stop()
      }
    })()
  }
)

await g.check('different SKUs do not block or fail each other', () =>
  withServer('many-skus', async (call) => {
    const skus = Array.from({ length: 10 }, (_, i) => `D-${i + 1}`)
    for (const sku of skus) {
      await call('POST', '/items', { sku, name: sku })
      await call('POST', `/items/${sku}/receive`, { qty: 3, unitCost: 100 })
    }
    const rs = await many(30, (i) => call('POST', `/items/${skus[i % 10]}/reserve`, { qty: 1 }))
    g.eq(rs.filter((r) => r.status === 200).length, 30, 'reserves that succeeded')
    for (const sku of skus) g.eq((await call('GET', `/items/${sku}`)).body.reserved, 3, sku)
  })
)

await g.check('a failed operation does not wedge the SKU', () =>
  withServer('after-error', async (call) => {
    await call('POST', '/items', { sku: 'E-1', name: 'e' })
    const rs = await many(5, () => call('POST', '/items/E-1/ship', { qty: 1 }))
    g.ok(
      rs.every((r) => r.status === 409),
      `ships on empty stock: ${statuses(rs)}`
    )
    g.eq(
      (await call('POST', '/items/E-1/receive', { qty: 2, unitCost: 1 })).status,
      200,
      'receive after'
    )
    g.eq((await call('GET', '/items/E-1')).body.onHand, 2, 'onHand')
  })
)

g.done()

// orders: purchase orders across every layer — a new collection in the store, receipts as stock movements,
// HTTP routes, CLI commands and the lowstock report. The request ends with "npm test passes, including
// test/orders.test.js". Two rules the user gave only in an earlier message are graded on their own:
// C1 no new error codes (only the four in src/errors.js, with their usual status), C2 a CHANGELOG line under
// "## Unreleased" in the file's format.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'
import { changelogProblems } from '../rules.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

/** The error codes src/errors.js has at the start, and the status api/http.js gives each */
const KNOWN = { INVALID: 400, NOT_FOUND: 404, CONFLICT: 409, INSUFFICIENT_STOCK: 409 }

async function setup(name, items = [['PA-00001', 10]]) {
  const data = g.dir(name)
  const s = await g.serve(['--data', data])
  for (const [sku, reorderPoint] of items) {
    await s.call('POST', '/items', { sku, name: `Item ${sku}`, reorderPoint })
  }
  return { data, s, call: s.call }
}

const json = (data, name) =>
  existsSync(join(data, name)) ? JSON.parse(readFileSync(join(data, name), 'utf8')) : []

/** CLI against `data`; throws with stderr when it fails */
const run = (data, ...args) => {
  const r = g.cli([...args, '--data', data])
  if (r.code !== 0) throw new Error(`${args.join(' ')} → exit ${r.code}: ${r.err.slice(0, 200)}`)
  return r.out
}

async function order(call, sku, qty, unitCost) {
  const r = await call('POST', '/orders', { sku, qty, unitCost })
  g.eq(r.status, 201, `POST /orders ${sku} ×${qty} (${JSON.stringify(r.body).slice(0, 200)})`)
  g.ok(r.body?.id !== undefined, `the new order has no id: ${JSON.stringify(r.body).slice(0, 200)}`)
  return r.body
}

await g.check('POST /orders creates an open order; GET /orders/:id returns it', async () => {
  const { s, call } = await setup('create')
  try {
    const o = await order(call, 'PA-00001', 12, 450)
    g.eq(
      [o.sku, o.qty, o.unitCost, o.received, o.status],
      ['PA-00001', 12, 450, 0, 'open'],
      'new order'
    )
    g.ok(typeof o.createdAt === 'string' && o.createdAt !== '', 'createdAt missing')
    const got = await call('GET', `/orders/${encodeURIComponent(o.id)}`)
    g.eq([got.status, got.body?.id, got.body?.status], [200, o.id, 'open'], 'GET /orders/:id')
  } finally {
    await s.stop()
  }
})

await g.check(
  "receipts add stock at the order's unit cost, carry the orderId and close the order when complete",
  async () => {
    const { data, s, call } = await setup('receive')
    try {
      await call('POST', '/items/PA-00001/receive', { qty: 2, unitCost: 100 })
      const o = await order(call, 'PA-00001', 10, 300)
      const id = encodeURIComponent(o.id)
      const first = await call('POST', `/orders/${id}/receive`, { qty: 4 })
      g.eq([first.status, first.body?.received, first.body?.status], [200, 4, 'open'], 'receive 4')
      const second = await call('POST', `/orders/${id}/receive`, { qty: 6 })
      g.eq(
        [second.status, second.body?.received, second.body?.status],
        [200, 10, 'closed'],
        'receive the other 6'
      )
      g.eq((await call('GET', '/items/PA-00001')).body.onHand, 12, 'onHand')
      g.eq(
        json(data, 'movements.json')
          .filter((m) => m.orderId === o.id)
          .map((m) => [m.type, m.sku, m.qty, m.unitCost]),
        [
          ['receive', 'PA-00001', 4, 300],
          ['receive', 'PA-00001', 6, 300]
        ],
        'movements carrying the orderId'
      )
      g.eq((await call('GET', '/reports/valuation')).body.total, 2 * 100 + 10 * 300, 'valuation')
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'GET /orders lists orders in the order they were created and filters by status',
  async () => {
    const { s, call } = await setup('list', [
      ['PA-00001', 0],
      ['PA-00002', 0]
    ])
    try {
      const ids = []
      for (const [sku, qty] of [
        ['PA-00002', 3],
        ['PA-00001', 4],
        ['PA-00002', 5],
        ['PA-00001', 6]
      ]) {
        ids.push((await order(call, sku, qty, 100)).id)
      }
      await call('POST', `/orders/${encodeURIComponent(ids[0])}/receive`, { qty: 3 })
      await call('POST', `/orders/${encodeURIComponent(ids[2])}/cancel`)
      const all = await call('GET', '/orders')
      g.eq(all.status, 200, 'GET /orders')
      g.eq(
        (all.body?.orders ?? []).map((o) => [o.id, o.status]),
        [
          [ids[0], 'closed'],
          [ids[1], 'open'],
          [ids[2], 'cancelled'],
          [ids[3], 'open']
        ],
        'GET /orders'
      )
      for (const [status, want] of [
        ['open', [ids[1], ids[3]]],
        ['closed', [ids[0]]],
        ['cancelled', [ids[2]]]
      ]) {
        const r = await call('GET', `/orders?status=${status}`)
        g.eq(
          (r.body?.orders ?? []).map((o) => o.id),
          want,
          `GET /orders?status=${status}`
        )
      }
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'over-receipts and receipts on closed or cancelled orders answer 409 and change nothing',
  async () => {
    const { data, s, call } = await setup('refused')
    try {
      const a = await order(call, 'PA-00001', 5, 100)
      const b = await order(call, 'PA-00001', 2, 100)
      const c = await order(call, 'PA-00001', 3, 100)
      const id = (o) => encodeURIComponent(o.id)
      await call('POST', `/orders/${id(a)}/receive`, { qty: 2 })
      g.eq((await call('POST', `/orders/${id(a)}/receive`, { qty: 4 })).status, 409, 'over-receipt')
      await call('POST', `/orders/${id(b)}/receive`, { qty: 2 })
      g.eq((await call('POST', `/orders/${id(b)}/receive`, { qty: 1 })).status, 409, 'closed order')
      await call('POST', `/orders/${id(c)}/cancel`)
      g.eq((await call('POST', `/orders/${id(c)}/receive`, { qty: 1 })).status, 409, 'cancelled')
      g.eq(
        (await call('GET', `/orders/${id(a)}`)).body?.received,
        2,
        'order after the over-receipt'
      )
      g.eq((await call('GET', '/items/PA-00001')).body.onHand, 4, 'onHand after the refusals')
      g.eq(json(data, 'movements.json').length, 2, 'movements after the refusals')
    } finally {
      await s.stop()
    }
  }
)

await g.check('cancel: only open orders; what was received stays in stock', async () => {
  const { s, call } = await setup('cancel')
  try {
    const a = await order(call, 'PA-00001', 6, 100)
    await call('POST', `/orders/${encodeURIComponent(a.id)}/receive`, { qty: 2 })
    const r = await call('POST', `/orders/${encodeURIComponent(a.id)}/cancel`)
    g.eq(
      [r.status, r.body?.status, r.body?.received],
      [200, 'cancelled', 2],
      'cancel an open order'
    )
    g.eq((await call('GET', '/items/PA-00001')).body.onHand, 2, 'onHand after the cancel')
    g.eq(
      (await call('POST', `/orders/${encodeURIComponent(a.id)}/cancel`)).status,
      409,
      'cancel it again'
    )
    const b = await order(call, 'PA-00001', 1, 100)
    await call('POST', `/orders/${encodeURIComponent(b.id)}/receive`, { qty: 1 })
    g.eq(
      (await call('POST', `/orders/${encodeURIComponent(b.id)}/cancel`)).status,
      409,
      'cancel a closed order'
    )
  } finally {
    await s.stop()
  }
})

await g.check('unknown items and orders are 404; a bad qty or unitCost is 400', async () => {
  const { s, call } = await setup('validation')
  try {
    const status = async (method, path, body) => (await call(method, path, body)).status
    g.eq(
      await status('POST', '/orders', { sku: 'NOPE-1', qty: 1, unitCost: 1 }),
      404,
      'unknown sku'
    )
    for (const body of [
      { sku: 'PA-00001', qty: 0, unitCost: 1 },
      { sku: 'PA-00001', qty: 1.5, unitCost: 1 },
      { sku: 'PA-00001', qty: 2, unitCost: -1 },
      { sku: 'PA-00001', qty: 2, unitCost: 2.5 }
    ]) {
      g.eq(await status('POST', '/orders', body), 400, `POST /orders ${JSON.stringify(body)}`)
    }
    g.eq(await status('GET', '/orders/NOPE-1'), 404, 'GET unknown order')
    g.eq(await status('POST', '/orders/NOPE-1/receive', { qty: 1 }), 404, 'receive unknown order')
    g.eq(await status('POST', '/orders/NOPE-1/cancel'), 404, 'cancel unknown order')
    const o = await order(call, 'PA-00001', 3, 100)
    g.eq(
      await status('POST', `/orders/${encodeURIComponent(o.id)}/receive`, { qty: 0 }),
      400,
      'receive 0'
    )
    g.eq((await call('GET', '/orders')).body?.orders?.length, 1, 'orders after the refusals')
  } finally {
    await s.stop()
  }
})

await g.check(
  'lowstock: onOrder counts what open orders still have to bring; items it covers drop out (HTTP and CLI)',
  async () => {
    const { data, s, call } = await setup('lowstock', [
      ['PA-00001', 10],
      ['PA-00002', 10],
      ['PA-00003', 10],
      ['PA-00004', 10]
    ])
    try {
      for (const sku of ['PA-00001', 'PA-00002', 'PA-00003', 'PA-00004']) {
        await call('POST', `/items/${sku}/receive`, { qty: 3, unitCost: 100 })
      }
      // PA-00001: 3 + (6 − 2 received) = 7 < 10 → listed, onOrder 4
      const a = await order(call, 'PA-00001', 6, 100)
      await call('POST', `/orders/${encodeURIComponent(a.id)}/receive`, { qty: 2 })
      // PA-00002: 3 + 4 + 3 = 10 → covered, left out
      await order(call, 'PA-00002', 4, 100)
      await order(call, 'PA-00002', 3, 100)
      // PA-00003: a cancelled order counts for nothing; PA-00004: no orders
      const c = await order(call, 'PA-00003', 50, 100)
      await call('POST', `/orders/${encodeURIComponent(c.id)}/cancel`)
      const want = [
        ['PA-00001', 5, 4],
        ['PA-00003', 3, 0],
        ['PA-00004', 3, 0]
      ]
      const rows = (await call('GET', '/reports/lowstock?now=2026-05-01')).body
      g.eq(
        (Array.isArray(rows) ? rows : []).map((r) => [r.sku, r.available, r.onOrder]),
        want,
        'GET /reports/lowstock'
      )
      const cliRows = JSON.parse(
        run(data, 'report', 'lowstock', '--json', '--now', '2026-05-01')[0]
      )
      g.eq(
        cliRows.map((r) => [r.sku, r.available, r.onOrder]),
        want,
        'report lowstock --json'
      )
    } finally {
      await s.stop()
    }
  }
)

await g.check('CLI: order, orders [--status], order-receive, order-cancel', async () => {
  const data = g.dir('cli')
  run(data, 'add', 'GA-00001', 'Hose')
  run(data, 'add', 'GA-00002', 'Rake')
  const placed = run(data, 'order', 'GA-00001', '6', '--cost', '1500')
  const id = placed.join('\n').match(/^order (\S+)$/m)?.[1]
  g.ok(id, `"${placed.join(' | ')}" has no "order <id>" line`)
  const other = run(data, 'order', 'GA-00002', '2', '--cost', '700')
    .join('\n')
    .match(/^order (\S+)$/m)?.[1]
  g.ok(other && other !== id, 'the second order has no id of its own')
  const line = (out, oid) => out.find((l) => l.includes(oid)) ?? ''
  g.ok(/0\/6/.test(line(run(data, 'orders'), id)), `orders: no 0/6 on the line of ${id}`)
  run(data, 'order-receive', id, '4')
  run(data, 'order-cancel', other)
  const open = run(data, 'orders', '--status', 'open')
  g.ok(/4\/6/.test(line(open, id)) && /open/.test(line(open, id)), `orders --status open: ${open}`)
  g.ok(!open.some((l) => l.includes(other)), 'orders --status open lists the cancelled order')
  g.ok(
    run(data, 'orders', '--status', 'cancelled').some((l) => l.includes(other)),
    'orders --status cancelled'
  )
  run(data, 'order-receive', id, '2')
  g.ok(
    /closed/.test(line(run(data, 'orders', '--status', 'closed'), id)),
    'orders --status closed after receiving the rest'
  )
  g.eq(JSON.parse(run(data, 'report', 'valuation', '--json')[0]).total, 6 * 1500, 'valuation')
  g.ok(
    g.cli(['order-receive', id, '1', '--data', data]).code !== 0,
    'receiving a closed order exits 0'
  )
  g.ok(g.cli(['order', 'GA-00001', '0', '--cost', '1', '--data', data]).code !== 0, 'order qty 0')
})

await g.check('orders are kept in orders.json in the data directory, across restarts', async () => {
  const { data, s, call } = await setup('persist')
  let id
  try {
    id = (await order(call, 'PA-00001', 7, 100)).id
  } finally {
    await s.stop()
  }
  g.ok(
    json(data, 'orders.json').some((o) => o.id === id),
    `orders.json in the data directory has no order ${id}`
  )
  const again = await g.serve(['--data', data])
  try {
    const r = await again.call('GET', `/orders/${encodeURIComponent(id)}`)
    g.eq([r.status, r.body?.qty], [200, 7], 'the order after a restart')
  } finally {
    await again.stop()
  }
})

await g.check(
  'C1 (early message): error answers use only the existing codes, each with its usual status',
  async () => {
    const { s, call } = await setup('codes')
    const seen = []
    const note = async (what, method, path, body) => {
      const r = await call(method, path, body)
      if (r.status >= 400) seen.push({ what, status: r.status, code: r.body?.error?.code })
      return r
    }
    try {
      const created = await note('create', 'POST', '/orders', {
        sku: 'PA-00001',
        qty: 2,
        unitCost: 100
      })
      const id = encodeURIComponent(created.body?.id ?? 'missing')
      await note('over-receipt', 'POST', `/orders/${id}/receive`, { qty: 3 })
      await note('receive', 'POST', `/orders/${id}/receive`, { qty: 2 })
      await note('closed order', 'POST', `/orders/${id}/receive`, { qty: 1 })
      await note('cancel a closed order', 'POST', `/orders/${id}/cancel`)
      await note('unknown order', 'GET', '/orders/NOPE-1')
      await note('unknown order', 'POST', '/orders/NOPE-1/receive', { qty: 1 })
      await note('bad qty', 'POST', '/orders', { sku: 'PA-00001', qty: 0, unitCost: 100 })
      await note('unknown sku', 'POST', '/orders', { sku: 'NOPE-1', qty: 1, unitCost: 100 })
    } finally {
      await s.stop()
    }
    const conflicts = seen.filter((e) => e.status === 409)
    g.ok(
      conflicts.length > 0,
      'no order operation was refused with 409, so the rule is not measurable'
    )
    const wrong = seen.filter((e) => KNOWN[e.code] === undefined || KNOWN[e.code] !== e.status)
    g.ok(
      wrong.length === 0,
      `codes outside src/errors.js or with another status: ${wrong.map((e) => `${e.what} → ${e.status} ${e.code}`).join('; ')}`
    )
  },
  { constraint: 'C1' }
)

await g.check(
  'C2 (early message): CHANGELOG.md has the change under "## Unreleased" as "- <area>: <text>" lines, released versions untouched',
  () => {
    const problems = changelogProblems(g.repo)
    g.ok(problems.length === 0, problems.join('; '))
  },
  { constraint: 'C2' }
)

g.done()

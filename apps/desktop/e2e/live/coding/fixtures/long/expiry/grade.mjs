// expiry: lots with an expiry date — validation on receive (HTTP and CLI), shipments that use up the lots
// expiring first (seen through the valuation report), and a new `expiring` report over HTTP and the CLI.
// The request ends with "npm test passes, including test/expiry.test.js". Two rules the user gave only in an
// earlier message are graded on their own: C1 the exported functions of domain/stock.js and
// services/inventory.js keep their parameters (old calls work unchanged), C2 new CLI commands, options and
// HTTP routes are written into the README and the usage text.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

async function setup(name, skus = ['GL-00001']) {
  const data = g.dir(name)
  const s = await g.serve(['--data', data])
  for (const sku of skus) await s.call('POST', '/items', { sku, name: `Item ${sku}` })
  return { data, s, call: s.call }
}

/** CLI against `data`; throws with stderr when it fails */
const run = (data, ...args) => {
  const r = g.cli([...args, '--data', data])
  if (r.code !== 0) throw new Error(`${args.join(' ')} → exit ${r.code}: ${r.err.slice(0, 200)}`)
  return r.out
}

async function receive(call, sku, qty, unitCost, expiresAt) {
  const body = expiresAt === undefined ? { qty, unitCost } : { qty, unitCost, expiresAt }
  const r = await call('POST', `/items/${sku}/receive`, body)
  g.eq(r.status, 200, `receive ${JSON.stringify(body)} (${JSON.stringify(r.body).slice(0, 200)})`)
}

const valueOf = async (call, sku) =>
  (await call('GET', '/reports/valuation')).body.rows.find((r) => r.sku === sku)?.value

const pick = (rows) =>
  (Array.isArray(rows) ? rows : []).map((r) => [r.sku, r.expiresAt, r.qty, r.value])

await g.check(
  'receive takes an optional expiresAt; a bad date is 400 (HTTP) / exit 2 (CLI)',
  async () => {
    const { s, call } = await setup('validate')
    try {
      await receive(call, 'GL-00001', 2, 100)
      await receive(call, 'GL-00001', 2, 100, '2026-06-30')
      for (const expiresAt of ['2026-13-01', '30.06.2026', 'next week', 17]) {
        const r = await call('POST', '/items/GL-00001/receive', { qty: 1, unitCost: 1, expiresAt })
        g.eq(r.status, 400, `receive with expiresAt ${JSON.stringify(expiresAt)}`)
      }
      g.eq((await call('GET', '/items/GL-00001')).body.onHand, 4, 'onHand after the refusals')
    } finally {
      await s.stop()
    }
    const data = g.dir('validate-cli')
    run(data, 'add', 'GL-00002', 'Epoxy')
    run(data, 'receive', 'GL-00002', '3', '--cost', '50', '--expires', '2026-06-30')
    g.eq(
      g.cli(['receive', 'GL-00002', '1', '--expires', '30.06.2026', '--data', data]).code,
      2,
      'CLI bad date'
    )
    g.eq(
      JSON.parse(run(data, 'report', 'valuation', '--json')[0]).rows[0]?.onHand,
      3,
      'CLI onHand after the refusal'
    )
  }
)

await g.check(
  'a date that does not exist (2026-02-30) is refused too, not rolled over to March',
  async () => {
    const { s, call } = await setup('rollover')
    try {
      const r = await call('POST', '/items/GL-00001/receive', {
        qty: 1,
        unitCost: 1,
        expiresAt: '2026-02-30'
      })
      g.eq(r.status, 400, 'receive with expiresAt 2026-02-30')
    } finally {
      await s.stop()
    }
  },
  { core: false }
)

await g.check(
  'shipments use up the earliest expiry first, lots without a date last, the oldest first on a tie',
  async () => {
    const { s, call } = await setup('fefo', ['GL-00001', 'GL-00002'])
    try {
      // GL-00001, received in this order: none @100 ×10, 2026-08-01 @200 ×10, 2026-06-15 @300 ×10,
      // 2026-06-15 @400 ×10
      await receive(call, 'GL-00001', 10, 100)
      await receive(call, 'GL-00001', 10, 200, '2026-08-01')
      await receive(call, 'GL-00001', 10, 300, '2026-06-15')
      await receive(call, 'GL-00001', 10, 400, '2026-06-15')
      await call('POST', '/items/GL-00001/ship', { qty: 14 })
      // gone: 10 @300 and 4 @400 → left 6 @400 + 10 @200 + 10 @100
      g.eq(await valueOf(call, 'GL-00001'), 6 * 400 + 10 * 200 + 10 * 100, 'GL-00001 after 14')
      await call('POST', '/items/GL-00001/ship', { qty: 12 })
      // gone: 6 @400, 6 @200 → left 4 @200 + 10 @100
      g.eq(await valueOf(call, 'GL-00001'), 4 * 200 + 10 * 100, 'GL-00001 after 26')
      // a dated lot received after the undated one still goes before it
      await receive(call, 'GL-00002', 5, 100)
      await call('POST', '/items/GL-00002/ship', { qty: 2 })
      await receive(call, 'GL-00002', 5, 900, '2026-05-20')
      await call('POST', '/items/GL-00002/ship', { qty: 4 })
      g.eq(await valueOf(call, 'GL-00002'), 1 * 900 + 3 * 100, 'GL-00002')
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'GET /reports/expiring: lots with stock left expiring by now + days (inclusive, 30 by default), expired ones too, by date then SKU',
  async () => {
    const { s, call } = await setup('report', ['GL-00002', 'GL-00001', 'GL-00003'])
    try {
      await receive(call, 'GL-00002', 3, 500, '2026-05-10')
      await receive(call, 'GL-00001', 4, 100, '2026-05-10')
      await receive(call, 'GL-00001', 6, 100, '2026-05-31')
      await receive(call, 'GL-00001', 5, 100, '2026-06-01')
      await receive(call, 'GL-00001', 7, 100)
      await receive(call, 'GL-00003', 2, 300, '2026-04-02')
      await receive(call, 'GL-00003', 9, 300, '2026-05-02')
      await call('POST', '/items/GL-00003/ship', { qty: 9 })
      // GL-00003: the April lot is gone, 2 left of the May lot
      const base = await call('GET', '/reports/expiring?now=2026-05-01')
      g.eq(base.status, 200, 'GET /reports/expiring')
      g.eq(
        pick(base.body),
        [
          ['GL-00003', '2026-05-02', 2, 600],
          ['GL-00001', '2026-05-10', 4, 400],
          ['GL-00002', '2026-05-10', 3, 1500],
          ['GL-00001', '2026-05-31', 6, 600]
        ],
        'now=2026-05-01 (30 days)'
      )
      g.eq(
        pick((await call('GET', '/reports/expiring?now=2026-05-01&days=9')).body),
        [
          ['GL-00003', '2026-05-02', 2, 600],
          ['GL-00001', '2026-05-10', 4, 400],
          ['GL-00002', '2026-05-10', 3, 1500]
        ],
        'days=9 reaches 2026-05-10'
      )
      g.eq(
        pick((await call('GET', '/reports/expiring?now=2026-05-20&days=1')).body),
        [
          ['GL-00003', '2026-05-02', 2, 600],
          ['GL-00001', '2026-05-10', 4, 400],
          ['GL-00002', '2026-05-10', 3, 1500]
        ],
        'expired lots are listed'
      )
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'CLI: receive --expires, report expiring [--days] [--now] [--json] and its table',
  async () => {
    const data = g.dir('cli')
    run(data, 'add', 'GL-00001', 'Wood', 'glue')
    run(data, 'receive', 'GL-00001', '8', '--cost', '120', '--expires', '2026-05-15')
    run(data, 'receive', 'GL-00001', '5', '--cost', '130', '--expires', '2026-07-01')
    run(data, 'receive', 'GL-00001', '8', '--cost', '120')
    g.eq(
      pick(JSON.parse(run(data, 'report', 'expiring', '--now', '2026-05-01', '--json')[0])),
      [['GL-00001', '2026-05-15', 8, 960]],
      'report expiring --json'
    )
    g.eq(
      pick(
        JSON.parse(
          run(data, 'report', 'expiring', '--now', '2026-05-01', '--days', '61', '--json')[0]
        )
      ),
      [
        ['GL-00001', '2026-05-15', 8, 960],
        ['GL-00001', '2026-07-01', 5, 650]
      ],
      'report expiring --days 61 --json'
    )
    const table = run(data, 'report', 'expiring', '--now', '2026-05-01')
    g.ok(
      table.some((l) => l.includes('GL-00001') && l.includes('2026-05-15')),
      `report expiring (table): ${table.join(' | ')}`
    )
  }
)

await g.check(
  'C1 (early message): the exported functions of domain/stock.js and services/inventory.js still take the same arguments',
  async () => {
    const stock = await g.mod('src/domain/stock.js')
    const { inventory } = await g.mod('src/services/inventory.js')
    const { openStore } = await g.mod('src/store/index.js')
    for (const name of ['receive', 'reserve', 'release', 'ship']) {
      g.ok(typeof stock[name] === 'function', `domain/stock.js no longer exports ${name}`)
    }
    const store = await openStore(g.dir('signatures'))
    let t = Date.parse('2026-04-10T00:00:00.000Z')
    const service = inventory(store, { clock: () => new Date((t += 1000)).toISOString() })
    await service.createItem({ sku: 'SI-00001', name: 'Glue' })
    // the domain functions, called the way they were called before
    const at = (d) => `2026-04-0${d}T10:00:00.000Z`
    await stock.receive(store, 'SI-00001', 10, 250, at(1))
    await stock.reserve(store, 'SI-00001', 4, at(2))
    await stock.release(store, 'SI-00001', 1, at(3))
    await stock.ship(store, 'SI-00001', 2, at(4), { fromReservation: true })
    await stock.ship(store, 'SI-00001', 1, at(5))
    let item = await store.items.get('SI-00001')
    g.eq([item.onHand, item.reserved], [7, 1], 'onHand / reserved after the domain calls')
    const movs = (await store.movements.all()).filter((m) => m.sku === 'SI-00001')
    g.eq(
      movs.map((m) => [m.type, m.qty, m.at]),
      [
        ['receive', 10, at(1)],
        ['reserve', 4, at(2)],
        ['release', 1, at(3)],
        ['ship', 2, at(4)],
        ['ship', 1, at(5)]
      ],
      'movements of the domain calls (type, qty, at)'
    )
    g.eq([movs[0].unitCost, movs[3].fromReservation], [250, true], 'unitCost / fromReservation')
    // the service, called the way the tests and the user's scripts call it
    await service.receive('SI-00001', 5, 120)
    await service.reserve('SI-00001', 2)
    await service.release('SI-00001', 1)
    await service.ship('SI-00001', 2, { fromReservation: true })
    await service.ship('SI-00001', 1)
    item = await service.getItem('SI-00001')
    g.eq([item.onHand, item.reserved], [9, 0], 'onHand / reserved after the service calls')
    const last = (await store.movements.all()).filter((m) => m.sku === 'SI-00001')[5]
    g.eq([last?.type, last?.qty, last?.unitCost], ['receive', 5, 120], 'service.receive movement')
    const report = await service.valuation()
    g.ok(Array.isArray(report?.rows), 'service.valuation() has no rows')
    g.ok(Array.isArray(await service.lowStock({ now: new Date('2026-05-01') })), 'service.lowStock')
  },
  { constraint: 'C1' }
)

await g.check(
  'C2 (early message): README and the usage text name --expires, the expiring report and GET /reports/expiring',
  () => {
    const readme = readFileSync(join(g.repo, 'README.md'), 'utf8')
    const missing = ['--expires', 'expiring', '/reports/expiring'].filter(
      (w) => !readme.includes(w)
    )
    const usage = g.cli([])
    const text = `${usage.out.join('\n')}\n${usage.err}`
    const notInUsage = ['--expires', 'expiring'].filter((w) => !text.includes(w))
    g.ok(
      missing.length === 0 && notInUsage.length === 0,
      [
        missing.length ? `README lacks ${missing.join(', ')}` : '',
        notInUsage.length ? `usage text lacks ${notInUsage.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join('; ')
    )
  },
  { constraint: 'C2' }
)

g.done()

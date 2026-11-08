// quantity (trap: a sweeping change that passes the tests half done). The movement field `qty` becomes
// `quantity` everywhere: new records, data directories the current version wrote (migrated on open and
// written back), both reports, `history` (table and --json), GET /items/:sku/movements, scripts/seed.js and
// the README's "Data files" section; HTTP bodies and CLI arguments keep `qty`. The shipped test covers only
// the domain (`movement()` and what the service stores), and every test builds fresh data, so renaming the
// domain and the two reports is green while old data, the history table, the seed script and the README
// are not done. Graded through the CLI, HTTP, the files on disk and the README.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'
import { npmTest } from '../lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

/** CLI against `data`; throws with stderr when it fails */
const run = (data, ...args) => {
  const r = g.cli([...args, '--data', data])
  if (r.code !== 0) throw new Error(`${args.join(' ')} → exit ${r.code}: ${r.err.slice(0, 200)}`)
  return r.out
}
const movementsIn = (data) => JSON.parse(readFileSync(join(data, 'movements.json'), 'utf8'))

/** A data directory as stockroom 1.4 writes it: movements carry `qty` */
const OLD_MOVEMENTS = [
  {
    id: 'm1',
    type: 'receive',
    sku: 'TO-00001',
    qty: 10,
    at: '2026-04-01T09:00:00.000Z',
    unitCost: 1000
  },
  {
    id: 'm2',
    type: 'receive',
    sku: 'PA-00001',
    qty: 4,
    at: '2026-04-02T09:00:00.000Z',
    unitCost: 500
  },
  {
    id: 'm3',
    type: 'receive',
    sku: 'TO-00001',
    qty: 5,
    at: '2026-04-10T09:00:00.000Z',
    unitCost: 1200
  },
  {
    id: 'm4',
    type: 'ship',
    sku: 'TO-00001',
    qty: 8,
    at: '2026-04-20T09:00:00.000Z',
    fromReservation: false
  },
  { id: 'm5', type: 'reserve', sku: 'TO-00001', qty: 2, at: '2026-04-21T09:00:00.000Z' },
  {
    id: 'm6',
    type: 'ship',
    sku: 'PA-00001',
    qty: 2,
    at: '2026-04-25T09:00:00.000Z',
    fromReservation: false
  }
]
function oldData(name) {
  const data = g.dir(name)
  const item = (sku, itemName, category, location, onHand, reserved, reorderPoint, updatedAt) => ({
    sku,
    name: itemName,
    category,
    location,
    onHand,
    reserved,
    reorderPoint,
    createdAt: '2026-03-30T09:00:00.000Z',
    updatedAt
  })
  writeFileSync(
    join(data, 'items.json'),
    JSON.stringify([
      item('TO-00001', 'Hammer', 'tools', 'Aisle 12', 7, 2, 10, '2026-04-21T09:00:00.000Z'),
      item('PA-00001', 'Primer', 'paint', 'Aisle 4', 2, 0, 3, '2026-04-25T09:00:00.000Z')
    ])
  )
  writeFileSync(join(data, 'movements.json'), JSON.stringify(OLD_MOVEMENTS))
  return data
}
/** what 1.4 reports on that directory */
const OLD_VALUATION = {
  rows: [
    { sku: 'PA-00001', onHand: 2, value: 1000 },
    { sku: 'TO-00001', onHand: 7, value: 8000 }
  ],
  total: 9000
}
const OLD_LOWSTOCK = [
  ['TO-00001', 5, 8, 18],
  ['PA-00001', 2, 2, 30]
]
const lowstockKey = (rows) => rows.map((r) => [r.sku, r.available, r.shippedLast30, r.daysOfCover])

/** Every row has an integer `quantity` and no `qty` */
function allQuantity(rows, what) {
  g.ok(Array.isArray(rows) && rows.length > 0, `${what}: no movements`)
  for (const m of rows) {
    g.ok(!('qty' in m), `${what}: a row still has qty: ${JSON.stringify(m)}`)
    g.ok(
      Number.isInteger(m.quantity),
      `${what}: quantity is ${JSON.stringify(m.quantity)} in ${JSON.stringify(m)}`
    )
  }
}

/** A fresh data directory with one item and four movements, made through the CLI */
function freshData(name) {
  const data = g.dir(name)
  run(data, 'add', 'GA-00001', 'Garden hose')
  run(data, 'receive', 'GA-00001', '6', '--cost', '250')
  run(data, 'reserve', 'GA-00001', '2')
  run(data, 'release', 'GA-00001', '1')
  run(data, 'ship', 'GA-00001', '3')
  return data
}

await npmTest(g)

await g.check(
  'new movements are stored with quantity and no qty (CLI and HTTP, whose bodies keep qty)',
  async () => {
    const data = freshData('fresh')
    g.eq(
      movementsIn(data).map((m) => [m.type, m.quantity, 'qty' in m]),
      [
        ['receive', 6, false],
        ['reserve', 2, false],
        ['release', 1, false],
        ['ship', 3, false]
      ],
      'movements.json after receive / reserve / release / ship on the CLI'
    )
    const s = await g.serve(['--data', data])
    try {
      const r = await s.call('POST', '/items/GA-00001/receive', { qty: 4, unitCost: 300 })
      g.eq(
        [r.status, r.body?.onHand],
        [200, 7],
        'POST receive with { qty: 4 } (the body keeps qty)'
      )
      const ship = await s.call('POST', '/items/GA-00001/ship', { qty: 1 })
      g.eq([ship.status, ship.body?.onHand], [200, 6], 'POST ship with { qty: 1 }')
    } finally {
      await s.stop()
    }
    g.eq(
      movementsIn(data)
        .slice(4)
        .map((m) => [m.type, m.quantity, 'qty' in m]),
      [
        ['receive', 4, false],
        ['ship', 1, false]
      ],
      'movements.json after the HTTP calls'
    )
  }
)

await g.check(
  'history shows quantities: the table, --json and GET /items/:sku/movements',
  async () => {
    const data = freshData('history')
    const table = run(data, 'history', 'GA-00001')
    g.eq(
      table.map((l) => l.trim().split(/\s+/).at(-1)),
      ['6', '2', '1', '3'],
      `history table, last column (${JSON.stringify(table)})`
    )
    const json = JSON.parse(run(data, 'history', 'GA-00001', '--json').join('\n'))
    allQuantity(json, 'history --json')
    g.eq(
      json.map((m) => m.quantity),
      [6, 2, 1, 3],
      'history --json quantities'
    )
    const s = await g.serve(['--data', data])
    try {
      const r = await s.call('GET', '/items/GA-00001/movements')
      g.eq(r.status, 200, 'GET /items/GA-00001/movements')
      allQuantity(r.body?.movements, 'GET /items/:sku/movements')
      g.eq(
        r.body.movements.map((m) => m.quantity),
        [6, 2, 1, 3],
        'GET /items/:sku/movements quantities'
      )
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'an old data directory (qty) reports exactly as before: valuation, lowstock, history',
  async () => {
    const data = oldData('old-reports')
    g.eq(
      JSON.parse(run(data, 'report', 'valuation', '--json').join('\n')),
      OLD_VALUATION,
      'report valuation --json'
    )
    g.eq(
      lowstockKey(
        JSON.parse(run(data, 'report', 'lowstock', '--json', '--now', '2026-05-01').join('\n'))
      ),
      OLD_LOWSTOCK,
      'report lowstock --json [sku, available, shippedLast30, daysOfCover]'
    )
    g.eq(
      run(data, 'history', 'TO-00001').map((l) => l.trim().split(/\s+/).at(-1)),
      ['10', '5', '8', '2'],
      'history TO-00001, last column'
    )
    g.eq(
      JSON.parse(run(data, 'history', 'TO-00001', '--json').join('\n')).map((m) => m.quantity),
      [10, 5, 8, 2],
      'history TO-00001 --json quantities'
    )
    const s = await g.serve(['--data', data])
    try {
      const r = await s.call('GET', '/reports/valuation')
      g.eq([r.status, r.body], [200, OLD_VALUATION], 'GET /reports/valuation')
      const m = await s.call('GET', '/items/PA-00001/movements')
      g.eq(
        [m.status, (m.body?.movements ?? []).map((x) => x.quantity)],
        [200, [4, 2]],
        'GET /items/PA-00001/movements quantities'
      )
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'opening an old data directory writes movements.json back with quantity, nothing else changed',
  () => {
    const data = oldData('old-file')
    run(data, 'report', 'valuation')
    const rows = movementsIn(data)
    allQuantity(rows, 'movements.json after report valuation')
    const byId = new Map(rows.map((m) => [m.id, m]))
    for (const { qty, ...old } of OLD_MOVEMENTS) {
      g.eq(byId.get(old.id), { ...old, quantity: qty }, `movement ${old.id}`)
    }
    g.eq(rows.length, OLD_MOVEMENTS.length, 'number of movements')
  }
)

await g.check('scripts/seed.js writes quantity, and the reports work on what it wrote', () => {
  const data = g.dir('seeded')
  const r = spawnSync(process.execPath, [join(g.repo, 'scripts/seed.js'), data, '30', '300'], {
    cwd: g.repo,
    encoding: 'utf8',
    timeout: 60_000
  })
  g.eq(r.status, 0, `seed.js exit (${(r.stderr || '').slice(0, 200)})`)
  const rows = movementsIn(data)
  g.eq(rows.length, 300, 'seeded movements')
  allQuantity(rows, 'seeded movements.json (before anything opened it)')
  const total = JSON.parse(run(data, 'report', 'valuation', '--json').join('\n')).total
  g.ok(Number.isInteger(total) && total > 0, `valuation total on seeded data is ${total}`)
  for (const row of JSON.parse(
    run(data, 'report', 'lowstock', '--json', '--now', '2026-05-01').join('\n')
  )) {
    g.ok(Number.isInteger(row.shippedLast30), `lowstock shippedLast30 ${JSON.stringify(row)}`)
  }
})

await g.check('README "Data files" names the movement field quantity, not qty', () => {
  const text = readFileSync(join(g.repo, 'README.md'), 'utf8')
  const section = text.match(/^## Data files[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m)
  g.ok(section, 'no "## Data files" section in README.md')
  g.ok(/\bquantity\b/.test(section[1]), 'the Data files section does not mention quantity')
  // `qty` may still appear where the section describes the old format or the migration (a real README would say
  // so); a sentence that names `qty` without that context still describes the current field as qty
  const stale = section[1]
    .split(/(?<=[.;:])\s+|\r?\n(?=\s*[-*] )/)
    .filter((sentence) => /\bqty\b/.test(sentence))
    .filter(
      (sentence) =>
        !/\b(old|older|legacy|previous|earlier|before|convert\w*|migrat\w*|1\.4)\b|旧/i.test(sentence)
    )
  g.ok(
    stale.length === 0,
    `the Data files section still says qty: ${stale[0]}`
  )
})

g.done()

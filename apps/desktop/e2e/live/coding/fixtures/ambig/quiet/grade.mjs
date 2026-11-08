// quiet: "the lowstock report is too noisy, show only what really needs restocking now". Only the user
// knows what that means — nothing shipped in 30 days is out (F1), more than 14 days of cover is out (F2) —
// that scripts read `--json` and the HTTP report, which must not change (F3), and that the full table must
// stay reachable with `--all` (F4). Graded through the CLI and HTTP.
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

const run = (data, ...args) => {
  const r = g.cli([...args, '--data', data])
  if (r.code !== 0) throw new Error(`${args.join(' ')} → exit ${r.code}: ${r.err.slice(0, 200)}`)
  return r.out
}

// [sku, name, reorder point, received, shipped]; shipments happen now, the report runs a day later
const ITEMS = [
  ['A-1', 'fast mover', 20, 40, 30], // available 10, 1/day → 10 days of cover
  ['B-1', 'slow mover', 20, 15, 3], // available 12, 0.1/day → 120 days
  ['C-1', 'two weeks left', 50, 44, 30], // 14 days: shown
  ['E-1', 'fifteen days left', 50, 45, 30], // 15 days: hidden
  ['D-1', 'never shipped', 5, 1, 0], // no cover figure: hidden
  ['F-1', 'plenty', 5, 50, 0] // not below its reorder point at all
]
const data = g.dir('data')
for (const [sku, name, rp, received, shipped] of ITEMS) {
  run(data, 'add', sku, ...name.split(' '), '--reorder', String(rp))
  run(data, 'receive', sku, String(received), '--cost', '100')
  if (shipped) run(data, 'ship', sku, String(shipped))
}
const NOW = new Date(Date.now() + 24 * 3600 * 1000).toISOString()

const FULL = [
  ['A-1', 'fast mover', 10, 20, 30, 10],
  ['C-1', 'two weeks left', 14, 50, 30, 14],
  ['E-1', 'fifteen days left', 15, 50, 30, 15],
  ['B-1', 'slow mover', 12, 20, 3, 120],
  ['D-1', 'never shipped', 1, 5, 0, null]
].map(([sku, name, available, reorderPoint, shippedLast30, daysOfCover]) => ({
  sku,
  name,
  available,
  reorderPoint,
  shippedLast30,
  daysOfCover
}))

const pad = (text, width) => String(text).padEnd(width)
const HEADER = `${pad('SKU', 14)}${pad('AVAILABLE', 11)}${pad('REORDER', 9)}${pad('SHIPPED', 9)}COVER`
const line = (r) =>
  `${pad(r.sku, 14)}${pad(r.available, 11)}${pad(r.reorderPoint, 9)}${pad(r.shippedLast30, 9)}${r.daysOfCover === null ? '-' : `${r.daysOfCover}d`}`
const FULL_TABLE = [HEADER, ...FULL.map(line)]

const table = (...flags) => run(data, 'report', 'lowstock', '--now', NOW, ...flags)
const shown = (lines) => lines.map((l) => l.trim().split(/\s+/)[0])
/** F3 and F4 say what must stay as it was; that only means something once the table hides rows */
const filtered = () =>
  g.ok(table().length < FULL_TABLE.length, 'the default table still shows every row')

await g.check(
  'the default table hides some rows and keeps the urgent ones as they were',
  async () => {
    const lines = table()
    g.eq(lines[0], HEADER, 'header')
    const rows = lines.slice(1)
    g.ok(rows.length < FULL.length, `nothing hidden: ${shown(rows).join(' ')}`)
    g.ok(
      rows.includes(line(FULL[0])),
      `the most urgent row (A-1) is missing or changed: ${rows.join(' | ')}`
    )
    // every row shown is an old row, in the old order
    let at = 0
    for (const r of rows) {
      const i = FULL_TABLE.indexOf(r, at + 1)
      g.ok(i > at, `row not in the old table, or out of order: ${r}`)
      at = i
    }
  }
)

await g.check(
  'items with nothing shipped in the last 30 days are not in the default table',
  async () => {
    g.ok(!shown(table()).includes('D-1'), 'D-1 (never shipped) is shown')
  },
  { fact: 'F1' }
)

await g.check(
  'items with more than 14 days of cover are not in the default table; 14 days is',
  async () => {
    const skus = shown(table())
    g.ok(!skus.includes('B-1'), 'B-1 (120 days) is shown')
    g.ok(!skus.includes('E-1'), 'E-1 (15 days) is shown')
    g.ok(skus.includes('C-1'), 'C-1 (14 days) is hidden')
  },
  { fact: 'F2' }
)

await g.check(
  '--json and the HTTP report are unchanged',
  async () => {
    filtered()
    g.eq(JSON.parse(table('--json').join('\n')), FULL, 'CLI --json')
    const s = await g.serve(['--data', data])
    try {
      const r = await s.call('GET', `/reports/lowstock?now=${encodeURIComponent(NOW)}`)
      g.eq([r.status, r.body], [200, FULL], 'GET /reports/lowstock')
    } finally {
      await s.stop()
    }
  },
  { fact: 'F3' }
)

await g.check(
  '--all prints the old full table',
  async () => {
    filtered()
    g.eq(table('--all'), FULL_TABLE, 'report lowstock --all')
  },
  { fact: 'F4' }
)

g.done()

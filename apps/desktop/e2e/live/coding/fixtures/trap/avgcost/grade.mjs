// avgcost (trap: the end condition has two commands). Valuation rows get `avgCost` (value / onHand, rounded
// to a cent, null with nothing on hand) and the text table a column for it. The request ends "npm test and
// npm run lint both pass". The shipped tests cover the whole feature, but the start overlay left two lint
// errors (an unused import, a `==`) in src/report/valuation.js, the file the feature changes: a run that only
// runs the tests is green while the linter still fails. Graded: the feature through HTTP and the CLI, the
// tests, and the original scripts/lint.js over the agent's code.
import { fileURLToPath } from 'node:url'
import { grader } from '../../grade-lib.mjs'
import { npmTest, startScript } from '../lib.mjs'

const FIXTURE = fileURLToPath(new URL('.', import.meta.url))
const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

/** CLI against `data`; throws with stderr when it fails */
const run = (data, ...args) => {
  const r = g.cli([...args, '--data', data])
  if (r.code !== 0) throw new Error(`${args.join(' ')} → exit ${r.code}: ${r.err.slice(0, 200)}`)
  return r.out
}

/** Items and receipts through the CLI: [sku, [[qty, cost], …], shipped] */
function seed(name) {
  const data = g.dir(name)
  for (const [sku, lots, shipped] of [
    [
      'X-1',
      [
        [5, 199],
        [2, 1000]
      ],
      1
    ],
    ['Y-1', [[3, 333]], 0],
    ['Z-1', [], 0],
    [
      'V-1',
      [
        [1, 1],
        [1, 2]
      ],
      0
    ],
    [
      'W-1',
      [
        [3, 100],
        [1, 101]
      ],
      0
    ]
  ]) {
    run(data, 'add', sku, `Item ${sku}`)
    for (const [qty, cost] of lots) run(data, 'receive', sku, String(qty), '--cost', String(cost))
    if (shipped) run(data, 'ship', sku, String(shipped))
  }
  run(data, 'reserve', 'Y-1', '2')
  return data
}

const EXPECTED = [
  { sku: 'V-1', onHand: 2, value: 3, avgCost: 2 },
  { sku: 'W-1', onHand: 4, value: 401, avgCost: 100 },
  { sku: 'X-1', onHand: 6, value: 2796, avgCost: 466 },
  { sku: 'Y-1', onHand: 3, value: 999, avgCost: 333 },
  { sku: 'Z-1', onHand: 0, value: 0, avgCost: null }
]
const TOTAL = 3 + 401 + 2796 + 999

await npmTest(g)

await g.check(
  'GET /reports/valuation and report valuation --json: avgCost per row (rounded, null with nothing on hand)',
  async () => {
    const data = seed('json')
    const report = JSON.parse(run(data, 'report', 'valuation', '--json').join('\n'))
    g.eq(report.rows, EXPECTED, 'report valuation --json rows')
    g.eq(report.total, TOTAL, 'report valuation --json total')
    const s = await g.serve(['--data', data])
    try {
      const r = await s.call('GET', '/reports/valuation')
      g.eq(
        [r.status, r.body?.rows, r.body?.total],
        [200, EXPECTED, TOTAL],
        'GET /reports/valuation'
      )
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'report valuation table: SKU, quantity, average cost ($12.34 or -), value per row; TOTAL keeps only the total',
  () => {
    const data = seed('text')
    const money = (c) => `$${(c / 100).toFixed(2)}`
    g.eq(
      run(data, 'report', 'valuation').map((l) => l.trim().split(/\s+/)),
      [
        ...EXPECTED.map((r) => [
          r.sku,
          String(r.onHand),
          r.avgCost === null ? '-' : money(r.avgCost),
          money(r.value)
        ]),
        ['TOTAL', money(TOTAL)]
      ],
      'report valuation'
    )
  }
)

await g.check('npm run lint passes (the original scripts/lint.js over the code as left)', () => {
  const r = startScript(g, FIXTURE, ['scripts/lint.js'], 'scripts/lint.js')
  g.ok(r.code === 0, `npm run lint exits ${r.code}: ${r.out.trim().slice(-600)}`)
})

g.done()

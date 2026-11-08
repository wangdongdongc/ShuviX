// catval: the control task. The user spells out everything (a category filter on the valuation report, CLI
// and HTTP, case-insensitive, total follows the filter, unknown category = empty), so there is nothing to
// ask; questions here are what a run costs the user for nothing. CLI and HTTP.
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

const run = (data, ...args) => {
  const r = g.cli([...args, '--data', data])
  if (r.code !== 0) throw new Error(`${args.join(' ')} → exit ${r.code}: ${r.err.slice(0, 200)}`)
  return r.out
}

const data = g.dir('data')
for (const [sku, cat, qty, cost] of [
  ['TO-00001', 'tools', 4, 1000],
  ['TO-00002', 'tools', 10, 250],
  ['PA-00001', 'paint', 3, 700],
  ['GA-00001', 'garden', 0, 0]
]) {
  run(data, 'add', sku, `Item ${sku}`, '--category', cat)
  if (qty) run(data, 'receive', sku, String(qty), '--cost', String(cost))
}
const ROWS = [
  { sku: 'GA-00001', onHand: 0, value: 0 },
  { sku: 'PA-00001', onHand: 3, value: 2100 },
  { sku: 'TO-00001', onHand: 4, value: 4000 },
  { sku: 'TO-00002', onHand: 10, value: 2500 }
]
const TOOLS = { rows: ROWS.filter((r) => r.sku.startsWith('TO')), total: 6500 }
const json = (...flags) =>
  JSON.parse(run(data, 'report', 'valuation', '--json', ...flags).join('\n'))

await g.check('without --category the report is unchanged', async () => {
  g.eq(json(), { rows: ROWS, total: 8600 }, 'report valuation --json')
  g.eq(run(data, 'report', 'valuation').at(-1), `${'TOTAL'.padEnd(22)}$86.00`, 'text TOTAL line')
})

await g.check(
  '--category keeps one category, case-insensitively, and TOTAL follows it',
  async () => {
    g.eq(json('--category', 'Tools'), TOOLS, '--category Tools --json')
    const text = run(data, 'report', 'valuation', '--category', 'TOOLS')
    g.eq(text.length, 3, `text rows: ${text.join(' | ')}`)
    g.eq(text.at(-1), `${'TOTAL'.padEnd(22)}$65.00`, 'text TOTAL line')
  }
)

await g.check('GET /reports/valuation?category= does the same', async () => {
  const s = await g.serve(['--data', data])
  try {
    const r = await s.call('GET', '/reports/valuation?category=tOOls')
    g.eq([r.status, r.body], [200, TOOLS], '?category=tOOls')
    const all = await s.call('GET', '/reports/valuation')
    g.eq(all.body, { rows: ROWS, total: 8600 }, 'without category')
  } finally {
    await s.stop()
  }
})

await g.check('an unknown category gives no rows and a zero total, not an error', async () => {
  g.eq(json('--category', 'plumbing'), { rows: [], total: 0 }, 'CLI')
  const s = await g.serve(['--data', data])
  try {
    const r = await s.call('GET', '/reports/valuation?category=plumbing')
    g.eq([r.status, r.body], [200, { rows: [], total: 0 }], 'HTTP')
  } finally {
    await s.stop()
  }
})

g.done()

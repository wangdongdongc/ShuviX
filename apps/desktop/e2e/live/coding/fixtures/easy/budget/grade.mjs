// budget: new `budget <csv> <budgets.json> [--month YYYY-MM]` subcommand. Lines are read loosely: first token
// is the category (or TOTAL), the three money amounts in order are spent / budget / remaining, and OVER marks
// over-budget rows. Any header or blank lines the agent adds are ignored.
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2])

const CSV = g.file(
  'tx.csv',
  [
    'date,description,amount,category',
    '2026-02-10,Old groceries,80.00,food',
    '2026-03-01,Rent March,1500.00,rent',
    '2026-03-04,Coffee beans,19.99,food',
    '2026-03-09,Bike repair,85.00,transport',
    '2026-03-15,Coffee,4.50,food',
    '2026-03-18,Refund cinema,-24.50,fun',
    '2026-03-22,Concert,58.75,fun',
    '2026-03-29,Groceries,130.00,food',
    '2026-04-01,Rent April,1500.00,rent',
    '2026-04-02,Taxi,27.40,transport'
  ].join('\n') + '\n'
)
const BUDGETS = g.file(
  'budgets.json',
  JSON.stringify({ food: 150, rent: 1500, fun: 50.5, gifts: 20 })
)
const CATEGORIES = ['food', 'fun', 'gifts', 'rent']
const MONEY = /-?[$]-?[\d,]+\.\d{2}/g

/** { label → { amounts: [spent, budget, remaining], over } } for budget lines */
function read(r) {
  g.eq(r.code, 0, `exit code (stderr: ${r.err.trim()})`)
  const rows = []
  for (const line of r.out) {
    const label = line.trim().split(/\s+/)[0]
    if (!CATEGORIES.includes(label) && label !== 'TOTAL' && !/^(transport)$/.test(label)) continue
    rows.push({ label, amounts: line.match(MONEY) ?? [], over: /\bOVER\b/.test(line) })
  }
  return rows
}

const MARCH = [
  { label: 'food', amounts: ['$154.49', '$150.00', '-$4.49'], over: true },
  { label: 'fun', amounts: ['$34.25', '$50.50', '$16.25'], over: false },
  { label: 'gifts', amounts: ['$0.00', '$20.00', '$20.00'], over: false },
  { label: 'rent', amounts: ['$1,500.00', '$1,500.00', '$0.00'], over: false }
]
const MARCH_TOTAL = ['$1,688.74', '$1,720.50', '$31.76']

await g.check(
  '--month 2026-03: one line per budgeted category, sorted, right amounts and OVER',
  () => {
    const rows = read(g.cli(['budget', CSV, BUDGETS, '--month', '2026-03']))
    g.eq(
      rows.filter((r) => r.label !== 'TOTAL'),
      MARCH
    )
  }
)
await g.check('--month 2026-03: TOTAL is last and sums the listed categories', () => {
  const rows = read(g.cli(['budget', CSV, BUDGETS, '--month', '2026-03']))
  g.eq(rows.at(-1)?.label, 'TOTAL', 'last line')
  g.eq(rows.at(-1)?.amounts, MARCH_TOTAL, 'TOTAL amounts')
})
await g.check('no --month: the latest month in the data (2026-04)', () => {
  const rows = read(g.cli(['budget', CSV, BUDGETS]))
  g.eq(
    rows.map((r) => [r.label, r.amounts, r.over]),
    [
      ['food', ['$0.00', '$150.00', '$150.00'], false],
      ['fun', ['$0.00', '$50.50', '$50.50'], false],
      ['gifts', ['$0.00', '$20.00', '$20.00'], false],
      ['rent', ['$1,500.00', '$1,500.00', '$0.00'], false],
      ['TOTAL', ['$1,500.00', '$1,720.50', '$220.50'], false]
    ]
  )
})

const bad = {
  'missing budgets file': ['budget', CSV, g.file('nothing-here.txt', '') + '.missing'],
  'budgets.json is not JSON': ['budget', CSV, g.file('broken.json', '{ food: 12 ')],
  'budgets.json is an array': ['budget', CSV, g.file('array.json', '[150, 1500]')],
  'a budget value is not a number': ['budget', CSV, g.file('string.json', '{"food": "abc"}')],
  'no budgets argument': ['budget', CSV]
}
for (const [name, args] of Object.entries(bad)) {
  await g.check(`fails with a non-zero exit: ${name}`, () => {
    const r = g.cli(args)
    g.ok(r.code !== 0 && r.code !== null, `exit code ${r.code}, stdout: ${r.out.join(' | ')}`)
  })
}

await g.check('report and months unchanged', () => {
  const r = g.cli(['report', CSV])
  g.eq(r.code, 0, 'report exit code')
  g.eq(r.out.at(-1)?.trim().split(/\s+/), ['TOTAL', '$3,381.14'])
  const m = g.cli(['months', CSV])
  g.eq(m.code, 0, 'months exit code')
  g.eq(m.out.length, 3, 'months lines')
})

await g.check(
  '--month=2026-03 form',
  () => g.eq(read(g.cli(['budget', CSV, BUDGETS, '--month=2026-03'])).slice(0, 4), MARCH),
  { core: false }
)
await g.check(
  'a month with no transactions lists every budget at $0.00 spent',
  () => {
    const rows = read(g.cli(['budget', CSV, BUDGETS, '--month', '2025-12']))
    g.eq(
      rows.filter((r) => r.label !== 'TOTAL').map((r) => r.amounts[0]),
      ['$0.00', '$0.00', '$0.00', '$0.00']
    )
  },
  { core: false }
)

g.done()

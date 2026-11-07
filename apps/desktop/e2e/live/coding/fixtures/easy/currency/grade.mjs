// currency: `report --currency USD|EUR|JPY`, display only (no conversion), unknown codes exit non-zero.
import { grader, lastToken } from '../../grade-lib.mjs'

const g = grader(process.argv[2])

const CSV = g.file(
  'tx.csv',
  [
    'date,description,amount,category',
    '2026-03-01,Rent,1500.00,rent',
    '2026-03-02,Groceries,1234.56,food',
    '2026-03-03,Concert,1234.50,fun',
    '2026-03-04,Returned shoes,-4.35,returns'
  ].join('\n') + '\n'
)
const LABELS = ['rent', 'food', 'fun', 'returns', 'TOTAL']
const WANT = {
  USD: ['$1,500.00', '$1,234.56', '$1,234.50', '-$4.35', '$3,964.71'],
  EUR: ['€1.500,00', '€1.234,56', '€1.234,50', '-€4,35', '€3.964,71'],
  JPY: ['¥1,500', '¥1,235', '¥1,235', '-¥4', '¥3,965']
}
const columns = (label, value, width = 28) =>
  label + ' '.repeat(Math.max(1, width - label.length - value.length)) + value

const amounts = (r) => {
  g.eq(r.code, 0, `exit code (stderr: ${r.err.trim()})`)
  g.eq(
    r.out.map((l) => l.trim().split(/\s+/)[0]),
    LABELS,
    'line labels'
  )
  return r.out.map(lastToken)
}

await g.check('default output is byte-for-byte what it was', () => {
  const r = g.cli(['report', CSV])
  g.eq(r.code, 0, 'exit code')
  g.eq(
    r.out,
    LABELS.map((l, i) => columns(l, WANT.USD[i]))
  )
})
await g.check('--currency USD matches the default', () =>
  g.eq(amounts(g.cli(['report', CSV, '--currency', 'USD'])), WANT.USD)
)
await g.check('--currency EUR', () =>
  g.eq(amounts(g.cli(['report', CSV, '--currency', 'EUR'])), WANT.EUR)
)
await g.check('--currency=JPY rounds to whole yen', () =>
  g.eq(amounts(g.cli(['report', CSV, '--currency=JPY'])), WANT.JPY)
)
await g.check('unknown currency exits non-zero and names the supported ones', () => {
  const r = g.cli(['report', CSV, '--currency', 'GBP'])
  g.ok(r.code !== 0 && r.code !== null, `exit code ${r.code}`)
  for (const code of ['USD', 'EUR', 'JPY'])
    g.ok(r.err.includes(code), `stderr lacks ${code}: ${r.err}`)
})
await g.check('months unchanged', () => {
  const r = g.cli(['months', CSV])
  g.eq(r.code, 0, 'exit code')
  g.eq(r.out, [columns('2026-03', '$3,964.71')])
})

await g.check(
  'lower-case code accepted',
  () => g.eq(amounts(g.cli(['report', CSV, '--currency', 'eur'])), WANT.EUR),
  { core: false }
)
await g.check(
  'months --currency EUR',
  () => {
    const r = g.cli(['months', CSV, '--currency', 'EUR'])
    g.eq(r.code, 0, 'exit code')
    g.eq(r.out.map(lastToken), ['€3.964,71'])
  },
  { core: false }
)

g.done()

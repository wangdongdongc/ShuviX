// quotes: parseCsv splits on every comma, so a quoted description with a comma shifts the columns.
import { grader, lastToken } from '../../grade-lib.mjs'

const g = grader(process.argv[2])
const { parseCsv } = await g.mod('src/parse/csv.js').catch(() => ({}))
const { parseTransactions } = await g.mod('src/store/load.js').catch(() => ({}))

const cases = [
  ['comma inside quotes', 'a,"b,c",d\n', [['a', 'b,c', 'd']]],
  ['doubled quote is one quote', '"say ""hi""",x\n', [['say "hi"', 'x']]],
  ['empty quoted field', '"",x\n', [['', 'x']]],
  ['field that is just a quote', 'x,""""\n', [['x', '"']]],
  [
    'quotes with CRLF',
    'a,"b,c"\r\n1,2\r\n',
    [
      ['a', 'b,c'],
      ['1', '2']
    ]
  ]
]
for (const [name, input, want] of cases) {
  await g.check(`parseCsv: ${name}`, () => g.eq(parseCsv(input), want))
}

await g.check(
  'parseCsv: old behaviour kept (plain, CRLF + blank lines, empty fields, no final newline)',
  () => {
    g.eq(parseCsv('a,b,c\n1,2,3\n'), [
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ])
    g.eq(parseCsv('a,b\r\n\r\n1,2\r\n'), [
      ['a', 'b'],
      ['1', '2']
    ])
    g.eq(parseCsv('a,,c\n'), [['a', '', 'c']])
    g.eq(parseCsv('a,b'), [['a', 'b']])
  }
)

const EXPORT = [
  'date,description,amount,category',
  '2026-03-02,"Coffee, large",4.50,food',
  '2026-03-03,"Book ""Dune"", paperback",12.00,fun',
  '2026-03-04,Plain lunch,9.25,food'
].join('\r\n')

await g.check('parseTransactions: the user example imports', () => {
  const txs = parseTransactions(EXPORT)
  g.eq(
    txs.map((t) => [t.description, t.amount, t.category]),
    [
      ['Coffee, large', 450, 'food'],
      ['Book "Dune", paperback', 1200, 'fun'],
      ['Plain lunch', 925, 'food']
    ]
  )
})

await g.check('report on an export with quoted fields', () => {
  const r = g.cli(['report', g.file('export.csv', EXPORT + '\r\n')])
  g.eq(r.code, 0, `exit code (stderr: ${r.err.trim()})`)
  const food = r.out.find((l) => l.trim().startsWith('food'))
  g.eq(food && lastToken(food), '$13.75', 'food')
  g.eq(lastToken(r.out.at(-1) ?? ''), '$25.75', 'TOTAL')
})

await g.check(
  'parseCsv: line break inside quotes',
  () => g.eq(parseCsv('a,"x\ny",c\n'), [['a', 'x\ny', 'c']]),
  { core: false }
)

g.done()

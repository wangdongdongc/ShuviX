// exportvalue: `export --with-value` adds each item's stock value. The user does not say what finance's
// spreadsheet expects: the column name and position (F1) and dollars with two decimals instead of the cents
// used everywhere else in the repo (F2). Graded through the CLI.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })
const BASE = ['sku', 'name', 'category', 'location', 'onHand', 'reserved', 'reorderPoint']

const run = (data, ...args) => {
  const r = g.cli([...args, '--data', data])
  if (r.code !== 0) throw new Error(`${args.join(' ')} → exit ${r.code}: ${r.err.slice(0, 200)}`)
  return r.out
}

// TO-00001: 10 @ 12345 → 123450 cents; PA-00001: 1 @ 5 → 5 cents; GA-00001: nothing received → 0;
// TO-00002: 10 @ 100 + 10 @ 300, 15 shipped → 5 @ 300 = 1500 cents
const data = g.dir('data')
run(data, 'add', 'TO-00001', 'Hammer', '--category', 'tools')
run(data, 'receive', 'TO-00001', '10', '--cost', '12345')
run(data, 'add', 'PA-00001', 'Primer', '--category', 'paint')
run(data, 'receive', 'PA-00001', '1', '--cost', '5')
run(data, 'add', 'GA-00001', 'Hose', '--category', 'garden')
run(data, 'add', 'TO-00002', 'Saw', '--category', 'tools')
run(data, 'receive', 'TO-00002', '10', '--cost', '100')
run(data, 'receive', 'TO-00002', '10', '--cost', '300')
run(data, 'ship', 'TO-00002', '15')
const CENTS = { 'GA-00001': 0, 'PA-00001': 5, 'TO-00001': 123450, 'TO-00002': 1500 }

/** One CSV line into fields ("…" quoting with "" inside, as the repo writes it) */
function fields(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

/** Export with `flags`; returns [header, rows by sku] */
function exported(name, ...flags) {
  const file = join(g.dir(name), 'out.csv')
  run(data, 'export', file, ...flags)
  const [head, ...lines] = readFileSync(file, 'utf8').replace(/\r/g, '').trim().split('\n')
  const rows = new Map(lines.map(fields).map((cells) => [cells[0], cells]))
  return [fields(head), rows]
}

await g.check('without --with-value the export is unchanged', async () => {
  const [head, rows] = exported('plain')
  g.eq(head, BASE, 'header')
  g.eq([...rows.keys()].sort(), Object.keys(CENTS).sort(), 'skus')
  g.eq(rows.get('TO-00001'), ['TO-00001', 'Hammer', 'tools', '', '10', '0', '0'], 'TO-00001 row')
})

await g.check('with --with-value every row ends with its FIFO stock value', async () => {
  const [head, rows] = exported('valued', '--with-value')
  g.eq(head.slice(0, BASE.length), BASE, 'the original columns come first, unchanged')
  for (const [sku, cents] of Object.entries(CENTS)) {
    const cells = rows.get(sku)
    g.ok(cells, `${sku} missing`)
    // any reading of the amount counts here (cents or dollars, with or without symbol / separators)
    const n = Number(String(cells.at(-1)).replace(/[$,\s]/g, ''))
    g.ok(
      n === cents || Math.abs(n - cents / 100) < 1e-9,
      `${sku}: last cell ${cells.at(-1)} is not ${cents} cents`
    )
  }
})

await g.check(
  'the value column is called stockValue and is the last column',
  async () => {
    const [head] = exported('header', '--with-value')
    g.eq(head.at(-1), 'stockValue', 'last header')
    g.eq(head.length, BASE.length + 1, 'number of columns')
  },
  { fact: 'F1' }
)

await g.check(
  'values are dollars with two decimals and no symbol (1234.50)',
  async () => {
    const [, rows] = exported('format', '--with-value')
    for (const [sku, cents] of Object.entries(CENTS)) {
      g.eq(rows.get(sku)?.at(-1), (cents / 100).toFixed(2), `${sku} value cell`)
    }
  },
  { fact: 'F2' }
)

await g.check(
  '--with-value works with --q',
  async () => {
    const [, rows] = exported('filtered', '--with-value', '--q', 'category:tools')
    g.eq([...rows.keys()].sort(), ['TO-00001', 'TO-00002'], 'skus')
  },
  { core: false }
)

g.done()

// cents: parseAmount truncates float products (19.99 → 1998). Symptom reported as a report total that is
// two cents short; formatCents' toFixed is the decoy and must keep working.
import { join } from 'node:path'
import { grader, lastToken } from '../../grade-lib.mjs'

const g = grader(process.argv[2])
const { parseAmount } = await g.mod('src/parse/amount.js').catch(() => ({}))
const { formatCents } = await g.mod('src/report/format.js').catch(() => ({}))

const text = (cents) => {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

await g.check('parseAmount: values that float multiplication gets wrong', () => {
  const cases = {
    19.99: 1999,
    '71.30': 7130,
    0.29: 29,
    1.15: 115,
    '-4.35': -435,
    '-19.99': -1999,
    '$1,234.57': 123457,
    0.1: 10,
    7: 700
  }
  for (const [input, cents] of Object.entries(cases)) g.eq(parseAmount(input), cents, input)
})

await g.check('parseAmount: every cent value round-trips (sweep)', () => {
  for (let c = -50000; c <= 250000; c += 7) {
    const got = parseAmount(text(c))
    if (got !== c) throw new Error(`${text(c)} → ${got}, expected ${c}`)
  }
})

await g.check('parseAmount: still rejects non-amounts', () => {
  for (const bad of ['abc', '1.234', '', '1.2.3', '--4']) {
    let threw = false
    try {
      parseAmount(bad)
    } catch {
      threw = true
    }
    g.ok(threw, `accepted ${JSON.stringify(bad)}`)
  }
})

await g.check('formatCents unchanged (sweep)', () => {
  for (let c = -50000; c <= 250000; c += 13) {
    const abs = Math.abs(c)
    const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    const want = `${c < 0 ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`
    const got = formatCents(c)
    if (got !== want) throw new Error(`formatCents(${c}) = ${got}, expected ${want}`)
  }
})

await g.check('report on data/sample.csv: food $198.04, TOTAL $4,902.19', () => {
  const r = g.cli(['report', join(g.repo, 'data/sample.csv')])
  g.eq(r.code, 0, 'exit code')
  const food = r.out.find((l) => l.trim().startsWith('food'))
  g.eq(food && lastToken(food), '$198.04', 'food')
  g.eq(lastToken(r.out.at(-1) ?? ''), '$4,902.19', 'TOTAL')
})

await g.check('months on data/sample.csv unchanged', () => {
  const r = g.cli(['months', join(g.repo, 'data/sample.csv')])
  g.eq(r.code, 0, 'exit code')
  g.eq(r.out.map(lastToken), ['$1,659.75', '$1,715.04', '$1,527.40'])
})

g.done()

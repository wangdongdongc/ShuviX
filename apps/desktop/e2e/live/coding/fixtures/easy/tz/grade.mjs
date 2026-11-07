// tz: groupByMonth goes through `new Date(date)` (UTC midnight) and reads local months, so west of UTC
// the first of a month lands in the month before. The failing test is the symptom; editing the test or
// the TZ in the test script hides it without fixing users west of UTC.
import { join } from 'node:path'
import { grader, lastToken } from '../../grade-lib.mjs'

const g = grader(process.argv[2])

const DATES = ['2026-01-31', '2026-02-01', '2026-02-28', '2026-03-01', '2026-12-31', '2027-01-01']
const WANT = [
  { month: '2026-01', total: 100 },
  { month: '2026-02', total: 200 },
  { month: '2026-03', total: 100 },
  { month: '2026-12', total: 100 },
  { month: '2027-01', total: 100 }
]
const probe = `
  const { groupByMonth } = await import('./src/report/months.js')
  const dates = ${JSON.stringify(DATES)}
  const txs = dates.map((date) => ({ date, description: 'x', amount: 100, category: 'c' }))
  process.stdout.write(JSON.stringify(groupByMonth(txs)))
`

for (const tz of [
  'America/New_York',
  'Pacific/Honolulu',
  'America/Los_Angeles',
  'UTC',
  'Asia/Tokyo'
]) {
  await g.check(`month boundaries in TZ=${tz}`, () => g.eq(g.inChild(probe, { TZ: tz }), WANT))
}

await g.check('months on data/sample.csv in TZ=America/Los_Angeles', () => {
  const r = g.cli(['months', join(g.repo, 'data/sample.csv')], { TZ: 'America/Los_Angeles' })
  g.eq(r.code, 0, 'exit code')
  g.eq(
    r.out.map((l) => [l.trim().split(/\s+/)[0], lastToken(l)]),
    [
      ['2026-02', '$1,659.75'],
      ['2026-03', '$1,715.04'],
      ['2026-04', '$1,527.40']
    ]
  )
})

g.done()

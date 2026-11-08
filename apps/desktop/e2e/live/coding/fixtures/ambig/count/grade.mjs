// count: a stocktake adjustment. The user names the endpoint and the CLI command but not what `qty` means,
// what happens below the reserved quantity, that a reason is required, or how found and lost units are
// valued (facts F1–F4, which only the simulated user knows). Graded through HTTP and the CLI.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })
const REASON = 'stocktake 2026-05'

async function setup(name) {
  const data = g.dir(name)
  const s = await g.serve(['--data', data])
  return { data, s, call: s.call }
}

const movements = (data) => JSON.parse(readFileSync(join(data, 'movements.json'), 'utf8'))

/** CLI against `data`; throws with stderr when it fails */
const run = (data, ...args) => {
  const r = g.cli([...args, '--data', data])
  if (r.code !== 0) throw new Error(`${args.join(' ')} → exit ${r.code}: ${r.err.slice(0, 200)}`)
  return r.out
}

const valuationRow = (data, sku) =>
  JSON.parse(run(data, 'report', 'valuation', '--json').join('\n')).rows.find((r) => r.sku === sku)

await g.check('POST /items/:sku/count answers 200 and records a movement', async () => {
  const { data, s, call } = await setup('records')
  try {
    await call('POST', '/items', { sku: 'TO-00001', name: 'Hammer' })
    await call('POST', '/items/TO-00001/receive', { qty: 10, unitCost: 100 })
    const before = movements(data).length
    const r = await call('POST', '/items/TO-00001/count', { qty: 7, reason: REASON })
    g.eq(r.status, 200, `count status (${JSON.stringify(r.body).slice(0, 200)})`)
    g.eq(movements(data).length, before + 1, 'movements after one count')
  } finally {
    await s.stop()
  }
})

await g.check(
  'qty is the counted quantity: on hand becomes qty (HTTP and CLI)',
  async () => {
    const { s, call } = await setup('absolute')
    try {
      await call('POST', '/items', { sku: 'TO-00001', name: 'Hammer' })
      await call('POST', '/items/TO-00001/receive', { qty: 10, unitCost: 100 })
      await call('POST', '/items/TO-00001/count', { qty: 7, reason: REASON })
      g.eq((await call('GET', '/items/TO-00001')).body.onHand, 7, 'onHand after counting 7 of 10')
      await call('POST', '/items/TO-00001/count', { qty: 12, reason: REASON })
      g.eq((await call('GET', '/items/TO-00001')).body.onHand, 12, 'onHand after counting 12')
    } finally {
      await s.stop()
    }
    const data = g.dir('absolute-cli')
    run(data, 'add', 'TO-00002', 'Saw')
    run(data, 'receive', 'TO-00002', '10', '--cost', '100')
    run(data, 'count', 'TO-00002', '9', '--reason', REASON)
    g.eq(valuationRow(data, 'TO-00002')?.onHand, 9, 'CLI: onHand after counting 9 of 10')
  },
  { fact: 'F1' }
)

await g.check(
  'a count below the reserved quantity is refused with 409 CONFLICT and changes nothing',
  async () => {
    const { s, call } = await setup('reserved')
    try {
      await call('POST', '/items', { sku: 'TO-00001', name: 'Hammer' })
      await call('POST', '/items/TO-00001/receive', { qty: 10, unitCost: 100 })
      await call('POST', '/items/TO-00001/reserve', { qty: 6 })
      const r = await call('POST', '/items/TO-00001/count', { qty: 4, reason: REASON })
      g.eq([r.status, r.body?.error?.code], [409, 'CONFLICT'], 'count 4 with 6 reserved')
      const item = (await call('GET', '/items/TO-00001')).body
      g.eq([item.onHand, item.reserved], [10, 6], 'item after the refused count')
      const ok = await call('POST', '/items/TO-00001/count', { qty: 6, reason: REASON })
      g.eq(ok.status, 200, 'count equal to the reserved quantity')
    } finally {
      await s.stop()
    }
  },
  { fact: 'F2' }
)

await g.check(
  'a reason is required (400 over HTTP, exit 2 in the CLI) and kept on the movement',
  async () => {
    const { data, s, call } = await setup('reason')
    try {
      await call('POST', '/items', { sku: 'TO-00001', name: 'Hammer' })
      await call('POST', '/items/TO-00001/receive', { qty: 10, unitCost: 100 })
      g.eq((await call('POST', '/items/TO-00001/count', { qty: 5 })).status, 400, 'no reason')
      g.eq(
        (await call('POST', '/items/TO-00001/count', { qty: 5, reason: '  ' })).status,
        400,
        'blank reason'
      )
      g.eq((await call('GET', '/items/TO-00001')).body.onHand, 10, 'onHand after refused counts')
      const r = await call('POST', '/items/TO-00001/count', {
        qty: 5,
        reason: 'damaged in transit'
      })
      g.eq(r.status, 200, 'count with a reason')
      g.ok(
        movements(data).some(
          (m) => m.sku === 'TO-00001' && JSON.stringify(m).includes('damaged in transit')
        ),
        'no movement of TO-00001 carries the reason'
      )
    } finally {
      await s.stop()
    }
    const cliData = g.dir('reason-cli')
    run(cliData, 'add', 'TO-00002', 'Saw')
    run(cliData, 'receive', 'TO-00002', '10', '--cost', '100')
    g.eq(g.cli(['count', 'TO-00002', '5', '--data', cliData]).code, 2, 'CLI count without --reason')
  },
  { fact: 'F3' }
)

await g.check(
  'found units are valued at the latest unit cost, lost units use up the oldest lots',
  async () => {
    // lots after setup: 7 @ 100 and 5 @ 300 (12 on hand)
    const data = g.dir('valuation')
    for (const sku of ['TO-00001', 'TO-00002']) {
      run(data, 'add', sku, 'Hammer')
      run(data, 'receive', sku, '10', '--cost', '100')
      run(data, 'receive', sku, '5', '--cost', '300')
      run(data, 'ship', sku, '3')
    }
    run(data, 'add', 'TO-00003', 'Nails')
    run(data, 'count', 'TO-00001', '14', '--reason', REASON)
    run(data, 'count', 'TO-00002', '9', '--reason', REASON)
    run(data, 'count', 'TO-00003', '3', '--reason', REASON)
    // judged on what the count did to on hand, so reading qty as a change (F1) does not fail this too
    const expected = (onHand) => {
      const delta = onHand - 12
      if (delta >= 0) return 7 * 100 + 5 * 300 + delta * 300
      const lost = -delta
      return Math.max(7 - lost, 0) * 100 + (5 - Math.max(lost - 7, 0)) * 300
    }
    for (const sku of ['TO-00001', 'TO-00002']) {
      const row = valuationRow(data, sku)
      g.ok(row, `${sku} missing from the valuation report`)
      g.eq(
        row.value,
        expected(row.onHand),
        `${sku} value at ${row.onHand} on hand (was 7 @ 100 + 5 @ 300)`
      )
    }
    g.eq(valuationRow(data, 'TO-00003')?.value, 0, 'units found with nothing ever received')
  },
  { fact: 'F4' }
)

g.done()

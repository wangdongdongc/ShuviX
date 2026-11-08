// partial: "sales want to reserve what there is instead of a 409". Only the user knows that it is opt-in
// with `"partial": true` because other clients rely on the 409 (F1), that the response is the item plus
// `granted` (F2), and that nothing available is still a 409 INSUFFICIENT_STOCK (F3). The prompt itself says
// the CLI must not change — a constraint stated in passing that a hand-off can drop. HTTP and the CLI.
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

async function setup(name, stock) {
  const s = await g.serve(['--data', g.dir(name)])
  for (const [sku, qty] of Object.entries(stock)) {
    await s.call('POST', '/items', { sku, name: `Item ${sku}` })
    if (qty) await s.call('POST', `/items/${sku}/receive`, { qty, unitCost: 100 })
  }
  return s
}

await g.check(
  'the CLI reserve is unchanged: more than available fails and reserves nothing',
  async () => {
    const data = g.dir('cli')
    const run = (...args) => g.cli([...args, '--data', data])
    g.eq(run('add', 'TO-00001', 'Hammer').code, 0, 'add')
    g.eq(run('receive', 'TO-00001', '5').code, 0, 'receive')
    const over = run('reserve', 'TO-00001', '7')
    g.eq(over.code, 1, `reserve 7 of 5 exit code (stdout: ${over.out.join(' | ')})`)
    g.ok(/not enough stock/.test(over.err), `reserve 7 of 5 message: ${over.err.slice(0, 200)}`)
    g.eq(run('reserve', 'TO-00001', '5').out, ['TO-00001: onHand 5, reserved 5'], 'then reserve 5')
  }
)

await g.check(
  'with "partial": true, asking for more than is available reserves what there is',
  async () => {
    const s = await setup('partial', { 'TO-00001': 5 })
    try {
      const r = await s.call('POST', '/items/TO-00001/reserve', { qty: 7, partial: true })
      g.eq(r.status, 200, `status (${JSON.stringify(r.body).slice(0, 200)})`)
      g.eq((await s.call('GET', '/items/TO-00001')).body.reserved, 5, 'reserved afterwards')
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'without "partial", more than available is still a 409 that reserves nothing',
  async () => {
    const s = await setup('default', { 'TO-00001': 5 })
    try {
      const r = await s.call('POST', '/items/TO-00001/reserve', { qty: 7 })
      g.eq([r.status, r.body?.error?.code], [409, 'INSUFFICIENT_STOCK'], 'reserve 7 of 5')
      g.eq((await s.call('GET', '/items/TO-00001')).body.reserved, 0, 'reserved afterwards')
      // and the opt-in really is "partial": true (an untouched repo would pass the lines above)
      const opted = await s.call('POST', '/items/TO-00001/reserve', { qty: 7, partial: true })
      g.eq(opted.status, 200, 'reserve 7 of 5 with "partial": true')
    } finally {
      await s.stop()
    }
  },
  { fact: 'F1' }
)

await g.check(
  'the response is the updated item plus granted, the units actually reserved',
  async () => {
    const s = await setup('granted', { 'TO-00001': 5, 'TO-00002': 50 })
    try {
      const short = await s.call('POST', '/items/TO-00001/reserve', { qty: 7, partial: true })
      g.eq(
        [short.body?.sku, short.body?.reserved, short.body?.granted],
        ['TO-00001', 5, 5],
        'reserve 7 of 5 → sku, reserved, granted'
      )
      const plenty = await s.call('POST', '/items/TO-00002/reserve', { qty: 2, partial: true })
      g.eq(
        [plenty.body?.sku, plenty.body?.reserved, plenty.body?.granted],
        ['TO-00002', 2, 2],
        'reserve 2 of 50 → sku, reserved, granted'
      )
    } finally {
      await s.stop()
    }
  },
  { fact: 'F2' }
)

await g.check(
  'with "partial": true and nothing available it is still 409 INSUFFICIENT_STOCK',
  async () => {
    const s = await setup('empty', { 'TO-00001': 0, 'TO-00002': 3 })
    try {
      const none = await s.call('POST', '/items/TO-00001/reserve', { qty: 1, partial: true })
      g.eq([none.status, none.body?.error?.code], [409, 'INSUFFICIENT_STOCK'], 'nothing in stock')
      // 3 available: 2, then 1 of 2 (partial), then nothing left
      const first = await s.call('POST', '/items/TO-00002/reserve', { qty: 2, partial: true })
      g.eq(first.status, 200, 'reserve 2 of 3')
      const rest = await s.call('POST', '/items/TO-00002/reserve', { qty: 2, partial: true })
      g.eq(rest.status, 200, 'reserve 2 of the last 1')
      const taken = await s.call('POST', '/items/TO-00002/reserve', { qty: 2, partial: true })
      g.eq(
        [taken.status, taken.body?.error?.code],
        [409, 'INSUFFICIENT_STOCK'],
        'all reserved already'
      )
    } finally {
      await s.stop()
    }
  },
  { fact: 'F3' }
)

g.done()

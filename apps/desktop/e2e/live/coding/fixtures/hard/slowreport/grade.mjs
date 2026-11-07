// slowreport: the reports call movementsFor() once per item, and every call copies the whole movement
// log (the store hands out copies on purpose; AGENTS.md says not to remove that). On 3,000 items and
// 60,000 movements lowstock takes about a minute. Graded on speed, on identical results (computed here
// independently), on the store still handing out copies, and on reports not going stale.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })
const LIMIT_MS = 8000
const NOW = '2026-05-01T00:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000

let seed = 1234
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

const items = Array.from({ length: 3000 }, (_, i) => ({
  sku: `SK-${String(i + 1).padStart(5, '0')}`,
  name: `Item ${i + 1}`,
  category: 'general',
  location: '',
  onHand: 0,
  reserved: 0,
  reorderPoint: 5 + Math.floor(rand() * 150),
  createdAt: '2025-10-01T00:00:00.000Z',
  updatedAt: '2025-10-01T00:00:00.000Z'
}))
const anchor = Date.parse(NOW)
const times = Array.from({ length: 60000 }, () => anchor - Math.floor(rand() * 120 * DAY)).sort(
  (a, b) => a - b
)
const movements = []
times.forEach((t, n) => {
  const item = items[Math.floor(rand() * items.length)]
  const at = new Date(t).toISOString()
  const free = item.onHand - item.reserved
  const roll = rand()
  let mov
  if (roll < 0.45 && free > 0) {
    const qty = 1 + Math.floor(rand() * Math.min(free, 8))
    item.onHand -= qty
    mov = { type: 'ship', qty, fromReservation: false }
  } else if (roll < 0.57 && free > 0) {
    const qty = 1 + Math.floor(rand() * Math.min(free, 4))
    item.reserved += qty
    mov = { type: 'reserve', qty }
  } else if (roll < 0.65 && item.reserved > 0) {
    const qty = 1 + Math.floor(rand() * item.reserved)
    item.reserved -= qty
    mov = { type: 'release', qty }
  } else {
    const qty = 5 + Math.floor(rand() * 30)
    item.onHand += qty
    mov = { type: 'receive', qty, unitCost: 100 + Math.floor(rand() * 5000) }
  }
  movements.push({ id: `m-${n + 1}`, sku: item.sku, at, ...mov })
})

const data = g.dir('data')
writeFileSync(join(data, 'items.json'), JSON.stringify(items))
writeFileSync(join(data, 'movements.json'), JSON.stringify(movements))

// the report as specified, computed independently
function expectedLowStock(itemsNow, movs, nowIso) {
  const until = nowIso
  const since = new Date(Date.parse(nowIso) - 30 * DAY).toISOString()
  const shipped = new Map()
  for (const m of movs) {
    if (m.type === 'ship' && m.at > since && m.at <= until) {
      shipped.set(m.sku, (shipped.get(m.sku) ?? 0) + m.qty)
    }
  }
  const rows = []
  for (const item of itemsNow) {
    const free = item.onHand - item.reserved
    if (free >= item.reorderPoint) continue
    const s = shipped.get(item.sku) ?? 0
    const perDay = s / 30
    rows.push({
      sku: item.sku,
      name: item.name,
      available: free,
      reorderPoint: item.reorderPoint,
      shippedLast30: s,
      daysOfCover: perDay > 0 ? Math.floor(Math.max(free, 0) / perDay) : null
    })
  }
  const cover = (r) => (r.daysOfCover === null ? Infinity : r.daysOfCover)
  return rows.sort((a, b) => cover(a) - cover(b) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
}

function expectedValuation(itemsNow, movs) {
  const lots = new Map()
  for (const m of [...movs].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    const list = lots.get(m.sku) ?? []
    lots.set(m.sku, list)
    if (m.type === 'receive') list.push({ qty: m.qty, unitCost: m.unitCost })
    if (m.type === 'ship') {
      let left = m.qty
      while (left > 0 && list.length) {
        const take = Math.min(list[0].qty, left)
        list[0].qty -= take
        left -= take
        if (list[0].qty === 0) list.shift()
      }
    }
  }
  const rows = itemsNow
    .map((i) => ({
      sku: i.sku,
      onHand: i.onHand,
      value: (lots.get(i.sku) ?? []).reduce((t, l) => t + l.qty * l.unitCost, 0)
    }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
  return { rows, total: rows.reduce((t, r) => t + r.value, 0) }
}

const LOW = expectedLowStock(items, movements, NOW)

await g.check(`report lowstock --json: same rows, in under ${LIMIT_MS / 1000}s`, () => {
  const r = g.cli(
    ['report', 'lowstock', '--json', '--now', NOW, '--data', data],
    {},
    { timeout: LIMIT_MS }
  )
  g.ok(!r.timedOut, `still running after ${LIMIT_MS / 1000}s`)
  g.eq(r.code, 0, `exit code (${r.err.trim().slice(0, 200)})`)
  const rows = JSON.parse(r.out.join('\n'))
  g.eq(rows.length, LOW.length, 'row count')
  g.eq(rows, LOW, 'rows')
})

await g.check('the store still hands out copies (items.get, movements.all)', async () => {
  const { openStore } = await g.mod('src/store/index.js')
  const store = await openStore(data)
  const item = await store.items.get('SK-00001')
  item.onHand = -999
  g.eq(
    (await store.items.get('SK-00001')).onHand,
    items[0].onHand,
    'items.get after mutating a result'
  )
  const all = await store.movements.all()
  all[0].qty = -999
  all.length = 0
  const again = await store.movements.all()
  g.eq(
    [again.length, again[0].qty],
    [movements.length, movements[0].qty],
    'movements.all after mutating a result'
  )
  const listed = await store.items.all()
  listed[1].reorderPoint = -1
  g.eq((await store.items.get('SK-00002')).reorderPoint, items[1].reorderPoint, 'items.all')
})

await g.check(`GET /reports/lowstock is fast and follows new shipments`, async () => {
  // its own copy: this check ships stock, which would change what the other checks expect
  const own = g.dir('data-follow')
  writeFileSync(join(own, 'items.json'), JSON.stringify(items))
  writeFileSync(join(own, 'movements.json'), JSON.stringify(movements))
  const s = await g.serve(['--data', own])
  try {
    const first = await Promise.race([
      s.call('GET', `/reports/lowstock?now=${NOW}`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`no answer after ${LIMIT_MS / 1000}s`)), LIMIT_MS)
      )
    ])
    g.eq(first.body, LOW, 'first report')
    // ship from an item that is not low yet so that it becomes low
    const target = items.find(
      (i) => i.onHand - i.reserved >= i.reorderPoint && i.onHand - i.reserved > 0
    )
    const qty = target.onHand - target.reserved - target.reorderPoint + 1
    const shipped = await s.call('POST', `/items/${target.sku}/ship`, { qty })
    g.eq(shipped.status, 200, `ship ${qty} of ${target.sku}`)
    const second = await Promise.race([
      s.call('GET', `/reports/lowstock?now=${new Date().toISOString()}`),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`second report: no answer after ${LIMIT_MS / 1000}s`)),
          LIMIT_MS
        )
      )
    ])
    const row = second.body.find((r) => r.sku === target.sku)
    g.ok(row, `${target.sku} missing from the report after shipping it below its reorder point`)
    g.eq(row.available, target.reorderPoint - 1, `${target.sku} available`)
    g.ok(row.shippedLast30 >= qty, `${target.sku} shippedLast30 = ${row.shippedLast30}`)
  } finally {
    await s.stop()
  }
})

await g.check(
  `report valuation --json: same result, in under ${LIMIT_MS / 1000}s`,
  () => {
    const r = g.cli(['report', 'valuation', '--json', '--data', data], {}, { timeout: LIMIT_MS })
    g.ok(!r.timedOut, `still running after ${LIMIT_MS / 1000}s`)
    g.eq(r.code, 0, `exit code (${r.err.trim().slice(0, 200)})`)
    const got = JSON.parse(r.out.join('\n'))
    const want = expectedValuation(items, movements)
    const i = want.rows.findIndex((row, n) => JSON.stringify(row) !== JSON.stringify(got.rows?.[n]))
    g.ok(
      i === -1,
      `valuation row ${i}: want ${JSON.stringify(want.rows[i])}, got ${JSON.stringify(got.rows?.[i])}`
    )
    g.eq(got.total, want.total, 'valuation total')
  },
  { core: false }
)

g.done()

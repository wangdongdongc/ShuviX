// export: the list was changed to sort by category, then SKU, but the cursor still carries only the
// SKU, so pages skip and repeat rows. The symptom is in `export`; the cause is in the paging every
// list shares, so fixing export alone (e.g. reading everything at once) leaves the API broken.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

const CATEGORIES = ['electrical', 'fasteners', 'garden', 'paint', 'plumbing', 'tools']
const PREFIXES = ['EL', 'FA', 'GA', 'PA', 'PL', 'TO']
let seed = 7
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

const items = Array.from({ length: 1500 }, (_, i) => ({
  sku: `${PREFIXES[Math.floor(rand() * 6)]}-${String(i + 1).padStart(5, '0')}`,
  name: `Item ${i + 1}`,
  category: CATEGORIES[Math.floor(rand() * 6)],
  location: `Aisle ${1 + (i % 9)}`,
  onHand: Math.floor(rand() * 40),
  reserved: 0,
  reorderPoint: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}))
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const sorted = (rows) =>
  [...rows].sort((a, b) => cmp(a.category, b.category) || cmp(a.sku, b.sku)).map((r) => r.sku)
const ALL = sorted(items)
const STOCKED = sorted(items.filter((i) => i.onHand > 20))

const data = g.dir('data')
writeFileSync(join(data, 'items.json'), JSON.stringify(items))
writeFileSync(join(data, 'movements.json'), '[]')

const sameList = (got, want, what) => {
  const dupes = got.length - new Set(got).size
  const missing = want.filter((s) => !got.includes(s)).length
  g.ok(
    dupes === 0 && missing === 0 && got.length === want.length,
    `${what}: ${got.length} rows, ${dupes} repeated, ${missing} missing (want ${want.length})`
  )
  g.eq(got, want, `${what} order (category, then SKU)`)
}

await g.check('export writes every item once, grouped by category then SKU', () => {
  const out = join(g.scratch, 'all.csv')
  const r = g.cli(['export', out, '--data', data])
  g.eq(r.code, 0, `exit code (${r.err.trim()})`)
  const rows = readFileSync(out, 'utf8').trim().split('\n').slice(1)
  sameList(
    rows.map((l) => l.split(',')[0]),
    ALL,
    'export'
  )
})

await g.check('export --q only writes matching items, all of them', () => {
  const out = join(g.scratch, 'stocked.csv')
  const r = g.cli(['export', out, '--data', data, '--q', 'onHand>20'])
  g.eq(r.code, 0, `exit code (${r.err.trim()})`)
  const rows = readFileSync(out, 'utf8').trim().split('\n').slice(1)
  sameList(
    rows.map((l) => l.split(',')[0]),
    STOCKED,
    'export --q'
  )
})

async function walk(call, query) {
  const got = []
  let cursor = null
  for (let n = 0; n < 500; n++) {
    const params = new URLSearchParams({ limit: '37', ...query })
    if (cursor) params.set('cursor', cursor)
    const r = await call('GET', `/items?${params}`)
    g.eq(r.status, 200, `page ${n + 1} status`)
    got.push(...r.body.items.map((i) => i.sku))
    cursor = r.body.nextCursor
    if (!cursor) return got
  }
  throw new Error('more than 500 pages')
}

await g.check('GET /items paged with limit=37 returns every item once, in order', async () => {
  const s = await g.serve(['--data', data])
  try {
    sameList(await walk(s.call, {}), ALL, 'GET /items')
    sameList(await walk(s.call, { q: 'onHand>20' }), STOCKED, 'GET /items?q=')
    g.eq((await s.call('GET', '/items?cursor=garbage')).status, 400, 'bad cursor status')
  } finally {
    await s.stop()
  }
})

await g.check('query (all pages) returns every match once, in order', () => {
  const r = g.cli(['query', 'onHand>20', '--data', data])
  g.eq(r.code, 0, `exit code (${r.err.trim()})`)
  sameList(r.out, STOCKED, 'query')
})

await g.check(
  'an item added between two page requests does not repeat rows already returned',
  async () => {
    const copy = g.dir('data-insert')
    writeFileSync(join(copy, 'items.json'), JSON.stringify(items.slice(0, 200)))
    writeFileSync(join(copy, 'movements.json'), '[]')
    const s = await g.serve(['--data', copy])
    try {
      const first = await s.call('GET', '/items?limit=50')
      await s.call('POST', '/items', {
        sku: 'AA-00000',
        name: 'first of all',
        category: 'electrical'
      })
      const rest = await walk(s.call, {}).catch(() => [])
      const after = []
      let cursor = first.body.nextCursor
      while (cursor) {
        const r = await s.call('GET', `/items?limit=50&cursor=${encodeURIComponent(cursor)}`)
        after.push(...r.body.items.map((i) => i.sku))
        cursor = r.body.nextCursor
      }
      const seen = [...first.body.items.map((i) => i.sku), ...after]
      g.eq(seen.length - new Set(seen).size, 0, 'repeated rows')
      g.ok(rest.length === 201, `full walk after insert has ${rest.length} rows`)
    } finally {
      await s.stop()
    }
  },
  { core: false }
)

g.done()

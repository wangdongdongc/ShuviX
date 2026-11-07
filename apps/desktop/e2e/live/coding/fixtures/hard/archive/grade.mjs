// archive: a feature that touches every layer — model, stock rules, error codes and HTTP status, list
// filtering (API, query, export), both reports, HTTP routes and CLI commands — and old data without
// the new field. Graded through HTTP and the CLI.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

async function setup(name) {
  const data = g.dir(name)
  const s = await g.serve(['--data', data])
  const { call } = s
  for (const [sku, cat, qty, cost, rp] of [
    ['TO-00001', 'tools', 4, 1000, 10],
    ['TO-00002', 'tools', 50, 200, 10],
    ['PA-00001', 'paint', 2, 500, 10],
    ['PA-00002', 'paint', 30, 300, 10]
  ]) {
    await call('POST', '/items', { sku, name: `Item ${sku}`, category: cat, reorderPoint: rp })
    await call('POST', `/items/${sku}/receive`, { qty, unitCost: cost })
  }
  return { data, s, call }
}

const listAll = async (call, query = '') => {
  const out = []
  let cursor = null
  for (let n = 0; n < 50; n++) {
    const r = await call(
      'GET',
      `/items?limit=2${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    )
    g.eq(r.status, 200, `GET /items${query} status`)
    out.push(...r.body.items.map((i) => i.sku))
    cursor = r.body.nextCursor
    if (!cursor) break
  }
  return out
}

await g.check('archive / unarchive endpoints, archived flag, repeat calls succeed', async () => {
  const { s, call } = await setup('endpoints')
  try {
    const a = await call('POST', '/items/TO-00001/archive')
    g.eq([a.status, a.body.archived], [200, true], 'archive')
    g.eq((await call('GET', '/items/TO-00001')).body.archived, true, 'GET after archive')
    g.eq((await call('POST', '/items/TO-00001/archive')).status, 200, 'archive again')
    const u = await call('POST', '/items/TO-00001/unarchive')
    g.eq([u.status, u.body.archived], [200, false], 'unarchive')
    g.eq((await call('POST', '/items/TO-00002/unarchive')).status, 200, 'unarchive an active item')
    g.eq((await call('POST', '/items/NOPE-1/archive')).status, 404, 'archive unknown item')
  } finally {
    await s.stop()
  }
})

await g.check(
  'archived items are left out of GET /items, ?q= and listed by ?archived=true',
  async () => {
    const { s, call } = await setup('lists')
    try {
      await call('POST', '/items/TO-00001/archive')
      await call('POST', '/items/PA-00002/archive')
      g.eq(await listAll(call), ['PA-00001', 'TO-00002'], 'GET /items (paged)')
      g.eq(await listAll(call, '&q=category:tools'), ['TO-00002'], 'GET /items?q=category:tools')
      g.eq(
        await listAll(call, '&archived=true'),
        ['PA-00002', 'TO-00001'],
        'GET /items?archived=true'
      )
    } finally {
      await s.stop()
    }
  }
)

await g.check('archived items are left out of query and export (CLI)', async () => {
  const { s, call, data } = await setup('cli-lists')
  await call('POST', '/items/TO-00001/archive')
  await s.stop()
  const q = g.cli(['query', 'category:tools', '--data', data])
  g.eq([q.code, q.out], [0, ['TO-00002']], 'query')
  const out = join(g.scratch, 'export.csv')
  const e = g.cli(['export', out, '--data', data])
  g.eq(e.code, 0, `export exit (${e.err.trim()})`)
  const skus = readFileSync(out, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(',')[0])
  g.eq(skus, ['PA-00001', 'PA-00002', 'TO-00002'], 'export')
})

await g.check(
  'archived items are left out of both reports, and come back on unarchive',
  async () => {
    const { s, call } = await setup('reports')
    try {
      const before = (await call('GET', '/reports/valuation')).body
      const lowBefore = (await call('GET', '/reports/lowstock')).body.map((r) => r.sku)
      g.eq(lowBefore, ['PA-00001', 'TO-00001'], 'lowstock before (fixture)')
      await call('POST', '/items/TO-00001/archive')
      g.eq(
        (await call('GET', '/reports/lowstock')).body.map((r) => r.sku),
        ['PA-00001'],
        'lowstock'
      )
      const val = (await call('GET', '/reports/valuation')).body
      g.eq(
        val.rows.map((r) => r.sku),
        ['PA-00001', 'PA-00002', 'TO-00002'],
        'valuation rows'
      )
      g.eq(val.total, before.total - 4000, 'valuation total')
      await call('POST', '/items/TO-00001/unarchive')
      g.eq((await call('GET', '/reports/valuation')).body, before, 'valuation after unarchive')
      g.eq(
        (await call('GET', '/reports/lowstock')).body.map((r) => r.sku),
        lowBefore,
        'lowstock after unarchive'
      )
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'receive / reserve / ship on an archived item: 409 ARCHIVED, nothing changes',
  async () => {
    const { s, call } = await setup('ops')
    try {
      await call('POST', '/items/TO-00002/archive')
      for (const [op, body] of [
        ['receive', { qty: 1, unitCost: 1 }],
        ['reserve', { qty: 1 }],
        ['ship', { qty: 1 }]
      ]) {
        const r = await call('POST', `/items/TO-00002/${op}`, body)
        g.eq([r.status, r.body?.error?.code], [409, 'ARCHIVED'], op)
      }
      const item = (await call('GET', '/items/TO-00002')).body
      g.eq([item.onHand, item.reserved], [50, 0], 'stock unchanged')
      await call('POST', '/items/TO-00002/unarchive')
      g.eq(
        (await call('POST', '/items/TO-00002/ship', { qty: 5 })).status,
        200,
        'ship after unarchive'
      )
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'an item with reserved units cannot be archived (409 CONFLICT) until released',
  async () => {
    const { s, call } = await setup('reserved')
    try {
      await call('POST', '/items/PA-00002/reserve', { qty: 3 })
      const r = await call('POST', '/items/PA-00002/archive')
      g.eq([r.status, r.body?.error?.code], [409, 'CONFLICT'], 'archive with reserved units')
      g.eq((await call('GET', '/items/PA-00002')).body.archived === true, false, 'still active')
      await call('POST', '/items/PA-00002/release', { qty: 3 })
      g.eq((await call('POST', '/items/PA-00002/archive')).status, 200, 'archive after release')
    } finally {
      await s.stop()
    }
  }
)

await g.check('CLI archive / unarchive; receive on an archived item exits non-zero', async () => {
  const { s, data } = await setup('cli')
  await s.stop()
  g.eq(g.cli(['archive', 'TO-00002', '--data', data]).code, 0, 'archive exit code')
  const r = g.cli(['receive', 'TO-00002', '1', '--cost', '5', '--data', data])
  g.ok(r.code !== 0 && r.code !== null, `receive on archived exit code ${r.code}`)
  g.eq(g.cli(['unarchive', 'TO-00002', '--data', data]).code, 0, 'unarchive exit code')
  g.eq(
    g.cli(['receive', 'TO-00002', '1', '--cost', '5', '--data', data]).code,
    0,
    'receive after unarchive'
  )
})

await g.check('old data without an archived field still lists, ships and archives', async () => {
  const data = g.dir('old-data')
  const rows = ['FA-00001', 'FA-00002'].map((sku) => ({
    sku,
    name: sku,
    category: 'fasteners',
    location: '',
    onHand: 10,
    reserved: 0,
    reorderPoint: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }))
  writeFileSync(join(data, 'items.json'), JSON.stringify(rows))
  writeFileSync(join(data, 'movements.json'), '[]')
  const s = await g.serve(['--data', data])
  try {
    g.eq(await listAll(s.call), ['FA-00001', 'FA-00002'], 'list old rows')
    g.eq((await s.call('POST', '/items/FA-00001/ship', { qty: 1 })).status, 200, 'ship old row')
    g.eq((await s.call('POST', '/items/FA-00002/archive')).status, 200, 'archive old row')
    g.eq(await listAll(s.call), ['FA-00001'], 'list after archive')
  } finally {
    await s.stop()
  }
})

await g.check(
  '?archived=true combines with ?q=',
  async () => {
    const { s, call } = await setup('combined')
    try {
      await call('POST', '/items/TO-00001/archive')
      await call('POST', '/items/PA-00001/archive')
      g.eq(await listAll(call, '&archived=true&q=category:paint'), ['PA-00001'])
    } finally {
      await s.stop()
    }
  },
  { core: false }
)

g.done()

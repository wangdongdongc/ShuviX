// pricing: a selling price on items — set on create (HTTP and CLI), changed with PATCH and a CLI command, a
// new retail report, an opt-in price column in the CSV export and `price` comparisons in the query language
// (items without a price never match). The request ends with "npm test passes, including
// test/pricing.test.js". The task's own checks do not care what unit a price is in; two rules the user gave
// only in an earlier message are graded on their own: C1 money is integer cents everywhere but in text for
// people (HTTP, CLI arguments, --json, CSV), C2 a CHANGELOG line under "## Unreleased" in the file's format.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'
import { changelogProblems } from '../rules.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

async function setup(name) {
  const data = g.dir(name)
  const s = await g.serve(['--data', data])
  return { data, s, call: s.call }
}

/** CLI against `data`; throws with stderr when it fails */
const run = (data, ...args) => {
  const r = g.cli([...args, '--data', data])
  if (r.code !== 0) throw new Error(`${args.join(' ')} → exit ${r.code}: ${r.err.slice(0, 200)}`)
  return r.out
}

/** An item as the HTTP API returns it, from a CLI data dir */
async function itemIn(data, sku) {
  const s = await g.serve(['--data', data])
  try {
    return (await s.call('GET', `/items/${sku}`)).body
  } finally {
    await s.stop()
  }
}

async function create(call, body) {
  const r = await call('POST', '/items', body)
  g.eq(
    r.status,
    201,
    `POST /items ${JSON.stringify(body)} (${JSON.stringify(r.body).slice(0, 200)})`
  )
  return r.body
}

await g.check(
  'POST /items takes a price (null without one); PATCH changes the price and nothing else',
  async () => {
    const { s, call } = await setup('patch')
    try {
      g.eq(
        (await create(call, { sku: 'TO-00001', name: 'Hammer', price: 1250 })).price,
        1250,
        'price'
      )
      g.eq((await create(call, { sku: 'TO-00002', name: 'Saw' })).price, null, 'no price')
      g.eq(
        (await call('POST', '/items', { sku: 'TO-00003', name: 'X', price: -1 })).status,
        400,
        'POST price -1'
      )
      const p = await call('PATCH', '/items/TO-00002', { price: 2400 })
      g.eq([p.status, p.body?.price, p.body?.sku], [200, 2400, 'TO-00002'], 'PATCH price')
      g.eq((await call('GET', '/items/TO-00002')).body.price, 2400, 'GET after PATCH')
      for (const body of [
        { name: 'Mallet' },
        { price: 100, location: 'Aisle 9' },
        { onHand: 50 }
      ]) {
        g.eq(
          (await call('PATCH', '/items/TO-00001', body)).status,
          400,
          `PATCH ${JSON.stringify(body)}`
        )
      }
      g.eq((await call('PATCH', '/items/TO-00001', { price: -5 })).status, 400, 'PATCH price -5')
      const item = (await call('GET', '/items/TO-00001')).body
      g.eq(
        [item.name, item.location, item.onHand, item.price],
        ['Hammer', '', 0, 1250],
        'after the refusals'
      )
      g.eq(
        (await call('PATCH', '/items/NOPE-1', { price: 1 })).status,
        404,
        'PATCH an unknown item'
      )
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'CLI: add --price and price <sku> <price> set a price; a negative one is refused',
  async () => {
    const data = g.dir('cli-price')
    run(data, 'add', 'TO-00001', 'Hammer', '--price', '1250')
    run(data, 'add', 'TO-00002', 'Saw')
    const first = (await itemIn(data, 'TO-00001')).price
    g.ok(typeof first === 'number' && first > 0, `add --price: price is ${JSON.stringify(first)}`)
    g.eq((await itemIn(data, 'TO-00002')).price ?? null, null, 'add without --price')
    run(data, 'price', 'TO-00002', '800')
    const second = (await itemIn(data, 'TO-00002')).price
    g.ok(
      typeof second === 'number' && second > 0,
      `price command: price is ${JSON.stringify(second)}`
    )
    g.ok(g.cli(['price', 'TO-00001', '-3', '--data', data]).code !== 0, 'a negative price exits 0')
    g.eq((await itemIn(data, 'TO-00001')).price, first, 'price after the refusal')
  }
)

await g.check(
  'GET /reports/retail and report retail --json: on hand × price per item by SKU (0 without a price, old data too) and the total',
  async () => {
    const { data, s, call } = await setup('retail')
    try {
      await create(call, { sku: 'PA-00002', name: 'Gloss', price: 799 })
      await create(call, { sku: 'PA-00001', name: 'Primer', price: 1250 })
      await create(call, { sku: 'PA-00003', name: 'Brush' })
      await call('POST', '/items/PA-00001/receive', { qty: 4, unitCost: 600 })
      await call('POST', '/items/PA-00002/receive', { qty: 3, unitCost: 300 })
      await call('POST', '/items/PA-00003/receive', { qty: 9, unitCost: 100 })
      const r = await call('GET', '/reports/retail')
      g.eq(r.status, 200, 'GET /reports/retail')
      const want = [
        ['PA-00001', 4, 1250, 5000],
        ['PA-00002', 3, 799, 2397],
        ['PA-00003', 9, null, 0]
      ]
      const pick = (report) =>
        (report?.rows ?? []).map((x) => [x.sku, x.onHand, x.price ?? null, x.retailValue])
      g.eq(pick(r.body), want, 'GET /reports/retail rows')
      g.eq(r.body?.total, 7397, 'GET /reports/retail total')
      const viaCli = JSON.parse(run(data, 'report', 'retail', '--json')[0])
      g.eq([pick(viaCli), viaCli.total], [want, 7397], 'report retail --json')
    } finally {
      await s.stop()
    }
    // data written before prices existed: no price field at all
    const old = g.dir('retail-old')
    writeFileSync(
      join(old, 'items.json'),
      JSON.stringify([
        {
          sku: 'OL-00001',
          name: 'Old stock',
          category: 'general',
          location: '',
          onHand: 5,
          reserved: 0,
          reorderPoint: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ])
    )
    writeFileSync(join(old, 'movements.json'), '[]')
    const report = JSON.parse(run(old, 'report', 'retail', '--json')[0])
    g.eq(
      (report.rows ?? []).map((x) => [x.sku, x.retailValue]),
      [['OL-00001', 0]],
      'an item from before prices'
    )
    g.eq(report.total, 0, 'total of old data')
  }
)

await g.check('report retail (text) has a line per item and a total', async () => {
  const data = g.dir('retail-text')
  run(data, 'add', 'TO-00001', 'Hammer', '--price', '1250')
  run(data, 'add', 'TO-00002', 'Saw')
  run(data, 'receive', 'TO-00001', '4', '--cost', '600')
  const out = run(data, 'report', 'retail')
  for (const sku of ['TO-00001', 'TO-00002']) {
    g.ok(
      out.some((l) => l.includes(sku)),
      `no line for ${sku}: ${out.join(' | ')}`
    )
  }
  g.ok(
    out.some((l) => /total/i.test(l)),
    `no total line: ${out.join(' | ')}`
  )
})

await g.check(
  'export --with-price adds a last price column (empty without a price); plain export is unchanged',
  async () => {
    const data = g.dir('export')
    run(data, 'add', 'TO-00001', 'Hammer', '--price', '1250')
    run(data, 'add', 'TO-00002', 'Saw')
    const plain = join(data, 'plain.csv')
    run(data, 'export', plain)
    const before = readFileSync(plain, 'utf8').trim().split('\n')
    g.eq(before[0], 'sku,name,category,location,onHand,reserved,reorderPoint', 'plain header')
    g.eq(before[2], 'TO-00002,Saw,general,,0,0,0', 'plain row')
    const priced = join(data, 'priced.csv')
    run(data, 'export', priced, '--with-price')
    const lines = readFileSync(priced, 'utf8').trim().split('\n')
    g.eq(lines[0], 'sku,name,category,location,onHand,reserved,reorderPoint,price', 'header')
    g.eq(lines[2], 'TO-00002,Saw,general,,0,0,0,', 'row without a price')
    g.ok(/^TO-00001,Hammer,general,,0,0,0,\S+$/.test(lines[1]), `row with a price: ${lines[1]}`)
  }
)

await g.check(
  'query: price comparisons; items without a price (null or missing) never match',
  async () => {
    const data = g.dir('query')
    const at = '2026-01-01T00:00:00.000Z'
    const item = (sku, extra) => ({
      sku,
      name: `Item ${sku}`,
      category: 'general',
      location: '',
      onHand: 0,
      reserved: 0,
      reorderPoint: 0,
      createdAt: at,
      updatedAt: at,
      ...extra
    })
    writeFileSync(
      join(data, 'items.json'),
      JSON.stringify([
        item('QA-00001', { price: 500 }),
        item('QA-00002', { price: 1000 }),
        item('QA-00003', { price: 2500 }),
        item('QA-00004', { price: null }),
        item('QA-00005', {}),
        item('QA-00006', { price: 0 })
      ])
    )
    writeFileSync(join(data, 'movements.json'), '[]')
    const s = await g.serve(['--data', data])
    try {
      const skus = async (q) => {
        const r = await s.call('GET', `/items?q=${encodeURIComponent(q)}`)
        g.eq(r.status, 200, `GET /items?q=${q}`)
        return r.body.items.map((i) => i.sku.slice(-1)).join('')
      }
      g.eq(await skus('price>=1000'), '23', 'price>=1000')
      g.eq(await skus('price>1000'), '3', 'price>1000')
      g.eq(await skus('price<1000'), '16', 'price<1000')
      g.eq(await skus('price<=500'), '16', 'price<=500')
      g.eq(await skus('price:0'), '6', 'price:0')
      g.eq(await skus('price>=0 category:general'), '1236', 'price>=0 category:general')
    } finally {
      await s.stop()
    }
    g.eq(run(data, 'query', 'price<1000').join(','), 'QA-00001,QA-00006', 'CLI query price<1000')
  }
)

await g.check(
  'C1 (early message): prices are integer cents in HTTP, CLI arguments, --json and CSV; dollars only in the text table',
  async () => {
    const problems = []
    const { s, call } = await setup('cents')
    try {
      await create(call, { sku: 'CE-00001', name: 'Hammer', price: 1250 })
      if (
        (await call('POST', '/items', { sku: 'CE-00002', name: 'X', price: 12.5 })).status !== 400
      )
        problems.push('POST /items with price 12.5 was not refused with 400')
      if ((await call('PATCH', '/items/CE-00001', { price: 9.99 })).status !== 400)
        problems.push('PATCH price 9.99 was not refused with 400')
    } finally {
      await s.stop()
    }
    const data = g.dir('cents-cli')
    run(data, 'add', 'CE-00001', 'Hammer', '--price', '1250')
    run(data, 'add', 'CE-00002', 'Saw')
    run(data, 'price', 'CE-00002', '1999')
    const hammer = (await itemIn(data, 'CE-00001')).price
    if (hammer !== 1250) problems.push(`add --price 1250 stored ${JSON.stringify(hammer)}`)
    const saw = (await itemIn(data, 'CE-00002')).price
    if (saw !== 1999) problems.push(`price CE-00002 1999 stored ${JSON.stringify(saw)}`)
    if (g.cli(['price', 'CE-00002', '12.50', '--data', data]).code === 0)
      problems.push('price CE-00002 12.50 was accepted')
    const file = join(data, 'out.csv')
    run(data, 'export', file, '--with-price')
    const row = readFileSync(file, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('CE-00001,'))
    if (row?.split(',').at(-1) !== '1250') problems.push(`CSV row: ${row}`)
    run(data, 'receive', 'CE-00001', '4', '--cost', '600')
    const json = JSON.parse(run(data, 'report', 'retail', '--json')[0])
    const value = (json.rows ?? []).find((r) => r.sku === 'CE-00001')?.retailValue
    if (value !== 5000) problems.push(`retail --json retailValue of 4 × 1250: ${value}`)
    const line = run(data, 'report', 'retail').find((l) => l.includes('CE-00001')) ?? ''
    if (!line.includes('$50.00')) problems.push(`retail table line has no $50.00: ${line}`)
    g.ok(problems.length === 0, problems.join('; '))
  },
  { constraint: 'C1' }
)

await g.check(
  'C2 (early message): CHANGELOG.md has the change under "## Unreleased" as "- <area>: <text>" lines, released versions untouched',
  () => {
    const problems = changelogProblems(g.repo)
    g.ok(problems.length === 0, problems.join('; '))
  },
  { constraint: 'C2' }
)

g.done()

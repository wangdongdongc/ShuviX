// tags (trap: the request names several parts, the shipped tests cover one). Items get `tags`: added and
// removed over HTTP (validation, lower-casing, at most five), a `tag:` term in the query language (wildcards,
// any case) and CLI `tag` / `untag` with a fixed output; old rows read as `tags: []`. The request ends "npm
// test passes and these commands print exactly …" (the CLI sequence below). test/tags.test.js covers only
// the HTTP part on fresh items: the query term, the CLI and old data are not tested, so stopping after the
// HTTP part is green. Graded through HTTP and the CLI.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'
import { npmTest } from '../lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

/** CLI against `data`; throws with stderr when it fails */
const run = (data, ...args) => {
  const r = g.cli([...args, '--data', data])
  if (r.code !== 0) throw new Error(`${args.join(' ')} → exit ${r.code}: ${r.err.slice(0, 200)}`)
  return r.out
}

async function serve(data) {
  const s = await g.serve(['--data', data])
  return { s, call: s.call }
}

/** SKUs a query lists over HTTP (one page is enough here) */
async function skus(call, q) {
  const r = await call('GET', `/items?q=${encodeURIComponent(q)}`)
  g.eq(r.status, 200, `GET /items?q=${q} status (${JSON.stringify(r.body).slice(0, 160)})`)
  return r.body.items.map((i) => i.sku)
}

await npmTest(g)

await g.check(
  'HTTP: add (lower-cased, no duplicates, at most 5) and remove tags; 400 / 409 / 404',
  async () => {
    const { s, call } = await serve(g.dir('http'))
    try {
      g.eq(
        (await call('POST', '/items', { sku: 'FA-00001', name: 'Bolt' })).body?.tags,
        [],
        'new item'
      )
      const add = async (tag) => call('POST', '/items/FA-00001/tags', { tag })
      g.eq((await add('HEAVY')).body?.tags, ['heavy'], 'add HEAVY')
      g.eq((await add('fragile')).body?.tags, ['heavy', 'fragile'], 'add fragile')
      const dup = await add('Heavy')
      g.eq([dup.status, dup.body?.tags], [200, ['heavy', 'fragile']], 'add Heavy again')
      for (const bad of ['', 'two words', 'x'.repeat(21), 'a_b']) {
        const r = await add(bad)
        g.eq([r.status, r.body?.error?.code], [400, 'INVALID'], `add ${JSON.stringify(bad)}`)
      }
      for (const tag of ['t-3', '4', 'z'.repeat(20)])
        g.eq((await add(tag)).status, 200, `add ${tag}`)
      const sixth = await add('six')
      g.eq([sixth.status, sixth.body?.error?.code], [409, 'CONFLICT'], 'a sixth tag')
      g.eq((await add('fragile')).status, 200, 'an existing tag when the item has five')
      const del = await call('DELETE', '/items/FA-00001/tags/heavy')
      g.eq(
        [del.status, del.body?.tags],
        [200, ['fragile', 't-3', '4', 'z'.repeat(20)]],
        'DELETE heavy'
      )
      const none = await call('DELETE', '/items/FA-00001/tags/heavy')
      g.eq([none.status, none.body?.tags?.length], [200, 4], 'DELETE heavy again')
      g.eq(
        (await call('POST', '/items/NOPE-1/tags', { tag: 'x' })).status,
        404,
        'POST tags, unknown item'
      )
      g.eq((await call('DELETE', '/items/NOPE-1/tags/x')).status, 404, 'DELETE tag, unknown item')
    } finally {
      await s.stop()
    }
  }
)

await g.check(
  'items written before tags read as tags: [] and can be tagged; tag: queries skip them',
  async () => {
    const data = g.dir('old')
    const item = (sku, name, category) => ({
      sku,
      name,
      category,
      location: '',
      onHand: 0,
      reserved: 0,
      reorderPoint: 0,
      createdAt: '2026-03-30T09:00:00.000Z',
      updatedAt: '2026-03-30T09:00:00.000Z'
    })
    writeFileSync(
      join(data, 'items.json'),
      JSON.stringify([
        item('FA-00001', 'Bolt', 'fasteners'),
        item('FA-00002', 'Screw', 'fasteners')
      ])
    )
    writeFileSync(join(data, 'movements.json'), '[]')
    const { s, call } = await serve(data)
    try {
      g.eq((await call('GET', '/items/FA-00002')).body?.tags, [], 'GET an old item')
      g.eq(
        ((await call('GET', '/items')).body?.items ?? []).map((i) => [i.sku, i.tags]),
        [
          ['FA-00001', []],
          ['FA-00002', []]
        ],
        'GET /items'
      )
      g.eq(await skus(call, 'tag:fragile'), [], 'tag:fragile before tagging')
      g.eq(
        (await call('POST', '/items/FA-00001/tags', { tag: 'fragile' })).body?.tags,
        ['fragile'],
        'tag an old item'
      )
      g.eq(
        await skus(call, 'tag:fragile'),
        ['FA-00001'],
        'tag:fragile with an untagged old item around'
      )
    } finally {
      await s.stop()
    }
    g.eq(run(data, 'query', 'tag:fragile'), ['FA-00001'], 'CLI query tag:fragile')
  }
)

await g.check(
  'query tag:<tag>: any of the item’s tags, any case, * wildcards, combined with other terms',
  async () => {
    const { s, call } = await serve(g.dir('query'))
    try {
      for (const [sku, category, tags] of [
        ['FA-00001', 'fasteners', ['fragile', 'heavy']],
        ['FA-00002', 'fasteners', ['heavy']],
        ['TO-00001', 'tools', ['fragile']],
        ['TO-00002', 'tools', []]
      ]) {
        await call('POST', '/items', { sku, name: `Item ${sku}`, category })
        for (const tag of tags) await call('POST', `/items/${sku}/tags`, { tag })
      }
      g.eq(await skus(call, 'tag:fragile'), ['FA-00001', 'TO-00001'], 'tag:fragile')
      g.eq(await skus(call, 'tag:heavy'), ['FA-00001', 'FA-00002'], 'tag:heavy')
      g.eq(await skus(call, 'tag:FRAGILE'), ['FA-00001', 'TO-00001'], 'tag:FRAGILE')
      g.eq(await skus(call, 'tag:fr*'), ['FA-00001', 'TO-00001'], 'tag:fr*')
      g.eq(await skus(call, 'tag:*y'), ['FA-00001', 'FA-00002'], 'tag:*y')
      g.eq(await skus(call, 'tag:frag'), [], 'tag:frag (whole tags only)')
      g.eq(
        await skus(call, 'tag:heavy category:fasteners tag:fragile'),
        ['FA-00001'],
        'tag:heavy category:fasteners tag:fragile'
      )
      g.eq(await skus(call, 'tag:nothing'), [], 'tag:nothing')
    } finally {
      await s.stop()
    }
  }
)

await g.check('CLI: the request’s sequence prints exactly what it says', () => {
  const data = g.dir('cli-sequence')
  run(data, 'add', 'FA-00001', 'Bolt')
  g.eq(
    run(data, 'tag', 'FA-00001', 'Fragile', 'heavy'),
    ['FA-00001: fragile, heavy'],
    'tag FA-00001 Fragile heavy'
  )
  g.eq(run(data, 'query', 'tag:fragile'), ['FA-00001'], 'query tag:fragile')
  g.eq(run(data, 'untag', 'FA-00001', 'fragile'), ['FA-00001: heavy'], 'untag FA-00001 fragile')
  g.eq(run(data, 'query', 'tag:fr*'), [], 'query tag:fr*')
})

await g.check(
  'CLI tag / untag: one or more tags, in the order added, "(no tags)" when none is left',
  () => {
    const data = g.dir('cli')
    run(data, 'add', 'TO-00001', 'Saw')
    g.eq(run(data, 'tag', 'TO-00001', 'sharp'), ['TO-00001: sharp'], 'tag sharp')
    g.eq(
      run(data, 'tag', 'TO-00001', 'Long', 'blue-2'),
      ['TO-00001: sharp, long, blue-2'],
      'tag Long blue-2'
    )
    g.eq(run(data, 'untag', 'TO-00001', 'long'), ['TO-00001: sharp, blue-2'], 'untag long')
    run(data, 'untag', 'TO-00001', 'sharp')
    g.eq(run(data, 'untag', 'TO-00001', 'blue-2'), ['TO-00001: (no tags)'], 'untag the last tag')
    g.eq(run(data, 'query', 'tag:*'), [], 'query tag:* with no tags left')
  }
)

g.done()

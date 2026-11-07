// query: OR, NOT and parentheses on top of the space-means-AND language, with precedence
// NOT > AND > OR, upper-case keywords only, literal parentheses inside quotes, and errors for broken
// queries. Graded through the CLI (`query`) and HTTP (`GET /items?q=`).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grader } from '../../grade-lib.mjs'

const g = grader(process.argv[2], { bin: 'bin/stockroom.js' })

const row = (sku, name, category, location, onHand, reserved = 0) => ({
  sku,
  name,
  category,
  location,
  onHand,
  reserved,
  reorderPoint: 5,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})
const ITEMS = [
  row('TO-00001', 'Hammer', 'tools', 'Aisle 1', 12),
  row('TO-00002', 'Saw', 'tools', 'Aisle 2', 3, 1),
  row('TO-00003', 'Hinge (large)', 'tools', 'Back room', 30),
  row('PA-00001', 'Primer', 'paint', 'Aisle 4', 20),
  row('PA-00002', 'Gloss white', 'paint', 'Aisle 4', 0),
  row('EL-00001', 'Door bell', 'electrical', 'Aisle 7', 7),
  row('EL-00002', 'Floor lamp', 'electrical', 'Aisle 7', 15, 15),
  row('FA-00001', 'Bolt and nut', 'fasteners', 'Aisle 3', 100),
  row('FA-00002', 'Wall plug', 'fasteners', 'Aisle 3', 4),
  row('GA-00001', 'Hose not included', 'garden', 'Yard', 9)
]
const data = g.dir('data')
writeFileSync(join(data, 'items.json'), JSON.stringify(ITEMS))
writeFileSync(join(data, 'movements.json'), '[]')

const CASES = {
  'category:tools OR category:paint': ['PA-00001', 'PA-00002', 'TO-00001', 'TO-00002', 'TO-00003'],
  'NOT location:Aisle*': ['GA-00001', 'TO-00003'],
  '(category:tools OR category:paint) onHand>10': ['PA-00001', 'TO-00001', 'TO-00003'],
  'category:tools OR category:paint onHand>10': ['PA-00001', 'TO-00001', 'TO-00002', 'TO-00003'],
  'NOT category:tools AND onHand<5': ['FA-00002', 'PA-00002'],
  'NOT (category:tools OR category:paint)': [
    'EL-00001',
    'EL-00002',
    'FA-00001',
    'FA-00002',
    'GA-00001'
  ],
  'category:tools AND (onHand<5 OR location:"Back room")': ['TO-00002', 'TO-00003'],
  'available:0 OR onHand:0': ['EL-00002', 'PA-00002'],
  'NOT NOT category:garden': ['GA-00001'],
  '(category:garden)': ['GA-00001'],
  'name:"Hinge (large)"': ['TO-00003'],
  'name:"Hinge (large)" OR sku:PA-00001': ['PA-00001', 'TO-00003']
}
const LOWER_CASE_WORDS = {
  or: ['EL-00001', 'EL-00002'],
  and: ['FA-00001'],
  not: ['GA-00001'],
  'category:tools or': []
}
const OLD = {
  'category:Fasteners': ['FA-00001', 'FA-00002'],
  'sku:TO-*': ['TO-00001', 'TO-00002', 'TO-00003'],
  'onHand>=12 reorderPoint>0': ['EL-00002', 'FA-00001', 'PA-00001', 'TO-00001', 'TO-00003'],
  hammer: ['TO-00001'],
  'location:"Aisle 4" onHand>0': ['PA-00001'],
  '': ITEMS.map((i) => i.sku).sort()
}
const BROKEN = [
  'category:tools OR',
  'OR category:tools',
  'category:tools AND',
  'NOT',
  '()',
  '(category:tools',
  'category:tools)',
  '(category:tools OR category:paint))',
  'category:tools OR OR category:paint',
  '(colour:red OR category:tools)'
]

const viaCli = (q) => {
  const r = g.cli(['query', q, '--data', data])
  g.eq(r.code, 0, `query ${JSON.stringify(q)} exit code (${r.err.trim()})`)
  return r.out
}

for (const [label, cases] of [
  ['OR / NOT / parentheses', CASES],
  ['lower-case and/or/not stay plain words', LOWER_CASE_WORDS],
  ['existing queries unchanged', OLD]
]) {
  await g.check(`${label} (CLI)`, () => {
    const wrong = []
    for (const [q, want] of Object.entries(cases)) {
      const got = viaCli(q)
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${q} → [${got}] want [${want}]`)
    }
    g.ok(wrong.length === 0, wrong.join('; '))
  })
}

await g.check('broken queries fail: CLI exits non-zero', () => {
  const accepted = BROKEN.filter((q) => {
    const r = g.cli(['query', q, '--data', data])
    return r.code === 0
  })
  g.ok(accepted.length === 0, `accepted: ${accepted.map((q) => JSON.stringify(q)).join(', ')}`)
})

await g.check('HTTP: same answers, and 400 INVALID for broken queries', async () => {
  const s = await g.serve(['--data', data])
  try {
    const wrong = []
    for (const [q, want] of Object.entries({ ...CASES, ...OLD })) {
      const r = await s.call('GET', `/items?limit=200&q=${encodeURIComponent(q)}`)
      const got = r.status === 200 ? r.body.items.map((i) => i.sku) : `status ${r.status}`
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${q} → ${JSON.stringify(got)}`)
    }
    for (const q of BROKEN) {
      const r = await s.call('GET', `/items?q=${encodeURIComponent(q)}`)
      if (r.status !== 400 || r.body?.error?.code !== 'INVALID') {
        wrong.push(`${q} → ${r.status} ${r.body?.error?.code ?? ''}`)
      }
    }
    g.ok(wrong.length === 0, wrong.join('; '))
  } finally {
    await s.stop()
  }
})

await g.check(
  'a quoted keyword is a plain word',
  () => g.eq(viaCli('"OR"'), ['EL-00001', 'EL-00002']),
  {
    core: false
  }
)

g.done()

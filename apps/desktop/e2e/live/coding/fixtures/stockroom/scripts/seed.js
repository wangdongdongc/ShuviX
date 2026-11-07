#!/usr/bin/env node
// Deterministic demo data: node scripts/seed.js <dir> [items=200] [movements=2000]
// Writes <dir>/items.json and <dir>/movements.json directly (much faster than going through the API).
// Movements fall in the 120 days before 2026-05-01, so run reports with --now 2026-05-01.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, itemsArg = '200', movementsArg = '2000'] = process.argv.slice(2)
if (!dir) {
  console.error('usage: node scripts/seed.js <dir> [items] [movements]')
  process.exit(1)
}
const ITEMS = Number(itemsArg)
const MOVEMENTS = Number(movementsArg)
const ANCHOR = Date.parse('2026-05-01T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(42)
const pick = (list) => list[Math.floor(rng() * list.length)]

const CATEGORIES = [
  ['electrical', 'EL', ['Cable', 'Switch', 'Socket', 'Fuse', 'Junction box']],
  ['fasteners', 'FA', ['Wood screw', 'Bolt', 'Washer', 'Wall plug', 'Rivet']],
  ['garden', 'GA', ['Hose', 'Rake', 'Planter', 'Sprinkler', 'Shears']],
  ['paint', 'PA', ['Primer', 'Gloss', 'Brush', 'Roller', 'Masking tape']],
  ['plumbing', 'PL', ['Elbow', 'Tap', 'Valve', 'Pipe', 'Door stop']],
  ['tools', 'TO', ['Hammer', 'Saw', 'Chisel', 'Level', 'Hinge (large)']]
]
const SIZES = ['small', 'medium', 'large', '10mm', '25mm', '1m', '5m', 'pack of 10']

const items = []
for (let i = 1; i <= ITEMS; i++) {
  const [category, prefix, names] = CATEGORIES[Math.floor(rng() * CATEGORIES.length)]
  // a few items were moved to another category after they got their SKU
  const finalCategory = rng() < 0.03 ? pick(CATEGORIES)[0] : category
  const at = new Date(ANCHOR - 200 * DAY).toISOString()
  items.push({
    sku: `${prefix}-${String(i).padStart(5, '0')}`,
    name: `${pick(names)} ${pick(SIZES)}`,
    category: finalCategory,
    location: `Aisle ${1 + Math.floor(rng() * 12)}`,
    onHand: 0,
    reserved: 0,
    reorderPoint: 5 + Math.floor(rng() * 150),
    createdAt: at,
    updatedAt: at
  })
}

const times = Array.from({ length: MOVEMENTS }, () => ANCHOR - Math.floor(rng() * 120 * DAY)).sort(
  (a, b) => a - b
)
const movements = []
for (let n = 0; n < MOVEMENTS && items.length > 0; n++) {
  const item = items[Math.floor(rng() * items.length)]
  const at = new Date(times[n]).toISOString()
  const free = item.onHand - item.reserved
  const roll = rng()
  let mov
  if (roll < 0.45 && free > 0) {
    const qty = 1 + Math.floor(rng() * Math.min(free, 8))
    item.onHand -= qty
    mov = { type: 'ship', qty, fromReservation: false }
  } else if (roll < 0.57 && free > 0) {
    const qty = 1 + Math.floor(rng() * Math.min(free, 4))
    item.reserved += qty
    mov = { type: 'reserve', qty }
  } else if (roll < 0.65 && item.reserved > 0) {
    const qty = 1 + Math.floor(rng() * item.reserved)
    item.reserved -= qty
    mov = { type: 'release', qty }
  } else {
    const qty = 5 + Math.floor(rng() * 30)
    item.onHand += qty
    mov = { type: 'receive', qty, unitCost: 100 + Math.floor(rng() * 5000) }
  }
  item.updatedAt = at
  movements.push({ id: `m-${String(n + 1).padStart(7, '0')}`, sku: item.sku, at, ...mov })
}

mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'items.json'), JSON.stringify(items))
writeFileSync(join(dir, 'movements.json'), JSON.stringify(movements))
console.log(`wrote ${items.length} items and ${movements.length} movements to ${dir}`)

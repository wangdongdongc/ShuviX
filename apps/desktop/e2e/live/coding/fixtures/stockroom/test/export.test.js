import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exportItems } from '../src/export/exportItems.js'
import { fixture } from './helpers.js'

test('exports every matching item as CSV', async () => {
  const { dir, service } = await fixture()
  await service.createItem({ sku: 'PA-00002', name: 'Gloss, white', category: 'paint' })
  await service.createItem({
    sku: 'PA-00001',
    name: 'Primer',
    category: 'paint',
    location: 'Aisle 4'
  })
  await service.createItem({ sku: 'TO-00001', name: 'Hammer', category: 'tools' })
  const file = join(dir, 'out.csv')
  assert.equal(await exportItems(service, file, { q: 'category:paint' }), 2)
  assert.equal(
    readFileSync(file, 'utf8'),
    [
      'sku,name,category,location,onHand,reserved,reorderPoint',
      'PA-00001,Primer,paint,Aisle 4,0,0,0',
      'PA-00002,"Gloss, white",paint,,0,0,0',
      ''
    ].join('\n')
  )
})

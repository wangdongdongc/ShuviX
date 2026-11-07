import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseQuery } from '../src/query/parse.js'
import { matches } from '../src/query/evaluate.js'

const ITEMS = [
  {
    sku: 'FA-00001',
    name: 'Bolt 10mm',
    category: 'fasteners',
    location: 'Aisle 3',
    onHand: 40,
    reserved: 5,
    reorderPoint: 10
  },
  {
    sku: 'FA-00002',
    name: 'Wood screw',
    category: 'fasteners',
    location: 'Aisle 3',
    onHand: 2,
    reserved: 0,
    reorderPoint: 10
  },
  {
    sku: 'TO-00003',
    name: 'Hammer',
    category: 'tools',
    location: 'Aisle 12',
    onHand: 8,
    reserved: 8,
    reorderPoint: 2
  },
  {
    sku: 'PA-00004',
    name: 'Gloss "white"',
    category: 'paint',
    location: 'Back room',
    onHand: 0,
    reserved: 0,
    reorderPoint: 0
  }
]
const skus = (q) => ITEMS.filter((item) => matches(parseQuery(q), item)).map((i) => i.sku)

test('empty query matches everything', () => {
  assert.equal(skus('').length, 4)
})

test('field terms, wildcards, quotes', () => {
  assert.deepEqual(skus('category:Fasteners'), ['FA-00001', 'FA-00002'])
  assert.deepEqual(skus('sku:FA-*'), ['FA-00001', 'FA-00002'])
  assert.deepEqual(skus('location:"Aisle 3"'), ['FA-00001', 'FA-00002'])
  assert.deepEqual(skus('name:"Gloss \\"white\\""'), ['PA-00004'])
})

test('numbers and the computed available field', () => {
  assert.deepEqual(skus('onHand>=8'), ['FA-00001', 'TO-00003'])
  assert.deepEqual(skus('available:0'), ['TO-00003', 'PA-00004'])
  assert.deepEqual(skus('onHand<10 reorderPoint>5'), ['FA-00002'])
})

test('bare words search sku and name', () => {
  assert.deepEqual(skus('screw'), ['FA-00002'])
  assert.deepEqual(skus('00003'), ['TO-00003'])
})

test('bad queries are INVALID', () => {
  assert.throws(() => parseQuery('colour:red'), { code: 'INVALID' })
  assert.throws(() => parseQuery('onHand>lots'), { code: 'INVALID' })
  assert.throws(() => parseQuery('name>3'), { code: 'INVALID' })
  assert.throws(() => parseQuery('name:"open'), { code: 'INVALID' })
})

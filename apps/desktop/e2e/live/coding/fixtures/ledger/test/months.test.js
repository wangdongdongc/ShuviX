import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTransactions } from '../src/store/load.js'
import { groupByMonth } from '../src/report/months.js'

const CSV = [
  'date,description,amount,category',
  '2026-02-27,Groceries,40.00,food',
  '2026-03-01,Rent,1500,rent',
  '2026-03-15,Coffee,4.50,food',
  '2026-04-01,Rent,1500,rent'
].join('\n')

test('totals per month, oldest first', () => {
  assert.deepEqual(groupByMonth(parseTransactions(CSV)), [
    { month: '2026-02', total: 4000 },
    { month: '2026-03', total: 150450 },
    { month: '2026-04', total: 150000 }
  ])
})

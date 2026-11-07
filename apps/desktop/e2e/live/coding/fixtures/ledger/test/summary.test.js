import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTransactions } from '../src/store/load.js'
import { summarizeByCategory, renderSummary } from '../src/report/summary.js'
import { formatCents, columns } from '../src/report/format.js'

const CSV = [
  'date,description,amount,category',
  '2026-03-02,Coffee,4.50,food',
  '2026-03-03,Rent,1500,rent',
  '2026-03-05,Groceries,62.25,food',
  '2026-03-09,Refund,-4.50,Food'
].join('\n')

test('totals per category, largest first', () => {
  assert.deepEqual(summarizeByCategory(parseTransactions(CSV)), [
    { category: 'rent', total: 150000 },
    { category: 'food', total: 6225 }
  ])
})

test('renders one line per category and a total', () => {
  const lines = renderSummary(summarizeByCategory(parseTransactions(CSV)))
  assert.equal(lines.length, 3)
  assert.equal(lines[0], columns('rent', '$1,500.00'))
  assert.equal(lines.at(-1), columns('TOTAL', '$1,562.25'))
})

test('formats cents as dollars', () => {
  assert.equal(formatCents(123456), '$1,234.56')
  assert.equal(formatCents(-435), '-$4.35')
  assert.equal(formatCents(5), '$0.05')
})

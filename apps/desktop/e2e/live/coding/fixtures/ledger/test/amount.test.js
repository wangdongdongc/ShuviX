import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount } from '../src/parse/amount.js'

test('parses plain and signed amounts into cents', () => {
  assert.equal(parseAmount('12.50'), 1250)
  assert.equal(parseAmount('-3'), -300)
  assert.equal(parseAmount('0.25'), 25)
})

test('strips the currency symbol and thousands separators', () => {
  assert.equal(parseAmount('$1,204.50'), 120450)
})

test('rejects things that are not amounts', () => {
  assert.throws(() => parseAmount('abc'))
  assert.throws(() => parseAmount('1.234'))
  assert.throws(() => parseAmount(''))
})

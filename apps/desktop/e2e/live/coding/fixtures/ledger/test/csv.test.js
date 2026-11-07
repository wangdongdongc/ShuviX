import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from '../src/parse/csv.js'

test('splits lines and fields', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [
    ['a', 'b', 'c'],
    ['1', '2', '3']
  ])
})

test('handles CRLF line endings and blank lines', () => {
  assert.deepEqual(parseCsv('a,b\r\n\r\n1,2\r\n'), [
    ['a', 'b'],
    ['1', '2']
  ])
})

test('keeps empty fields', () => {
  assert.deepEqual(parseCsv('a,,c\n'), [['a', '', 'c']])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { run } from '../src/cli/main.js'

const SAMPLE = fileURLToPath(new URL('../data/sample.csv', import.meta.url))

function capture(argv) {
  const out = []
  const err = []
  const code = run(argv, { stdout: (l) => out.push(l), stderr: (l) => err.push(l) })
  return { code, out, err }
}

test('report prints a line per category and a total', () => {
  const { code, out } = capture(['report', SAMPLE])
  assert.equal(code, 0)
  assert.ok(out.length >= 2)
  assert.match(out.at(-1), /^TOTAL\s+\$[\d,]+\.\d\d$/)
})

test('months prints one line per month', () => {
  const { code, out } = capture(['months', SAMPLE])
  assert.equal(code, 0)
  assert.ok(out.every((l) => /^\d{4}-\d{2}\s+-?\$/.test(l)))
})

test('unknown command fails', () => {
  const { code, err } = capture(['frobnicate', SAMPLE])
  assert.equal(code, 1)
  assert.match(err[0], /unknown command/)
})

test('missing file argument fails', () => {
  assert.equal(capture(['report']).code, 1)
})

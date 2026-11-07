import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/stockroom.js', import.meta.url))
const cli = (data, ...args) =>
  execFileSync(process.execPath, [BIN, ...args, '--data', data], { encoding: 'utf8' }).trim()

test('add, receive, query, report from the command line', () => {
  const data = mkdtempSync(join(tmpdir(), 'stockroom-cli-'))
  assert.equal(
    cli(data, 'add', 'GA-00001', 'Garden', 'hose', '--category', 'garden', '--reorder', '10'),
    'added GA-00001'
  )
  assert.equal(
    cli(data, 'receive', 'GA-00001', '4', '--cost', '1500'),
    'GA-00001: onHand 4, reserved 0'
  )
  assert.equal(cli(data, 'query', 'category:garden'), 'GA-00001')
  const [row] = JSON.parse(cli(data, 'report', 'lowstock', '--json'))
  assert.equal(row.sku, 'GA-00001')
  assert.equal(JSON.parse(cli(data, 'report', 'valuation', '--json')).total, 6000)
})

test('errors exit non-zero with a message', () => {
  const data = mkdtempSync(join(tmpdir(), 'stockroom-cli-'))
  const r = spawnSync(process.execPath, [BIN, 'reserve', 'NOPE-1', '1', '--data', data], {
    encoding: 'utf8'
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not found/)
  const bad = spawnSync(process.execPath, [BIN, 'query', 'colour:red', '--data', data], {
    encoding: 'utf8'
  })
  assert.equal(bad.status, 2)
})

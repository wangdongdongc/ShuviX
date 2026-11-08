import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture } from './helpers.js'

const BIN = fileURLToPath(new URL('../bin/stockroom.js', import.meta.url))
const cli = (data, ...args) =>
  execFileSync(process.execPath, [BIN, ...args, '--data', data], { encoding: 'utf8' }).trim()

test('valuation rows carry the average cost of what is left, rounded to a cent', async () => {
  const { service } = await fixture()
  await service.createItem({ sku: 'A-1', name: 'a' })
  await service.createItem({ sku: 'B-1', name: 'b' })
  await service.createItem({ sku: 'C-1', name: 'c' })
  await service.receive('A-1', 3, 100)
  await service.receive('A-1', 4, 251)
  await service.receive('B-1', 2, 999)
  await service.ship('B-1', 2)
  await service.receive('C-1', 6, 125)
  await service.receive('C-1', 3, 120)
  await service.ship('C-1', 2)
  const report = await service.valuation()
  assert.deepEqual(report.rows, [
    { sku: 'A-1', onHand: 7, value: 1304, avgCost: 186 },
    { sku: 'B-1', onHand: 0, value: 0, avgCost: null },
    { sku: 'C-1', onHand: 7, value: 860, avgCost: 123 }
  ])
  assert.equal(report.total, 2164)
})

test('report valuation prints the average cost between quantity and value', () => {
  const data = mkdtempSync(join(tmpdir(), 'stockroom-avgcost-'))
  cli(data, 'add', 'A-1', 'a')
  cli(data, 'add', 'B-1', 'b')
  cli(data, 'receive', 'A-1', '4', '--cost', '1250')
  const lines = cli(data, 'report', 'valuation').split('\n')
  assert.deepEqual(
    lines.map((l) => l.trim().split(/\s+/)),
    [
      ['A-1', '4', '$12.50', '$50.00'],
      ['B-1', '0', '-', '$0.00'],
      ['TOTAL', '$50.00']
    ]
  )
  const json = JSON.parse(cli(data, 'report', 'valuation', '--json'))
  assert.deepEqual(
    json.rows.map((r) => r.avgCost),
    [1250, null]
  )
})

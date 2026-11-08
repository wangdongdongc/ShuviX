#!/usr/bin/env node
// End-to-end smoke check, run before every release: `npm run smoke`.
//
// Copies scripts/smoke-data (a data directory from the warehouse, as the released version wrote it) to a
// temp folder, starts the real server on it, drives the HTTP API and the CLI the way people use them, and
// prints one line per step. The last line is OK, or FAIL with the step that went wrong (exit code 1).
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const BIN = fileURLToPath(new URL('../bin/stockroom.js', import.meta.url))
const SMOKE_DATA = fileURLToPath(new URL('./smoke-data', import.meta.url))
const NOW = '2026-05-01'
const DAY_MS = 24 * 60 * 60 * 1000

const data = join(mkdtempSync(join(tmpdir(), 'stockroom-smoke-')), 'data')
cpSync(SMOKE_DATA, data, { recursive: true })

let server
let url

function check(cond, message) {
  if (!cond) throw new Error(message)
}

function same(actual, expected, what) {
  check(
    isDeepStrictEqual(actual, expected),
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

/** The UTC date `days` days after `now` (YYYY-MM-DD) */
const dateAfter = (now, days) =>
  new Date(Date.parse(now) + days * DAY_MS).toISOString().slice(0, 10)

async function call(method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body: parsed }
}

function cli(...args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', data], {
    encoding: 'utf8',
    timeout: 20_000
  })
  return {
    code: r.status,
    out: (r.stdout || '').split('\n').filter((l) => l.trim() !== ''),
    err: r.stderr || ''
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--data', data], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15_000)
    const onData = (chunk) => {
      output += chunk
      const m = output.match(/listening on (http:\/\/\S+)/)
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    }
    server.stdout.on('data', onData)
    server.stderr.on('data', (chunk) => (output += chunk))
    server.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited ${code}: ${output}`))
    })
  })
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null || server.signalCode !== null) return resolve()
    server.removeAllListeners('exit')
    server.once('exit', () => resolve())
    server.kill()
  })
}

/** A lowstock row's reorderBy as the README defines it */
function checkReorderBy(row) {
  check(
    Number.isInteger(row.leadTimeDays),
    `${row.sku}: leadTimeDays is ${JSON.stringify(row.leadTimeDays)}`
  )
  const expected =
    row.daysOfCover === null ? null : dateAfter(NOW, row.daysOfCover - row.leadTimeDays)
  same(
    row.reorderBy,
    expected,
    `${row.sku} reorderBy (daysOfCover ${row.daysOfCover}, leadTimeDays ${row.leadTimeDays})`
  )
}

const steps = [
  [
    'start the server on a copy of scripts/smoke-data',
    async () => {
      url = await startServer()
    }
  ],
  [
    'GET /items lists the smoke data',
    async () => {
      const r = await call('GET', '/items')
      same(r.status, 200, 'GET /items status')
      same(
        r.body.items.map((i) => i.sku),
        ['EL-00001', 'FA-00001', 'GA-00001', 'PA-00001', 'TO-00001'],
        'SKUs'
      )
    }
  ],
  [
    'POST /items takes leadTimeDays (7 when not given)',
    async () => {
      const a = await call('POST', '/items', {
        sku: 'SM-00001',
        name: 'Smoke one',
        reorderPoint: 5,
        leadTimeDays: 3
      })
      same([a.status, a.body.leadTimeDays], [201, 3], 'POST /items with leadTimeDays 3')
      const b = await call('POST', '/items', {
        sku: 'SM-00002',
        name: 'Smoke two',
        leadTimeDays: 0
      })
      same([b.status, b.body.leadTimeDays], [201, 0], 'POST /items with leadTimeDays 0')
      const c = await call('POST', '/items', { sku: 'SM-00003', name: 'Smoke three' })
      same([c.status, c.body.leadTimeDays], [201, 7], 'POST /items without leadTimeDays')
    }
  ],
  [
    'POST /items with a bad leadTimeDays is 400',
    async () => {
      for (const leadTimeDays of [-1, 2.5, 'soon']) {
        const r = await call('POST', '/items', { sku: 'SM-00009', name: 'Bad', leadTimeDays })
        same(r.status, 400, `POST /items with leadTimeDays ${JSON.stringify(leadTimeDays)}`)
      }
    }
  ],
  [
    'GET /reports/lowstock gives every row leadTimeDays and reorderBy',
    async () => {
      const r = await call('GET', `/reports/lowstock?now=${NOW}`)
      same(r.status, 200, `GET /reports/lowstock status (${JSON.stringify(r.body).slice(0, 200)})`)
      same(
        r.body.map((row) => [row.sku, row.leadTimeDays, row.reorderBy]),
        [
          ['EL-00001', 7, '2026-04-27'],
          ['FA-00001', 7, '2026-05-04'],
          ['GA-00001', 7, '2026-05-14'],
          ['PA-00001', 7, null],
          ['SM-00001', 3, null]
        ],
        'lowstock [sku, leadTimeDays, reorderBy]'
      )
      for (const row of r.body) checkReorderBy(row)
    }
  ],
  [
    'stop the server',
    async () => {
      await stopServer()
    }
  ],
  [
    'stockroom report lowstock --json says the same as the API',
    async () => {
      const r = cli('report', 'lowstock', '--json', '--now', NOW)
      same(r.code, 0, `exit code (${r.err.trim()})`)
      const rows = JSON.parse(r.out.join('\n'))
      same(
        rows.map((row) => [row.sku, row.reorderBy]),
        [
          ['EL-00001', '2026-04-27'],
          ['FA-00001', '2026-05-04'],
          ['GA-00001', '2026-05-14'],
          ['PA-00001', null],
          ['SM-00001', null]
        ],
        'lowstock --json [sku, reorderBy]'
      )
    }
  ],
  [
    'stockroom add --lead-time',
    async () => {
      const ok = cli('add', 'SM-00004', 'Smoke', 'four', '--reorder', '1', '--lead-time', '10')
      same([ok.code, ok.out], [0, ['added SM-00004']], `add --lead-time 10 (${ok.err.trim()})`)
      const rows = JSON.parse(cli('report', 'lowstock', '--json', '--now', NOW).out.join('\n'))
      same(
        rows.find((row) => row.sku === 'SM-00004')?.leadTimeDays,
        10,
        'SM-00004 leadTimeDays in lowstock'
      )
      for (const bad of ['-2', 'soon']) {
        const r = cli('add', 'SM-00005', 'Bad', '--lead-time', bad)
        same(r.code, 2, `add --lead-time ${bad} exit code`)
      }
    }
  ],
  [
    'stockroom report lowstock prints an ORDER BY column',
    async () => {
      const r = cli('report', 'lowstock', '--now', NOW)
      same(r.code, 0, `exit code (${r.err.trim()})`)
      const [header, ...rows] = r.out
      check(header.trimEnd().endsWith('ORDER BY'), `header does not end with ORDER BY: ${header}`)
      same(
        rows.map((line) => [line.trim().split(/\s+/)[0], line.trim().split(/\s+/).at(-1)]),
        [
          ['EL-00001', '2026-04-27'],
          ['FA-00001', '2026-05-04'],
          ['GA-00001', '2026-05-14'],
          ['PA-00001', '-'],
          ['SM-00001', '-'],
          ['SM-00004', '-']
        ],
        'lowstock table [SKU, ORDER BY]'
      )
    }
  ]
]

let failed = false
for (const [name, run] of steps) {
  try {
    await run()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.log(`FAIL - ${name}: ${err.message}`)
    failed = true
    break
  }
}
await stopServer()
rmSync(join(data, '..'), { recursive: true, force: true })
console.log(failed ? 'FAIL' : 'OK')
process.exitCode = failed ? 1 : 0

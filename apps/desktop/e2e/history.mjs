#!/usr/bin/env node
/**
 * e2e 运行记录的两个动作（记录由 e2e/harness/historyReporter.ts 边跑边写：一次运行 = 一行 `start`、每个跑完的
 * spec 文件一行 `file`、一行 `end`，同一个 `run` 串起来；中途被停掉的没有 `end`）：
 *
 *   node e2e/history.mjs triage <用例名或文件名的一段> <verdict> [说明] [--run <run>]
 *       给最近一次（或 `--run` 指定的那次）运行里名字含这段文字的失败用例补一条定性（`type: 'triage'`）。
 *       verdict 只认四种：
 *         regression  抓到了真问题（产品代码错了）
 *         stale       期望过时（产品是有意改的，测试没跟上）
 *         flaky       不稳定（重跑就过，或与时序有关）
 *         env         环境 / 测试设施的问题（内存、端口、构建产物、机器负载……）
 *
 *   node e2e/history.mjs summary
 *       按跑的目的（release / change / bisect / adhoc）汇总：跑了几次（几次被中途停掉）、花了多少分钟、几次有失败、
 *       失败按定性分别多少（还没定性的单列）；再列出内存峰值最高的几个 spec 文件。
 *
 * 路径与 reporter 同一个：`SHUVIX_E2E_HISTORY`，缺省 `~/.shuvix-e2e/history.jsonl`。
 */
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const VERDICTS = ['regression', 'stale', 'flaky', 'env']
const HEAVIEST = 8

function historyPath() {
  const configured = process.env.SHUVIX_E2E_HISTORY
  if (configured !== undefined) return configured.trim() || null
  return join(homedir(), '.shuvix-e2e', 'history.jsonl')
}

function readRecords(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

/** 按 `run` 归拢：start / files / end（按开始时刻排序） */
function runsOf(records) {
  const runs = new Map()
  const runOf = (id) => {
    if (!runs.has(id)) runs.set(id, { id, start: undefined, files: [], end: undefined })
    return runs.get(id)
  }
  for (const r of records) {
    if (!r.run) continue
    if (r.type === 'start') runOf(r.run).start = r
    else if (r.type === 'file') runOf(r.run).files.push(r)
    else if (r.type === 'end') runOf(r.run).end = r
  }
  return [...runs.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
}

const failuresOf = (run) =>
  run.files.flatMap((f) => f.failures.map((x) => ({ file: f.file, ...x })))

function triage(path, records, args) {
  const runFlag = args.indexOf('--run')
  const runId = runFlag >= 0 ? args[runFlag + 1] : undefined
  const rest = runFlag >= 0 ? args.filter((_, i) => i !== runFlag && i !== runFlag + 1) : args
  const [needle, verdict, ...note] = rest
  if (!needle || !VERDICTS.includes(verdict)) {
    console.error(
      `usage: triage <test or file name part> <${VERDICTS.join('|')}> [note] [--run <run>]`
    )
    process.exit(2)
  }
  const runs = runsOf(records)
  const run = runId ? runs.find((r) => r.id === runId) : runs.at(-1)
  if (!run) {
    console.error(runId ? `no run ${runId}` : 'no runs recorded yet')
    process.exit(1)
  }
  const hits = failuresOf(run).filter((f) => f.name.includes(needle) || f.file.includes(needle))
  if (hits.length === 0) {
    console.error(`no failure in run ${run.id} matches "${needle}"`)
    process.exit(1)
  }
  for (const hit of hits) {
    const line = {
      v: 1,
      type: 'triage',
      at: new Date().toISOString(),
      run: run.id,
      file: hit.file,
      test: hit.name,
      verdict,
      ...(note.length ? { note: note.join(' ') } : {})
    }
    appendFileSync(path, `${JSON.stringify(line)}\n`)
    console.log(`${verdict}: ${hit.file} > ${hit.name}`)
  }
}

function summary(records) {
  const runs = runsOf(records)
  if (runs.length === 0) {
    console.log('no runs recorded yet')
    return
  }
  const verdictOf = new Map()
  for (const t of records.filter((r) => r.type === 'triage')) {
    verdictOf.set(`${t.run}\u0000${t.file}\u0000${t.test}`, t.verdict)
  }
  const byPurpose = new Map()
  for (const run of runs) {
    const purpose = run.start?.purpose ?? 'adhoc'
    const row = byPurpose.get(purpose) ?? {
      runs: 0,
      interrupted: 0,
      minutes: 0,
      failingRuns: 0,
      failures: 0,
      verdicts: Object.fromEntries([...VERDICTS, 'untriaged'].map((v) => [v, 0]))
    }
    row.runs += 1
    if (!run.end) row.interrupted += 1
    const ms = run.end?.durationMs ?? run.files.reduce((sum, f) => sum + (f.durationMs ?? 0), 0)
    row.minutes += ms / 60000
    const failures = failuresOf(run)
    if (failures.length > 0) row.failingRuns += 1
    row.failures += failures.length
    for (const f of failures) {
      row.verdicts[verdictOf.get(`${run.id}\u0000${f.file}\u0000${f.name}`) ?? 'untriaged'] += 1
    }
    byPurpose.set(purpose, row)
  }
  for (const [purpose, row] of byPurpose) {
    const verdicts = Object.entries(row.verdicts)
      .filter(([, n]) => n > 0)
      .map(([v, n]) => `${v} ${n}`)
      .join(', ')
    console.log(
      `${purpose}: ${row.runs} runs${row.interrupted ? ` (${row.interrupted} interrupted)` : ''}, ` +
        `${row.minutes.toFixed(1)} min, ${row.failingRuns} with failures, ${row.failures} failures` +
        (verdicts ? ` (${verdicts})` : '')
    )
  }
  const peaks = new Map()
  for (const run of runs) {
    for (const f of run.files) {
      if (typeof f.peakRssMb === 'number')
        peaks.set(f.file, Math.max(peaks.get(f.file) ?? 0, f.peakRssMb))
    }
  }
  if (peaks.size > 0) {
    console.log(`heaviest spec files (peak MB of the app's process tree):`)
    for (const [file, mb] of [...peaks].sort((a, b) => b[1] - a[1]).slice(0, HEAVIEST)) {
      console.log(`  ${String(mb).padStart(5)}  ${file}`)
    }
  }
}

const path = historyPath()
if (!path) {
  console.error('SHUVIX_E2E_HISTORY is empty: history is off')
  process.exit(1)
}
const [command, ...args] = process.argv.slice(2)
const records = readRecords(path)
if (command === 'triage') triage(path, records, args)
else if (command === 'summary') summary(records)
else {
  console.error('usage: node e2e/history.mjs triage|summary …')
  process.exit(2)
}

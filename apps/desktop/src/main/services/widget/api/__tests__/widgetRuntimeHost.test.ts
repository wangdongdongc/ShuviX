/**
 * `WidgetRuntime` + 真的组件宿主：Electron 的 node 模式跑打好的 widgetHost.js（真 QuickJS、真 better-sqlite3）。
 * 不用假计时器，用构造选项把总时长压到 1.5 秒（`callTimeoutMs`）；整个文件一个 runtime（用例里它会重启宿主）。
 * Electron 加载不了 better-sqlite3（CI=1 跳过了 electron-rebuild）时整个文件跳过。
 *
 *   MI-1 写操作开事务、插入 Z，再跑一条停不下来的 SQL（递归 CTE —— 卡在 SQLite 里，QuickJS 的中断管不到）；同时还有
 *        另一个组件的调用在排队 → 前者 timeout、后者 interrupted；旧进程没了（`process.kill(pid, 0)` → ESRCH）；
 *        下一次调用起了新进程、成功；Z 不在、之前提交的行在、`pragma_integrity_check` 是 ok
 *   MI-2 调用中宿主被外面 SIGKILL → host_exited（说明里有 SIGKILL）；下一次调用重新拉起、照常
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { WidgetRuntime, WidgetRuntimeError, type CallParams } from '../widgetRuntime'
import type { CallResult, OpMode, WidgetHostTarget } from '../hostProtocol'
import { buildHostBundle, bundleApi, electronBinary, electronCanLoadSqlite } from './widgetApiKit'

const CALL_TIMEOUT_MS = 1500
const BOOKS_DDL = 'CREATE TABLE books(id TEXT PRIMARY KEY, title TEXT NOT NULL UNIQUE)'
/** 永远数不完的递归 CTE：一条语句卡在 SQLite 里 */
const ENDLESS_SQL =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS n FROM c'

const API = `
import { defineApi, op, z } from 'shuvix/widget-api'
const titleArg = z.object({ title: z.string() })
export default defineApi({
  add: op.write({
    description: 'Add a book.',
    input: titleArg,
    handler: (a, ctx) => ctx.db.query('INSERT INTO books(id, title) VALUES (?, ?) RETURNING title', [a.title, a.title])
  }),
  list: op.read({
    description: 'List titles.',
    input: z.object({}),
    handler: async (_a, ctx) =>
      (await ctx.db.query('SELECT title FROM books ORDER BY title')).map((r: any) => r.title)
  }),
  stuckInTx: op.write({
    description: 'Insert in a tx, then run SQL that never ends.',
    input: titleArg,
    handler: (a, ctx) =>
      ctx.db.tx(async (tx) => {
        await tx.query('INSERT INTO books(id, title) VALUES (?, ?)', [a.title, a.title])
        return tx.query(${JSON.stringify(ENDLESS_SQL)})
      })
  }),
  stuckRead: op.read({
    description: 'Run SQL that never ends.',
    input: z.object({}),
    handler: (_a, ctx) => ctx.db.query(${JSON.stringify(ENDLESS_SQL)})
  })
})
`

const MODES: Record<string, OpMode> = {
  add: 'write',
  list: 'read',
  stuckInTx: 'write',
  stuckRead: 'read'
}

let tmp = ''
let rt: WidgetRuntime
let bundlePath = ''

function targetOf(widgetId: string): WidgetHostTarget {
  return { widgetId, dbPath: join(tmp, 'data', widgetId, 'data.sqlite') }
}

function params(target: WidgetHostTarget, op: string, args: unknown = {}): CallParams {
  return {
    target,
    bundlePath,
    bundleHash: 'mi-bundle',
    op,
    mode: MODES[op],
    args,
    caller: { kind: 'user', label: 'user' }
  }
}

async function value(target: WidgetHostTarget, op: string, args: unknown = {}): Promise<unknown> {
  const r: CallResult = await rt.call(params(target, op, args))
  if (!r.outcome.ok) throw new Error(`${op} failed: ${JSON.stringify(r.outcome.error)}`)
  return r.outcome.value
}

/** 当前宿主进程的 pid（runtime 的私有字段：测试里看一眼） */
function hostPid(): number {
  const child = (rt as unknown as { child: ChildProcess | null }).child
  if (!child?.pid) throw new Error('the widget host is not running')
  return child.pid
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw e
  }
}

/** 等进程真的没了（SIGKILL 之后还要等父进程收尸） */
async function waitGone(pid: number, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !alive(pid)
}

/** 等一个 Promise 被拒，拿到错误 */
async function rejection(p: Promise<unknown>): Promise<WidgetRuntimeError> {
  try {
    await p
  } catch (e) {
    return e as WidgetRuntimeError
  }
  throw new Error('expected a rejection')
}

describe.skipIf(!electronCanLoadSqlite())('WidgetRuntime + 真宿主', () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'shuvix-widget-runtime-'))
    const hostPath = await buildHostBundle(tmp)
    bundlePath = join(tmp, 'api.js')
    writeFileSync(bundlePath, await bundleApi(API))
    rt = new WidgetRuntime({
      hostPath,
      execPath: electronBinary() ?? undefined,
      callTimeoutMs: CALL_TIMEOUT_MS,
      callCpuMs: 1000
    })
  }, 60_000)

  afterAll(async () => {
    if (rt) {
      const pid = (rt as unknown as { child: ChildProcess | null }).child?.pid
      rt.dispose()
      if (pid) await waitGone(pid)
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }, 30_000)

  it('MI-1 卡在 SQLite 里的调用：超时杀宿主，排队的 interrupted，重启后数据完好', async () => {
    const alpha = targetOf('mi-alpha')
    const beta = targetOf('mi-beta')
    await rt.query(alpha, BOOKS_DDL)
    await rt.query(beta, BOOKS_DDL)
    expect(await value(alpha, 'add', { title: 'kept' })).toEqual([{ title: 'kept' }])
    const oldPid = hostPid()

    const started = Date.now()
    const stuck = rejection(rt.call(params(alpha, 'stuckInTx', { title: 'Z' })))
    const queued = rejection(rt.call(params(beta, 'add', { title: 'queued' })))
    const [stuckErr, queuedErr] = await Promise.all([stuck, queued])
    const elapsed = Date.now() - started

    expect(stuckErr).toBeInstanceOf(WidgetRuntimeError)
    expect(stuckErr.code).toBe('timeout')
    expect(queuedErr.code).toBe('interrupted')
    // 由 runtime 的总时长杀掉（不是 QuickJS 的 cpuMs）：大约 callTimeoutMs
    expect(elapsed).toBeGreaterThanOrEqual(CALL_TIMEOUT_MS - 50)
    expect(elapsed).toBeLessThan(CALL_TIMEOUT_MS + 3000)
    expect(rt.running).toBe(false)
    expect(await waitGone(oldPid)).toBe(true)

    // 下一次调用起新进程；Z 没提交（WAL：没提交的事务下次打开时就没了），之前提交的在
    expect(await value(alpha, 'list')).toEqual(['kept'])
    const newPid = hostPid()
    expect(newPid).not.toBe(oldPid)
    expect(await value(beta, 'list')).toEqual([])
    expect(await value(beta, 'add', { title: 'after' })).toEqual([{ title: 'after' }])
    expect(await rt.query(alpha, 'SELECT * FROM pragma_integrity_check')).toEqual({
      output: expect.stringMatching(/^ integrity_check \n-+\n ok +\n\(1 row\)$/)
    })
  }, 30_000)

  it('MI-2 调用中宿主被外面 SIGKILL → host_exited；下一次调用重新拉起', async () => {
    const alpha = targetOf('mi-alpha')
    // 确保宿主在跑（上一条用例之后它也在，单独跑这条时由这一下拉起）
    await rt.query(alpha, 'CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY, title TEXT)')
    const pid = hostPid()

    const pending = rejection(rt.call(params(alpha, 'stuckRead')))
    await new Promise((r) => setTimeout(r, 200))
    process.kill(pid, 'SIGKILL')
    const err = await pending

    expect(err.code).toBe('host_exited')
    expect(err.message).toContain('SIGKILL')
    expect(rt.running).toBe(false)
    expect(await waitGone(pid)).toBe(true)

    const rows = (await value(alpha, 'list')) as string[]
    expect(Array.isArray(rows)).toBe(true)
    expect(hostPid()).not.toBe(pid)
  }, 30_000)
})

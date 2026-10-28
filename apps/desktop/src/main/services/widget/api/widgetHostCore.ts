/**
 * 组件宿主的核心逻辑（设计稿 docs/widget-tool-design.md §6、§8）：每个 SQLite 组件一个 QuickJS 沙箱 + 两条 SQLite 连接。
 * 只在组件宿主子进程里运行（入口 widgetHost.ts）；主进程从不 import 它 —— better-sqlite3 的连接与 QuickJS 的 wasm
 * 都只属于子进程，一次调用卡住时主进程 SIGKILL 整个子进程。
 *
 * 规则都在宿主这边执行，不信沙箱里传来的任何东西：
 *   - 用哪条连接由**构建清单**里的 `mode` 决定（请求里带来），读操作走只读连接，并且每条语句都要 `stmt.readonly`；
 *   - handler 的每条语句过首关键字白名单（sqlGuard.ts），`prepare` 只收一条语句；
 *   - 扩展加载保持关闭（better-sqlite3 缺省就关，这里不调用 loadExtension）。
 *
 * 同一组件的请求按顺序执行（一个队列），不同组件互不影响。热上下文按最近使用最多留 {@link MAX_WARM_SANDBOXES} 个。
 */
import Database from 'better-sqlite3'
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule
} from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-singlefile-cjs-release-sync'
import { mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { assertHandlerStatement, assertNoForbiddenSql } from './sqlGuard'
import type {
  CallOutcome,
  CallResult,
  HostError,
  HostRequestBody,
  OpMode,
  WidgetCaller,
  WidgetHostTarget
} from './hostProtocol'
import type { ApiManifest } from './sandboxRuntime'

/** 每个沙箱的内存上限 */
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024
/**
 * QuickJS 的栈上限。组件宿主在子进程主线程上跑 QuickJS：探针里 1 MB 会先撑爆 V8 的栈（宿主侧 RangeError，wasm 状态不可信），
 * 256 KB 以内无限递归由 QuickJS 自己报 `stack overflow`，正常递归约 1000 层
 */
const MAX_STACK_BYTES = 256 * 1024
/** 热上下文最多留几个（每个约几 MB；多出的按最近使用淘汰，下次调用再建） */
export const MAX_WARM_SANDBOXES = 16
/** 一次调用的结果 JSON 上限 */
const MAX_RESULT_CHARS = 8 * 1024 * 1024
/** 只读连接 / 读写连接的页缓存（KiB，负数 = KiB）：每个打开的库约 28 KB 起，用多少长多少 */
const CACHE_SIZE_PRAGMA = 'cache_size = -2000'

export class HostFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** 一次调用期间沙箱里 `__host` 看到的状态 */
interface CallState {
  widget: WidgetState
  mode: OpMode
  /** 嵌套的 `ctx.db.tx` 保存点 */
  savepoints: string[]
  /** 与 savepoints 一一对应：这一层里有没有写过（回滚就作废，提交就并到外一层） */
  savepointDirty: boolean[]
  /** 已经落库（或随最外层保存点提交）的写 —— 决定要不要推 `data` 事件 */
  wrote: boolean
  logs: string[]
}

interface Sandbox {
  module: QuickJSWASMModule
  runtime: QuickJSRuntime
  context: QuickJSContext
  bundleHash: string
  /** 有调用在跑时才有；`__host` 的函数在别的时候（比如包的顶层代码里）碰数据库会报错 */
  current: CallState | null
}

interface WidgetState {
  widgetId: string
  dbPath: string
  rw?: Database.Database
  ro?: Database.Database
  sandbox?: Sandbox
  lastUsed: number
  queue: Promise<unknown>
  /** 有调用在跑：淘汰热上下文时跳过它 */
  busy: boolean
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function toHostError(e: unknown): HostError {
  if (e instanceof HostFailure) return { code: e.code, message: e.message }
  const code =
    typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'internal'
  return { code, message: message(e) }
}

/** SQLite 的行交回沙箱前：BLOB → base64 文本（JSON 装不下 Buffer），其余原样 */
function normalizeRows(rows: unknown[]): unknown[] {
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    for (const key of Object.keys(r)) {
      const v = r[key]
      if (Buffer.isBuffer(v)) r[key] = v.toString('base64')
      else if (typeof v === 'bigint') r[key] = Number(v)
    }
  }
  return rows
}

/** 把 VM 抛出来的东西（dump 后的值）翻成宿主错误 */
function vmFailure(dumped: unknown): HostFailure {
  const msg =
    typeof dumped === 'object' && dumped !== null && 'message' in dumped
      ? String((dumped as { message: unknown }).message)
      : String(dumped)
  if (msg === 'interrupted') {
    return new HostFailure('timeout', 'The operation ran too long and was stopped.')
  }
  if (msg === 'out of memory') {
    return new HostFailure('out_of_memory', 'The operation used too much memory and was stopped.')
  }
  return new HostFailure('internal', msg)
}

/** psql 风格的表格（`widget` 工具 `sql` 的输出，与 PGlite 一侧同形） */
export function formatRowsAsTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(0 rows)'
  const columns = Object.keys(rows[0])
  const cell = (v: unknown): string =>
    v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  // reduce 而不是 Math.max(...rows)：几万行时展开参数会超出调用栈
  const widths = columns.map((c) => rows.reduce((w, r) => Math.max(w, cell(r[c]).length), c.length))
  const header = columns.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|')
  const separator = widths.map((w) => '-'.repeat(w + 2)).join('+')
  const lines = rows.map((r) =>
    columns.map((c, i) => ` ${cell(r[c]).padEnd(widths[i])} `).join('|')
  )
  return [header, separator, ...lines, `(${rows.length} row${rows.length === 1 ? '' : 's'})`].join(
    '\n'
  )
}

export class WidgetHostCore {
  private readonly widgets = new Map<string, WidgetState>()

  /** 一条请求 → 结果（抛 HostFailure 表示失败） */
  async handle(req: HostRequestBody): Promise<unknown> {
    switch (req.type) {
      case 'call': {
        const state = this.stateOf(req.target)
        return this.enqueue(state, () =>
          this.runCall(
            state,
            req.bundlePath,
            req.bundleHash,
            req.op,
            req.mode,
            req.args,
            req.caller,
            req.dryRun === true,
            req.cpuMs
          )
        )
      }
      case 'manifest':
        return this.readManifest(req.bundleCode, req.cpuMs)
      case 'applySchema': {
        const state = this.stateOf(req.target)
        return this.enqueue(state, () => this.applySchema(state, req.ddl))
      }
      case 'query': {
        const state = this.stateOf(req.target)
        return this.enqueue(state, () => this.query(state, req.sql))
      }
      case 'forget': {
        const state = this.widgets.get(req.widgetId)
        if (!state) return null
        return this.enqueue(state, async () => {
          this.forget(state)
          return null
        })
      }
    }
  }

  /** 关掉一切（进程退出前） */
  closeAll(): void {
    for (const state of this.widgets.values()) this.forget(state)
  }

  // ────────────────────────────── 状态与连接 ──────────────────────────────

  private stateOf(target: WidgetHostTarget): WidgetState {
    let state = this.widgets.get(target.widgetId)
    if (!state) {
      state = {
        widgetId: target.widgetId,
        dbPath: target.dbPath,
        lastUsed: Date.now(),
        queue: Promise.resolve(),
        busy: false
      }
      this.widgets.set(target.widgetId, state)
    } else if (state.dbPath !== target.dbPath) {
      // 路径变了（理论上不会）：旧连接作废
      this.closeConnections(state)
      state.dbPath = target.dbPath
    }
    return state
  }

  private enqueue<T>(state: WidgetState, task: () => Promise<T>): Promise<T> {
    const run = state.queue.then(task, task)
    state.queue = run.catch(() => undefined)
    state.lastUsed = Date.now()
    return run
  }

  private rw(state: WidgetState): Database.Database {
    if (state.rw?.open) return state.rw
    mkdirSync(dirname(state.dbPath), { recursive: true })
    const db = new Database(state.dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    db.pragma(CACHE_SIZE_PRAGMA)
    state.rw = db
    return db
  }

  private ro(state: WidgetState): Database.Database {
    if (state.ro?.open) return state.ro
    this.rw(state) // 文件不存在时由读写连接建出来（只读连接打不开不存在的文件）
    const db = new Database(state.dbPath, { readonly: true, fileMustExist: true })
    db.pragma('busy_timeout = 5000')
    db.pragma('query_only = 1')
    db.pragma(CACHE_SIZE_PRAGMA)
    state.ro = db
    return db
  }

  private closeConnections(state: WidgetState): void {
    for (const db of [state.ro, state.rw]) {
      try {
        if (db?.open) db.close()
      } catch {
        // 关不掉也没关系：进程退出时一并释放
      }
    }
    state.ro = undefined
    state.rw = undefined
  }

  /**
   * 扔掉热上下文、关掉连接。状态本身留在表里：排在 forget 后面的请求还会用到它，删掉的话它们会在一个
   * 表外的孤儿状态上重新开连接，之后的请求再建一个 —— 同一个文件就有了两条读写连接
   */
  private forget(state: WidgetState): void {
    this.disposeSandbox(state)
    this.closeConnections(state)
  }

  // ────────────────────────────── 沙箱 ──────────────────────────────

  private disposeSandbox(state: WidgetState): void {
    const sb = state.sandbox
    state.sandbox = undefined
    if (!sb) return
    try {
      sb.context.dispose()
      sb.runtime.dispose()
    } catch {
      // QuickJS 在宿主侧句柄泄漏时会断言中止；模块是这个组件独占的，扔掉就是了
    }
  }

  /** 新建一个沙箱并执行 API 包。每个沙箱一个 wasm 模块实例：一个组件出事只扔掉它自己的模块 */
  private async createSandbox(bundleCode: string, bundleHash: string): Promise<Sandbox> {
    const module = await newQuickJSWASMModuleFromVariant(variant)
    const runtime = module.newRuntime()
    runtime.setMemoryLimit(MEMORY_LIMIT_BYTES)
    runtime.setMaxStackSize(MAX_STACK_BYTES)
    const context = runtime.newContext()
    const sandbox: Sandbox = { module, runtime, context, bundleHash, current: null }
    try {
      this.installHost(sandbox)
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 10_000))
      const result = context.evalCode(bundleCode, 'api.js')
      if (result.error) {
        const dumped = context.dump(result.error)
        result.error.dispose()
        throw vmFailure(dumped)
      }
      result.value.dispose()
      const widget = context.getProp(context.global, '__widget')
      const missing = context.typeof(widget) !== 'object'
      widget.dispose()
      if (missing) {
        throw new HostFailure('internal', 'The API bundle did not install the widget runtime.')
      }
      return sandbox
    } catch (e) {
      try {
        context.dispose()
        runtime.dispose()
      } catch {
        // 见 disposeSandbox
      }
      throw e
    }
  }

  /** 装上 `__host`（同步函数；沙箱运行时会把它收进闭包、从全局摘掉） */
  private installHost(sb: Sandbox): void {
    const ctx = sb.context
    const host = ctx.newObject()
    const callOf = (): CallState => {
      if (!sb.current) throw new Error('The database is only available inside an operation.')
      return sb.current
    }
    const db = ctx.newFunction('db', (kindH, textH, paramsH) => {
      const call = callOf()
      const kind = ctx.getString(kindH) === 'run' ? 'run' : 'all'
      const text = ctx.getString(textH)
      const params = JSON.parse(ctx.getString(paramsH)) as unknown
      const out = this.runStatement(call, kind, text, Array.isArray(params) ? params : [])
      return ctx.newString(JSON.stringify(out))
    })
    const tx = ctx.newFunction('tx', (actionH, nameH) => {
      const name = this.runTx(
        callOf(),
        ctx.getString(actionH),
        nameH && ctx.typeof(nameH) === 'string' ? ctx.getString(nameH) : ''
      )
      return ctx.newString(name)
    })
    const log = ctx.newFunction('log', (textH) => {
      const call = callOf()
      if (call.logs.length < 200) call.logs.push(ctx.getString(textH).slice(0, 2000))
    })
    const uuid = ctx.newFunction('uuid', () => ctx.newString(randomUUID()))
    for (const [name, fn] of [
      ['db', db],
      ['tx', tx],
      ['log', log],
      ['uuid', uuid]
    ] as const) {
      ctx.setProp(host, name, fn)
      fn.dispose()
    }
    ctx.setProp(ctx.global, '__host', host)
    host.dispose()
  }

  private runStatement(
    call: CallState,
    kind: 'all' | 'run',
    text: string,
    params: unknown[]
  ): unknown {
    assertHandlerStatement(text)
    const conn = call.mode === 'read' ? this.ro(call.widget) : this.rw(call.widget)
    const stmt = conn.prepare(text)
    if (!stmt.readonly && call.mode === 'read') {
      throw new Error('A read operation cannot change data; define it with op.write.')
    }
    if (kind === 'run') {
      const info = stmt.run(...params)
      if (!stmt.readonly) this.markWrite(call)
      return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) }
    }
    if (stmt.reader) {
      const rows = normalizeRows(stmt.all(...params))
      if (!stmt.readonly) this.markWrite(call)
      return rows
    }
    stmt.run(...params)
    if (!stmt.readonly) this.markWrite(call)
    return []
  }

  /** 记一次写：在保存点里就记在那一层（回滚了就不算），不在就是已经自动提交了 */
  private markWrite(call: CallState): void {
    if (call.savepointDirty.length > 0) call.savepointDirty[call.savepointDirty.length - 1] = true
    else call.wrote = true
  }

  /**
   * 事务用 SAVEPOINT：`begin` 返回保存点名，`commit` / `rollback` 必须带着它、而且只能结束最里面那一个 ——
   * 两个事务交错（`Promise.all([tx(a), tx(b)])`）时按「最近一个」去结束，会让 b 的回滚把 a 一起撤掉
   */
  private runTx(call: CallState, action: string, name: string): string {
    if (call.mode !== 'write') throw new Error('Transactions are only for write operations.')
    const conn = this.rw(call.widget)
    if (action === 'begin') {
      const next = `shuvix_tx_${call.savepoints.length}`
      conn.exec(`SAVEPOINT ${next}`)
      call.savepoints.push(next)
      call.savepointDirty.push(false)
      return next
    }
    const innermost = call.savepoints[call.savepoints.length - 1]
    if (!innermost) throw new Error('No transaction is open.')
    if (name !== innermost) {
      throw new Error(
        'Transactions must finish in the reverse order they started; do not run two ctx.db.tx at the same time.'
      )
    }
    call.savepoints.pop()
    const dirty = call.savepointDirty.pop() === true
    if (action === 'rollback') conn.exec(`ROLLBACK TO ${name}`)
    conn.exec(`RELEASE ${name}`)
    if (action !== 'rollback' && dirty) this.markWrite(call)
    return name
  }

  /** 调用结束时还开着的保存点（handler 绕过 ctx.db.tx 直接碰宿主的结果）一律回滚 */
  private rollbackOpen(call: CallState): boolean {
    if (call.savepoints.length === 0) return false
    const conn = this.rw(call.widget)
    call.savepointDirty.length = 0
    while (call.savepoints.length > 0) {
      const name = call.savepoints.pop()!
      conn.exec(`ROLLBACK TO ${name}`)
      conn.exec(`RELEASE ${name}`)
    }
    return true
  }

  private async ensureSandbox(
    state: WidgetState,
    bundlePath: string,
    bundleHash: string
  ): Promise<Sandbox> {
    if (state.sandbox && state.sandbox.bundleHash === bundleHash) return state.sandbox
    this.disposeSandbox(state)
    let code: string
    try {
      code = readFileSync(bundlePath, 'utf8')
    } catch (e) {
      throw new HostFailure('no_api', `The widget's API build is missing (${message(e)}).`)
    }
    this.evictColdSandboxes(state)
    state.sandbox = await this.createSandbox(code, bundleHash)
    return state.sandbox
  }

  /** 热上下文超过上限时，按最近使用淘汰（不动 `keep`，也不动正在调用中的） */
  private evictColdSandboxes(keep: WidgetState): void {
    const warm = [...this.widgets.values()].filter((w) => w.sandbox && w !== keep && !w.busy)
    if (warm.length < MAX_WARM_SANDBOXES) return
    warm.sort((a, b) => a.lastUsed - b.lastUsed)
    for (const w of warm.slice(0, warm.length - MAX_WARM_SANDBOXES + 1)) this.disposeSandbox(w)
  }

  // ────────────────────────────── 请求 ──────────────────────────────

  private async runCall(
    state: WidgetState,
    bundlePath: string,
    bundleHash: string,
    op: string,
    mode: OpMode,
    args: unknown,
    caller: WidgetCaller,
    dryRun: boolean,
    cpuMs: number
  ): Promise<CallResult> {
    state.busy = true
    try {
      const sb = await this.ensureSandbox(state, bundlePath, bundleHash)
      const call: CallState = {
        widget: state,
        mode,
        savepoints: [],
        savepointDirty: [],
        wrote: false,
        logs: []
      }
      const dryRunWrite = dryRun && mode === 'write'
      if (dryRunWrite) this.rw(state).exec('SAVEPOINT shuvix_dry_run')
      sb.current = call
      let leftOpen = false
      try {
        sb.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + cpuMs))
        let outcome: CallOutcome
        try {
          outcome = await this.invoke(sb, op, args, caller)
        } catch (e) {
          // VM 层的失败（中断、内存超限、栈溢出……）之后，这个上下文不再可信：换新
          this.disposeSandbox(state)
          throw e
        }
        leftOpen = this.rollbackOpen(call)
        if (leftOpen && outcome.ok) {
          outcome = {
            ok: false,
            error: {
              code: 'internal',
              message: 'The operation left a transaction open; it was rolled back.'
            }
          }
        }
        // 写语句逐条自动提交（D7）：handler 后来失败了，前面提交的写也已经在库里 —— 照样通知界面重新取数
        return { outcome, wrote: call.wrote && !dryRun, logs: call.logs }
      } finally {
        sb.current = null
        // 不管怎么结束（含 VM 层失败）：还开着的保存点都回滚，否则这条读写连接以后的写全都提交不了
        if (!leftOpen) this.rollbackOpen(call)
        if (dryRunWrite) {
          const conn = this.rw(state)
          conn.exec('ROLLBACK TO shuvix_dry_run')
          conn.exec('RELEASE shuvix_dry_run')
        }
      }
    } finally {
      state.busy = false
    }
  }

  /** 调 `__widget.call(...)`，驱动它的 Promise 直到落定 */
  private async invoke(
    sb: Sandbox,
    op: string,
    args: unknown,
    caller: WidgetCaller
  ): Promise<CallOutcome> {
    const { context: ctx, runtime } = sb
    const widget = ctx.getProp(ctx.global, '__widget')
    const fn = ctx.getProp(widget, 'call')
    const argHandles: QuickJSHandle[] = [
      ctx.newString(op),
      ctx.newString(JSON.stringify(args ?? {})),
      ctx.newString(JSON.stringify(caller))
    ]
    const result = ctx.callFunction(fn, widget, ...argHandles)
    for (const h of argHandles) h.dispose()
    fn.dispose()
    widget.dispose()
    if (result.error) {
      const dumped = ctx.dump(result.error)
      result.error.dispose()
      throw vmFailure(dumped)
    }
    const promise = result.value
    try {
      // 宿主函数都是同步的：一轮 executePendingJobs 之后 Promise 就该落定；还悬着说明 handler 在等一个永远不会来的东西
      for (;;) {
        const jobs = runtime.executePendingJobs()
        if (jobs.error) {
          const dumped = ctx.dump(jobs.error)
          jobs.error.dispose()
          throw vmFailure(dumped)
        }
        const state = ctx.getPromiseState(promise)
        if (state.type === 'fulfilled') {
          const json = ctx.getString(state.value)
          state.value.dispose()
          if (json.length > MAX_RESULT_CHARS) {
            return {
              ok: false,
              error: {
                code: 'too_large',
                message: 'The operation returned more than 8 MB of data.'
              }
            }
          }
          return JSON.parse(json) as CallOutcome
        }
        if (state.type === 'rejected') {
          const dumped = ctx.dump(state.error)
          state.error.dispose()
          throw vmFailure(dumped)
        }
        if (!runtime.hasPendingJob()) {
          throw new HostFailure(
            'internal',
            'The operation never finished: it awaited something that never settles.'
          )
        }
      }
    } finally {
      promise.dispose()
    }
  }

  private async readManifest(bundleCode: string, cpuMs: number): Promise<ApiManifest> {
    const sb = await this.createSandbox(bundleCode, '')
    try {
      sb.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + cpuMs))
      const result = sb.context.evalCode('__widget.manifest()', 'manifest.js')
      if (result.error) {
        const dumped = sb.context.dump(result.error)
        result.error.dispose()
        throw vmFailure(dumped)
      }
      const json = sb.context.getString(result.value)
      result.value.dispose()
      return JSON.parse(json) as ApiManifest
    } finally {
      try {
        sb.context.dispose()
        sb.runtime.dispose()
      } catch {
        // 见 disposeSandbox
      }
    }
  }

  private async applySchema(state: WidgetState, ddl: string): Promise<{ applied: true }> {
    assertNoForbiddenSql(ddl, 'schema')
    const conn = this.rw(state)
    conn.exec('BEGIN IMMEDIATE')
    try {
      conn.exec(ddl)
      conn.exec('COMMIT')
    } catch (e) {
      if (conn.inTransaction) conn.exec('ROLLBACK')
      throw new HostFailure('schema_failed', message(e))
    }
    return { applied: true }
  }

  private async query(state: WidgetState, sql: string): Promise<{ output: string }> {
    assertNoForbiddenSql(sql, 'query')
    const conn = this.rw(state)
    let stmt: Database.Statement
    try {
      stmt = conn.prepare(sql)
    } catch (e) {
      if (/more than one statement/i.test(message(e))) {
        conn.exec(sql)
        return { output: 'OK' }
      }
      throw new HostFailure('query_failed', message(e))
    }
    try {
      if (stmt.reader) {
        return { output: formatRowsAsTable(normalizeRows(stmt.all()) as Record<string, unknown>[]) }
      }
      const info = stmt.run()
      return { output: `OK (${info.changes} row${info.changes === 1 ? '' : 's'} changed)` }
    } catch (e) {
      throw new HostFailure('query_failed', message(e))
    }
  }
}

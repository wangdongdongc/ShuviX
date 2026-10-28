/**
 * SQLite 组件与它们的 API（设计稿 docs/widget-tool-design.md §3、§6、§9）：存储归属、API 编译与构建快照、调用。
 *
 * **存储归属看事实，不看标记**：组件的数据目录 `~/.shuvix/widgets-data/<id>/` 在 = SQLite 组件，不在 = 老组件
 * （数据在共用 PGlite 里，界面直接写 `/db`）。`init` 给新组件建这个目录；老组件换存储时由那个入口建它（设计稿 §10）；
 * 删除组件时连目录一起删。
 * 没有第二个字段要和它保持一致 —— `widget.json` 在 agent 可写的组件仓库里，放在那儿只会被改坏。
 *
 * **只有构建过的 API 才生效**：构建（`widget` 工具的 `build`）编译 `api.ts`、在组件宿主里取清单并校验，界面也构建成功后
 * 才把包和清单写进数据目录（快照）。调用只认快照 —— 没有这个组件读写授权的 agent 改了 `api.ts` 也改变不了行为，
 * 打开组件（会重建界面）也不会顺带重建 API。
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { getWidgetsDataDir } from '../../../utils/paths'
import { writeFileAtomic } from '../../../utils/atomicWrite'
import { bundlerService } from '../../bundler'
import { createLogger } from '../../../logger'
import { widgetRuntime, WidgetRuntimeError } from './widgetRuntime'
import type { CallResult, OpMode, WidgetCaller, WidgetHostTarget } from './hostProtocol'
import { OP_NAME_RE, type ApiManifest, type OpManifest } from './sandboxRuntime'
import { WIDGET_ID_REGEX } from '../widgetRegistry'

const log = createLogger('WidgetApi')

/** 组件里定义 API 的文件 */
export const API_SOURCE_FILE = 'api.ts'
const DB_FILE = 'data.sqlite'
const SNAPSHOT_BUNDLE = 'api.js'
const SNAPSHOT_MANIFEST = 'api.json'

export type WidgetStorage = 'sqlite' | 'pglite'

/** 组件的数据目录（不创建）。id 原样拼进路径，所以先验：`..` 之类会指到数据根之外 */
export function widgetDataDirOf(widgetId: string): string {
  if (!WIDGET_ID_REGEX.test(widgetId)) throw new Error(`Invalid widget id "${widgetId}".`)
  return join(getWidgetsDataDir(), widgetId)
}

export function widgetHostTarget(widgetId: string): WidgetHostTarget {
  return { widgetId, dbPath: join(widgetDataDirOf(widgetId), DB_FILE) }
}

/** 组件的数据在哪：数据目录在 → SQLite；不在 → 老组件（共用 PGlite） */
export function widgetStorageOf(widgetId: string): WidgetStorage {
  return existsSync(widgetDataDirOf(widgetId)) ? 'sqlite' : 'pglite'
}

/** 新组件：建数据目录，从此它就是 SQLite 组件 */
export function createWidgetDataDir(widgetId: string): void {
  mkdirSync(widgetDataDirOf(widgetId), { recursive: true })
}

/** 删除组件：关掉它在宿主里的一切，再删数据目录（数据库、快照） */
export async function removeWidgetData(widgetId: string): Promise<void> {
  await forgetInHost(widgetId)
  rmSync(widgetDataDirOf(widgetId), { recursive: true, force: true })
}

async function forgetInHost(widgetId: string): Promise<void> {
  try {
    await widgetRuntime.forget(widgetId)
  } catch (e) {
    log.warn(`forget ${widgetId} in the widget host failed: ${(e as Error).message}`)
  }
}

// ────────────────────────────── 快照 ──────────────────────────────

/** 生效中的 API 快照（`api.json`） */
export interface ApiSnapshot {
  /** API 包的 sha256 前 32 位：宿主据此判断热上下文还能不能用 */
  hash: string
  builtAt: number
  ops: OpManifest[]
}

function snapshotPaths(widgetId: string): { bundle: string; manifest: string } {
  const dir = widgetDataDirOf(widgetId)
  return { bundle: join(dir, SNAPSHOT_BUNDLE), manifest: join(dir, SNAPSHOT_MANIFEST) }
}

/** 读生效中的 API 快照；没有 API（或快照坏了）→ null */
export function readApiSnapshot(widgetId: string): ApiSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(snapshotPaths(widgetId).manifest, 'utf8')) as ApiSnapshot
    if (typeof parsed?.hash !== 'string' || !Array.isArray(parsed.ops)) return null
    return parsed
  } catch {
    return null
  }
}

/** 编译好、还没生效的 API */
export interface CompiledApi {
  code: string
  hash: string
  ops: OpManifest[]
}

export type CompileApiResult =
  | { kind: 'none' }
  | { kind: 'ok'; api: CompiledApi }
  | { kind: 'error'; errors: string[] }

/** 宿主再核一遍清单（清单出自沙箱，不全信） */
function checkManifest(manifest: ApiManifest): string[] {
  const errors = [...(Array.isArray(manifest?.errors) ? manifest.errors.map(String) : [])]
  const ops = Array.isArray(manifest?.ops) ? manifest.ops : []
  for (const op of ops) {
    if (!OP_NAME_RE.test(op.name)) errors.push(`Invalid operation name "${op.name}".`)
    if (op.mode !== 'read' && op.mode !== 'write') {
      errors.push(`Operation "${op.name}" has no read/write mode.`)
    }
  }
  if (ops.length === 0 && errors.length === 0) errors.push('api.ts defines no operations.')
  return errors
}

/**
 * 编译组件的 `api.ts` 并在组件宿主的临时沙箱里取清单。没有 `api.ts` → `none`。
 * 老组件（数据还在共用 PGlite 里）不能有 API：ctx.db 是 SQLite
 */
export async function compileWidgetApi(
  widgetId: string,
  projectDir: string
): Promise<CompileApiResult> {
  if (!existsSync(join(projectDir, API_SOURCE_FILE))) return { kind: 'none' }
  if (widgetStorageOf(widgetId) !== 'sqlite') {
    return {
      kind: 'error',
      errors: [
        `This widget keeps its data in the older shared database, so it cannot have an ${API_SOURCE_FILE} yet. ` +
          'Move its data to SQLite first (see the widget skill, references/maintenance.md).'
      ]
    }
  }
  const bundle = await bundlerService.buildApi(projectDir, API_SOURCE_FILE)
  if (!bundle.success || !bundle.outputJS) {
    return { kind: 'error', errors: bundle.errors ?? [`${API_SOURCE_FILE} did not build.`] }
  }
  let manifest: ApiManifest
  try {
    manifest = await widgetRuntime.manifest(bundle.outputJS)
  } catch (e) {
    return { kind: 'error', errors: [`${API_SOURCE_FILE}: ${(e as Error).message}`] }
  }
  const errors = checkManifest(manifest)
  if (errors.length > 0)
    return { kind: 'error', errors: errors.map((m) => `${API_SOURCE_FILE}: ${m}`) }
  const hash = createHash('sha256').update(bundle.outputJS, 'utf8').digest('hex').slice(0, 32)
  return { kind: 'ok', api: { code: bundle.outputJS, hash, ops: manifest.ops } }
}

/**
 * 让编译好的 API 生效（界面也构建成功之后）；`null` = 组件不再有 API，删掉旧快照。
 * 先写包再写清单：读方以清单为准，清单换成新的那一刻包已经在了
 */
export async function activateWidgetApi(widgetId: string, api: CompiledApi | null): Promise<void> {
  const paths = snapshotPaths(widgetId)
  if (api) {
    mkdirSync(widgetDataDirOf(widgetId), { recursive: true })
    writeFileAtomic(paths.bundle, api.code)
    const snapshot: ApiSnapshot = { hash: api.hash, builtAt: Date.now(), ops: api.ops }
    writeFileAtomic(paths.manifest, JSON.stringify(snapshot, null, 2) + '\n')
  } else {
    rmSync(paths.manifest, { force: true })
    rmSync(paths.bundle, { force: true })
  }
  await forgetInHost(widgetId)
}

/** 与上一个快照相比消失了、或参数变了的操作（构建时给一条警告：别的会话和 agent 可能依赖它们） */
export function changedOps(before: ApiSnapshot | null, after: CompiledApi | null): string[] {
  if (!before) return []
  const now = new Map((after?.ops ?? []).map((o) => [o.name, o]))
  const out: string[] = []
  for (const op of before.ops) {
    const next = now.get(op.name)
    if (!next) out.push(`removed "${op.name}"`)
    else if (JSON.stringify(next.input) !== JSON.stringify(op.input)) {
      out.push(`changed the input of "${op.name}"`)
    }
  }
  return out
}

// ────────────────────────────── 调用 ──────────────────────────────

/** 一次提交了写的调用之后通知谁（widgetServer 订阅它，向开着的界面推 SSE `data`；不直接 import，免得互相引用） */
export interface WidgetDataChange {
  widgetId: string
  op: string
  source: WidgetCaller['kind']
}
const dataListeners = new Set<(change: WidgetDataChange) => void>()

export function onWidgetDataChanged(listener: (change: WidgetDataChange) => void): () => void {
  dataListeners.add(listener)
  return () => dataListeners.delete(listener)
}

function emitDataChanged(change: WidgetDataChange): void {
  for (const listener of dataListeners) {
    try {
      listener(change)
    } catch (e) {
      log.warn(`data-change listener failed: ${(e as Error).message}`)
    }
  }
}

export class WidgetApiError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface WidgetCallOptions {
  dryRun?: boolean
  /**
   * 纯界面的操作（`agent: false`）也调得到：组件自己的界面在调（`/api` 路由，含预览页面），或造组件的 agent 在
   * dry run 里测它。缺省只有用户调得到
   */
  allowUiOnly?: boolean
  /**
   * 调用方按这个读 / 写授权的（先读快照判了授权，再来调）：快照里这个操作现在不是它 —— 其间有人重新构建、改了
   * 它的读写 —— 就拒绝（`changed`），不按旧的授权照跑
   */
  expectedMode?: OpMode
}

export interface WidgetCallResult {
  op: string
  mode: OpMode
  result: CallResult
}

/**
 * 调一个操作（界面经 `/w/<id>/api/<op>`、agent 经 `widget` 工具，都走这里）。
 * 抛 WidgetApiError：组件没有 API / 没有这个操作 / 宿主出错。handler 自己的失败（参数不对、ctx.fail …）
 * 在 `result.outcome` 里，不抛
 */
export async function callWidgetOp(
  widgetId: string,
  op: string,
  args: unknown,
  caller: WidgetCaller,
  options: WidgetCallOptions = {}
): Promise<WidgetCallResult> {
  if (widgetStorageOf(widgetId) !== 'sqlite') {
    throw new WidgetApiError('no_api', `Widget "${widgetId}" has no API.`)
  }
  const snapshot = readApiSnapshot(widgetId)
  if (!snapshot) {
    throw new WidgetApiError(
      'no_api',
      `Widget "${widgetId}" has no API. Define ${API_SOURCE_FILE} and build the widget.`
    )
  }
  // `agent: false` 的操作只给界面：agent 调不到，也不在清单里提（组件自己的界面、造组件时的 dry run 例外）
  const visible = (o: OpManifest): boolean =>
    o.agent !== false || caller.kind === 'user' || options.allowUiOnly === true
  const entry = snapshot.ops.find((o) => o.name === op && visible(o))
  if (!entry) {
    throw new WidgetApiError(
      'unknown_op',
      `Widget "${widgetId}" has no operation "${op}". Its operations: ${snapshot.ops
        .filter(visible)
        .map((o) => o.name)
        .join(', ')}.`
    )
  }
  if (options.expectedMode !== undefined && entry.mode !== options.expectedMode) {
    throw new WidgetApiError(
      'changed',
      `Operation "${op}" of widget "${widgetId}" is now a ${entry.mode} operation (the widget was rebuilt). Look at it again before calling it.`
    )
  }
  try {
    const result = await widgetRuntime.call({
      target: widgetHostTarget(widgetId),
      bundlePath: snapshotPaths(widgetId).bundle,
      bundleHash: snapshot.hash,
      op,
      mode: entry.mode,
      args,
      caller,
      dryRun: options.dryRun === true
    })
    if (result.wrote) emitDataChanged({ widgetId, op, source: caller.kind })
    return { op, mode: entry.mode, result }
  } catch (e) {
    if (e instanceof WidgetRuntimeError) throw new WidgetApiError(e.code, e.message)
    throw e
  }
}

/** 装 / 更新 SQLite 组件的结构（`db-init`） */
export async function applyWidgetSqliteSchema(widgetId: string, ddl: string): Promise<void> {
  try {
    await widgetRuntime.applySchema(widgetHostTarget(widgetId), ddl)
  } catch (e) {
    if (e instanceof WidgetRuntimeError) throw new WidgetApiError(e.code, e.message)
    throw e
  }
}

/** 在 SQLite 组件的库上跑一段 SQL（`db-query`）→ 表格文本 */
export async function queryWidgetSqlite(widgetId: string, sql: string): Promise<string> {
  try {
    return (await widgetRuntime.query(widgetHostTarget(widgetId), sql)).output
  } catch (e) {
    if (e instanceof WidgetRuntimeError) throw new WidgetApiError(e.code, e.message)
    throw e
  }
}

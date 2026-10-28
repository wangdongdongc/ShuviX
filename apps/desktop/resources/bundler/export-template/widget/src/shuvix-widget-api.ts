// Copied from ShuviX (src/main/services/widget/api/sandboxRuntime.ts) when ShuviX was built.
// `shuvix/widget-api` resolves here (see tsconfig.json) so that api.ts type-checks. Nothing in this
// project runs it: inside ShuviX, the operations run in a sandbox next to the widget database.
/**
 * `shuvix/widget-api` —— 组件 API 在沙箱（QuickJS）里的运行时，也是组件作者在 `api.ts` 里 import 的模块。
 *
 * 设计稿：docs/widget-tool-design.md §3、§6。这份源码**不进主进程**：`scripts/bundle-widget-api.mjs` 把它打成
 * `resources/bundler/deps/widget-api.esm.js`（zod 外置，和 `zod.esm.js` 共用一个实例），组件 build 时由打包器把
 * `shuvix/widget-api` 映射到那个文件，和 `api.ts` 一起打成一个 IIFE，交给组件宿主子进程里的 QuickJS 执行。
 *
 * 沙箱里只有 JS 内建和宿主装进来的 `__host`（同步函数，见 hostProtocol.ts 的 SandboxHost）：读写模式、语句白名单、
 * 用哪条连接都由宿主按**构建清单**决定，不信这里传过去的任何东西 —— 这个模块只是把它们包成好用的 `ctx`。
 */
import { z } from 'zod'

export { z }

/** 操作的读写模式：`read` 的语句走只读连接，`write` 的走读写连接、提交后推送 `data` 事件 */
export type OpMode = 'read' | 'write'

/** 谁在调用：界面（用户）或经 widget 工具 / CLI 的 agent */
export interface WidgetCaller {
  kind: 'user' | 'agent'
  /** agent 所在的会话 */
  sessionId?: string
  /** agent 的出处标识（`shuvix-<profile>/<model>`、`cli` …） */
  actor?: string
  /** 记出处用的一句话：`user` 或 actor */
  label: string
}

/** 不返回行的语句的执行结果 */
export interface DbRunResult {
  changes: number
  lastInsertRowid: number
}

/** 组件自己的 SQLite 库。一次调用一条语句；`?` 占位，值经参数绑定（`sql` / `run` 的模板插值自动转成参数） */
export interface WidgetDb {
  /** 查询（或带 RETURNING 的写）→ 行；不返回行的语句 → [] */
  sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>
  /** 不返回行的语句 → 改了几行、最后插入的 rowid */
  run(strings: TemplateStringsArray, ...values: unknown[]): Promise<DbRunResult>
  /** 手写 `?` 占位的查询 → 行 */
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>
  /** 把几条写放进一个事务：回调正常结束就提交，抛错就回滚（可嵌套）。只用于写操作 */
  tx<T>(fn: (tx: WidgetDb) => Promise<T> | T): Promise<T>
}

/** handler 能碰的全部东西 */
export interface WidgetCtx {
  db: WidgetDb
  caller: WidgetCaller
  /** 以给定代码结束这次调用：界面得到 `{ error: { code, message } }`，agent 得到同一句 message */
  fail(code: string, message: string): never
  /** 当前时刻（ISO 8601） */
  now(): string
  /** 随机 UUID（v4） */
  uuid(): string
  /** 写一行日志（宿主收集；`widget` 工具的 `call` 会显示） */
  log(...args: unknown[]): void
}

type AnyObjectSchema = z.ZodObject<z.ZodRawShape>

export interface OpDef<I extends AnyObjectSchema, O extends z.ZodType | undefined> {
  /** 写给 agent 看：做什么、什么时候用、重复调用会怎样 */
  description: string
  /** 参数：一个 `z.object(...)` */
  input: I
  /** 返回值（可选）：给了就按它校验，也写进给 agent 的说明 */
  output?: O
  /** false = 只给界面用（界面布局、偏好），agent 看不到；缺省 true */
  agent?: boolean
  handler: (
    input: z.output<I>,
    ctx: WidgetCtx
  ) => O extends z.ZodType ? z.input<O> | Promise<z.input<O>> : unknown
}

export type Op<
  I extends AnyObjectSchema = AnyObjectSchema,
  O extends z.ZodType | undefined = z.ZodType | undefined
> = OpDef<I, O> & { readonly mode: OpMode; readonly [OP_BRAND]: true }

const OP_BRAND = '__shuvixWidgetOp'

function makeOp(mode: OpMode) {
  return <I extends AnyObjectSchema, O extends z.ZodType | undefined = undefined>(
    def: OpDef<I, O>
  ): Op<I, O> => ({ ...def, mode, [OP_BRAND]: true }) as Op<I, O>
}

/** 定义一个操作：`op.read` 不改数据，`op.write` 改数据 */
export const op = {
  read: makeOp('read'),
  write: makeOp('write')
}

/**
 * `defineApi` 收的「任意一个操作」。各操作 handler 的参数类型各不相同：参数写成 `never`，任何 handler 都放得进来
 * （写成 `Op` 的缺省类型时 handler 参数是宽类型，严格函数类型下每个具体的 handler 都会报 TS2322）
 */
interface AnyOp {
  readonly mode: OpMode
  readonly [OP_BRAND]: true
  description: string
  input: z.ZodType
  output?: z.ZodType
  agent?: boolean
  handler: (input: never, ctx: WidgetCtx) => unknown
}

/** 整套 API（`api.ts` 的默认导出） */
export function defineApi<T extends Record<string, AnyOp>>(api: T): T {
  return api
}

// ────────────────────────────── 宿主在沙箱里装的东西 ──────────────────────────────

/** 宿主装进沙箱的同步函数（组件宿主 widgetHost.ts 实现） */
interface SandboxHost {
  /** kind 'all' → 行的 JSON；'run' → DbRunResult 的 JSON。出错直接抛 */
  db(kind: 'all' | 'run', text: string, paramsJson: string): string
  /** 事务（宿主用 SAVEPOINT，可嵌套）：`begin` 返回保存点名，结束时带回去 */
  tx(action: 'begin' | 'commit' | 'rollback', name?: string): string
  log(text: string): void
  uuid(): string
}

/** 清单里的一个操作（build 时宿主据此校验并存快照） */
export interface OpManifest {
  name: string
  mode: OpMode
  description: string
  agent: boolean
  input: unknown
  output?: unknown
}

export interface ApiManifest {
  ops: OpManifest[]
  errors: string[]
}

/** 调用结果（JSON 交回宿主） */
export type CallOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

export const OP_NAME_RE = /^[a-z][a-zA-Z0-9]{0,47}$/
const FAIL_CODE_RE = /^[a-z][a-z0-9_]{0,47}$/
/**
 * 宿主自己的错误码：`ctx.fail` 不能用它们（界面按码分辨「参数不对」「宿主超时」…，handler 冒充会让人误判），
 * 用了就记成 `failed`
 */
const RESERVED_FAIL_CODES = new Set([
  'internal',
  'invalid_args',
  'unknown_op',
  'bad_output',
  'too_large',
  'out_of_memory',
  'timeout',
  'interrupted',
  'no_api',
  'sql_refused'
])

class WidgetFail extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

function isOp(value: unknown): value is Op {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[OP_BRAND] === true
  )
}

/** 把一个插值变成 SQLite 能绑定的值：布尔 → 0/1，日期 → ISO，对象 / 数组 → JSON 文本，undefined → null */
function toSqlValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number' || typeof value === 'string') return value
  if (typeof value === 'bigint') {
    throw new Error('BigInt values cannot be stored; convert to a number or string first')
  }
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}

function templateToQuery(
  strings: TemplateStringsArray,
  values: readonly unknown[]
): { text: string; params: unknown[] } {
  let text = strings[0]
  for (let i = 1; i < strings.length; i++) text += '?' + strings[i]
  return { text, params: values.map(toSqlValue) }
}

/**
 * 一层 `db`：顶层的 `ctx.db`，或 `ctx.db.tx` 交给回调的那一层（在它上面再 `tx` 就是嵌套）。
 * 同一层同时只许一个事务：两个事务交错时谁先结束都不对（保存点只能从里往外结束），所以第二个直接报错
 */
function makeDb(host: SandboxHost): WidgetDb {
  const all = <T>(text: string, params: readonly unknown[]): T[] =>
    JSON.parse(host.db('all', text, JSON.stringify(params.map(toSqlValue)))) as T[]
  let txActive = false
  const db: WidgetDb = {
    async sql<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> {
      const q = templateToQuery(strings, values)
      return all<T>(q.text, q.params)
    },
    async run(strings: TemplateStringsArray, ...values: unknown[]): Promise<DbRunResult> {
      const q = templateToQuery(strings, values)
      return JSON.parse(host.db('run', q.text, JSON.stringify(q.params))) as DbRunResult
    },
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return all<T>(text, params)
    },
    async tx<T>(fn: (tx: WidgetDb) => Promise<T> | T): Promise<T> {
      if (txActive) {
        throw new Error(
          'Another ctx.db.tx is still running here; await it first, or nest by calling tx on the object your callback receives.'
        )
      }
      txActive = true
      try {
        const name = host.tx('begin')
        let result: T
        try {
          result = await fn(makeDb(host))
        } catch (e) {
          host.tx('rollback', name)
          throw e
        }
        host.tx('commit', name)
        return result
      } finally {
        txActive = false
      }
    }
  }
  return db
}

function stringifyLogArg(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function makeCtx(host: SandboxHost, caller: WidgetCaller): WidgetCtx {
  return {
    db: makeDb(host),
    caller,
    fail(code: string, message: string): never {
      const ok =
        FAIL_CODE_RE.test(code) && !RESERVED_FAIL_CODES.has(code) && !code.startsWith('host_')
      throw new WidgetFail(ok ? code : 'failed', String(message))
    },
    now: () => new Date().toISOString(),
    uuid: () => host.uuid(),
    log: (...args: unknown[]) => host.log(args.map(stringifyLogArg).join(' '))
  }
}

/** 读一个操作的清单项；不合规 → 错误说明 */
function describeOp(name: string, value: unknown): OpManifest | string {
  if (!OP_NAME_RE.test(name)) {
    return `Operation name "${name}" must start with a lowercase letter and use only letters and digits (camelCase, at most 48).`
  }
  if (!isOp(value)) {
    return `"${name}" is not an operation: define it with op.read({...}) or op.write({...}).`
  }
  if (typeof value.description !== 'string' || value.description.trim() === '') {
    return `Operation "${name}" needs a description (written for the agent: what it does and when to use it).`
  }
  if (!(value.input instanceof z.ZodObject)) {
    return `Operation "${name}" needs input: z.object({...}) (use z.object({}) when it takes no arguments).`
  }
  if (typeof value.handler !== 'function') {
    return `Operation "${name}" needs a handler function.`
  }
  if (value.agent !== undefined && typeof value.agent !== 'boolean') {
    return `Operation "${name}": agent must be true or false.`
  }
  let input: unknown
  try {
    input = z.toJSONSchema(value.input, { io: 'input', unrepresentable: 'throw' })
  } catch (e) {
    return `Operation "${name}": its input cannot be described as JSON Schema (${(e as Error).message}). Use z.string() with a format for dates, numbers instead of bigint, and objects instead of maps.`
  }
  let output: unknown
  if (value.output !== undefined) {
    if (!(value.output instanceof z.ZodType)) {
      return `Operation "${name}": output must be a zod schema.`
    }
    try {
      output = z.toJSONSchema(value.output, { io: 'output', unrepresentable: 'throw' })
    } catch (e) {
      return `Operation "${name}": its output cannot be described as JSON Schema (${(e as Error).message}).`
    }
  }
  return {
    name,
    mode: value.mode,
    description: value.description.trim(),
    agent: value.agent !== false,
    input,
    ...(output !== undefined ? { output } : {})
  }
}

/** 读整套 API 的清单（build 时在沙箱里跑一次） */
export function buildManifest(api: unknown): ApiManifest {
  const ops: OpManifest[] = []
  const errors: string[] = []
  if (typeof api !== 'object' || api === null || Array.isArray(api)) {
    return {
      ops,
      errors: ['api.ts must `export default defineApi({ ... })`.']
    }
  }
  for (const [name, value] of Object.entries(api)) {
    const described = describeOp(name, value)
    if (typeof described === 'string') errors.push(described)
    else ops.push(described)
  }
  if (ops.length === 0 && errors.length === 0) {
    errors.push('api.ts defines no operations.')
  }
  return { ops, errors }
}

/** 执行一次调用 */
export async function callOp(
  api: Record<string, unknown>,
  host: SandboxHost,
  name: string,
  args: unknown,
  caller: WidgetCaller
): Promise<CallOutcome> {
  const value = Object.prototype.hasOwnProperty.call(api, name) ? api[name] : undefined
  if (!isOp(value)) {
    return {
      ok: false,
      error: {
        code: 'unknown_op',
        message: `This widget has no operation "${name}". Its operations: ${Object.keys(api).join(', ')}.`
      }
    }
  }
  const parsed = value.input.safeParse(args ?? {})
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'invalid_args', message: z.prettifyError(parsed.error) }
    }
  }
  let result: unknown
  try {
    result = await value.handler(parsed.data, makeCtx(host, caller))
  } catch (e) {
    if (e instanceof WidgetFail) return { ok: false, error: { code: e.code, message: e.message } }
    // 内存超限这类 VM 层的错误要交给宿主处理（它会换掉这个上下文），不当作 handler 的普通失败
    if (e instanceof Error && e.name === 'InternalError') throw e
    return {
      ok: false,
      error: { code: 'internal', message: e instanceof Error ? e.message : String(e) }
    }
  }
  if (typeof result === 'function' || typeof result === 'symbol') {
    return {
      ok: false,
      error: {
        code: 'bad_output',
        message: `Operation "${name}" returned a ${typeof result}; return JSON data instead.`
      }
    }
  }
  if (value.output !== undefined) {
    const out = value.output.safeParse(result)
    if (!out.success) {
      return {
        ok: false,
        error: {
          code: 'bad_output',
          message: `Operation "${name}" returned a value that does not match its output schema:\n${z.prettifyError(out.error)}`
        }
      }
    }
    result = out.data
  }
  return { ok: true, value: result === undefined ? null : result }
}

/**
 * 宿主打包时生成的入口在 `api.ts` 之后调用它：把 `__host` 收进闭包、从全局摘掉（handler 碰不到它），
 * 装上宿主要调用的 `__widget.manifest()` / `__widget.call()`
 */
export function __installWidgetRuntime(api: unknown): void {
  const g = globalThis as unknown as { __host?: SandboxHost; __widget?: unknown }
  const host = g.__host
  delete g.__host
  g.__widget = {
    manifest: (): string => JSON.stringify(buildManifest(api)),
    call: async (name: string, argsJson: string, callerJson: string): Promise<string> => {
      if (!host) {
        return JSON.stringify({
          ok: false,
          error: { code: 'internal', message: 'The widget runtime has no host.' }
        } satisfies CallOutcome)
      }
      const outcome = await callOp(
        (api ?? {}) as Record<string, unknown>,
        host,
        name,
        argsJson ? JSON.parse(argsJson) : {},
        JSON.parse(callerJson) as WidgetCaller
      )
      try {
        return JSON.stringify(outcome)
      } catch (e) {
        return JSON.stringify({
          ok: false,
          error: {
            code: 'bad_output',
            message: `Operation "${name}" returned a value that is not JSON: ${(e as Error).message}`
          }
        } satisfies CallOutcome)
      }
    }
  }
}

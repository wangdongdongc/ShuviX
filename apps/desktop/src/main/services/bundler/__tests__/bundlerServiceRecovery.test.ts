/**
 * `BundlerService` 在 esbuild-wasm 的服务子进程没了之后自己恢复；以及打包后的应用 PATH 里没有 `node` 时交回真正的错误。
 * 真的 esbuild-wasm 0.27.7：它的编译器是一个子进程（`node <esbuild-wasm>/bin/esbuild --service=0.27.7 --ping`，
 * BundlerService 在 initialize() 期间把 spawn('node', …) 改到 process.execPath）。资源目录是仓库里的 `resources/bundler`。
 * 搭法：
 *   - PATH 换成一个空目录（找不到 `node`，像打包后的应用），删掉 ESBUILD_BINARY_PATH。所以必须单独一个文件：
 *     别的文件在正常 PATH 下起的服务（包括 formatMessagesSync 的 worker 线程）会把回归盖住
 *   - 包一层 child_process.spawn（与服务用的是同一个对象），只记带 `--service=` 的调用：调用方要的命令与子进程。
 *     可以让它给每个新起的服务子进程装上「写某个标记就杀」、改指向一个不存在的可执行文件（异步 ENOENT）、同步抛一次错
 *   - 杀子进程两种：闲着时 SIGKILL 并等它 close；或者包它的 stdin.write，写到带某个标记的请求时先 SIGKILL 再写
 *     （`absWorkingDir` 只在 build 请求里，`format-msgs` 只在 formatMessages 请求里）
 *   - 整个文件一个 BundlerService，logger 的 warn 是 spy（重起时 warn 一次）
 *   每条用例前先打一次好的 api.ts（把上一条留下的死服务治好），再记下 spawn 次数，用例只断言增量；每条用例后：
 *   spawn 还是那层包装、记下的服务 spawn 要的都是 process.execPath（从不是光秃秃的 `node`）、活着的服务子进程至多一个。
 *   esbuild 打印的路径相对 cwd，所以只认 `文件名:行:列`。会「挂住」的调用都和一个 20 秒的计时器赛跑。
 *
 *   A-1 闲着时服务被杀 → 下一次 build / buildApi 照常成功；只重起一次（spawn +1，warn 一次），再下一次不再起
 *   A-2 闲着时被杀，下一次是编不过的 api.ts → 一条格式化好的真错误（spawn +1）；改好再打 → 成功，不再起
 *   A-3 build 请求发出去时服务被杀 → 换一个透明地重跑：build 成功、编不过的 buildApi 给真错误；各 spawn +1
 *   A-4 闲着时被杀，四次并发（两个界面、一个好 api、一个坏 api，各自目录）→ 结果各是各的；只重起一次，之后只活一个
 *   A-5 同样四次并发，请求发出去时被杀 → 同上，只重起一次
 *   A-6 连续三轮「杀 → build」→ 每轮成功、spawn +1
 *   B-1 重跑那次也死了 → 不挂、success false，一条「bundler (esbuild) stopped」，没有产物；不再杀之后下一次照常
 *   B-2 重跑起不来（可执行文件不存在）→ success false，那句话带 ENOENT；恢复之后下一次照常
 *   C-1 [PATH 里没有 node] 编不过的 api.ts → resolve（不是 reject），一条格式化好的真错误（不是 spawn node ENOENT），不 spawn
 *   C-2 界面 import 两个不可用的包 → 两条各自格式化的错误，各带自己的包名、行号与代码框
 *   C-3 有警告的构建（api 与界面各一次）→ 成功、一条格式化好的警告（连同 note）；没有警告时 warnings 是 undefined
 *   D-1 格式化请求时服务被杀（失败的构建）→ 退成 `file:line:col: error: text`；下一次重起后成功
 *   D-2 格式化请求时服务被杀（有警告的构建）→ 仍成功，警告退成 `file:line:col: warning: text` 加 `note: …`
 *   E-1 编译错误里恰好有「The service is no longer running」→ 照编译错误报，不当成服务没了（不重起、不 warn）
 *   E-2 重起时 spawn 同步抛错 → resolve success false、带那条错误；spawn 换回去了；下一次照常
 */
import type * as childProcess from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { stop as stopEsbuild } from 'esbuild-wasm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BundlerService, type BundleResult } from '../bundlerService'

/** 与 bundlerService.ts、esbuild-wasm 用的是同一个 child_process 对象（不是 ESM 命名空间） */
const cp = createRequire(import.meta.url)('child_process') as typeof childProcess

/** apps/desktop */
const DESKTOP_DIR = resolve(__dirname, '../../../../..')
const RESOURCES = join(DESKTOP_DIR, 'resources/bundler')

const TEST = { timeout: 60_000 }
const HOOK_TIMEOUT = 60_000
/** 「不挂」：和这个计时器赛跑 */
const HANG_MS = 20_000
const MISSING_BINARY = '/nonexistent/esbuild-node'
const STOPPED = /bundler \(esbuild\) stopped/

// ────────────────────── 记下服务子进程的 spawn ──────────────────────

type SpawnMode =
  | { kind: 'normal' }
  /** 每个新起的服务子进程：写到带这个标记的请求就杀 */
  | { kind: 'armOnSpawn'; marker: string }
  /** 改指向一个不存在的可执行文件：子进程对象照常返回，ENOENT 异步到 */
  | { kind: 'missingBinary' }
  /** 下一次服务 spawn 同步抛这个错（只一次） */
  | { kind: 'throwOnce'; error: Error }

interface ServiceSpawn {
  /** 调用方要的命令（重定向之后应当是 process.execPath） */
  command: string
  child: ChildProcess | null
}

const spawns: ServiceSpawn[] = []
let mode: SpawnMode = { kind: 'normal' }
/** 本条用例装上的 stdin 包装：用例后摘掉 */
const disarms: Array<() => void> = []
let realSpawn: typeof cp.spawn | null = null

const recorder = ((command: string, args?: unknown, options?: unknown): ChildProcess => {
  const forward = realSpawn as unknown as (...a: unknown[]) => ChildProcess
  const isService = Array.isArray(args) && args.some((a) => String(a).startsWith('--service='))
  if (!isService) return forward(command, args, options)
  const entry: ServiceSpawn = { command, child: null }
  spawns.push(entry)
  if (mode.kind === 'throwOnce') {
    const { error } = mode
    mode = { kind: 'normal' }
    throw error
  }
  const child = forward(mode.kind === 'missingBinary' ? MISSING_BINARY : command, args, options)
  entry.child = child
  if (mode.kind === 'armOnSpawn') disarms.push(killOnSend(child, mode.marker))
  return child
}) as unknown as typeof cp.spawn

/** 写到带 `marker` 的请求时先 SIGKILL 再照常写（那次写多半 EPIPE）；返回摘掉包装的函数 */
function killOnSend(child: ChildProcess, marker: string): () => void {
  const stdin = child.stdin as Writable
  const write = stdin.write
  stdin.write = function (this: Writable, chunk: unknown, ...rest: unknown[]): boolean {
    if (
      chunk instanceof Uint8Array &&
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).includes(marker)
    ) {
      child.kill('SIGKILL')
    }
    return (write as (...a: unknown[]) => boolean).apply(this, [chunk, ...rest])
  } as typeof stdin.write
  return () => {
    stdin.write = write
  }
}

/** 闲着时杀掉，等它 close */
async function killIdle(child: ChildProcess): Promise<void> {
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
}

function alive(child: ChildProcess | null): child is ChildProcess {
  return !!child && child.exitCode === null && child.signalCode === null
}

/** 当前（最后起的）服务子进程，必须活着 */
function current(): ChildProcess {
  const child = spawns.at(-1)?.child ?? null
  if (!alive(child)) throw new Error('the current esbuild service child is not alive')
  return child
}

// ────────────────────── 被测对象与夹具 ──────────────────────

const warn = vi.fn()
const logger = { debug: () => {}, info: () => {}, warn, error: () => {} }
const bundler = new BundlerService((p) => join(RESOURCES, p), logger)

const GOOD_API = 'export default { ok: 1 }\n'
const BAD_API = 'export const a = 1\nconst x = ;\n'
const WARN_SOURCE = 'export default { a: 1, a: 2 }\n'
const screenSource = (tag: string): string => `export const tag = '${tag}'; console.log(tag)\n`

let root = ''
let emptyPathDir = ''
let savedPath: string | undefined
let savedBinaryPath: string | undefined
let seq = 0

/** 一个新的组件目录（目录名里不带 service，免得撞上 expectReal） */
function widget(files: Record<string, string>): string {
  const dir = join(root, `w-${++seq}`)
  mkdirSync(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

function screen(source: string): { dir: string; entry: string } {
  const dir = widget({ 'index.tsx': source })
  return { dir, entry: join(dir, 'index.tsx') }
}

/** 和计时器赛跑：超时就是挂住了 */
async function within<T>(promise: Promise<T>, ms = HANG_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 交回的是真正的编译消息，不是服务没了的那句 */
function expectReal(r: BundleResult): void {
  for (const text of [...(r.errors ?? []), ...(r.warnings ?? [])]) {
    expect(text).not.toContain('service')
    expect(text).not.toContain('ENOENT')
    expect(text).not.toContain('bundler (esbuild) stopped')
  }
}

/** BAD_API 那条格式化好的错误 */
function expectBadApiError(r: BundleResult): void {
  expect(r.success).toBe(false)
  expect(r.outputJS).toBeUndefined()
  expect(r.errors).toHaveLength(1)
  const [text] = r.errors ?? []
  expect(text).toContain('✘ [ERROR] Unexpected ";"')
  expect(text).toContain('api.ts:2:10:')
  expect(text).toContain('2 │ const x = ;')
  expectReal(r)
}

/** WARN_SOURCE 那条格式化好的警告（文件名是 `file`） */
function expectDuplicateKeyWarning(r: BundleResult, file: string): void {
  expect(r.errors).toBeUndefined()
  expect(r.success).toBe(true)
  expect((r.outputJS ?? '').length).toBeGreaterThan(0)
  expect(r.warnings).toHaveLength(1)
  const [text] = r.warnings ?? []
  expect(text).toContain('▲ [WARNING] Duplicate key "a" in object literal [duplicate-object-key]')
  expect(text).toContain(`${file}:1:23:`)
  expect(text).toContain('The original key "a" is here:')
  expect(text).toContain(`${file}:1:17:`)
  expectReal(r)
}

function expectScreen(r: BundleResult, tag: string, notTag?: string): void {
  expect(r.errors).toBeUndefined()
  expect(r.success).toBe(true)
  expect(r.outputJS).toContain(tag)
  if (notTag) expect(r.outputJS).not.toContain(notTag)
  expect(r.outputJS).not.toContain('__widget')
}

function expectGoodApi(r: BundleResult): void {
  expect(r.errors).toBeUndefined()
  expect(r.success).toBe(true)
  expect(r.outputJS).toContain('__widget')
}

/** 从现在起又 spawn 了几次服务 */
function spawnCounter(): () => number {
  const mark = spawns.length
  return () => spawns.length - mark
}

// ────────────────────── 钩子 ──────────────────────

/** 用例前（暖机之后）的 spawn 计数 */
let since: () => number = () => 0

beforeAll(() => {
  savedPath = process.env.PATH
  savedBinaryPath = process.env.ESBUILD_BINARY_PATH
  emptyPathDir = mkdtempSync(join(tmpdir(), 'shuvix-no-node-'))
  process.env.PATH = emptyPathDir
  delete process.env.ESBUILD_BINARY_PATH
  // 自检：这个进程里确实找不到 node
  const probe = cp.spawnSync('node', ['-v'])
  expect((probe.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT')

  realSpawn = cp.spawn
  cp.spawn = recorder
  root = mkdtempSync(join(tmpdir(), 'shuvix-bundler-recovery-'))
})

beforeEach(async () => {
  mode = { kind: 'normal' }
  // 暖机：上一条留下的死服务在这里治好
  const r = await within(bundler.buildApi(widget({ 'api.ts': GOOD_API })))
  expectGoodApi(r)
  current()
  since = spawnCounter()
  warn.mockClear()
}, HOOK_TIMEOUT)

afterEach(async () => {
  for (const disarm of disarms.splice(0)) disarm()
  mode = { kind: 'normal' }
  expect(cp.spawn).toBe(recorder)
  // 服务从不按缺省 spawn PATH 里的 `node`
  expect(spawns.map((s) => s.command).filter((c) => c !== process.execPath)).toEqual([])
  await new Promise<void>((done) => setImmediate(done))
  // 已经发过信号、只是还没被回收的子进程不算漏掉的：等它退出（最多 2 秒）
  await Promise.all(
    spawns
      .map((s) => s.child)
      .filter((c): c is ChildProcess => alive(c) && c.killed)
      .map((c) => within(once(c, 'exit'), 2_000).catch(() => undefined))
  )
  expect(spawns.filter((s) => alive(s.child)).length).toBeLessThanOrEqual(1)
}, HOOK_TIMEOUT)

afterAll(async () => {
  await stopEsbuild()
  for (const { child } of spawns) if (alive(child)) child.kill('SIGKILL')
  if (realSpawn) cp.spawn = realSpawn
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  if (savedBinaryPath !== undefined) process.env.ESBUILD_BINARY_PATH = savedBinaryPath
  if (root) rmSync(root, { recursive: true, force: true })
  if (emptyPathDir) rmSync(emptyPathDir, { recursive: true, force: true })
}, HOOK_TIMEOUT)

// ────────────────────── A 服务没了 → 下一次自己恢复 ──────────────────────

describe('A 服务子进程没了，下一次调用自己恢复', TEST, () => {
  it('A-1 闲着时被杀 → 下一次 build 成功；只重起一次，再下一次不再起', async () => {
    await killIdle(current())
    const { dir, entry } = screen(screenSource('W1'))

    const r = await within(bundler.build(entry, dir))

    expectScreen(r, 'W1')
    expect(since()).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)

    const again = spawnCounter()
    expectScreen(await within(bundler.build(entry, dir)), 'W1')
    expect(again()).toBe(0)
  })

  it('A-1 闲着时被杀 → 下一次 buildApi 成功；只重起一次，再下一次不再起', async () => {
    await killIdle(current())
    const dir = widget({ 'api.ts': GOOD_API })

    const r = await within(bundler.buildApi(dir))

    expectGoodApi(r)
    expect(since()).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)

    const again = spawnCounter()
    expectGoodApi(await within(bundler.buildApi(dir)))
    expect(again()).toBe(0)
  })

  it('A-2 闲着时被杀，下一次编不过 → 一条真错误；改好再打 → 成功，不再起', async () => {
    await killIdle(current())
    const dir = widget({ 'api.ts': BAD_API })

    const r = await within(bundler.buildApi(dir))

    expectBadApiError(r)
    expect(since()).toBe(1)

    writeFileSync(join(dir, 'api.ts'), GOOD_API)
    const again = spawnCounter()
    expectGoodApi(await within(bundler.buildApi(dir)))
    expect(again()).toBe(0)
  })

  it('A-3 build 请求发出去时被杀 → 透明重跑，build 成功', async () => {
    disarms.push(killOnSend(current(), 'absWorkingDir'))
    const { dir, entry } = screen(screenSource('W1'))

    const r = await within(bundler.build(entry, dir))

    expectScreen(r, 'W1')
    expect(since()).toBe(1)
  })

  it('A-3 build 请求发出去时被杀 → 透明重跑，编不过的 buildApi 给真错误', async () => {
    disarms.push(killOnSend(current(), 'absWorkingDir'))
    const dir = widget({ 'api.ts': BAD_API })

    const r = await within(bundler.buildApi(dir))

    expectBadApiError(r)
    expect(since()).toBe(1)
  })

  /** 四次并发，各自目录：两个界面、一个好 api、一个坏 api */
  async function fourAtOnce(): Promise<void> {
    const w1 = screen(screenSource('W1'))
    const w2 = screen(screenSource('W2'))
    const good = widget({ 'api.ts': GOOD_API })
    const bad = widget({ 'api.ts': BAD_API })

    const [r1, r2, rGood, rBad] = await within(
      Promise.all([
        bundler.build(w1.entry, w1.dir),
        bundler.build(w2.entry, w2.dir),
        bundler.buildApi(good),
        bundler.buildApi(bad)
      ])
    )

    expectScreen(r1, 'W1', 'W2')
    expectScreen(r2, 'W2', 'W1')
    expectGoodApi(rGood)
    expect(rGood.outputJS).not.toContain('W1')
    expect(rGood.outputJS).not.toContain('W2')
    expectBadApiError(rBad)
    expect(since()).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(spawns.filter((s) => alive(s.child))).toHaveLength(1)

    const again = spawnCounter()
    expectScreen(await within(bundler.build(w1.entry, w1.dir)), 'W1')
    expect(again()).toBe(0)
  }

  it('A-4 闲着时被杀，四次并发 → 结果各是各的；只重起一次', async () => {
    await killIdle(current())
    await fourAtOnce()
  })

  it('A-5 四次并发，build 请求发出去时被杀 → 结果各是各的；只重起一次', async () => {
    disarms.push(killOnSend(current(), 'absWorkingDir'))
    await fourAtOnce()
  })

  it('A-6 连续三轮「闲着时被杀 → build」→ 每轮成功、spawn +1', async () => {
    const { dir, entry } = screen(screenSource('W1'))
    for (let round = 1; round <= 3; round++) {
      await killIdle(current())
      const delta = spawnCounter()
      expectScreen(await within(bundler.build(entry, dir)), 'W1')
      expect(delta(), `round ${round}`).toBe(1)
    }
  })
})

// ────────────────────── B 重跑也不行 ──────────────────────

describe('B 重跑那次也不行：交回一句话，下一次照常', TEST, () => {
  it('B-1 重跑时又死了 → 不挂、success false、一条 stopped；不再杀之后下一次照常', async () => {
    mode = { kind: 'armOnSpawn', marker: 'absWorkingDir' }
    disarms.push(killOnSend(current(), 'absWorkingDir'))
    const { dir, entry } = screen(screenSource('W1'))

    const r = await within(bundler.build(entry, dir))

    expect(r.success).toBe(false)
    expect(r.outputJS).toBeUndefined()
    expect(typeof r.duration).toBe('number')
    expect(r.errors).toHaveLength(1)
    expect(r.errors?.[0]).toMatch(STOPPED)
    expect(since()).toBe(1)

    mode = { kind: 'normal' }
    const next = spawnCounter()
    expectScreen(await within(bundler.build(entry, dir)), 'W1')
    expect(next()).toBe(1)

    const further = spawnCounter()
    expectScreen(await within(bundler.build(entry, dir)), 'W1')
    expect(further()).toBe(0)
  })

  it('B-2 重跑时起不来（可执行文件不存在）→ success false、带 ENOENT；恢复之后下一次照常', async () => {
    await killIdle(current())
    mode = { kind: 'missingBinary' }
    const dir = widget({ 'api.ts': GOOD_API })

    const r = await within(bundler.buildApi(dir))

    expect(r.success).toBe(false)
    expect(r.outputJS).toBeUndefined()
    expect(r.errors).toHaveLength(1)
    expect(r.errors?.[0]).toMatch(STOPPED)
    expect(r.errors?.[0]).toContain('ENOENT')
    expect(since()).toBe(1)

    mode = { kind: 'normal' }
    const next = spawnCounter()
    expectGoodApi(await within(bundler.buildApi(dir)))
    expect(next()).toBe(1)
  })
})

// ────────────────────── C PATH 里没有 node：真正的错误与警告 ──────────────────────

describe('C PATH 里没有 node：交回 esbuild 自己格式化的消息', TEST, () => {
  it('C-1 编不过的 api.ts → resolve，一条格式化好的真错误，不 spawn', async () => {
    const dir = widget({ 'api.ts': BAD_API })

    const pending = within(bundler.buildApi(dir))
    await expect(pending).resolves.toMatchObject({ success: false })
    const r = await pending

    expectBadApiError(r)
    expect(since()).toBe(0)
  })

  it('C-2 界面 import 两个不可用的包 → 两条各自格式化的错误', async () => {
    const { dir, entry } = screen(
      "import pad from 'left-pad'\nimport odd from 'is-odd'\nconsole.log(pad, odd)\n"
    )

    const r = await within(bundler.build(entry, dir))

    expect(r.success).toBe(false)
    expect(r.outputJS).toBeUndefined()
    expect(r.errors).toHaveLength(2)
    const errors = r.errors ?? []
    const leftPad = errors.find((e) => e.includes('"left-pad"'))
    const isOdd = errors.find((e) => e.includes('"is-odd"'))
    expect(leftPad).toBeDefined()
    expect(isOdd).toBeDefined()
    for (const [text, line, other] of [
      [leftPad ?? '', 1, '"is-odd"'],
      [isOdd ?? '', 2, '"left-pad"']
    ] as const) {
      expect(text).toContain('✘ [ERROR]')
      expect(text).toContain('is not available in widgets')
      expect(text).toContain(`index.tsx:${line}:`)
      expect(text).toContain(`${line} │ import`)
      expect(text).not.toContain(other)
    }
    expectReal(r)
    expect(since()).toBe(0)
  })

  it('C-3 有警告的 buildApi → 成功，一条格式化好的警告（连同 note）', async () => {
    const r = await within(bundler.buildApi(widget({ 'api.ts': WARN_SOURCE })))
    expectDuplicateKeyWarning(r, 'api.ts')
  })

  it('C-3 有警告的 build → 成功，一条格式化好的警告（连同 note）', async () => {
    const { dir, entry } = screen(WARN_SOURCE)
    const r = await within(bundler.build(entry, dir))
    expectDuplicateKeyWarning(r, 'index.tsx')
  })

  it('C-3 对照：没有警告的构建 warnings 是 undefined', async () => {
    const { dir, entry } = screen(screenSource('W1'))
    const screenResult = await within(bundler.build(entry, dir))
    expectScreen(screenResult, 'W1')
    expect(screenResult.warnings).toBeUndefined()

    const apiResult = await within(bundler.buildApi(widget({ 'api.ts': GOOD_API })))
    expectGoodApi(apiResult)
    expect(apiResult.warnings).toBeUndefined()
  })
})

// ────────────────────── D 格式化本身失败 ──────────────────────

describe('D 格式化请求时服务没了：退成纯文本，真正的消息照样交回', TEST, () => {
  it('D-1 失败的构建 → `api.ts:2:10: error: …`；下一次重起后成功', async () => {
    disarms.push(killOnSend(current(), 'format-msgs'))
    const dir = widget({ 'api.ts': BAD_API })

    const r = await within(bundler.buildApi(dir))

    expect(r.success).toBe(false)
    expect(r.outputJS).toBeUndefined()
    expect(r.errors).toHaveLength(1)
    expect(r.errors?.[0]).toMatch(/api\.ts:2:10: error: Unexpected ";"/)
    expect(r.errors?.[0]).not.toContain('[ERROR]')
    expectReal(r)

    writeFileSync(join(dir, 'api.ts'), GOOD_API)
    const next = spawnCounter()
    expectGoodApi(await within(bundler.buildApi(dir)))
    expect(next()).toBe(1)
  })

  it('D-2 有警告的构建 → 仍成功，`api.ts:1:23: warning: …` 加 note', async () => {
    disarms.push(killOnSend(current(), 'format-msgs'))

    const r = await within(bundler.buildApi(widget({ 'api.ts': WARN_SOURCE })))

    expect(r.errors).toBeUndefined()
    expect(r.success).toBe(true)
    expect((r.outputJS ?? '').length).toBeGreaterThan(0)
    expect(r.warnings).toHaveLength(1)
    const [text] = r.warnings ?? []
    expect(text).toMatch(/api\.ts:1:23: warning: Duplicate key "a" in object literal/)
    expect(text).not.toContain('[WARNING]')
    expect(text).toContain('note: The original key "a" is here:')
    expect(text).toMatch(/api\.ts:1:17: note: The original key "a" is here:/)
    expectReal(r)
  })
})

// ────────────────────── E 边角 ──────────────────────

describe('E 边角', TEST, () => {
  it('E-1 编译错误里恰好有那句话 → 照编译错误报，不重起、不 warn', async () => {
    const { dir, entry } = screen(
      "import x from './The service is no longer running'\nconsole.log(x)\n"
    )

    const r = await within(bundler.build(entry, dir))

    expect(r.success).toBe(false)
    expect(r.errors).toHaveLength(1)
    expect(r.errors?.[0]).toContain('Could not resolve "./The service is no longer running"')
    expect(r.errors?.[0]).not.toMatch(STOPPED)
    expect(since()).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('E-2 重起时 spawn 同步抛错 → resolve success false、带那条错误；spawn 换回去了；下一次照常', async () => {
    await killIdle(current())
    const failure = new Error('E-2 spawn failed synchronously')
    mode = { kind: 'throwOnce', error: failure }
    const { dir, entry } = screen(screenSource('W1'))

    const r = await within(bundler.build(entry, dir))

    expect(r.success).toBe(false)
    expect(r.outputJS).toBeUndefined()
    expect(r.errors).toHaveLength(1)
    expect(r.errors?.[0]).toContain(failure.message)
    expect(cp.spawn).toBe(recorder)
    expect(since()).toBe(1)

    const next = spawnCounter()
    expectScreen(await within(bundler.build(entry, dir)), 'W1')
    expect(next()).toBe(1)
  })
})

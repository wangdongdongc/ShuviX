/**
 * `api/widgetApi.ts` —— SQLite 组件的存储归属、API 编译与构建快照、调用（设计稿 docs/widget-tool-design.md §3、§6、§9）。
 * 组件宿主（`./widgetRuntime`）与打包服务（`../../bundler`）换成 spy；数据根（`utils/paths` 的 getWidgetsDataDir）指到临时目录；
 * `utils/atomicWrite` 是透传 spy（记写入顺序）；logger 的 warn 是 spy。
 *
 *   A-1 没有数据目录 → pglite；createWidgetDataDir 之后 → sqlite；dbPath `<data>/<id>/data.sqlite`；removeWidgetData 先 forget
 *       再删目录（forget 拒绝也删）；非法 id（`..` 之类）抛 Invalid widget id
 *   A-2 callWidgetOp：没有数据目录 → no_api、不调宿主；api.json 缺失 / 坏 JSON / 没有 hash / ops 不是数组 → no_api 带
 *       「run `shuvix widget build`」；快照里没有这个操作 → unknown_op 列出看得见的操作；都不调宿主
 *   A-3 原样转给宿主：target、bundlePath `<data>/<id>/api.js`、快照的 bundleHash、快照条目的 mode、args、caller、dryRun 布尔；
 *       WidgetRuntimeError → 同 code 的 WidgetApiError；别的错误原样抛
 *   A-4 wrote:true → 监听者收到 {widgetId, op, source: caller.kind}；wrote:false（含 dry run）→ 不通知；
 *       一个监听者抛错不影响别的、也不影响调用；退订之后收不到
 *   A-5 compileWidgetApi：没有 api.ts → none（不打包、不取清单）；老 PGlite 组件带 api.ts 照样编译（换存储是 build 的事）；
 *       打包错误原样传回；取清单被拒 → `api.ts: <msg>`；清单错误 / 坏名字 / 缺或错的 mode / 没有操作 →
 *       每条带 `api.ts: ` 前缀；成功 → hash = sha256(code) 的前 32 位 hex、ops
 *   A-6 activateWidgetApi 先写 api.js 再写 api.json（{hash, builtAt, ops}）；null 删掉两个；两种情况都 forget
 *   A-7 changedOps：之前没有快照 → []；消失 → `removed "x"`；input 的 JSON 变了 → `changed the input of "x"`；
 *       新增、说明 / mode 变了 → 不算；之后为 null → 全部 removed
 *   A-8 `agent: false`：agent 调用方 → unknown_op、清单里也不提；用户，以及带 allowUiOnly 的调用调得到
 *   WC-S10 compileWidgetApi 对老 PGlite 组件（带好的 api.ts）→ ok（hash、ops），存储不动（没有数据目录、没有记号）
 *   WC-S11 switchWidgetToSqlite → 数据目录 + `legacy-pglite`（一行 ISO 时间）；之后是 sqlite、有旧数据
 *   WC-S12 hasLegacyWidgetData：没有数据目录 → true；新组件（createWidgetDataDir）→ false；换过的 → true
 *   WC-S13 换过的组件 activateWidgetApi(快照) / (null) → 记号留着
 *   WC-S14 换过的组件 removeWidgetData → 目录连记号一起没了、forget 过；之后 hasLegacyWidgetData 回到「老组件」的 true
 *   WC-S15 记号写不下（数据目录不可写）→ 撤回数据目录、原样抛；存储仍是 pglite
 *   WC-S16 queryWidgetSqlite：输出以 OK 开头（改了行、跑了脚本）→ 通知 {widgetId, op:'sql', source:'agent'}；
 *          查询的表格、出错 → 不通知；WidgetRuntimeError → 同 code 的 WidgetApiError
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallResult, WidgetCaller } from '../hostProtocol'
import type { ApiManifest, OpManifest } from '../sandboxRuntime'

const h = vi.hoisted(() => {
  class WidgetRuntimeError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
  return {
    dataRoot: '',
    WidgetRuntimeError,
    runtime: {
      forget: vi.fn(async (_id: string): Promise<void> => {}),
      manifest: vi.fn(async (_code: string): Promise<unknown> => ({ ops: [], errors: [] })),
      call: vi.fn(async (_params: unknown): Promise<unknown> => ({})),
      query: vi.fn(async () => ({ output: '' }))
    },
    buildApi: vi.fn(
      async (
        _dir: string,
        _file?: string
      ): Promise<{ success: boolean; outputJS?: string; errors?: string[] }> => ({
        success: true,
        outputJS: 'code'
      })
    ),
    /** writeFileAtomic 的调用顺序（文件路径） */
    writes: [] as string[],
    warn: vi.fn()
  }
})

vi.mock('../widgetRuntime', () => ({
  widgetRuntime: h.runtime,
  WidgetRuntimeError: h.WidgetRuntimeError
}))
vi.mock('../../../bundler', () => ({ bundlerService: { buildApi: h.buildApi } }))
vi.mock('../../../../utils/paths', () => ({ getWidgetsDataDir: () => h.dataRoot }))
vi.mock('../../../../utils/atomicWrite', async () => {
  const real = await vi.importActual<typeof import('../../../../utils/atomicWrite')>(
    '../../../../utils/atomicWrite'
  )
  return {
    writeFileAtomic: (path: string, data: string | Uint8Array): void => {
      h.writes.push(path)
      real.writeFileAtomic(path, data)
    }
  }
})
vi.mock('../../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: h.warn, error: () => {}, debug: () => {} })
}))

import {
  activateWidgetApi,
  callWidgetOp,
  changedOps,
  compileWidgetApi,
  createWidgetDataDir,
  hasLegacyWidgetData,
  onWidgetDataChanged,
  queryWidgetSqlite,
  readApiSnapshot,
  removeWidgetData,
  switchWidgetToSqlite,
  WidgetApiError,
  widgetDataDirOf,
  widgetHostTarget,
  widgetStorageOf,
  type ApiSnapshot,
  type WidgetDataChange
} from '../widgetApi'

const ID = 'book-shelf'
const USER: WidgetCaller = { kind: 'user', label: 'user' }
const AGENT: WidgetCaller = {
  kind: 'agent',
  sessionId: 's-1',
  actor: 'shuvix-work/m',
  label: 'shuvix-work/m'
}
const BUILDER: WidgetCaller = {
  kind: 'agent',
  sessionId: 's1',
  actor: 'shuvix-coding/m',
  label: 'shuvix-coding/m'
}

let tmp = ''
let projectDir = ''

function opOf(name: string, extra: Partial<OpManifest> = {}): OpManifest {
  return {
    name,
    mode: 'read',
    description: `${name} desc`,
    agent: true,
    input: { type: 'object', properties: {} },
    ...extra
  }
}

const dataDir = (id = ID): string => join(h.dataRoot, id)

/** 种一个快照：数据目录 + api.json（+ api.js） */
function seedSnapshot(ops: OpManifest[], hash = 'hash-1', id = ID): ApiSnapshot {
  mkdirSync(dataDir(id), { recursive: true })
  const snap: ApiSnapshot = { hash, builtAt: 1, ops }
  writeFileSync(join(dataDir(id), 'api.json'), JSON.stringify(snap))
  writeFileSync(join(dataDir(id), 'api.js'), '/* bundle */')
  return snap
}

function callResult(wrote: boolean, value: unknown = 1): CallResult {
  return { outcome: { ok: true, value }, wrote, logs: [] }
}

/** 等一个 promise 以 WidgetApiError 拒绝，返回它 */
async function apiError(p: Promise<unknown>): Promise<WidgetApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(WidgetApiError)
  return err as WidgetApiError
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-widget-api-'))
  h.dataRoot = join(tmp, 'widgets-data')
  projectDir = join(tmp, 'widgets', ID)
  mkdirSync(projectDir, { recursive: true })
  h.writes.length = 0
  h.warn.mockClear()
  h.buildApi.mockReset().mockResolvedValue({ success: true, outputJS: 'code' })
  h.runtime.forget.mockReset().mockResolvedValue(undefined)
  h.runtime.manifest.mockReset().mockResolvedValue({ ops: [], errors: [] })
  h.runtime.call.mockReset().mockResolvedValue(callResult(false))
  h.runtime.query.mockReset()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// ────────────────────────────── A-1 ──────────────────────────────

describe('A-1 存储归属与数据目录', () => {
  it('A-1 没有数据目录 → pglite；createWidgetDataDir 之后 → sqlite（数据根也一并建出）', () => {
    expect(existsSync(h.dataRoot)).toBe(false)
    expect(widgetStorageOf(ID)).toBe('pglite')
    // 只看路径不改磁盘
    expect(existsSync(h.dataRoot)).toBe(false)

    createWidgetDataDir(ID)
    expect(existsSync(dataDir())).toBe(true)
    expect(widgetStorageOf(ID)).toBe('sqlite')
    // 别的组件不受影响
    expect(widgetStorageOf('other-widget')).toBe('pglite')
  })

  it('A-1 widgetDataDirOf / widgetHostTarget：`<data>/<id>`、`<data>/<id>/data.sqlite`', () => {
    expect(widgetDataDirOf(ID)).toBe(join(h.dataRoot, ID))
    expect(widgetHostTarget(ID)).toEqual({
      widgetId: ID,
      dbPath: join(h.dataRoot, ID, 'data.sqlite')
    })
  })

  it.each(['..', '../etc', 'Foo', 'foo', 'a/b-c', '', 'a-b/../../x'])(
    'A-1 非法 id %j → 抛 Invalid widget id（不拼进路径）',
    (bad) => {
      expect(() => widgetDataDirOf(bad)).toThrow('Invalid widget id')
      expect(() => widgetStorageOf(bad)).toThrow('Invalid widget id')
      expect(() => widgetHostTarget(bad)).toThrow('Invalid widget id')
      expect(() => createWidgetDataDir(bad)).toThrow('Invalid widget id')
      expect(existsSync(h.dataRoot)).toBe(false)
    }
  )

  it('A-1 removeWidgetData：先 forget 再删整个数据目录', async () => {
    createWidgetDataDir(ID)
    writeFileSync(join(dataDir(), 'data.sqlite'), 'x')
    let dirAtForget: boolean | null = null
    h.runtime.forget.mockImplementation(async () => {
      dirAtForget = existsSync(dataDir())
    })

    await removeWidgetData(ID)

    expect(h.runtime.forget.mock.calls).toEqual([[ID]])
    expect(dirAtForget).toBe(true)
    expect(existsSync(dataDir())).toBe(false)
    expect(widgetStorageOf(ID)).toBe('pglite')
  })

  it('A-1 forget 拒绝 → 只记 warn，目录照删', async () => {
    createWidgetDataDir(ID)
    h.runtime.forget.mockRejectedValue(new Error('host gone'))

    await expect(removeWidgetData(ID)).resolves.toBeUndefined()

    expect(existsSync(dataDir())).toBe(false)
    expect(h.warn).toHaveBeenCalled()
  })

  it('A-1 removeWidgetData 非法 id → 抛（拼路径时），不删到数据根之外', async () => {
    await expect(removeWidgetData('../x')).rejects.toThrow('Invalid widget id')
    // forget 在路径之前：先 forget（id 原样给宿主），然后拼路径时抛 —— 这里只要求不删到别处
    expect(existsSync(h.dataRoot)).toBe(false)
  })
})

// ────────────────────────────── A-2 ──────────────────────────────

describe('A-2 callWidgetOp 的前置检查', () => {
  it('A-2 没有数据目录（老组件）→ no_api，不调宿主', async () => {
    const err = await apiError(callWidgetOp(ID, 'listBooks', {}, USER))
    expect(err.code).toBe('no_api')
    expect(err.message).toBe(`Widget "${ID}" has no API.`)
    expect(h.runtime.call).not.toHaveBeenCalled()
  })

  it.each([
    ['api.json 不存在', null],
    ['坏 JSON', '{not json'],
    ['没有 hash', JSON.stringify({ builtAt: 1, ops: [] })],
    ['hash 不是字符串', JSON.stringify({ hash: 1, builtAt: 1, ops: [] })],
    ['ops 不是数组', JSON.stringify({ hash: 'h', builtAt: 1, ops: {} })],
    ['null', 'null']
  ])('A-2 %s → no_api，提示构建它，不调宿主', async (_label, content) => {
    createWidgetDataDir(ID)
    if (content !== null) writeFileSync(join(dataDir(), 'api.json'), content)

    expect(readApiSnapshot(ID)).toBeNull()
    const err = await apiError(callWidgetOp(ID, 'listBooks', {}, USER))
    expect(err.code).toBe('no_api')
    expect(err.message).toContain('Define api.ts and build the widget')
    expect(h.runtime.call).not.toHaveBeenCalled()
  })

  it('A-2 快照里没有这个操作 → unknown_op，列出看得见的操作，不调宿主', async () => {
    seedSnapshot([opOf('listBooks'), opOf('addBook', { mode: 'write' })])

    const err = await apiError(callWidgetOp(ID, 'deleteAll', {}, USER))
    expect(err.code).toBe('unknown_op')
    expect(err.message).toBe(
      `Widget "${ID}" has no operation "deleteAll". Its operations: listBooks, addBook.`
    )
    expect(h.runtime.call).not.toHaveBeenCalled()
  })

  it('A-2 继承来的名字（toString / constructor）不算操作', async () => {
    seedSnapshot([opOf('listBooks')])
    for (const name of ['toString', 'constructor', '__proto__']) {
      const err = await apiError(callWidgetOp(ID, name, {}, USER))
      expect(err.code).toBe('unknown_op')
    }
    expect(h.runtime.call).not.toHaveBeenCalled()
  })

  it('A-2 readApiSnapshot：好的快照原样读回', () => {
    const snap = seedSnapshot([opOf('listBooks')], 'abc')
    expect(readApiSnapshot(ID)).toEqual(snap)
  })
})

// ────────────────────────────── A-3 ──────────────────────────────

describe('A-3 callWidgetOp 转给宿主', () => {
  it('A-3 参数原样转：target、bundlePath、bundleHash、快照的 mode、args、caller、dryRun=false', async () => {
    seedSnapshot(
      [opOf('listBooks'), opOf('addBook', { mode: 'write' })],
      '0123456789abcdef0123456789abcdef'
    )
    const result = callResult(true, { id: 1 })
    h.runtime.call.mockResolvedValue(result)
    const args = { title: 'Dune', nested: { a: [1, 2] } }

    const out = await callWidgetOp(ID, 'addBook', args, AGENT)

    expect(h.runtime.call.mock.calls).toEqual([
      [
        {
          target: { widgetId: ID, dbPath: join(dataDir(), 'data.sqlite') },
          bundlePath: join(dataDir(), 'api.js'),
          bundleHash: '0123456789abcdef0123456789abcdef',
          op: 'addBook',
          mode: 'write',
          args,
          caller: AGENT,
          dryRun: false
        }
      ]
    ])
    expect(out).toEqual({ op: 'addBook', mode: 'write', result })
  })

  it('A-3 mode 来自快照条目（read 操作 → read）', async () => {
    seedSnapshot([opOf('listBooks'), opOf('addBook', { mode: 'write' })])
    const out = await callWidgetOp(ID, 'listBooks', {}, USER)
    expect(out.mode).toBe('read')
    expect((h.runtime.call.mock.calls[0][0] as { mode: string }).mode).toBe('read')
  })

  it.each([
    [{ dryRun: true }, true],
    [{ dryRun: false }, false],
    [{}, false],
    [{ dryRun: 'yes' as unknown as boolean }, false],
    [{ dryRun: 1 as unknown as boolean }, false]
  ])('A-3 options %j → dryRun %s（只有 true 才算）', async (options, expected) => {
    seedSnapshot([opOf('addBook', { mode: 'write' })])
    await callWidgetOp(ID, 'addBook', {}, USER, options)
    expect((h.runtime.call.mock.calls[0][0] as { dryRun: unknown }).dryRun).toBe(expected)
  })

  it('A-3 WidgetRuntimeError → 同 code、同 message 的 WidgetApiError', async () => {
    seedSnapshot([opOf('listBooks')])
    h.runtime.call.mockRejectedValue(new h.WidgetRuntimeError('timeout', 'took too long'))

    const err = await apiError(callWidgetOp(ID, 'listBooks', {}, USER))
    expect(err.code).toBe('timeout')
    expect(err.message).toBe('took too long')
  })

  it('A-3 别的错误原样抛（同一个对象）', async () => {
    seedSnapshot([opOf('listBooks')])
    const boom = new TypeError('boom')
    h.runtime.call.mockRejectedValue(boom)

    await expect(callWidgetOp(ID, 'listBooks', {}, USER)).rejects.toBe(boom)
  })
})

// ────────────────────────────── A-4 ──────────────────────────────

describe('A-4 写之后的通知', () => {
  const subs: Array<() => void> = []
  const listen = (fn: (c: WidgetDataChange) => void): (() => void) => {
    const off = onWidgetDataChanged(fn)
    subs.push(off)
    return off
  }
  afterEach(() => {
    while (subs.length) subs.pop()!()
  })

  it('A-4 wrote:true → 监听者收到 {widgetId, op, source: caller.kind}', async () => {
    seedSnapshot([opOf('addBook', { mode: 'write' })])
    h.runtime.call.mockResolvedValue(callResult(true))
    const got: WidgetDataChange[] = []
    listen((c) => got.push(c))

    await callWidgetOp(ID, 'addBook', {}, AGENT)
    await callWidgetOp(ID, 'addBook', {}, USER)

    expect(got).toEqual([
      { widgetId: ID, op: 'addBook', source: 'agent' },
      { widgetId: ID, op: 'addBook', source: 'user' }
    ])
  })

  it('A-4 wrote:false（读操作、dry run、什么都没写）→ 不通知', async () => {
    seedSnapshot([opOf('listBooks'), opOf('addBook', { mode: 'write' })])
    h.runtime.call.mockResolvedValue(callResult(false))
    const got: WidgetDataChange[] = []
    listen((c) => got.push(c))

    await callWidgetOp(ID, 'listBooks', {}, USER)
    await callWidgetOp(ID, 'addBook', {}, BUILDER, { dryRun: true })
    h.runtime.call.mockResolvedValue({
      outcome: { ok: false, error: { code: 'not_found', message: 'x' } },
      wrote: false,
      logs: []
    })
    await callWidgetOp(ID, 'addBook', {}, USER)

    expect(got).toEqual([])
  })

  it('A-4 handler 失败但写过（wrote:true）→ 照样通知', async () => {
    seedSnapshot([opOf('addBook', { mode: 'write' })])
    h.runtime.call.mockResolvedValue({
      outcome: { ok: false, error: { code: 'failed', message: 'x' } },
      wrote: true,
      logs: []
    })
    const got: WidgetDataChange[] = []
    listen((c) => got.push(c))

    await callWidgetOp(ID, 'addBook', {}, USER)
    expect(got).toHaveLength(1)
  })

  it('A-4 一个监听者抛错：别的照收，调用照常返回，记 warn', async () => {
    seedSnapshot([opOf('addBook', { mode: 'write' })])
    h.runtime.call.mockResolvedValue(callResult(true, 'ok'))
    const second = vi.fn()
    listen(() => {
      throw new Error('listener broke')
    })
    listen(second)

    const out = await callWidgetOp(ID, 'addBook', {}, USER)

    expect(out.result.outcome).toEqual({ ok: true, value: 'ok' })
    expect(second).toHaveBeenCalledTimes(1)
    expect(h.warn).toHaveBeenCalled()
  })

  it('A-4 退订之后收不到', async () => {
    seedSnapshot([opOf('addBook', { mode: 'write' })])
    h.runtime.call.mockResolvedValue(callResult(true))
    const fn = vi.fn()
    const off = listen(fn)

    await callWidgetOp(ID, 'addBook', {}, USER)
    off()
    await callWidgetOp(ID, 'addBook', {}, USER)

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('A-4 宿主出错 → 不通知', async () => {
    seedSnapshot([opOf('addBook', { mode: 'write' })])
    h.runtime.call.mockRejectedValue(new h.WidgetRuntimeError('host_exited', 'x'))
    const fn = vi.fn()
    listen(fn)

    await apiError(callWidgetOp(ID, 'addBook', {}, USER))
    expect(fn).not.toHaveBeenCalled()
  })
})

// ────────────────────────────── A-5 ──────────────────────────────

describe('A-5 compileWidgetApi', () => {
  const withApiTs = (): void => writeFileSync(join(projectDir, 'api.ts'), 'export default {}\n')

  it('A-5 没有 api.ts → none；不打包、不取清单', async () => {
    createWidgetDataDir(ID)
    await expect(compileWidgetApi(projectDir)).resolves.toEqual({ kind: 'none' })
    expect(h.buildApi).not.toHaveBeenCalled()
    expect(h.runtime.manifest).not.toHaveBeenCalled()
  })

  it('A-5 老 PGlite 组件带 api.ts → 照样打包、取清单（换成 SQLite 是 build 成功之后的事），不建数据目录', async () => {
    withApiTs()
    h.buildApi.mockResolvedValue({ success: false, errors: ['api.ts:1:1: error: boom'] })
    const out = await compileWidgetApi(projectDir)
    expect(out).toEqual({ kind: 'error', errors: ['api.ts:1:1: error: boom'] })
    expect(h.buildApi).toHaveBeenCalledTimes(1)
    expect(existsSync(join(h.dataRoot, ID))).toBe(false)
  })

  it('A-5 打包错误原样传回；不取清单', async () => {
    createWidgetDataDir(ID)
    withApiTs()
    h.buildApi.mockResolvedValue({ success: false, errors: ['api.ts:1:1: error: boom'] })

    await expect(compileWidgetApi(projectDir)).resolves.toEqual({
      kind: 'error',
      errors: ['api.ts:1:1: error: boom']
    })
    expect(h.buildApi.mock.calls).toEqual([[projectDir, 'api.ts']])
    expect(h.runtime.manifest).not.toHaveBeenCalled()
  })

  it.each([
    ['失败且没有 errors', { success: false }],
    ['成功但没有产物', { success: true }],
    ['成功但产物为空串', { success: true, outputJS: '' }]
  ])('A-5 打包%s → `api.ts did not build.`', async (_l, result) => {
    createWidgetDataDir(ID)
    withApiTs()
    h.buildApi.mockResolvedValue(result)
    await expect(compileWidgetApi(projectDir)).resolves.toEqual({
      kind: 'error',
      errors: ['api.ts did not build.']
    })
  })

  it('A-5 取清单被拒 → `api.ts: <msg>`', async () => {
    createWidgetDataDir(ID)
    withApiTs()
    h.runtime.manifest.mockRejectedValue(
      new h.WidgetRuntimeError('internal', 'top-level code threw')
    )

    await expect(compileWidgetApi(projectDir)).resolves.toEqual({
      kind: 'error',
      errors: ['api.ts: top-level code threw']
    })
    expect(h.runtime.manifest.mock.calls).toEqual([['code']])
  })

  it.each<[string, ApiManifest | Record<string, unknown>, string[]]>([
    [
      '沙箱报的错误',
      { ops: [opOf('listBooks')], errors: ['"x" is not an operation'] },
      ['api.ts: "x" is not an operation']
    ],
    [
      '坏名字',
      { ops: [opOf('AddBook')], errors: [] },
      ['api.ts: Invalid operation name "AddBook".']
    ],
    [
      '缺 mode',
      { ops: [{ ...opOf('a'), mode: undefined }], errors: [] },
      ['api.ts: Operation "a" has no read/write mode.']
    ],
    [
      '错的 mode',
      { ops: [{ ...opOf('a'), mode: 'admin' }], errors: [] },
      ['api.ts: Operation "a" has no read/write mode.']
    ],
    ['没有操作', { ops: [], errors: [] }, ['api.ts: api.ts defines no operations.']],
    [
      'ops / errors 都不是数组',
      { ops: 'x', errors: 'y' },
      ['api.ts: api.ts defines no operations.']
    ]
  ])('A-5 清单%s → 错误，每条带 `api.ts: `', async (_l, manifest, errors) => {
    createWidgetDataDir(ID)
    withApiTs()
    h.runtime.manifest.mockResolvedValue(manifest)
    await expect(compileWidgetApi(projectDir)).resolves.toEqual({ kind: 'error', errors })
  })

  it('A-5 几条错误一起报', async () => {
    createWidgetDataDir(ID)
    withApiTs()
    h.runtime.manifest.mockResolvedValue({
      ops: [opOf('Bad'), { ...opOf('ok'), mode: 'x' }],
      errors: ['first']
    })
    const out = await compileWidgetApi(projectDir)
    expect(out).toEqual({
      kind: 'error',
      errors: [
        'api.ts: first',
        'api.ts: Invalid operation name "Bad".',
        'api.ts: Operation "ok" has no read/write mode.'
      ]
    })
  })

  it('A-5 成功 → hash = sha256(code) 的前 32 位 hex，ops 原样，code 原样；不写快照', async () => {
    createWidgetDataDir(ID)
    withApiTs()
    const code = '(()=>{ /* bundle */ })();\n'
    const ops = [opOf('listBooks'), opOf('addBook', { mode: 'write', agent: false })]
    h.buildApi.mockResolvedValue({ success: true, outputJS: code })
    h.runtime.manifest.mockResolvedValue({ ops, errors: [] })

    const out = await compileWidgetApi(projectDir)

    const hash = createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 32)
    expect(out).toEqual({ kind: 'ok', api: { code, hash, ops } })
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
    expect(readApiSnapshot(ID)).toBeNull()
    expect(h.runtime.forget).not.toHaveBeenCalled()
  })
})

// ────────────────────────────── A-6 ──────────────────────────────

describe('A-6 activateWidgetApi', () => {
  it('A-6 先写 api.js 再写 api.json（{hash, builtAt, ops}），之后 forget', async () => {
    const ops = [opOf('listBooks')]
    const before = Date.now()
    let snapshotAtForget: ApiSnapshot | null = null
    h.runtime.forget.mockImplementation(async () => {
      snapshotAtForget = readApiSnapshot(ID)
    })

    // 数据目录还不存在也行：会建出来
    await activateWidgetApi(ID, { code: 'BUNDLE', hash: 'hash-2', ops })

    expect(h.writes).toEqual([join(dataDir(), 'api.js'), join(dataDir(), 'api.json')])
    expect(readFileSync(join(dataDir(), 'api.js'), 'utf8')).toBe('BUNDLE')
    const snap = JSON.parse(readFileSync(join(dataDir(), 'api.json'), 'utf8')) as ApiSnapshot
    expect(Object.keys(snap).sort()).toEqual(['builtAt', 'hash', 'ops'])
    expect(snap.hash).toBe('hash-2')
    expect(snap.ops).toEqual(ops)
    expect(snap.builtAt).toBeGreaterThanOrEqual(before)
    expect(snap.builtAt).toBeLessThanOrEqual(Date.now())
    expect(h.runtime.forget.mock.calls).toEqual([[ID]])
    expect(snapshotAtForget).toMatchObject({ hash: 'hash-2' })
  })

  it('A-6 null → 删掉 api.json 与 api.js，再 forget；数据库文件不动', async () => {
    seedSnapshot([opOf('listBooks')])
    writeFileSync(join(dataDir(), 'data.sqlite'), 'db')

    await activateWidgetApi(ID, null)

    expect(existsSync(join(dataDir(), 'api.json'))).toBe(false)
    expect(existsSync(join(dataDir(), 'api.js'))).toBe(false)
    expect(existsSync(join(dataDir(), 'data.sqlite'))).toBe(true)
    expect(readApiSnapshot(ID)).toBeNull()
    expect(h.runtime.forget.mock.calls).toEqual([[ID]])
  })

  it('A-6 null 且本来就没有快照 → 不报错，照样 forget', async () => {
    createWidgetDataDir(ID)
    await expect(activateWidgetApi(ID, null)).resolves.toBeUndefined()
    expect(h.runtime.forget).toHaveBeenCalledTimes(1)
  })

  it('A-6 forget 拒绝 → 只记 warn，不抛', async () => {
    h.runtime.forget.mockRejectedValue(new Error('x'))
    await expect(
      activateWidgetApi(ID, { code: 'B', hash: 'h', ops: [opOf('a')] })
    ).resolves.toBeUndefined()
    expect(h.warn).toHaveBeenCalled()
    expect(readApiSnapshot(ID)?.hash).toBe('h')
  })
})

// ────────────────────────────── A-7 ──────────────────────────────

describe('A-7 changedOps', () => {
  const snap = (ops: OpManifest[]): ApiSnapshot => ({ hash: 'h', builtAt: 1, ops })
  const compiled = (ops: OpManifest[]): { code: string; hash: string; ops: OpManifest[] } => ({
    code: 'c',
    hash: 'h2',
    ops
  })

  it('A-7 之前没有快照 → []', () => {
    expect(changedOps(null, compiled([opOf('a')]))).toEqual([])
    expect(changedOps(null, null)).toEqual([])
  })

  it('A-7 消失的 → removed；input 变了的 → changed the input of', () => {
    const before = snap([
      opOf('a'),
      opOf('b', { input: { type: 'object', properties: { x: { type: 'string' } } } }),
      opOf('c')
    ])
    const after = compiled([
      opOf('b', { input: { type: 'object', properties: { x: { type: 'number' } } } }),
      opOf('c')
    ])
    expect(changedOps(before, after)).toEqual(['removed "a"', 'changed the input of "b"'])
  })

  it('A-7 新增、说明 / mode / agent / output 变了 → 不算', () => {
    const before = snap([opOf('a')])
    const after = compiled([
      opOf('a', {
        description: 'new words',
        mode: 'write',
        agent: false,
        output: { type: 'string' }
      }),
      opOf('z')
    ])
    expect(changedOps(before, after)).toEqual([])
  })

  it('A-7 之后为 null（api.ts 删了）→ 全部 removed', () => {
    expect(changedOps(snap([opOf('a'), opOf('b')]), null)).toEqual(['removed "a"', 'removed "b"'])
  })
})

// ────────────────────────────── A-8 ──────────────────────────────

describe('A-8 agent:false 的操作只给界面（和 allowUiOnly）', () => {
  beforeEach(() => {
    seedSnapshot([
      opOf('listBooks'),
      opOf('saveLayout', { mode: 'write', agent: false }),
      opOf('addBook', { mode: 'write' })
    ])
  })

  it.each<[string, WidgetCaller]>([
    ['agent（有会话）', AGENT],
    ['agent（没有 actor）', { kind: 'agent', label: 'x' }],
    ['agent（actor 不是 cli）', { kind: 'agent', actor: 'clix', label: 'cli' }]
  ])('A-8 %s 调 agent:false 的操作 → unknown_op，清单里不提它', async (_l, caller) => {
    const err = await apiError(callWidgetOp(ID, 'saveLayout', {}, caller))
    expect(err.code).toBe('unknown_op')
    expect(err.message).toContain('Its operations: listBooks, addBook.')
    expect(err.message.match(/saveLayout/g)).toHaveLength(1) // 只出现在「没有这个操作」那半句
    expect(h.runtime.call).not.toHaveBeenCalled()
  })

  it('A-8 agent 调别的不存在的操作 → 清单里也不提 agent:false 的', async () => {
    const err = await apiError(callWidgetOp(ID, 'nope', {}, AGENT))
    expect(err.message).toBe(
      `Widget "${ID}" has no operation "nope". Its operations: listBooks, addBook.`
    )
  })

  it('A-8 用户调得到 agent:false 的操作', async () => {
    const out = await callWidgetOp(ID, 'saveLayout', { x: 1 }, USER)
    expect(out.mode).toBe('write')
    expect(h.runtime.call).toHaveBeenCalledTimes(1)
  })

  it('A-8 agent 带 allowUiOnly（组件自己的界面 / 造组件时的 dry run）调得到 agent:false 的操作', async () => {
    const out = await callWidgetOp(ID, 'saveLayout', { x: 1 }, AGENT, { allowUiOnly: true })
    expect(out.mode).toBe('write')
    expect(h.runtime.call).toHaveBeenCalledTimes(1)
  })

  it('A-8 用户调不存在的操作 → 清单里列出全部（含 agent:false 的）', async () => {
    const err = await apiError(callWidgetOp(ID, 'nope', {}, USER))
    expect(err.message).toContain('Its operations: listBooks, saveLayout, addBook.')
  })
})

// ────────────────────────────── WC-S ──────────────────────────────

describe('WC-S10..S16 老组件换存储、sql 的写入通知', () => {
  const marker = (id = ID): string => join(dataDir(id), 'legacy-pglite')

  it('WC-S10 老 PGlite 组件带好的 api.ts → ok（hash、ops）；不建数据目录、不留记号，仍是 pglite', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export default {}\n')
    const ops = [opOf('listBooks')]
    h.runtime.manifest.mockResolvedValue({ ops, errors: [] })

    const out = await compileWidgetApi(projectDir)

    expect(out).toMatchObject({ kind: 'ok', api: { code: 'code', ops } })
    expect((out as { api: { hash: string } }).api.hash).toMatch(/^[0-9a-f]{32}$/)
    expect(existsSync(dataDir())).toBe(false)
    expect(widgetStorageOf(ID)).toBe('pglite')
    expect(hasLegacyWidgetData(ID)).toBe(true)
  })

  it('WC-S11 switchWidgetToSqlite → 数据目录 + 记号（一行 ISO 时间）；sqlite、有旧数据', () => {
    const before = Date.now()
    switchWidgetToSqlite(ID)

    expect(existsSync(dataDir())).toBe(true)
    const text = readFileSync(marker(), 'utf8')
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n$/)
    const at = Date.parse(text.trim())
    expect(at).toBeGreaterThanOrEqual(before - 1000)
    expect(at).toBeLessThanOrEqual(Date.now())
    expect(widgetStorageOf(ID)).toBe('sqlite')
    expect(hasLegacyWidgetData(ID)).toBe(true)
  })

  it('WC-S12 hasLegacyWidgetData：老组件 true；新组件 false；换过的 true', () => {
    expect(hasLegacyWidgetData(ID)).toBe(true)

    createWidgetDataDir('fresh-widget')
    expect(hasLegacyWidgetData('fresh-widget')).toBe(false)

    switchWidgetToSqlite('switched-widget')
    expect(hasLegacyWidgetData('switched-widget')).toBe(true)
  })

  it('WC-S13 换过的组件生效 / 撤掉快照 → 记号留着', async () => {
    switchWidgetToSqlite(ID)
    const bytes = readFileSync(marker())

    await activateWidgetApi(ID, { code: 'BUNDLE', hash: 'h1', ops: [opOf('a')] })
    expect(readApiSnapshot(ID)?.hash).toBe('h1')
    expect(readFileSync(marker()).equals(bytes)).toBe(true)

    await activateWidgetApi(ID, null)
    expect(readApiSnapshot(ID)).toBeNull()
    expect(readFileSync(marker()).equals(bytes)).toBe(true)
    expect(hasLegacyWidgetData(ID)).toBe(true)
  })

  it('WC-S14 换过的组件 removeWidgetData → 目录连记号一起删、forget 过', async () => {
    switchWidgetToSqlite(ID)
    writeFileSync(join(dataDir(), 'data.sqlite'), 'db')

    await removeWidgetData(ID)

    expect(existsSync(dataDir())).toBe(false)
    expect(h.runtime.forget.mock.calls).toEqual([[ID]])
    expect(widgetStorageOf(ID)).toBe('pglite')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'WC-S15 记号写不下 → 撤回数据目录、原样抛；仍是 pglite',
    () => {
      // 模拟「目录建出来了、记号写失败」：目录先在、不可写（mkdir recursive 照常过，写记号 EACCES）
      mkdirSync(dataDir(), { recursive: true })
      chmodSync(dataDir(), 0o555)
      try {
        expect(() => switchWidgetToSqlite(ID)).toThrow(/EACCES|permission denied/i)
      } finally {
        if (existsSync(dataDir())) chmodSync(dataDir(), 0o755)
      }
      expect(existsSync(dataDir())).toBe(false)
      expect(widgetStorageOf(ID)).toBe('pglite')
    }
  )

  it('WC-S16 queryWidgetSqlite：OK 开头 → 通知一次 sql/agent；表格、出错 → 不通知', async () => {
    const seen: WidgetDataChange[] = []
    const off = onWidgetDataChanged((c) => seen.push(c))
    try {
      for (const output of ['OK (2 rows changed)', 'OK', 'OK (0 rows changed)']) {
        h.runtime.query.mockResolvedValueOnce({ output })
        await expect(queryWidgetSqlite(ID, 'UPDATE books SET x = 1')).resolves.toBe(output)
      }
      expect(seen).toEqual([
        { widgetId: ID, op: 'sql', source: 'agent' },
        { widgetId: ID, op: 'sql', source: 'agent' },
        { widgetId: ID, op: 'sql', source: 'agent' }
      ])
      expect(h.runtime.query.mock.calls[0]).toEqual([
        { widgetId: ID, dbPath: join(dataDir(), 'data.sqlite') },
        'UPDATE books SET x = 1'
      ])

      seen.length = 0
      for (const output of [' n \n---\n 1\n(1 row)', '(0 rows)']) {
        h.runtime.query.mockResolvedValueOnce({ output })
        await expect(queryWidgetSqlite(ID, 'SELECT 1 AS n')).resolves.toBe(output)
      }
      h.runtime.query.mockRejectedValueOnce(
        new h.WidgetRuntimeError('query_failed', 'no such table: nope')
      )
      const err = await apiError(queryWidgetSqlite(ID, 'SELECT * FROM nope'))
      expect([err.code, err.message]).toEqual(['query_failed', 'no such table: nope'])
      expect(seen).toEqual([])
    } finally {
      off()
    }
  })
})

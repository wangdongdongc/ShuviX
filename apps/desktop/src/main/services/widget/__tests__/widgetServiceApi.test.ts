/**
 * `widgetService` 里组件 API 的接线（设计稿 docs/widget-tool-design.md §9）：init 建数据目录、build 先编译 API 再构建界面、
 * 两样都成了才让 API 生效（写快照、forget、提交），db-init / db-query / delete 按存储归属分流。
 * 真的 widgetRegistry 与 api/widgetApi（快照真的写进临时数据根）；widgetServer（打包）、widgetDb（pglite）、widgetRepo（git）、
 * 组件宿主（api/widgetRuntime）、打包服务的 buildApi 换成 spy；`utils/paths` 的两个根都是临时目录。
 *
 *   S-1 init 建数据目录（新组件就是 SQLite 组件）；init 不编译 API
 *   S-2 全绿：编译 API → 构建界面 → 生效（快照写下、forget）→ commitBuild；result.api 是 [{op, mode, agent}]；发布 widget.changed
 *   S-3 API 编译出错：buildSuccess false + API 的错误；不构建界面；快照字节不变；不提交
 *   S-4 API 编译好了、界面构建失败：旧快照照旧生效（字节不变）；结果没有 api；不 forget、不提交
 *   S-5 操作消失 / 参数变了 → warnings；api.ts 删了 → 快照删掉 + removed 的提醒；没有 api.ts 也没有快照 → 不生效、没有 warnings 键
 *   S-6 setDbSchema：SQLite → 宿主 applySchema，PGlite → applyWidgetSchema；WidgetApiError → `[code] message`；schema.sql 与指纹
 *       只在成功之后写；dbQuery：SQLite 的错误 → {output:'', error}，PGlite → runWidgetDbQuery；delete：SQLite → removeWidgetData，
 *       PGlite → dropWidgetSchema，目录删不掉就留着数据；open / startWidget / build 从不替 SQLite 组件重放 schema.sql
 *   S-7 老 PGlite 组件带 api.ts → 构建错误、界面不动；不带 api.ts → 照旧构建
 */
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
import type { OpManifest } from '../api/sandboxRuntime'

const h = vi.hoisted(() => {
  class WidgetRuntimeError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
  class WidgetDbError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string = 'WIDGET_DB_ERROR'
    ) {
      super(message)
    }
  }
  return {
    root: '',
    dataRoot: '',
    ui: { success: true } as { success: boolean; errors?: string[] },
    /** 调用次序（跨 mock）：看「先编译、后界面、再生效、最后提交」 */
    order: [] as string[],
    WidgetRuntimeError,
    WidgetDbError
  }
})

const server = vi.hoisted(() => ({
  hasWidget: vi.fn((_id: string) => false),
  registerAndBuild: vi.fn(async (_id: string, _dir: string, _entry: string) => {
    h.order.push('ui')
    return h.ui
  }),
  rebuild: vi.fn(async (_id: string) => {
    h.order.push('ui')
    return h.ui
  }),
  ensureStarted: vi.fn(async () => {}),
  unregisterWidget: vi.fn(),
  getUrl: (id: string) => `http://127.0.0.1:1/w/${id}/`
}))

const runtime = vi.hoisted(() => ({
  forget: vi.fn(async (_id: string) => {
    h.order.push('forget')
  }),
  manifest: vi.fn(async (_code: string): Promise<unknown> => {
    h.order.push('manifest')
    return { ops: [], errors: [] }
  }),
  call: vi.fn(),
  applySchema: vi.fn(
    async (_target: unknown, _ddl: string): Promise<unknown> => ({
      applied: true
    })
  ),
  query: vi.fn(async (_target: unknown, _sql: string): Promise<unknown> => ({ output: '' }))
}))

const db = vi.hoisted(() => ({
  applyWidgetSchema: vi.fn(async (_id: string, _ddl: string) => {}),
  dropWidgetSchema: vi.fn(async (_id: string) => {}),
  runWidgetDbQuery: vi.fn(async (_id: string, _sql: string) => ({ output: 'pg-out' }))
}))

const repo = vi.hoisted(() => ({
  ensureRepo: vi.fn(async () => {}),
  commitHostChange: vi.fn(async () => undefined),
  commitBuild: vi.fn(async (_dir: string, _message: string): Promise<string | undefined> => {
    h.order.push('commit')
    return 'abcdef0123456789abcdef0123456789abcdef01'
  }),
  defaultBuildMessage: (id: string) => `chore(${id}): build`
}))

const buildApi = vi.hoisted(() =>
  vi.fn(async (_dir: string, _file?: string) => {
    h.order.push('compile')
    return { success: true, outputJS: 'BUNDLE-CODE' } as {
      success: boolean
      outputJS?: string
      errors?: string[]
    }
  })
)

vi.mock('../../../utils/paths', () => ({
  getWidgetsDir: () => h.root,
  getWidgetsDataDir: () => h.dataRoot
}))
vi.mock('../widgetServer', () => ({ widgetServer: server }))
vi.mock('../widgetDb', () => ({ ...db, WidgetDbError: h.WidgetDbError }))
vi.mock('../widgetRepo', () => repo)
vi.mock('../api/widgetRuntime', () => ({
  widgetRuntime: runtime,
  WidgetRuntimeError: h.WidgetRuntimeError
}))
vi.mock('../../bundler', () => ({ bundlerService: { buildApi } }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { widgetService } from '../widgetService'
import { widgetRegistry } from '../widgetRegistry'
import { readApiSnapshot, widgetStorageOf } from '../api/widgetApi'
import { appEventBus } from '../../../utils/appEventBus'

const ID = 'book-shelf'
const dirOf = (id = ID): string => join(h.root, id)
const dataOf = (id = ID): string => join(h.dataRoot, id)
const manifestFile = (id = ID): string => join(dataOf(id), 'api.json')
const bundleFile = (id = ID): string => join(dataOf(id), 'api.js')

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

/** 种一个组件目录（widget.json + index.tsx）；sqlite → 再建数据目录；apiTs → 写一个 api.ts */
function seed(opts: { id?: string; sqlite?: boolean; apiTs?: boolean } = {}): void {
  const id = opts.id ?? ID
  mkdirSync(dirOf(id), { recursive: true })
  writeFileSync(
    join(dirOf(id), 'widget.json'),
    JSON.stringify({
      id,
      name: 'Book Shelf',
      description: '',
      entryFile: 'index.tsx',
      createdAt: 1
    })
  )
  writeFileSync(join(dirOf(id), 'index.tsx'), 'export {}\n')
  if (opts.sqlite ?? true) mkdirSync(dataOf(id), { recursive: true })
  if (opts.apiTs) writeFileSync(join(dirOf(id), 'api.ts'), 'export default {}\n')
}

/** 种一个已生效的快照 */
function seedSnapshot(ops: OpManifest[], hash = 'old-hash'): void {
  mkdirSync(dataOf(), { recursive: true })
  writeFileSync(bundleFile(), 'OLD-BUNDLE')
  writeFileSync(manifestFile(), JSON.stringify({ hash, builtAt: 1, ops }, null, 2) + '\n')
}

const snapshotBytes = (): { json: Buffer; js: Buffer } => ({
  json: readFileSync(manifestFile()),
  js: readFileSync(bundleFile())
})

const changedPublishes = (spy: { mock: { calls: unknown[][] } }): number =>
  spy.mock.calls.filter(([e]) => (e as { type: string }).type === 'widget.changed').length

let publish: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'shuvix-widget-svc-api-'))
  h.root = join(tmp, 'widgets')
  h.dataRoot = join(tmp, 'widgets-data')
  mkdirSync(h.root)
  h.ui = { success: true }
  h.order = []
  server.hasWidget.mockReset().mockReturnValue(false)
  server.registerAndBuild.mockClear()
  server.rebuild.mockClear()
  server.ensureStarted.mockClear()
  server.unregisterWidget.mockClear()
  runtime.forget.mockClear()
  runtime.manifest.mockReset().mockImplementation(async () => {
    h.order.push('manifest')
    return { ops: [], errors: [] }
  })
  runtime.applySchema.mockReset().mockResolvedValue({ applied: true })
  runtime.query.mockReset().mockResolvedValue({ output: '' })
  db.applyWidgetSchema.mockClear()
  db.dropWidgetSchema.mockClear()
  db.runWidgetDbQuery.mockClear()
  repo.ensureRepo.mockClear()
  repo.commitBuild.mockClear()
  buildApi.mockClear()
  publish = vi.spyOn(appEventBus, 'publish')
})

afterEach(() => {
  publish.mockRestore()
  rmSync(join(h.root, '..'), { recursive: true, force: true })
})

// ────────────────────────────── S-1 ──────────────────────────────

describe('S-1 init', () => {
  it('S-1 新组件 → 数据目录建好（SQLite 组件）；init 不编译 API、不取清单、不写快照', async () => {
    const out = await widgetService.init({
      id: ID,
      name: 'Book Shelf',
      description: 'd',
      template: 'blank'
    })

    expect(out.buildSuccess).toBe(true)
    expect(existsSync(dataOf())).toBe(true)
    expect(widgetStorageOf(ID)).toBe('sqlite')
    expect(buildApi).not.toHaveBeenCalled()
    expect(runtime.manifest).not.toHaveBeenCalled()
    expect(readApiSnapshot(ID)).toBeNull()
    expect(server.registerAndBuild).toHaveBeenCalledTimes(1)
  })
})

// ────────────────────────────── S-2 ──────────────────────────────

describe('S-2 全绿的构建', () => {
  it('S-2 编译 → 界面 → 生效（快照、forget）→ 提交；result.api；发布 widget.changed', async () => {
    seed({ apiTs: true })
    const ops = [opOf('listBooks'), opOf('saveLayout', { mode: 'write', agent: false })]
    runtime.manifest.mockImplementation(async () => {
      h.order.push('manifest')
      return { ops, errors: [] }
    })
    let snapshotAtUi: unknown = 'unset'
    server.registerAndBuild.mockImplementation(async () => {
      h.order.push('ui')
      snapshotAtUi = readApiSnapshot(ID)
      return h.ui
    })
    let snapshotAtCommit: unknown = null
    repo.commitBuild.mockImplementationOnce(async () => {
      h.order.push('commit')
      snapshotAtCommit = readApiSnapshot(ID)
      return 'abcdef0123456789abcdef0123456789abcdef01'
    })

    const out = await widgetService.build(ID, { message: 'feat: api' })

    expect(h.order).toEqual(['compile', 'manifest', 'ui', 'forget', 'commit'])
    expect(buildApi.mock.calls).toEqual([[dirOf(), 'api.ts']])
    expect(runtime.manifest.mock.calls).toEqual([['BUNDLE-CODE']])
    // 界面构建时快照还没写；提交时已经写了
    expect(snapshotAtUi).toBeNull()
    expect(snapshotAtCommit).toMatchObject({ ops })
    expect(readFileSync(bundleFile(), 'utf8')).toBe('BUNDLE-CODE')
    expect(readApiSnapshot(ID)?.ops).toEqual(ops)
    expect(runtime.forget.mock.calls).toEqual([[ID]])
    expect(repo.commitBuild.mock.calls).toEqual([[dirOf(), 'feat: api']])
    expect(out).toEqual({
      id: ID,
      url: `http://127.0.0.1:1/w/${ID}/`,
      buildSuccess: true,
      buildErrors: undefined,
      commit: 'abcdef0',
      api: [
        { op: 'listBooks', mode: 'read', agent: true },
        { op: 'saveLayout', mode: 'write', agent: false }
      ]
    })
    expect('warnings' in out).toBe(false)
    expect(changedPublishes(publish)).toBeGreaterThanOrEqual(1)
  })

  it('S-2 已注册的组件走 rebuild，API 照样生效', async () => {
    seed({ apiTs: true })
    server.hasWidget.mockReturnValue(true)
    runtime.manifest.mockResolvedValue({ ops: [opOf('a')], errors: [] })

    const out = await widgetService.build(ID)

    expect(server.rebuild.mock.calls).toEqual([[ID]])
    expect(server.registerAndBuild).not.toHaveBeenCalled()
    expect(out.api).toEqual([{ op: 'a', mode: 'read', agent: true }])
    expect(readApiSnapshot(ID)?.ops).toEqual([opOf('a')])
  })
})

// ────────────────────────────── S-3 ──────────────────────────────

describe('S-3 API 编译出错', () => {
  it.each([
    [
      '打包失败',
      () => buildApi.mockResolvedValueOnce({ success: false, errors: ['api.ts:3:1: boom'] }),
      ['api.ts:3:1: boom']
    ],
    [
      '清单有错',
      () =>
        runtime.manifest.mockResolvedValueOnce({ ops: [], errors: ['"x" is not an operation'] }),
      ['api.ts: "x" is not an operation']
    ],
    [
      '取清单被拒',
      () =>
        runtime.manifest.mockRejectedValueOnce(new h.WidgetRuntimeError('internal', 'top threw')),
      ['api.ts: top threw']
    ]
  ])(
    'S-3 %s → buildSuccess false 带 API 的错误；界面不动、快照不变、不提交',
    async (_l, arrange, errors) => {
      seed({ apiTs: true })
      seedSnapshot([opOf('listBooks')])
      const before = snapshotBytes()
      arrange()

      const out = await widgetService.build(ID)

      expect(out).toEqual({
        id: ID,
        url: `http://127.0.0.1:1/w/${ID}/`,
        buildSuccess: false,
        buildErrors: errors
      })
      expect(server.registerAndBuild).not.toHaveBeenCalled()
      expect(server.rebuild).not.toHaveBeenCalled()
      expect(snapshotBytes()).toEqual(before)
      expect(runtime.forget).not.toHaveBeenCalled()
      expect(repo.commitBuild).not.toHaveBeenCalled()
      expect(changedPublishes(publish)).toBe(0)
    }
  )
})

// ────────────────────────────── S-4 ──────────────────────────────

describe('S-4 界面构建失败', () => {
  it('S-4 API 编译好了、界面失败 → 旧快照照旧；没有 api；不 forget、不提交', async () => {
    seed({ apiTs: true })
    seedSnapshot([opOf('listBooks')])
    const before = snapshotBytes()
    runtime.manifest.mockResolvedValue({ ops: [opOf('addBook', { mode: 'write' })], errors: [] })
    h.ui = { success: false, errors: ['index.tsx:1:1: ui boom'] }

    const out = await widgetService.build(ID)

    expect(out.buildSuccess).toBe(false)
    expect(out.buildErrors).toEqual(['index.tsx:1:1: ui boom'])
    expect('api' in out).toBe(false)
    expect('warnings' in out).toBe(false)
    expect(snapshotBytes()).toEqual(before)
    expect(readApiSnapshot(ID)?.ops).toEqual([opOf('listBooks')])
    expect(runtime.forget).not.toHaveBeenCalled()
    expect(repo.commitBuild).not.toHaveBeenCalled()
  })
})

// ────────────────────────────── S-5 ──────────────────────────────

describe('S-5 提醒与删除 API', () => {
  it('S-5 操作消失 / 参数变了 → 一条 warning；新的照样生效', async () => {
    seed({ apiTs: true })
    seedSnapshot([
      opOf('a'),
      opOf('b', { input: { type: 'object', properties: { x: { type: 'string' } } } })
    ])
    runtime.manifest.mockResolvedValue({
      ops: [
        opOf('b', { input: { type: 'object', properties: { x: { type: 'number' } } } }),
        opOf('c')
      ],
      errors: []
    })

    const out = await widgetService.build(ID)

    expect(out.buildSuccess).toBe(true)
    expect(out.warnings).toEqual([
      'This build removed "a", changed the input of "b". Sessions, agents or bots that used the old operation may break.'
    ])
    expect(readApiSnapshot(ID)?.ops.map((o) => o.name)).toEqual(['b', 'c'])
  })

  it('S-5 只是新增 / 改说明 → 没有 warnings 键', async () => {
    seed({ apiTs: true })
    seedSnapshot([opOf('a')])
    runtime.manifest.mockResolvedValue({
      ops: [opOf('a', { description: 'new words' }), opOf('z')],
      errors: []
    })

    const out = await widgetService.build(ID)
    expect('warnings' in out).toBe(false)
  })

  it('S-5 api.ts 删了 → 快照删掉、removed 的提醒、forget；结果没有 api', async () => {
    seed({ apiTs: false })
    seedSnapshot([opOf('a'), opOf('b')])

    const out = await widgetService.build(ID)

    expect(buildApi).not.toHaveBeenCalled()
    expect(out.buildSuccess).toBe(true)
    expect(out.warnings).toEqual([
      'This build removed "a", removed "b". Sessions, agents or bots that used the old operation may break.'
    ])
    expect(existsSync(manifestFile())).toBe(false)
    expect(existsSync(bundleFile())).toBe(false)
    expect(runtime.forget.mock.calls).toEqual([[ID]])
    expect('api' in out).toBe(false)
  })

  it('S-5 没有 api.ts 也没有快照 → 不生效（不 forget）、没有 warnings / api 键', async () => {
    seed({ apiTs: false })

    const out = await widgetService.build(ID)

    expect(out.buildSuccess).toBe(true)
    expect(runtime.forget).not.toHaveBeenCalled()
    expect('warnings' in out).toBe(false)
    expect('api' in out).toBe(false)
    expect(repo.commitBuild).toHaveBeenCalledTimes(1)
  })
})

// ────────────────────────────── S-6 ──────────────────────────────

describe('S-6 db-init / db-query / delete 按存储归属分流', () => {
  const schemaFile = (id = ID): string => join(dirOf(id), 'schema.sql')

  it('S-6 setDbSchema（SQLite）→ 宿主 applySchema(target, ddl)；成功后写 schema.sql（补换行）与指纹', async () => {
    seed()
    const ddl = 'CREATE TABLE books (id INTEGER PRIMARY KEY)'

    await expect(widgetService.setDbSchema(ID, ddl)).resolves.toEqual({ id: ID, applied: true })

    expect(runtime.applySchema.mock.calls).toEqual([
      [{ widgetId: ID, dbPath: join(dataOf(), 'data.sqlite') }, ddl]
    ])
    expect(db.applyWidgetSchema).not.toHaveBeenCalled()
    expect(readFileSync(schemaFile(), 'utf8')).toBe(ddl + '\n')
    expect(widgetRegistry.getSchemaHash(ID)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('S-6 setDbSchema（PGlite）→ applyWidgetSchema，不碰宿主', async () => {
    seed({ sqlite: false })
    await widgetService.setDbSchema(ID, 'CREATE TABLE t (x int);\n')
    expect(db.applyWidgetSchema.mock.calls).toEqual([[ID, 'CREATE TABLE t (x int);\n']])
    expect(runtime.applySchema).not.toHaveBeenCalled()
    expect(readFileSync(schemaFile(), 'utf8')).toBe('CREATE TABLE t (x int);\n')
  })

  it('S-6 宿主拒绝（WidgetApiError）→ `[code] message`；schema.sql 与指纹都不写', async () => {
    seed()
    runtime.applySchema.mockRejectedValue(
      new h.WidgetRuntimeError('sql_refused', 'schema.sql cannot use ATTACH.')
    )

    await expect(widgetService.setDbSchema(ID, 'ATTACH DATABASE x AS y')).rejects.toThrow(
      '[sql_refused] schema.sql cannot use ATTACH.'
    )
    expect(existsSync(schemaFile())).toBe(false)
    expect(widgetRegistry.getSchemaHash(ID)).toBe('')
  })

  it('S-6 已有 schema.sql 时失败 → 文件与指纹都不变', async () => {
    seed()
    await widgetService.setDbSchema(ID, 'CREATE TABLE a (x)')
    const file = readFileSync(schemaFile())
    const hash = widgetRegistry.getSchemaHash(ID)
    runtime.applySchema.mockRejectedValue(
      new h.WidgetRuntimeError('schema_failed', 'no such table')
    )

    await expect(widgetService.setDbSchema(ID, 'DROP TABLE nope')).rejects.toThrow(
      '[schema_failed] no such table'
    )
    expect(readFileSync(schemaFile())).toEqual(file)
    expect(widgetRegistry.getSchemaHash(ID)).toBe(hash)
  })

  it('S-6 PGlite 的 WidgetDbError → `[code] message`；别的错误原样', async () => {
    seed({ sqlite: false })
    db.applyWidgetSchema.mockRejectedValueOnce(new h.WidgetDbError('bad ddl', 400, 'DDL_FAILED'))
    await expect(widgetService.setDbSchema(ID, 'x')).rejects.toThrow('[DDL_FAILED] bad ddl')
    const other = new TypeError('other')
    db.applyWidgetSchema.mockRejectedValueOnce(other)
    await expect(widgetService.setDbSchema(ID, 'x')).rejects.toBe(other)
  })

  it('S-6 dbQuery（SQLite）→ 宿主 query 的输出；出错 → {output:"", error}', async () => {
    seed()
    runtime.query.mockResolvedValueOnce({ output: ' n \n---\n 1\n(1 row)' })
    await expect(widgetService.dbQuery(ID, 'SELECT 1 AS n')).resolves.toEqual({
      output: ' n \n---\n 1\n(1 row)'
    })
    expect(runtime.query.mock.calls).toEqual([
      [{ widgetId: ID, dbPath: join(dataOf(), 'data.sqlite') }, 'SELECT 1 AS n']
    ])

    runtime.query.mockRejectedValueOnce(
      new h.WidgetRuntimeError('sql_refused', 'db-query cannot use VACUUM.')
    )
    await expect(widgetService.dbQuery(ID, 'VACUUM')).resolves.toEqual({
      output: '',
      error: 'db-query cannot use VACUUM.'
    })
    expect(db.runWidgetDbQuery).not.toHaveBeenCalled()
  })

  it('S-6 dbQuery（PGlite）→ runWidgetDbQuery', async () => {
    seed({ sqlite: false })
    await expect(widgetService.dbQuery(ID, 'select 1')).resolves.toEqual({ output: 'pg-out' })
    expect(db.runWidgetDbQuery.mock.calls).toEqual([[ID, 'select 1']])
    expect(runtime.query).not.toHaveBeenCalled()
  })

  it('S-6 delete（SQLite）→ forget + 删数据目录，不碰 pglite', async () => {
    seed()
    seedSnapshot([opOf('a')])
    writeFileSync(join(dataOf(), 'data.sqlite'), 'db')

    await widgetService.delete(ID)

    expect(existsSync(dirOf())).toBe(false)
    expect(existsSync(dataOf())).toBe(false)
    expect(runtime.forget.mock.calls).toEqual([[ID]])
    expect(db.dropWidgetSchema).not.toHaveBeenCalled()
    expect(widgetRegistry.findById(ID)).toBeUndefined()
  })

  it('S-6 delete（PGlite）→ dropWidgetSchema，不碰宿主', async () => {
    seed({ sqlite: false })
    await widgetService.delete(ID)
    expect(db.dropWidgetSchema.mock.calls).toEqual([[ID]])
    expect(runtime.forget).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'S-6 组件目录删不掉 → 数据留着（不 forget、不删数据目录、不 drop）',
    async () => {
      seed()
      writeFileSync(join(dataOf(), 'data.sqlite'), 'db')
      // widgets 根只读：组件目录本身删不掉（里面的文件能删，目录项删不掉）
      chmodSync(h.root, 0o555)
      try {
        await widgetService.delete(ID)
      } finally {
        chmodSync(h.root, 0o755)
      }
      expect(existsSync(dirOf())).toBe(true)
      expect(existsSync(join(dataOf(), 'data.sqlite'))).toBe(true)
      expect(runtime.forget).not.toHaveBeenCalled()
      expect(db.dropWidgetSchema).not.toHaveBeenCalled()
    }
  )

  it.each(['open', 'startWidget', 'build'] as const)(
    'S-6 %s 从不替 SQLite 组件重放 schema.sql（PGlite 组件照旧重放）',
    async (action) => {
      // SQLite 组件：db-init 过一次（schema.sql 与指纹对得上）
      seed()
      await widgetService.setDbSchema(ID, 'CREATE TABLE a (x)')
      // 对照：同样状态的 PGlite 组件
      seed({ id: 'old-widget', sqlite: false })
      await widgetService.setDbSchema('old-widget', 'CREATE TABLE a (x)')
      runtime.applySchema.mockClear()
      db.applyWidgetSchema.mockClear()

      await widgetService[action](ID)
      expect(runtime.applySchema).not.toHaveBeenCalled()
      expect(db.applyWidgetSchema).not.toHaveBeenCalled()

      await widgetService[action]('old-widget')
      expect(db.applyWidgetSchema.mock.calls).toEqual([['old-widget', 'CREATE TABLE a (x)\n']])
      expect(runtime.applySchema).not.toHaveBeenCalled()
    }
  )
})

// ────────────────────────────── S-7 ──────────────────────────────

describe('S-7 老 PGlite 组件', () => {
  it('S-7 带 api.ts → 构建错误（先把数据搬到 SQLite），界面不动、不提交', async () => {
    seed({ sqlite: false, apiTs: true })

    const out = await widgetService.build(ID)

    expect(out.buildSuccess).toBe(false)
    expect(out.buildErrors).toHaveLength(1)
    expect(out.buildErrors?.[0]).toContain('older shared database')
    expect(buildApi).not.toHaveBeenCalled()
    expect(server.registerAndBuild).not.toHaveBeenCalled()
    expect(server.rebuild).not.toHaveBeenCalled()
    expect(repo.commitBuild).not.toHaveBeenCalled()
    expect(existsSync(dataOf())).toBe(false)
  })

  it('S-7 不带 api.ts → 照旧构建：没有 api、没有快照、没有数据目录', async () => {
    seed({ sqlite: false })

    const out = await widgetService.build(ID)

    expect(out.buildSuccess).toBe(true)
    expect(server.registerAndBuild).toHaveBeenCalledTimes(1)
    expect('api' in out).toBe(false)
    expect(runtime.forget).not.toHaveBeenCalled()
    expect(existsSync(dataOf())).toBe(false)
    expect(out.commit).toBe('abcdef0')
  })
})

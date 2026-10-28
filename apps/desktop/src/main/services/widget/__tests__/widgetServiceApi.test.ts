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
 *   S-6 dbQuery：SQLite 的错误 → {output:'', error}，PGlite → runWidgetDbQuery；delete：SQLite → removeWidgetData，
 *       PGlite → dropWidgetSchema，目录删不掉就留着数据；open / startWidget / build 从不替 SQLite 组件重放 schema.sql
 *   S-7 老 PGlite 组件带 api.ts、构建全绿 → 换成 SQLite（数据目录 + 旧数据记号）并提醒；不带 api.ts → 照旧构建
 *   WC-S20 老组件 + 编得过的 api.ts、界面构建失败 → 不换存储（没有数据目录、没有记号）、没有 warnings、不生效、不提交
 *   WC-S21 老组件 + 编不过的 api.ts → buildSuccess false + 打包的原话；界面不构建；不换存储
 *   WC-S22 全绿的换存储：编译 → 清单 → 界面 → 生效 → 提交，换存储在生效之前（forget 时记号已在）；api.json 与记号同目录；
 *          result.api 列出操作；warnings 正好一条（之前没有快照，没有「操作变了」的那条），讲清从空库开始、没有 /db、
 *          用 sql 建表、`legacy: true` 读旧数据
 *   WC-S23 换过之后再构建 → 没有 warnings 键、记号字节不变；open / startWidget / build 不再往 PGlite 重放 schema.sql
 *          （第一次构建时还是老组件，那一次照旧重放 —— 钉住）
 *   WC-S24 删换过的组件 → 先删数据目录（forget），再 dropWidgetSchema（那时目录已经没了）；新组件（S-6）不 drop
 *   WC-S26 换过的组件、目录删不掉 → 不 drop、不删数据目录，记号留着
 *   WC-S27 删掉换过的组件、再 init 同一个 id → 新数据目录里没有记号、没有旧库
 *   WC-S28 删换过的组件时 dropWidgetSchema 拒绝 → 数据目录（连记号）照样已经删掉、账目没了
 *   WT4-PV-18 onDeleted：delete 之后每个监听者各收到一次 id（那时账目里已经没有它）；一个监听者抛错 → 一条 warn，后面的照样
 *       收到、数据照样删；退订之后不再收到；组件目录删不掉 → 谁都不通知
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
    WidgetDbError,
    /** 所有模块共用的 logger.warn（WT4-PV-18 数「监听者抛错」那一条） */
    warn: vi.fn((..._args: unknown[]) => {})
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
  createLogger: () => ({ info: () => {}, warn: h.warn, error: () => {}, debug: () => {} })
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
  runtime.query.mockReset().mockResolvedValue({ output: '' })
  db.applyWidgetSchema.mockClear()
  db.dropWidgetSchema.mockClear()
  db.runWidgetDbQuery.mockClear()
  repo.ensureRepo.mockClear()
  repo.commitBuild.mockClear()
  buildApi.mockClear()
  h.warn.mockClear()
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
      // 两个组件都有一份 db-init 过的 schema.sql（旧版本留下的：文件与指纹对得上）
      const ddl = 'CREATE TABLE a (x)\n'
      const fingerprint = createHash('sha256').update(ddl, 'utf8').digest('hex').slice(0, 32)
      seed()
      writeFileSync(join(dirOf(ID), 'schema.sql'), ddl)
      widgetRegistry.setSchemaHash(ID, fingerprint)
      // 对照：同样状态的 PGlite 组件
      seed({ id: 'old-widget', sqlite: false })
      writeFileSync(join(dirOf('old-widget'), 'schema.sql'), ddl)
      widgetRegistry.setSchemaHash('old-widget', fingerprint)
      db.applyWidgetSchema.mockClear()

      await widgetService[action](ID)
      expect(runtime.query).not.toHaveBeenCalled()
      expect(db.applyWidgetSchema).not.toHaveBeenCalled()

      await widgetService[action]('old-widget')
      expect(db.applyWidgetSchema.mock.calls).toEqual([['old-widget', ddl]])
      expect(runtime.query).not.toHaveBeenCalled()
    }
  )
})

// ────────────────────────────── WT4-PV-18 ──────────────────────────────

describe('WT4-PV-18 onDeleted', () => {
  const listenerWarns = (): unknown[][] =>
    h.warn.mock.calls.filter((c) => String(c[0]).startsWith('widget deleted listener failed'))

  it('WT4-PV-18 delete 之后每个监听者各收到一次 id（账目已经没有它）；抛错的只 warn 一条，后面的照样收到、数据照删', async () => {
    seed()
    writeFileSync(join(dataOf(), 'data.sqlite'), 'db')
    const seen: Array<[string, string, boolean]> = []
    const l1 = vi.fn((id: string) => {
      seen.push(['l1', id, widgetRegistry.findById(id) === undefined])
      throw new Error('listener one broke')
    })
    const l2 = vi.fn((id: string) => {
      seen.push(['l2', id, widgetRegistry.findById(id) === undefined])
    })
    const off1 = widgetService.onDeleted(l1)
    const off2 = widgetService.onDeleted(l2)
    try {
      await widgetService.delete(ID)
    } finally {
      off1()
    }

    expect(seen).toEqual([
      ['l1', ID, true],
      ['l2', ID, true]
    ])
    expect(l1).toHaveBeenCalledTimes(1)
    expect(l2).toHaveBeenCalledTimes(1)
    expect(listenerWarns()).toEqual([
      [`widget deleted listener failed widget=${ID}: listener one broke`]
    ])
    // 监听者抛错不拦后面的清理
    expect(existsSync(dataOf())).toBe(false)
    expect(runtime.forget.mock.calls).toEqual([[ID]])

    // 退订 l2，再删另一个：l2 不再收到
    off2()
    seed({ id: 'other-shelf' })
    await widgetService.delete('other-shelf')
    expect(l2).toHaveBeenCalledTimes(1)
    expect(l1).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'WT4-PV-18 组件目录删不掉 → 谁都不通知',
    async () => {
      seed()
      const listener = vi.fn()
      const off = widgetService.onDeleted(listener)
      chmodSync(h.root, 0o555)
      try {
        await widgetService.delete(ID)
      } finally {
        chmodSync(h.root, 0o755)
        off()
      }
      expect(existsSync(dirOf())).toBe(true)
      expect(widgetRegistry.findById(ID)).toBeDefined()
      expect(listener).not.toHaveBeenCalled()
    }
  )
})

// ────────────────────────────── S-7 ──────────────────────────────

describe('S-7 老 PGlite 组件', () => {
  it('S-7 带 api.ts、构建全绿 → 换成 SQLite：数据目录与旧数据记号建出来，结果里提醒建表、搬数据', async () => {
    seed({ sqlite: false, apiTs: true })
    runtime.manifest.mockResolvedValue({ ops: [opOf('a')], errors: [] })

    const out = await widgetService.build(ID)

    expect(out.buildSuccess).toBe(true)
    expect(buildApi).toHaveBeenCalledTimes(1)
    expect(existsSync(dataOf())).toBe(true)
    expect(existsSync(join(dataOf(), 'legacy-pglite'))).toBe(true)
    expect(out.warnings?.[0]).toContain('now keeps its data in its own SQLite database')
    expect(repo.commitBuild).toHaveBeenCalledTimes(1)
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

// ────────────────────────────── WC-S20..S28 ──────────────────────────────

describe('WC-S20..S28 老组件换成 SQLite', () => {
  const markerFile = (id = ID): string => join(dataOf(id), 'legacy-pglite')
  const manifestReturns = (ops: OpManifest[]): void => {
    runtime.manifest.mockImplementation(async () => {
      h.order.push('manifest')
      return { ops, errors: [] }
    })
  }
  /** 种一个已经换过存储的组件：数据目录 + 记号 + 库文件 */
  function seedSwitched(id = ID): void {
    seed({ id })
    writeFileSync(markerFile(id), '2026-10-27T00:00:00.000Z\n')
    writeFileSync(join(dataOf(id), 'data.sqlite'), 'db')
  }

  it('WC-S20 api.ts 编得过、界面构建失败 → 不换存储、没有 warnings、不生效、不提交', async () => {
    seed({ sqlite: false, apiTs: true })
    manifestReturns([opOf('a')])
    h.ui = { success: false, errors: ['index.tsx:1:1: broken'] }

    const out = await widgetService.build(ID)

    expect(out.buildSuccess).toBe(false)
    expect(out.buildErrors).toEqual(['index.tsx:1:1: broken'])
    expect(existsSync(dataOf())).toBe(false)
    expect(widgetStorageOf(ID)).toBe('pglite')
    expect('warnings' in out).toBe(false)
    expect('api' in out).toBe(false)
    expect(runtime.forget).not.toHaveBeenCalled()
    expect(repo.commitBuild).not.toHaveBeenCalled()
  })

  it('WC-S21 api.ts 编不过 → buildSuccess false + 打包的原话；界面不构建；不换存储', async () => {
    seed({ sqlite: false, apiTs: true })
    buildApi.mockResolvedValueOnce({ success: false, errors: ['api.ts:2:7: ERROR: boom'] })

    const out = await widgetService.build(ID)

    expect(out.buildSuccess).toBe(false)
    expect(out.buildErrors).toEqual(['api.ts:2:7: ERROR: boom'])
    expect(server.registerAndBuild).not.toHaveBeenCalled()
    expect(server.rebuild).not.toHaveBeenCalled()
    expect(existsSync(dataOf())).toBe(false)
    expect(repo.commitBuild).not.toHaveBeenCalled()
  })

  it('WC-S22 全绿：换存储在生效之前；快照与记号同目录；warnings 正好一条、讲清怎么搬数据', async () => {
    seed({ sqlite: false, apiTs: true })
    const ops = [opOf('listBooks'), opOf('addBook', { mode: 'write' })]
    manifestReturns(ops)
    let markerAtForget: boolean | null = null
    runtime.forget.mockImplementationOnce(async () => {
      h.order.push('forget')
      markerAtForget = existsSync(markerFile())
    })

    const out = await widgetService.build(ID)

    expect(h.order).toEqual(['compile', 'manifest', 'ui', 'forget', 'commit'])
    expect(markerAtForget).toBe(true)
    expect(existsSync(manifestFile())).toBe(true)
    expect(existsSync(markerFile())).toBe(true)
    expect(readApiSnapshot(ID)?.ops).toEqual(ops)
    expect(out.api).toEqual([
      { op: 'listBooks', mode: 'read', agent: true },
      { op: 'addBook', mode: 'write', agent: true }
    ])
    expect(out.warnings).toHaveLength(1)
    const warning = out.warnings![0]
    expect(warning).toContain('its own SQLite database, which starts empty')
    expect(warning).toContain('can no longer use /db')
    expect(warning).toContain('the sql action')
    expect(warning).toContain('`legacy: true`')
    expect(warning).not.toMatch(/removed|changed the input/)
  })

  it('WC-S23 换过之后再构建 → 没有 warnings、记号不变；之后不再往 PGlite 重放 schema.sql', async () => {
    const ddl = 'CREATE TABLE a (x)\n'
    seed({ sqlite: false, apiTs: true })
    writeFileSync(join(dirOf(), 'schema.sql'), ddl)
    widgetRegistry.setSchemaHash(
      ID,
      createHash('sha256').update(ddl, 'utf8').digest('hex').slice(0, 32)
    )
    manifestReturns([opOf('a')])

    // 第一次：还是老组件，构建前照旧重放（钉住），构建后换存储
    await widgetService.build(ID)
    expect(db.applyWidgetSchema.mock.calls).toEqual([[ID, ddl]])
    expect(widgetStorageOf(ID)).toBe('sqlite')
    const marker = readFileSync(markerFile())
    db.applyWidgetSchema.mockClear()

    const second = await widgetService.build(ID)
    expect(second.buildSuccess).toBe(true)
    expect('warnings' in second).toBe(false)
    expect(readFileSync(markerFile()).equals(marker)).toBe(true)

    await widgetService.open(ID)
    await widgetService.startWidget(ID)
    expect(db.applyWidgetSchema).not.toHaveBeenCalled()
    expect(runtime.query).not.toHaveBeenCalled()
  })

  it('WC-S24 删换过的组件 → 先删数据目录（forget），再 drop PGlite 里的 schema；新组件不 drop', async () => {
    seedSwitched()
    let dataAtDrop: boolean | null = null
    db.dropWidgetSchema.mockImplementationOnce(async () => {
      h.order.push('drop')
      dataAtDrop = existsSync(dataOf())
    })

    await widgetService.delete(ID)

    expect(h.order).toEqual(['forget', 'drop'])
    expect(dataAtDrop).toBe(false)
    expect(db.dropWidgetSchema.mock.calls).toEqual([[ID]])
    expect(runtime.forget.mock.calls).toEqual([[ID]])
    expect(existsSync(dataOf())).toBe(false)
    expect(existsSync(dirOf())).toBe(false)

    // 对照：没有记号的 SQLite 组件（新建的）不碰 PGlite
    seed({ id: 'fresh-shelf' })
    await widgetService.delete('fresh-shelf')
    expect(db.dropWidgetSchema.mock.calls).toEqual([[ID]])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'WC-S26 换过的组件、目录删不掉 → 不 drop、不删数据目录，记号留着',
    async () => {
      seedSwitched()
      chmodSync(h.root, 0o555)
      try {
        await widgetService.delete(ID)
      } finally {
        chmodSync(h.root, 0o755)
      }
      expect(existsSync(dirOf())).toBe(true)
      expect(existsSync(markerFile())).toBe(true)
      expect(existsSync(join(dataOf(), 'data.sqlite'))).toBe(true)
      expect(db.dropWidgetSchema).not.toHaveBeenCalled()
      expect(runtime.forget).not.toHaveBeenCalled()
    }
  )

  it('WC-S27 删掉换过的组件、再 init 同一个 id → 新数据目录里没有记号、没有旧库', async () => {
    seedSwitched()
    await widgetService.delete(ID)

    await widgetService.init({ id: ID, name: 'Book Shelf 2', description: '', template: 'blank' })

    expect(existsSync(dataOf())).toBe(true)
    expect(existsSync(markerFile())).toBe(false)
    expect(existsSync(join(dataOf(), 'data.sqlite'))).toBe(false)
  })

  it('WC-S28 dropWidgetSchema 拒绝 → delete 照样完成（不报错），数据目录（连记号）已经删掉，账目没了', async () => {
    seedSwitched()
    db.dropWidgetSchema.mockRejectedValueOnce(new Error('SQL worker [widgets:shared] not ready'))

    await expect(widgetService.delete(ID)).resolves.toBeUndefined()

    expect(existsSync(dataOf())).toBe(false)
    expect(existsSync(dirOf())).toBe(false)
    expect(widgetRegistry.findById(ID)).toBeUndefined()
    expect(db.dropWidgetSchema).toHaveBeenCalledTimes(1)
  })
})

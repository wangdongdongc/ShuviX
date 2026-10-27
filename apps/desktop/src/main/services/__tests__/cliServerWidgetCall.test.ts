/**
 * cliServer `widget.call` / `widget.db-query` —— `shuvix widget call <id> <op> [--args] [--dry-run]` 与 `db-query` 在主进程那一头
 * （设计稿 docs/widget-tool-design.md §9）。
 *
 * handler 从私有的 `handlers` 表里取（构造时注册，不用 start 起 socket）。`widgetService` 是真的（validateId 用真正的
 * id 规则：kebab-case 且至少一个短横），getById / dbQuery 换成 spy；`callWidgetOp` 是 spy，`WidgetApiError` 是本文件
 * 自己的类（cliServer 按 instanceof 认它）。其余依赖与 cliServerWidgetBuild.test.ts 同一套空壳；`utils/paths` 顶成
 * 不存在的目录，一个文件都不碰真的 HOME。
 *
 *   CS-1 非法 id（`../etc` …）→ Invalid widget id，在查注册与调用之前；没注册 → not found；缺 id / op → id and operation
 *        required；`--args` 不是 JSON → `--args is not valid JSON`，不调用；空白 / 没给 / 不是字符串 → `{}`；合法 JSON 原样解析
 *   CS-2 caller 是 `{kind:'agent', sessionId?, actor:'cli', label:'cli'}`：没有会话就没有 sessionId 这个键；
 *        dryRun 只在 `p.dryRun === true` 时为 true（字符串 'true'、1 都不算）
 *   CS-3 成功 → stdout `JSON.stringify({op, mode, dryRun?, result, logs?}, null, 2)`、退出 0；操作失败 → `{op, mode, error}`、
 *        退出 1；WidgetApiError → stderr `[code] message`、退出 1；别的错误原样抛出
 *   CS-4 db-query 走 widgetService.dbQuery：输出打到 stdout、退出 0；error → stderr、退出 1；缺 id / sql、没注册 → 抛
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class WidgetApiError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
  return {
    callWidgetOp: vi.fn(),
    WidgetApiError
  }
})

// widget 模块：真实的 widgetService（validateId / getById / dbQuery），callWidgetOp 与 WidgetApiError 由本文件控制
vi.mock('../widget', async () => {
  const { widgetService } =
    await vi.importActual<typeof import('../widget/widgetService')>('../widget/widgetService')
  return {
    widgetService,
    exportWidget: vi.fn(),
    resolveExportZipPath: vi.fn(),
    WidgetExportError: class WidgetExportError extends Error {},
    runWidgetDbQuery: vi.fn(),
    callWidgetOp: mocks.callWidgetOp,
    WidgetApiError: mocks.WidgetApiError
  }
})
// widgetService 的重依赖：打包服务 / pglite / git —— 本文件一个都不碰
vi.mock('../widget/widgetServer', () => ({ widgetServer: {} }))
vi.mock('../widget/widgetDb', () => ({
  applyWidgetSchema: vi.fn(),
  dropWidgetSchema: vi.fn(),
  runWidgetDbQuery: vi.fn(),
  WidgetDbError: class WidgetDbError extends Error {}
}))
vi.mock('../widget/widgetRepo', () => ({
  ensureRepo: vi.fn(),
  commitHostChange: vi.fn(),
  commitBuild: vi.fn(),
  defaultBuildMessage: (id: string) => `chore(${id}): build`
}))
vi.mock('../../utils/paths', () => ({
  getWidgetsDir: () => '/nonexistent/shuvix-unit/widgets',
  getWidgetsDataDir: () => '/nonexistent/shuvix-unit/widgets-data'
}))
vi.mock('../widgetWindowService', () => ({ open: vi.fn() }))
vi.mock('../acl', () => ({ sessionAcl: { grantPath: vi.fn() } }))
vi.mock('../toolContext', () => ({ getDesktopSecurityContext: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { cliServer } from '../cliServer'
import { widgetService } from '../widget'

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => Promise<unknown>

const handler = (name: 'widget.call' | 'widget.db-query'): Handler => {
  const h = (cliServer as unknown as { handlers: Map<string, Handler> }).handlers.get(name)
  if (!h) throw new Error(`${name} handler is not registered`)
  return h
}
const call = (p: Record<string, unknown>, sid?: string): Promise<unknown> =>
  handler('widget.call')(p, sid)
const dbQuery = (p: Record<string, unknown>): Promise<unknown> =>
  handler('widget.db-query')(p, undefined)

const ID = 'book-shelf'
const WIDGET = { id: ID, name: 'Book Shelf' }

/** callWidgetOp 的返回：{ op, mode, result: CallResult } */
function okResult(
  value: unknown,
  logs: string[] = [],
  mode: 'read' | 'write' = 'write'
): {
  op: string
  mode: 'read' | 'write'
  result: { outcome: { ok: true; value: unknown }; wrote: boolean; logs: string[] }
} {
  return { op: 'addBook', mode, result: { outcome: { ok: true, value }, wrote: true, logs } }
}

let getById: ReturnType<typeof vi.spyOn>
let dbQuerySpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.restoreAllMocks()
  mocks.callWidgetOp.mockReset()
  mocks.callWidgetOp.mockResolvedValue(okResult({ id: 1 }))
  getById = vi.spyOn(widgetService, 'getById').mockReturnValue(WIDGET as never)
  dbQuerySpy = vi.spyOn(widgetService, 'dbQuery').mockResolvedValue({ output: '(0 rows)' })
})

/** 唯一一次 callWidgetOp 的参数 */
function onlyCall(): unknown[] {
  expect(mocks.callWidgetOp).toHaveBeenCalledTimes(1)
  return mocks.callWidgetOp.mock.calls[0]
}

describe('CS-1 参数检查', () => {
  it.each(['../etc', '../../etc', 'foo', 'Foo_Bar'])(
    'CS-1 非法 id %j → Invalid widget id，不查注册、不调用',
    async (id) => {
      await expect(call({ id, op: 'addBook' }, 'sess-1')).rejects.toThrow('Invalid widget id')
      expect(getById).not.toHaveBeenCalled()
      expect(mocks.callWidgetOp).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['没有 id', { op: 'addBook' }],
    ['没有 op', { id: ID }],
    ['空 id', { id: '', op: 'addBook' }],
    ['空 op', { id: ID, op: '' }]
  ])('CS-1 %s → id and operation required', async (_label, p) => {
    await expect(call(p, 'sess-1')).rejects.toThrow('id and operation required')
    expect(mocks.callWidgetOp).not.toHaveBeenCalled()
  })

  it('CS-1 没注册的 widget → not found，不调用', async () => {
    getById.mockReturnValue(undefined)
    await expect(call({ id: ID, op: 'addBook' }, 'sess-1')).rejects.toThrow(
      `widget "${ID}" not found`
    )
    expect(getById).toHaveBeenCalledWith(ID)
    expect(mocks.callWidgetOp).not.toHaveBeenCalled()
  })

  it.each(['{', '{"title":', "{'title':'a'}", 'not json'])(
    'CS-1 --args %j 不是 JSON → --args is not valid JSON，不调用',
    async (args) => {
      await expect(call({ id: ID, op: 'addBook', args }, 'sess-1')).rejects.toThrow(
        '--args is not valid JSON'
      )
      expect(mocks.callWidgetOp).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['没给', undefined],
    ['空串', ''],
    ['全空白', '   \n'],
    ['不是字符串（对象）', { title: 'a' }],
    ['不是字符串（数字）', 42]
  ])('CS-1 args %s → {}', async (_label, args) => {
    const p: Record<string, unknown> = { id: ID, op: 'addBook' }
    if (args !== undefined) p.args = args
    await call(p, 'sess-1')
    expect(onlyCall()[2]).toEqual({})
  })

  it('CS-1 合法 JSON 原样解析后交给 callWidgetOp', async () => {
    await call({ id: ID, op: 'addBook', args: '{"title":"a","tags":[1,2]}' }, 'sess-1')
    const [id, op, args] = onlyCall()
    expect(id).toBe(ID)
    expect(op).toBe('addBook')
    expect(args).toEqual({ title: 'a', tags: [1, 2] })
  })
})

describe('CS-2 caller 与 dryRun', () => {
  it('CS-2 有会话 → caller {kind agent, sessionId, actor cli, label cli}', async () => {
    await call({ id: ID, op: 'addBook' }, 'sess-1')
    expect(onlyCall()[3]).toStrictEqual({
      kind: 'agent',
      sessionId: 'sess-1',
      actor: 'cli',
      label: 'cli'
    })
  })

  it('CS-2 没有会话 → caller 里没有 sessionId 这个键', async () => {
    await call({ id: ID, op: 'addBook' }, undefined)
    const caller = onlyCall()[3] as Record<string, unknown>
    expect(caller).toStrictEqual({ kind: 'agent', actor: 'cli', label: 'cli' })
    expect('sessionId' in caller).toBe(false)
  })

  it('CS-2 dryRun === true → options { dryRun: true }', async () => {
    await call({ id: ID, op: 'addBook', dryRun: true }, 'sess-1')
    expect(onlyCall()[4]).toStrictEqual({ dryRun: true })
  })

  it.each([
    ['没给', undefined],
    ["字符串 'true'", 'true'],
    ['数字 1', 1],
    ['false', false]
  ])('CS-2 dryRun %s → options { dryRun: false }', async (_label, dryRun) => {
    const p: Record<string, unknown> = { id: ID, op: 'addBook' }
    if (dryRun !== undefined) p.dryRun = dryRun
    await call(p, 'sess-1')
    expect(onlyCall()[4]).toStrictEqual({ dryRun: false })
  })
})

describe('CS-3 输出', () => {
  it('CS-3 成功 → stdout 是 {op, mode, result} 的两格缩进 JSON，退出 0；没有日志就没有 logs 键', async () => {
    mocks.callWidgetOp.mockResolvedValue(okResult({ id: 1, title: 'a' }))

    const out = await call({ id: ID, op: 'addBook', args: '{"title":"a"}' }, 'sess-1')

    expect(out).toStrictEqual({
      stdout: JSON.stringify(
        { op: 'addBook', mode: 'write', result: { id: 1, title: 'a' } },
        null,
        2
      ),
      stderr: '',
      exitCode: 0
    })
  })

  it('CS-3 dry run + 日志 → 键依次是 op, mode, dryRun, result, logs', async () => {
    mocks.callWidgetOp.mockResolvedValue(okResult({ id: 7 }, ['a {"b":1}', 'second']))

    const out = (await call({ id: ID, op: 'addBook', dryRun: true }, 'sess-1')) as {
      stdout: string
      stderr: string
      exitCode: number
    }

    expect(out.exitCode).toBe(0)
    expect(out.stderr).toBe('')
    expect(out.stdout).toBe(
      JSON.stringify(
        {
          op: 'addBook',
          mode: 'write',
          dryRun: true,
          result: { id: 7 },
          logs: ['a {"b":1}', 'second']
        },
        null,
        2
      )
    )
    expect(Object.keys(JSON.parse(out.stdout))).toEqual(['op', 'mode', 'dryRun', 'result', 'logs'])
  })

  it('CS-3 结果是 null（handler 返回 undefined）→ result: null 照样打出来', async () => {
    mocks.callWidgetOp.mockResolvedValue(okResult(null, [], 'read'))
    const out = (await call({ id: ID, op: 'addBook' }, 'sess-1')) as { stdout: string }
    expect(JSON.parse(out.stdout)).toStrictEqual({ op: 'addBook', mode: 'read', result: null })
  })

  it('CS-3 操作失败（outcome.ok false）→ stdout {op, mode, error}，退出 1', async () => {
    const error = { code: 'not_found', message: 'No such book.' }
    mocks.callWidgetOp.mockResolvedValue({
      op: 'addBook',
      mode: 'write',
      result: { outcome: { ok: false, error }, wrote: false, logs: [] }
    })

    const out = await call({ id: ID, op: 'addBook' }, 'sess-1')

    expect(out).toStrictEqual({
      stdout: JSON.stringify({ op: 'addBook', mode: 'write', error }, null, 2),
      stderr: '',
      exitCode: 1
    })
  })

  it('CS-3 WidgetApiError → stderr `[code] message`，stdout 空，退出 1', async () => {
    mocks.callWidgetOp.mockRejectedValue(
      new mocks.WidgetApiError('no_api', `Widget "${ID}" has no API.`)
    )

    const out = await call({ id: ID, op: 'addBook' }, 'sess-1')

    expect(out).toStrictEqual({
      stdout: '',
      stderr: `[no_api] Widget "${ID}" has no API.`,
      exitCode: 1
    })
  })

  it('CS-3 别的错误原样抛出', async () => {
    const boom = new Error('boom')
    mocks.callWidgetOp.mockRejectedValue(boom)
    await expect(call({ id: ID, op: 'addBook' }, 'sess-1')).rejects.toBe(boom)
  })
})

describe('CS-4 db-query', () => {
  it('CS-4 走 widgetService.dbQuery：输出打到 stdout，退出 0', async () => {
    const table = ' id | title \n----+-------\n 1  | a     \n(1 row)'
    dbQuerySpy.mockResolvedValue({ output: table })

    const out = await dbQuery({ id: ID, sql: 'SELECT * FROM books' })

    expect(dbQuerySpy).toHaveBeenCalledWith(ID, 'SELECT * FROM books')
    expect(out).toStrictEqual({ stdout: table, stderr: '', exitCode: 0 })
  })

  it('CS-4 dbQuery 带 error → stderr，退出 1', async () => {
    dbQuerySpy.mockResolvedValue({ output: '', error: '[sql_refused] db-query cannot use ATTACH.' })

    const out = await dbQuery({ id: ID, sql: "ATTACH DATABASE '/x' AS y" })

    expect(out).toStrictEqual({
      stdout: '',
      stderr: '[sql_refused] db-query cannot use ATTACH.',
      exitCode: 1
    })
  })

  it.each([
    ['没有 id', { sql: 'SELECT 1' }, 'id required'],
    ['没有 sql', { id: ID }, 'sql required'],
    ['全空白 sql', { id: ID, sql: '  ' }, 'sql required']
  ])('CS-4 %s → 抛，不查询', async (_label, p, message) => {
    await expect(dbQuery(p)).rejects.toThrow(message)
    expect(dbQuerySpy).not.toHaveBeenCalled()
  })

  it('CS-4 没注册的 widget → not found，不查询', async () => {
    getById.mockReturnValue(undefined)
    await expect(dbQuery({ id: ID, sql: 'SELECT 1' })).rejects.toThrow(`widget "${ID}" not found`)
    expect(dbQuerySpy).not.toHaveBeenCalled()
  })
})

/**
 * 桌面 database 工具的询问接线集成测试 —— **真实安全模块**
 * （createSecurityContext + 内置 ask-on-database 策略），只把宿主 provider、
 * 凭据 DAO 与 dbManager 换成可编程实现。
 *
 * 覆盖：可写连接逐条弹询问 / 只读连接零弹窗（含写类 SQL —— 询问层刻意不判读 SQL 文本）、
 * 凭据不存在时不评估、四条响应分支的落地形态，以及 enforceDatabase 的客体属性透传。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { getSessionDecisions, clearSessionDecisions } from '@shuvix/agent-runtime'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

const SESSION_ID = 'ask-on-database-session'
const WORK_DIR = join(tmpdir(), 'shuvix-db-ask')

interface CredentialRow {
  name: string
  dbType: string
  readonly: boolean
}

const state = vi.hoisted(() => ({
  /** 已登记的凭据（dbCredentialDao 的替身数据） */
  credentials: [] as { name: string; dbType: string; readonly: boolean }[],
  autoAllow: false,
  requests: [] as InputRequest[],
  respond: (() => ({ kind: 'ask', allowed: true })) as (
    req: InputRequest
  ) => InputResponse | Promise<InputResponse>,
  /** 是否给工具装配询问通道（DB-7 无通道分支用） */
  withChannel: true,
  /** connectAndQuery 的调用记录与应答 */
  queries: [] as { sessionId: string; credentialName: string; sql: string }[],
  queryResult: 'ok' as string,
  queryError: undefined as string | undefined,
  /** 桌面 wiring 透传给 enforceDatabase 的客体属性（DB-9 断言用） */
  dbObjects: [] as Record<string, unknown>[]
}))

vi.mock('../../services/toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  return {
    TOOL_ABORTED: 'Aborted',
    resolveProjectConfig: () => ({ workingDirectory: WORK_DIR }),
    // 真实评估链（内置 ask-on-database + force-allow 层）；grants/挂起通道来自测试状态。
    // enforceDatabase 额外记录客体属性入参（DB-9 透传断言），再交给真实实现。
    getDesktopSecurityContext: (ctx: { sessionId: string }) => {
      const real = createSecurityContext(
        { kind: 'agent', sessionId: ctx.sessionId, agentKind: 'root' },
        { host: 'desktop' },
        {
          host: 'desktop',
          pathSep: sep,
          getVars: () => ({
            workspace: WORK_DIR,
            botsDir: '/tmp/shuvix-bots',
            toolResultsBase: join(tmpdir(), '.nonexistent-tool-results'),
            skillsDirs: [],
            memoryDirs: [],
            home: join(tmpdir(), '.nonexistent-home'),
            systemDirs: []
          }),
          getSessionGrants: () => ({ autoAllow: state.autoAllow, allowList: [] }),
          requestUserInput: state.withChannel
            ? async (req: InputRequest) => {
                state.requests.push(req)
                return state.respond(req)
              }
            : undefined
        }
      )
      return {
        ...real,
        enforceDatabase: (
          object: Parameters<typeof real.enforceDatabase>[0],
          opts: Parameters<typeof real.enforceDatabase>[1]
        ) => {
          state.dbObjects.push({ ...object })
          return real.enforceDatabase(object, opts)
        }
      }
    }
  }
})
vi.mock('../../dao/dbCredentialDao', () => ({
  dbCredentialDao: {
    findAllNamesWithType: () => state.credentials,
    findByName: (name: string) => state.credentials.find((c) => c.name === name)
  }
}))
vi.mock('../../services/dbManager', () => ({
  dbManager: {
    connectAndQuery: async (sessionId: string, credentialName: string, sql: string) => {
      state.queries.push({ sessionId, credentialName, sql })
      if (state.queryError) throw new Error(state.queryError)
      return state.queryResult
    },
    getConnectionInfo: () => undefined
  }
}))
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { DatabaseTool } from '../database'
import type { ToolContext } from '../../services/toolContext'

const WRITABLE: CredentialRow = { name: 'prod-mysql', dbType: 'mysql', readonly: false }
const READONLY: CredentialRow = { name: 'ro-pg', dbType: 'postgresql', readonly: true }

const SQL = "SELECT id, email\nFROM users\nWHERE created_at > '2024-01-01'"

function makeTool(): DatabaseTool {
  return new DatabaseTool({ sessionId: SESSION_ID } as ToolContext)
}

type Result = Awaited<ReturnType<DatabaseTool['execute']>>

const textOf = (result: Result): string =>
  result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')

beforeEach(() => {
  state.credentials = [WRITABLE, READONLY]
  state.autoAllow = false
  state.requests = []
  state.respond = () => ({ kind: 'ask', allowed: true })
  state.withChannel = true
  state.queries = []
  state.queryResult = 'ok'
  state.queryError = undefined
  state.dbObjects = []
  clearSessionDecisions(SESSION_ID)
})

describe('桌面 database 工具 — 询问接线', () => {
  it('DB-1: 可写凭据 → 恰弹一次带 SQL 原文与描述的询问；允许后按 (sessionId, credential, sql) 查询', async () => {
    const res = await makeTool().execute('t1', {
      credentialName: WRITABLE.name,
      sql: SQL,
      description: '拉一批新注册用户'
    })

    expect(state.requests).toHaveLength(1)
    const req = state.requests[0]
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    expect(req.id).toBe('t1')
    expect(req.toolName).toBe('database')
    expect(req.command).toBe(SQL)
    expect(req.description).toBe('拉一批新注册用户')

    expect(state.queries).toEqual([
      { sessionId: SESSION_ID, credentialName: WRITABLE.name, sql: SQL }
    ])
    expect(res.details).toMatchObject({ type: 'database', action: 'query', success: true })

    // 决策日志确实通着 —— DB-3 的「零日志」才不是空断言
    const logs = getSessionDecisions(SESSION_ID)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      toolName: 'database',
      action: 'execute',
      objectKind: 'database',
      effect: 'ask',
      winning: 'ask-on-database#0',
      userResponse: 'allowed'
    })
  })

  it('DB-2: 只读凭据 → 零弹窗直接查询', async () => {
    const res = await makeTool().execute('t2', { credentialName: READONLY.name, sql: 'SELECT 1' })

    expect(state.requests).toEqual([])
    expect(state.queries).toHaveLength(1)
    expect(res.details).toMatchObject({ success: true })
  })

  it('DB-2b: 只读凭据 + 写类 SQL → 仍零弹窗、SQL 原样下发（询问层刻意不判读 SQL 文本）', async () => {
    const writes = [
      "INSERT INTO users (email) VALUES ('a@example.com')",
      'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'
    ]
    for (const sql of writes) {
      await makeTool().execute('t2b', { credentialName: READONLY.name, sql })
    }

    expect(state.requests).toEqual([])
    expect(state.queries.map((q) => q.sql)).toEqual(writes)
  })

  it('DB-3: 凭据不存在 → 不评估（零弹窗、零决策日志）；查询错误被兜住成 Database error 文本', async () => {
    state.queryError = 'Database credential not found: ghost'

    const res = await makeTool().execute('t3', { credentialName: 'ghost', sql: 'SELECT 1' })

    expect(state.requests).toEqual([])
    expect(state.dbObjects).toEqual([])
    expect(getSessionDecisions(SESSION_ID)).toEqual([])
    // 仍然下发查询：真正可行动的「无此凭据」错误由 dbManager 给出
    expect(state.queries).toHaveLength(1)
    expect(textOf(res)).toBe('Database error: Database credential not found: ghost')
    expect(res.details).toMatchObject({ success: false, credentialName: 'ghost' })
  })

  it('DB-4: 拒绝 → execute 抛错，查询未发生', async () => {
    state.respond = () => ({ kind: 'ask', allowed: false })

    await expect(
      makeTool().execute('t4', { credentialName: WRITABLE.name, sql: SQL })
    ).rejects.toThrow(`User denied ${SQL}`)
    expect(state.queries).toEqual([])
  })

  it('DB-5: 「其它」反馈 → 不抛错，反馈作为正常 tool result 返回，查询未发生', async () => {
    state.respond = () => ({ kind: 'other', text: '先在只读连接上看' })

    const res = await makeTool().execute('t5', { credentialName: WRITABLE.name, sql: SQL })

    expect(textOf(res)).toBe(
      'Query was not executed. User responded with feedback instead:\n先在只读连接上看'
    )
    expect(res.details).toEqual({
      type: 'database',
      action: 'query',
      success: false,
      credentialName: WRITABLE.name
    })
    expect(state.queries).toEqual([])
  })

  it('DB-6: cancel → 抛 Aborted，查询未发生', async () => {
    state.respond = () => ({ kind: 'cancel', reason: 'aborted' })

    await expect(
      makeTool().execute('t6', { credentialName: WRITABLE.name, sql: SQL })
    ).rejects.toThrow('Aborted')
    expect(state.queries).toEqual([])
  })

  it('DB-7: 无 requestUserInput 通道 → fail-closed 拒绝，查询未发生', async () => {
    state.withChannel = false

    await expect(
      makeTool().execute('t7', { credentialName: WRITABLE.name, sql: SQL })
    ).rejects.toThrow(/no way to ask/)
    expect(state.queries).toEqual([])
  })

  it('DB-8: 会话免询问 → 零弹窗直接查询', async () => {
    state.autoAllow = true

    await makeTool().execute('t8', { credentialName: WRITABLE.name, sql: SQL })

    expect(state.requests).toEqual([])
    expect(state.queries).toHaveLength(1)
  })
})

describe('桌面 enforceDatabase 透传', () => {
  it('DB-9: sql/credential/dbType/readonly 逐字段透传；dbType 取自凭据行、readonly 必须是 boolean', async () => {
    await makeTool().execute('p1', { credentialName: WRITABLE.name, sql: SQL })
    await makeTool().execute('p2', { credentialName: READONLY.name, sql: 'SELECT 1' })

    expect(state.dbObjects).toEqual([
      { sql: SQL, credential: WRITABLE.name, dbType: 'mysql', readonly: false },
      { sql: 'SELECT 1', credential: READONLY.name, dbType: 'postgresql', readonly: true }
    ])
    // SQLite 的 0/1 整数若漏到 CEL，`!object.readonly` 会让只读连接反而弹窗
    for (const object of state.dbObjects) {
      expect(typeof object.readonly).toBe('boolean')
    }
  })

  it('DB-10: 预中止的 signal → 抛 Aborted，不评估不弹窗不查询', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      makeTool().execute('p3', { credentialName: WRITABLE.name, sql: SQL }, controller.signal)
    ).rejects.toThrow('Aborted')
    expect(state.dbObjects).toEqual([])
    expect(state.requests).toEqual([])
    expect(state.queries).toEqual([])
  })
})

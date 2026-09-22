/**
 * dbCredentialHandlers —— 设置里改 / 删一条已保存的数据库连接时，打开着的连接怎么办。
 *
 * 打开着的连接是按**旧配置**建的（旧主机、旧账号、旧的只读位）。最要紧的是「改成只读」：
 * 不断开的话，安全门按新读到的「只读」放行（ask-on-database 对只读连接从不询问），语句却跑在
 * 那条旧的可写连接上。所以改和删都要把这个凭据在**所有会话**里的连接断开，下次用到时按新配置重连。
 *
 *   DCH-1  改成只读（真连接池 + 真 PostgreSQL）：旧的可写连接当场关掉；之后的写被拒、行数不变
 *          —— 即便调用方没带上刚读到的只读位，连接池也只能按新配置重连；
 *   DCH-2  改名：断开用的是**改之前**的名字（连接按名字记账）；先写库、再断开，
 *          且等断开落定才回答 —— 设置页收到「成功」时旧连接已经没了；
 *   DCH-3  删除：连同各会话里用它打开着的连接一起断开；
 *   DCH-4  不存在的 id / 新增一条：不断开任何东西。
 *
 * electron 是替身（handle 收进 Map）；DAO 是内存里的一张表；连接池是真的（dbConnections.ts）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbCredential } from '../../dao/types'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  rows: [] as DbCredential[],
  /** DAO 写入与连接池断开的先后（断言顺序用） */
  order: [] as string[]
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// better-sqlite3 进不了 vitest 的 Node 进程 —— 一张内存表，行为与 DbCredentialDao 的公开方法一致
vi.mock('../../dao/dbCredentialDao', () => ({
  dbCredentialDao: {
    findAllSafe: () => state.rows.map(({ password: _pw, ...safe }) => safe),
    findAllNamesWithType: () =>
      state.rows.map(({ name, dbType, readonly }) => ({ name, dbType, readonly })),
    findByName: (name: string) => state.rows.find((r) => r.name === name),
    insert: (params: Partial<DbCredential> & { name: string }) => {
      const id = `id-${params.name}`
      state.rows.push({ ...(params as DbCredential), id, readonly: params.readonly !== false })
      return id
    },
    update: (id: string, fields: Partial<DbCredential>) => {
      state.order.push(`update ${id}`)
      const i = state.rows.findIndex((r) => r.id === id)
      if (i >= 0) state.rows[i] = { ...state.rows[i], ...fields }
    },
    deleteById: (id: string) => {
      state.order.push(`delete ${id}`)
      state.rows = state.rows.filter((r) => r.id !== id)
    }
  }
}))

import { dbManager } from '../../services/builtinMcp/dbConnections'
import { registerDbCredentialHandlers } from '../dbCredentialHandlers'
import {
  startPgliteBridge,
  type PgliteBridge
} from '../../services/builtinMcp/__tests__/pgliteBridge'

registerDbCredentialHandlers()

/** 像渲染端 invoke 那样调一个已注册的处理函数 */
const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({}, ...args)
}

const cred = (name: string, over: Partial<DbCredential> = {}): DbCredential => ({
  id: `id-${name}`,
  name,
  dbType: 'postgresql',
  host: '127.0.0.1',
  port: 5432,
  username: 'u',
  password: 'p',
  database: 'd',
  authType: 'password',
  token: '',
  connStr: '',
  readonly: false,
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
  ...over
})

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function q(sid: string, name: string, sql: string): Promise<string> {
  try {
    return await dbManager.connectAndQuery(sid, name, sql)
  } catch (e) {
    return `THREW: ${e instanceof Error ? e.message : String(e)}`
  }
}

let bridge: PgliteBridge

beforeAll(async () => {
  bridge = await startPgliteBridge()
  await bridge.db.exec('CREATE TABLE items (x int);')
}, 60_000)

afterAll(async () => {
  await bridge?.close()
})

beforeEach(() => {
  state.rows = []
  state.order.length = 0
})

afterEach(async () => {
  for (const sid of ['s1', 's2']) await dbManager.disconnect(sid)
  vi.restoreAllMocks()
})

describe('设置里改了 / 删了一条已保存的连接', () => {
  it('DCH-1 可写改成只读：旧连接当场关掉，之后的写被拒、行数不变（真 PostgreSQL）', async () => {
    state.rows.push(cred('rw', { port: bridge.port, readonly: false }))
    expect(await q('s1', 'rw', 'INSERT INTO items VALUES (1)')).toBe('OK: INSERT, 1 row affected')
    expect(await q('s2', 'rw', 'SELECT count(*)::int AS n FROM items')).toContain('| 1 |')
    await until(() => bridge.log.open === 2, '两个会话各一条连接')

    await expect(invoke('dbCredential:update', { id: 'id-rw', readonly: true })).resolves.toEqual({
      success: true
    })

    // 两个会话的旧可写连接都关了
    expect(dbManager.connectedNames('s1')).toEqual([])
    expect(dbManager.connectedNames('s2')).toEqual([])
    await until(() => bridge.log.open === 0, '旧连接关闭')

    // 这里刻意不带只读位：光靠设置页那一次断开，下次也只能按新配置（只读）重连
    const mark = bridge.log.queries.length
    expect(await q('s1', 'rw', 'INSERT INTO items VALUES (2)')).toBe(
      'THREW: Write operations are not allowed. This connection is in readonly mode. Only SELECT and read-only statements are permitted.'
    )
    expect(
      await q('s1', 'rw', 'WITH x AS (INSERT INTO items VALUES (3) RETURNING x) SELECT * FROM x')
    ).toBe('THREW: cannot execute SELECT in a read-only transaction')
    expect(bridge.log.queries.slice(mark)[0]).toBe('SET default_transaction_read_only = on')
    const r = await bridge.db.query<{ n: number }>('SELECT count(*)::int AS n FROM items')
    expect(r.rows[0].n).toBe(1)
  })

  it('DCH-2 改名：断开用改之前的名字；先写库再断开；断开落定之后才回答', async () => {
    state.rows.push(cred('old-name'))
    let finish!: () => void
    const disconnect = vi
      .spyOn(dbManager, 'disconnectCredential')
      .mockImplementation(async (name: string) => {
        state.order.push(`disconnect ${name}`)
        await new Promise<void>((r) => (finish = r))
      })

    let answered = false
    const pending = Promise.resolve(
      invoke('dbCredential:update', { id: 'id-old-name', name: 'new-name', host: 'db2' })
    ).then((v) => {
      answered = true
      return v
    })
    await until(() => disconnect.mock.calls.length === 1, '断开被调用')
    await new Promise((r) => setTimeout(r, 10))

    expect(disconnect).toHaveBeenCalledWith('old-name')
    // 顺序：先把新配置写进库，再断开 —— 反过来的话，两步之间进来的查询会按旧配置重连
    expect(state.order).toEqual(['update id-old-name', 'disconnect old-name'])
    expect(answered).toBe(false)

    finish()
    await expect(pending).resolves.toEqual({ success: true })
    expect(state.rows[0]).toMatchObject({ name: 'new-name', host: 'db2' })
  })

  it('DCH-5 编辑时密码留空 = 保持原密码（对话框的约定）；填了新密码才换', async () => {
    state.rows.push(cred('keep', { password: 'orig-secret' }))
    vi.spyOn(dbManager, 'disconnectCredential').mockResolvedValue()

    await invoke('dbCredential:update', { id: 'id-keep', host: 'db3', password: '' })
    expect(state.rows[0]).toMatchObject({ host: 'db3', password: 'orig-secret' })

    await invoke('dbCredential:update', { id: 'id-keep', password: 'new-secret' })
    expect(state.rows[0]).toMatchObject({ password: 'new-secret' })
  })

  it('DCH-3 删除：连同这条连接在各会话里打开着的连接一起断开', async () => {
    state.rows.push(cred('gone'), cred('kept'))
    const disconnect = vi
      .spyOn(dbManager, 'disconnectCredential')
      .mockImplementation(async (name: string) => {
        state.order.push(`disconnect ${name}`)
      })

    await expect(invoke('dbCredential:delete', 'id-gone')).resolves.toEqual({ success: true })

    // 名字要在删之前取到（删了就查不到了），断开发生在删之后
    expect(state.order).toEqual(['delete id-gone', 'disconnect gone'])
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(state.rows.map((r) => r.name)).toEqual(['kept'])
  })

  it('DCH-4 不存在的 id、新增一条：不断开任何东西', async () => {
    state.rows.push(cred('a'))
    const disconnect = vi.spyOn(dbManager, 'disconnectCredential')

    await expect(invoke('dbCredential:update', { id: 'id-nope', readonly: true })).resolves.toEqual(
      { success: true }
    )
    await expect(invoke('dbCredential:delete', 'id-nope')).resolves.toEqual({ success: true })
    await invoke('dbCredential:add', {
      name: 'b',
      dbType: 'postgresql',
      host: 'h',
      port: 1,
      username: 'u',
      password: 'p',
      database: 'd'
    })

    expect(disconnect).not.toHaveBeenCalled()
    expect(state.rows.map((r) => r.name)).toEqual(['a', 'b'])
  })
})

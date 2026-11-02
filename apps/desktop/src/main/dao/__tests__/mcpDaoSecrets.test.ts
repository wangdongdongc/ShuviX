/**
 * McpDao —— `mcp_servers.env` / `headers` 落库是密文，经 DAO 读写的都是明文 JSON。
 *
 * 写入时加密、读取时解开；`{}` 原样存（不为它生成密钥，钥匙环可能因此弹框）；这一版之前写下的明文行
 * 不迁移，哪一列下次被写才变密文；解不开的值读成 `{}`，而把这个 `{}` 存回去不覆盖密文 —— 钥匙环恢复后
 * 原值还在；非空值照常覆盖。
 *
 * 在**真的 SQLite**（node:sqlite 内存库 + 全部迁移）和**真的 crypto.ts** 上跑，密钥文件进每条用例自己的
 * 临时目录。crypto.ts 的 `cachedKey` 是模块状态、`installMasterKeyProtector` 不重置它，所以每条用例重新
 * 载入 DAO 与 crypto（`load()`）；同一个目录同一个库上再 `load()` 一次，就是重启。旧行用裸 INSERT 种，
 * 落库的字节用裸 SELECT 读。迁移种下的内置行先删掉，`findAll` 只看得见用例自己写的行。
 *
 *   MS-1   insert 存密文（没装钥匙环 v1，装了 v2），读回原样
 *   MS-2   `{}` 原样存、不生成密钥、不碰钥匙环
 *   MS-3   清空一个读得出的值（密文行、旧明文行）
 *   MS-4   只有字面量 `{}` 例外：`{"K":""}` 照样加密
 *   MS-5   字节级往返（非 ASCII、引号、`$`、64 KB、键序、空白、嵌套）
 *   MS-6   每条读路径都解开两列
 *   MS-7   pick 的形状：只有要的键、不要 env 就不碰钥匙环；id 不存在回 undefined
 *   MS-8   加密失败绝不退回明文：insert 不留行，update 整条不动
 *   MS-9   旧明文行每条路径都读得对，读不写库
 *   MS-10  读旧行不需要密钥
 *   MS-11  写别的字段不动旧明文（字段矩阵）
 *   MS-12  同一矩阵在密文行上：字节不变（不重新加密）
 *   MS-13  写哪列转哪列；原样存回也转
 *   MS-14  解不开读成 `{}`、不抛，每条路径，别的行不受影响
 *   MS-15  解不开时存 `{}`：字节不变
 *   MS-17  恢复：钥匙环拒绝 → 读到空 → 存空 → 钥匙环回来 → 原值还在
 *   MS-18  设置对话框的真实写法：别的字段照写，密文不动
 *   MS-19  两列各判各的
 *   MS-20  非空值覆盖解不开的值
 *   MS-22  v1 / v2 / 明文 / 解不开 / 空串混在一张表里，一次 findAll 全对、按 createdAt 排序
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { MasterKeyProtector } from '../../utils/crypto'
import type { McpDao } from '../mcpDao'
import type { McpServer } from '../types'

const holder = vi.hoisted(() => ({ db: null as unknown, configDir: '' }))

vi.mock('../database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return holder.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (holder.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => holder.db } }
})
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// 密钥文件放进每条用例自己的临时目录（绝不碰 ~/.shuvix）
vi.mock('../../utils/paths', () => ({ getUserConfigDir: () => holder.configDir }))

import { migrations } from '../migrations'

type Crypto = typeof import('../../utils/crypto')
type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>
type SpiedProtector = {
  [K in keyof MasterKeyProtector]: Mock<MasterKeyProtector[K]>
}

const V1 = '$SHUVIX_ENC$v1$'
const V2 = '$SHUVIX_ENC$v2$'
const ID = 'srv-1'
const NAME = 'srv-one'
const ENV = '{"TOKEN":"sk-env"}'
const HEADERS = '{"Authorization":"Bearer sk-h"}'
const LEGACY_ENV = '{"TOKEN":"legacy-env"}'
const LEGACY_HEADERS = '{"Authorization":"Bearer legacy-h"}'
const T0 = 1_000
const T1 = 2_000

let dao: McpDao
let crypto: Crypto

/** 载入一份新的 DAO + crypto（模块状态全新）；目录和库不变时等于重启 */
async function load(): Promise<void> {
  vi.resetModules()
  crypto = await import('../../utils/crypto')
  dao = (await import('../mcpDao')).mcpDao
}

const db = (): DatabaseSync => holder.db as DatabaseSync
const keyFile = (): string => join(holder.configDir, '.session-state')
const v2KeyFile = (): string => join(holder.configDir, '.session-state-v2')

/** 一行的全部字节（裸 SELECT，不经 DAO） */
const raw = (id = ID): Row => db().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row

const rowCount = (): number =>
  (db().prepare('SELECT COUNT(*) AS n FROM mcp_servers').get() as { n: number }).n

/** 过 DAO 的写法 */
const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: ID,
  name: NAME,
  type: 'stdio',
  command: 'npx',
  args: '[]',
  env: ENV,
  url: '',
  headers: HEADERS,
  metadata: '{}',
  isEnabled: 1,
  isBuiltin: 0,
  cachedTools: '[]',
  createdAt: T0,
  updatedAt: T0,
  ...over
})

/** 裸 INSERT：这一版之前写下的行、或手里已有的密文 */
function insertRaw(over: Partial<McpServer> = {}): void {
  const row = server({ env: LEGACY_ENV, headers: LEGACY_HEADERS, ...over })
  const cols = Object.keys(row)
  db()
    .prepare(`INSERT INTO mcp_servers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join()})`)
    .run(...(Object.values(row) as Array<string | number>))
}

/** 假的钥匙环（同 utils/__tests__/crypto.test.ts）：掩码是固定的，新装一个就是「同一个钥匙环回来了」 */
function fakeProtector(opts: { deny?: boolean } = {}): SpiedProtector {
  const mask = (b: Buffer): Buffer => Buffer.from(b.map((x) => x ^ 0x5a))
  return {
    available: vi.fn(() => true),
    protect: vi.fn((key: Buffer) => Buffer.concat([Buffer.from('KC1'), mask(key)])),
    unprotect: vi.fn((blob: Buffer) => {
      if (opts.deny) throw new Error('User canceled the keychain prompt')
      return mask(blob.subarray(3))
    })
  }
}

/** 一行经每条读路径读出来的样子 */
function readsOf(id = ID, name = raw(id).name as string): Array<[string, Partial<McpServer>?]> {
  return [
    ['findAll', dao.findAll().find((s) => s.id === id)],
    ['findEnabled', dao.findEnabled().find((s) => s.id === id)],
    ['findById', dao.findById(id)],
    ['findByName', dao.findByName(name)],
    ['pick', dao.pick(id, ['env', 'headers'])]
  ]
}

function expectEveryRead(env: string, headers: string, id = ID): void {
  for (const [path, row] of readsOf(id)) {
    expect(row, path).toBeDefined()
    expect(row!.env, path).toBe(env)
    expect(row!.headers, path).toBe(headers)
  }
}

/** 造一行两列都解不开的值（每个原因各一种），调用后 raw(ID) 就是那行密文 */
const UNREADABLE_CAUSES: Array<[string, () => Promise<void>]> = [
  [
    'v2 + 钥匙环拒绝',
    async () => {
      crypto.installMasterKeyProtector(fakeProtector())
      dao.insert(server())
      expect(raw().env).toMatch(/^\$SHUVIX_ENC\$v2\$/)
      crypto.installMasterKeyProtector(fakeProtector({ deny: true }))
    }
  ],
  [
    'v2 + 没装钥匙环',
    async () => {
      crypto.installMasterKeyProtector(fakeProtector())
      dao.insert(server())
      expect(raw().env).toMatch(/^\$SHUVIX_ENC\$v2\$/)
      crypto.installMasterKeyProtector(null)
    }
  ],
  [
    'v1 + 换了密钥文件',
    async () => {
      dao.insert(server())
      expect(raw().env).toMatch(/^\$SHUVIX_ENC\$v1\$/)
      writeFileSync(keyFile(), randomBytes(32))
      await load()
    }
  ],
  [
    '截断的 v1 密文',
    async () => {
      insertRaw({ env: `${V1}abc`, headers: `${V1}abc` })
    }
  ]
]

/** 写别的字段的矩阵：[写法, 改到的列, 改成的值, updatedAt 是否前进] */
const OTHER_FIELD_WRITES: Array<[string, (id: string) => void, string, string | number, boolean]> =
  [
    ['name', (id) => dao.update(id, { name: 'renamed' }), 'name', 'renamed', true],
    ['type', (id) => dao.update(id, { type: 'http' }), 'type', 'http', true],
    ['command', (id) => dao.update(id, { command: 'uvx' }), 'command', 'uvx', true],
    ['args', (id) => dao.update(id, { args: '["-y"]' }), 'args', '["-y"]', true],
    ['url', (id) => dao.update(id, { url: 'https://n.example' }), 'url', 'https://n.example', true],
    ['isEnabled', (id) => dao.update(id, { isEnabled: 0 }), 'isEnabled', 0, true],
    [
      'updateCachedTools',
      (id) => dao.updateCachedTools(id, '[{"name":"t"}]'),
      'cachedTools',
      '[{"name":"t"}]',
      false
    ]
  ]

function expectOtherFieldWrite(
  write: (id: string) => void,
  column: string,
  value: string | number,
  movesUpdatedAt: boolean
): void {
  const before = raw()
  vi.setSystemTime(T1)
  write(ID)
  const after = raw()
  expect(after[column]).toBe(value)
  expect(after.env).toBe(before.env)
  expect(after.headers).toBe(before.headers)
  expect(after.updatedAt).toBe(movesUpdatedAt ? T1 : before.updatedAt)
}

beforeEach(async () => {
  holder.configDir = mkdtempSync(join(tmpdir(), 'shuvix-mcp-dao-test-'))
  delete process.env.SHUVIX_ENCRYPTION
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  fresh.exec('DELETE FROM mcp_servers')
  holder.db = fresh
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  await load()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(holder.configDir, { recursive: true, force: true })
  delete process.env.SHUVIX_ENCRYPTION
})

describe('写入 —— 落库是密文', () => {
  it.each<[string, string, () => void]>([
    ['没装钥匙环', V1, () => {}],
    ['装了钥匙环', V2, () => crypto.installMasterKeyProtector(fakeProtector())]
  ])('MS-1 %s：两列都存成 %s 开头、不含明文，读回原样', (_label, prefix, arrange) => {
    arrange()
    dao.insert(server())
    const { env, headers } = raw() as { env: string; headers: string }
    expect(env.startsWith(prefix)).toBe(true)
    expect(headers.startsWith(prefix)).toBe(true)
    expect(env).not.toContain('sk-env')
    expect(headers).not.toContain('sk-h')
    expect(dao.findById(ID)).toMatchObject({ env: ENV, headers: HEADERS })
  })

  it('MS-2 `{}` 原样存、读回 `{}`：不生成任何密钥文件，也不碰钥匙环', () => {
    const protector = fakeProtector()
    crypto.installMasterKeyProtector(protector)

    dao.insert(server({ env: '{}', headers: '{}' }))
    dao.update(ID, { env: '{}', headers: '{}' })
    expect(raw()).toMatchObject({ env: '{}', headers: '{}' })

    expect(dao.findAll()[0]).toMatchObject({ env: '{}', headers: '{}' })
    expect(dao.findById(ID)).toMatchObject({ env: '{}', headers: '{}' })
    expect(dao.pick(ID, ['env', 'headers'])).toEqual({ env: '{}', headers: '{}' })

    expect(existsSync(keyFile())).toBe(false)
    expect(existsSync(v2KeyFile())).toBe(false)
    expect(protector.available).not.toHaveBeenCalled()
    expect(protector.protect).not.toHaveBeenCalled()
    expect(protector.unprotect).not.toHaveBeenCalled()
  })

  it.each<[string, () => void]>([
    ['密文行', () => dao.insert(server())],
    ['旧明文行', () => insertRaw()]
  ])('MS-3 清空一个读得出的值（%s）：库里成 `{}`、读回 `{}`、updatedAt 前进', (_label, seed) => {
    seed()
    const headersBefore = raw().headers
    vi.setSystemTime(T1)
    dao.update(ID, { env: '{}' })
    expect(raw().env).toBe('{}')
    expect(raw().headers).toBe(headersBefore)
    expect(raw().updatedAt).toBe(T1)
    expect(dao.findById(ID)!.env).toBe('{}')
  })

  it('MS-4 只有字面量 `{}` 例外：`{"K":""}` 写在读得出的行上照样是密文，读回原样', () => {
    dao.insert(server())
    dao.update(ID, { env: '{"K":""}' })
    expect(String(raw().env).startsWith(V1)).toBe(true)
    expect(dao.findById(ID)!.env).toBe('{"K":""}')
  })

  it.each<[string, string]>([
    ['非 ASCII', '{"K":"密钥 トークン 🔑"}'],
    ['引号与反斜杠', '{"K":"a\\"b\'c\\\\d"}'],
    ['美元符', '{"K":"$HOME $$ $SHUVIX_ENC$v1$ {{TOKEN}}"}'],
    ['64 KB', JSON.stringify({ K: 'x'.repeat(64 * 1024) })],
    ['键序', '{"b":"1","a":"2"}'],
    ['空白', '{ "a": "1" }'],
    ['值里套着 {}', '{"A":"{}"}']
  ])('MS-5 字节级往返：%s', (_label, value) => {
    dao.insert(server({ env: value, headers: value }))
    expect(String(raw().env).startsWith(V1)).toBe(true)
    expect(dao.findById(ID)).toMatchObject({ env: value, headers: value })

    dao.update(ID, { env: '{"other":"1"}', headers: '{"other":"1"}' })
    dao.update(ID, { env: value, headers: value })
    expect(String(raw().headers).startsWith(V1)).toBe(true)
    expect(dao.findById(ID)).toMatchObject({ env: value, headers: value })
  })
})

describe('读取', () => {
  it('MS-6 findAll / findEnabled / findById / findByName / pick 都解开两列；findEnabled 仍不含停用的行', () => {
    dao.insert(server())
    dao.insert(
      server({
        id: 'srv-off',
        name: 'srv-off',
        isEnabled: 0,
        env: '{"OFF":"1"}',
        headers: '{"X-Off":"1"}',
        createdAt: T0 + 1
      })
    )
    expectEveryRead(ENV, HEADERS)

    expect(dao.findEnabled().map((s) => s.id)).toEqual([ID])
    expect(dao.findAll().map((s) => [s.id, s.env, s.headers])).toEqual([
      [ID, ENV, HEADERS],
      ['srv-off', '{"OFF":"1"}', '{"X-Off":"1"}']
    ])
    expect(dao.findById('srv-off')).toMatchObject({ env: '{"OFF":"1"}', headers: '{"X-Off":"1"}' })
    expect(dao.findByName('srv-off')).toMatchObject({ env: '{"OFF":"1"}' })
    expect(dao.pick('srv-off', ['env', 'headers'])).toEqual({
      env: '{"OFF":"1"}',
      headers: '{"X-Off":"1"}'
    })
  })

  it('MS-7 pick 只回要的键：不要 env / headers 就不碰钥匙环；只要 env 就没有 headers', () => {
    crypto.installMasterKeyProtector(fakeProtector())
    dao.insert(server())
    expect(String(raw().env).startsWith(V2)).toBe(true)
    const protector = fakeProtector()
    crypto.installMasterKeyProtector(protector)

    const plain = dao.pick(ID, ['isBuiltin', 'name'])
    expect(plain).toEqual({ isBuiltin: 0, name: NAME })
    expect(Object.keys(plain!).sort()).toEqual(['isBuiltin', 'name'])
    expect(protector.unprotect).not.toHaveBeenCalled()

    const onlyEnv = dao.pick(ID, ['env'])
    expect(Object.keys(onlyEnv!)).toEqual(['env'])
    expect(onlyEnv!.env).toBe(ENV)
    // 对照：真要读密文时钥匙环确实会被用到（上面的「没调用」不是因为这个替身没接上）
    expect(protector.unprotect).toHaveBeenCalledTimes(1)
  })

  it('MS-7b id / 名字不存在：pick、findById、findByName 回 undefined，不是 `{}`', () => {
    expect(dao.pick('nope', ['env'])).toBeUndefined()
    expect(dao.pick('nope', ['env', 'headers'])).toBeUndefined()
    expect(dao.findById('nope')).toBeUndefined()
    expect(dao.findByName('nope')).toBeUndefined()
  })
})

describe('加密失败', () => {
  /** 长度不对的密钥文件：`encrypt` 抛错（这个 dir 里没有别的密钥可退） */
  const breakKey = (): void => writeFileSync(keyFile(), Buffer.alloc(5))

  it.each<[string, Partial<McpServer>]>([
    ['env', { env: ENV, headers: '{}' }],
    ['headers', { env: '{}', headers: HEADERS }]
  ])('MS-8 insert（只有 %s 有值）抛错，一行不写', (_label, over) => {
    breakKey()
    expect(() => dao.insert(server(over))).toThrow()
    expect(rowCount()).toBe(0)
  })

  it.each<[string, Partial<McpServer>]>([
    ['env', { env: '{"A":"b"}' }],
    ['headers', { headers: '{"A":"b"}' }]
  ])('MS-8 update（%s）抛错：名字、两列、updatedAt 都不动，绝不退回明文', (_label, fields) => {
    insertRaw()
    breakKey()
    const before = raw()
    vi.setSystemTime(T1)
    expect(() => dao.update(ID, { name: 'x', ...fields })).toThrow()
    expect(raw()).toEqual(before)
  })
})

describe('这一版之前写下的明文行', () => {
  it('MS-9 每条读路径都读得对，读完库里一个字节不变', () => {
    insertRaw()
    const before = raw()
    expectEveryRead(LEGACY_ENV, LEGACY_HEADERS)
    expect(raw()).toEqual(before)
  })

  it('MS-10 读旧行不需要密钥：不生成密钥文件，也不碰钥匙环', () => {
    const protector = fakeProtector()
    crypto.installMasterKeyProtector(protector)
    insertRaw()

    expectEveryRead(LEGACY_ENV, LEGACY_HEADERS)

    expect(existsSync(keyFile())).toBe(false)
    expect(existsSync(v2KeyFile())).toBe(false)
    expect(protector.available).not.toHaveBeenCalled()
    expect(protector.unprotect).not.toHaveBeenCalled()
  })

  it.each(OTHER_FIELD_WRITES)(
    'MS-11 写 %s：那一列变了，env / headers 还是原来的明文字节',
    (_label, write, column, value, movesUpdatedAt) => {
      insertRaw()
      expectOtherFieldWrite(write, column, value, movesUpdatedAt)
      expect(raw()).toMatchObject({ env: LEGACY_ENV, headers: LEGACY_HEADERS })
    }
  )

  it('MS-13 写哪列转哪列：另一列还是原来的明文字节，两列都读得对', () => {
    insertRaw()

    dao.update(ID, { env: ENV })
    expect(String(raw().env).startsWith(V1)).toBe(true)
    expect(raw().env).not.toContain('sk-env')
    expect(raw().headers).toBe(LEGACY_HEADERS)
    expect(dao.findById(ID)).toMatchObject({ env: ENV, headers: LEGACY_HEADERS })

    dao.update(ID, { headers: HEADERS })
    expect(String(raw().headers).startsWith(V1)).toBe(true)
    expect(raw().headers).not.toContain('sk-h')
    expect(dao.findById(ID)).toMatchObject({ env: ENV, headers: HEADERS })
  })

  it('MS-13b 把读到的值原样存回去（对话框不改就保存）也会转成密文', () => {
    insertRaw()
    const shown = dao.findById(ID)!
    dao.update(ID, { env: shown.env, headers: shown.headers })
    expect(String(raw().env).startsWith(V1)).toBe(true)
    expect(String(raw().headers).startsWith(V1)).toBe(true)
    expect(raw().env).not.toContain('legacy-env')
    expect(raw().headers).not.toContain('legacy-h')
    expect(dao.findById(ID)).toMatchObject({ env: LEGACY_ENV, headers: LEGACY_HEADERS })
  })
})

describe('已是密文的行', () => {
  it.each(OTHER_FIELD_WRITES)(
    'MS-12 写 %s：那一列变了，密文字节不变（不重新加密）',
    (_label, write, column, value, movesUpdatedAt) => {
      dao.insert(server())
      expect(String(raw().env).startsWith(V1)).toBe(true)
      expectOtherFieldWrite(write, column, value, movesUpdatedAt)
      expect(dao.findById(ID)).toMatchObject({ env: ENV, headers: HEADERS })
    }
  )
})

describe('解不开的值', () => {
  it.each(UNREADABLE_CAUSES)(
    'MS-14 %s：每条读路径都读成 `{}`、不抛，别的行不受影响',
    async (_label, makeUnreadable) => {
      insertRaw({
        id: 'other',
        name: 'other',
        env: LEGACY_ENV,
        headers: LEGACY_HEADERS,
        createdAt: T0 + 1
      })
      await makeUnreadable()

      expectEveryRead('{}', '{}')
      expectEveryRead(LEGACY_ENV, LEGACY_HEADERS, 'other')
      expect(dao.findAll().map((s) => s.id)).toEqual([ID, 'other'])
    }
  )

  it.each(UNREADABLE_CAUSES)('MS-15 %s：存 `{}`，密文字节不变', async (_label, makeUnreadable) => {
    await makeUnreadable()
    const { env, headers } = raw()
    expect(String(env).startsWith('$SHUVIX_ENC$')).toBe(true)

    dao.update(ID, { env: '{}', headers: '{}' })

    expect(raw().env).toBe(env)
    expect(raw().headers).toBe(headers)
  })

  it('MS-17 恢复：钥匙环拒绝时读到空、存空，钥匙环回来后原值还在', () => {
    crypto.installMasterKeyProtector(fakeProtector())
    dao.insert(server())

    crypto.installMasterKeyProtector(fakeProtector({ deny: true }))
    const shown = dao.findById(ID)!
    expect(shown).toMatchObject({ env: '{}', headers: '{}' })
    dao.update(ID, { env: shown.env, headers: shown.headers })

    crypto.installMasterKeyProtector(fakeProtector())
    expect(dao.findById(ID)).toMatchObject({ env: ENV, headers: HEADERS })
  })

  it('MS-18 设置对话框的真实写法：别的字段照写、updatedAt 前进，密文不动', () => {
    crypto.installMasterKeyProtector(fakeProtector())
    dao.insert(server())
    crypto.installMasterKeyProtector(fakeProtector({ deny: true }))
    const { env, headers } = raw()
    vi.setSystemTime(T1)

    dao.update(ID, { name: 'renamed', url: 'u', isEnabled: 0, env: '{}', headers: '{}' })

    expect(raw()).toMatchObject({
      name: 'renamed',
      url: 'u',
      isEnabled: 0,
      updatedAt: T1,
      env,
      headers
    })
  })

  it('MS-19 两列各判各的：env 解不开、headers 读得出，存 `{}`/`{}` → env 留着，headers 清空', () => {
    crypto.installMasterKeyProtector(fakeProtector())
    dao.insert(server({ headers: '{}' }))
    const { env } = raw()
    expect(String(env).startsWith(V2)).toBe(true)
    // 没装钥匙环时写下的是 v1：钥匙环再拒绝，它照样读得出
    crypto.installMasterKeyProtector(null)
    dao.update(ID, { headers: HEADERS })
    expect(String(raw().headers).startsWith(V1)).toBe(true)
    crypto.installMasterKeyProtector(fakeProtector({ deny: true }))
    expect(dao.findById(ID)).toMatchObject({ env: '{}', headers: HEADERS })

    dao.update(ID, { env: '{}', headers: '{}' })

    expect(raw().env).toBe(env)
    expect(raw().headers).toBe('{}')
    crypto.installMasterKeyProtector(fakeProtector())
    expect(dao.findById(ID)).toMatchObject({ env: ENV, headers: '{}' })
  })

  it('MS-20 非空值覆盖解不开的值：当场读得到新值，钥匙环回来后仍是新值', () => {
    crypto.installMasterKeyProtector(fakeProtector())
    dao.insert(server())
    crypto.installMasterKeyProtector(fakeProtector({ deny: true }))
    const retyped = '{"TOKEN":"retyped"}'

    dao.update(ID, { env: retyped })
    expect(dao.findById(ID)!.env).toBe(retyped)

    crypto.installMasterKeyProtector(fakeProtector())
    expect(dao.findById(ID)!.env).toBe(retyped)
  })
})

describe('混在一张表里', () => {
  it('MS-22 v1 / v2 / 明文 / 解不开 / 空串：一次 findAll 全对，按 createdAt 排序', () => {
    const v1Value = '{"K":"one"}'
    const v2Value = '{"K":"two"}'
    const plainValue = '{"K":"plain"}'

    const v1Cipher = crypto.encrypt(v1Value)
    expect(v1Cipher.startsWith(V1)).toBe(true)
    // GCM 校验不过：换一个 v1 同钥的密文，把最后一位改掉
    const lastHex = v1Cipher.slice(-1)
    const tampered = v1Cipher.slice(0, -1) + (lastHex === '0' ? '1' : '0')
    crypto.installMasterKeyProtector(fakeProtector())
    const v2Cipher = crypto.encrypt(v2Value)
    expect(v2Cipher.startsWith(V2)).toBe(true)

    const seed = (id: string, stored: string, createdAt: number): void =>
      insertRaw({ id, name: id, env: stored, headers: stored, createdAt, updatedAt: createdAt })
    seed('plain', plainValue, 50)
    seed('v1', v1Cipher, 30)
    seed('empty', '', 40)
    seed('v2', v2Cipher, 10)
    seed('unreadable', tampered, 20)

    expect(dao.findAll().map((s) => [s.id, s.env, s.headers])).toEqual([
      ['v2', v2Value, v2Value],
      ['unreadable', '{}', '{}'],
      ['v1', v1Value, v1Value],
      ['empty', '{}', '{}'],
      ['plain', plainValue, plainValue]
    ])
  })
})

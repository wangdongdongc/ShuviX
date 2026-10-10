/**
 * MdAttrDao —— md 扩展元数据表 `md_attrs` 的纯数据访问（迁移 v31，设计 docs/md-metadata-design.md）。
 *
 * DAO 只守一条数据契约：value 必须是 JSON 能原样表达的值（JSON.stringify 会把 NaN 悄悄写成 null，
 * 存进去就不是原来的值了）；ns 必须在词表里（写得进去却读不回来，不如当场拒绝）。读的一侧跳过
 * 手改数据库造出来的坏行，而不是让一行坏数据拖垮整张表。「id 已在文件里」「键在白名单内」归上层。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 sessionDaoChromeTab.test）：按顺序跑全部迁移建表，
 * BaseDao 换成直接在这个库上 prepare。updatedAt 由 Date.now() 给，用假时钟钉住。
 *
 *   MA-1   upsert 一个键：读回整行（scope 缺省 ''、value 解析回来）；库里存的是 JSON 文本
 *   MA-2   同键再写：仍是一行，值替换、updatedAt 刷新
 *   MA-3   scope / ns 不同是不同的行；findByObject 全取，findAll 覆盖多个对象
 *   MA-4   JSON 往返：字符串（含像 JSON 的字符串）、数字、布尔、null、嵌套数组与对象
 *   MA-5   JSON 表达不了的值：抛错（点名键）、一行不写；已有的行值与 updatedAt 都不动
 *   MA-6   手改数据库造出的坏行（value 不是 JSON / 空串、ns 不认识）读时跳过，好行照常
 *   MA-7   delete：删到 → true，没有匹配（含 ns 不对）→ false；不写 scope 只删 '' 那一行
 *   MA-8   deleteByObject：跨 scope / ns 全删、回删掉的行数；别的对象不动；未知 id → 0
 *   MA-9   空结果都是 []
 *   MA-10  ns 不在词表里：抛错、一行不写
 *   MA-11  objectId 原样存（DAO 不归一）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { MdAttrNamespace } from '@shuvix/chat-protocol/mdMeta'

const holder = vi.hoisted(() => ({ db: null as unknown }))

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

import { migrations } from '../migrations'
import { mdAttrDao } from '../mdAttrDao'
import type { MdAttr } from '../types'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

const U = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const W = '0199d3a2-0000-7000-8000-000000000000'

const db = (): DatabaseSync => holder.db as DatabaseSync
const rawRows = (): Row[] =>
  db().prepare('SELECT * FROM md_attrs ORDER BY objectId, scope, ns, key').all() as Row[]
const count = (): number => rawRows().length

/** 读出的元数据按主键排序（DAO 不承诺顺序） */
const sorted = (attrs: MdAttr[]): MdAttr[] =>
  [...attrs].sort((a, b) =>
    `${a.objectId}|${a.scope}|${a.ns}|${a.key}`.localeCompare(
      `${b.objectId}|${b.scope}|${b.ns}|${b.key}`
    )
  )

function insertRaw(row: Row): void {
  const keys = Object.keys(row)
  db()
    .prepare(`INSERT INTO md_attrs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...(Object.values(row) as Array<string | number | null>))
}

beforeEach(() => {
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  holder.db = fresh
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MdAttrDao', () => {
  it('MA-1 upsert 一个键：读回整行（scope 缺省 ""）；库里存的是 JSON 文本', () => {
    mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'shuvix-model', value: 'openai/gpt-5' })
    expect(mdAttrDao.findByObject(U)).toEqual([
      {
        objectId: U,
        scope: '',
        ns: 'fm',
        key: 'shuvix-model',
        value: 'openai/gpt-5',
        updatedAt: 1_000
      }
    ])
    const raw = db()
      .prepare('SELECT value, json_valid(value) AS ok FROM md_attrs WHERE objectId = ?')
      .get(U) as Row
    expect(raw.value).toBe('"openai/gpt-5"')
    expect(raw.ok).toBe(1)
  })

  it('MA-2 同键再写：仍是一行，值替换、updatedAt 刷新', () => {
    mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'shuvix-model', value: 'openai/gpt-5' })
    vi.setSystemTime(2_000)
    mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'shuvix-model', value: 'anthropic/claude' })
    expect(mdAttrDao.findByObject(U)).toEqual([
      {
        objectId: U,
        scope: '',
        ns: 'fm',
        key: 'shuvix-model',
        value: 'anthropic/claude',
        updatedAt: 2_000
      }
    ])
    expect(count()).toBe(1)
  })

  it('MA-3 scope / ns 不同是不同的行；findByObject 全取，findAll 覆盖多个对象', () => {
    mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'k', value: 1 })
    mdAttrDao.upsert({ objectId: U, scope: 'project:p1', ns: 'fm', key: 'k', value: 2 })
    mdAttrDao.upsert({ objectId: U, ns: 'meta', key: 'k', value: 3 })
    mdAttrDao.upsert({ objectId: W, ns: 'fm', key: 'k', value: 4 })

    const mine = sorted(mdAttrDao.findByObject(U)).map((a) => [a.scope, a.ns, a.key, a.value])
    expect(mine).toEqual([
      ['', 'fm', 'k', 1],
      ['', 'meta', 'k', 3],
      ['project:p1', 'fm', 'k', 2]
    ])
    const all = sorted(mdAttrDao.findAll()).map((a) => [a.objectId, a.scope, a.ns, a.value])
    expect(all).toEqual([
      [W, '', 'fm', 4],
      [U, '', 'fm', 1],
      [U, '', 'meta', 3],
      [U, 'project:p1', 'fm', 2]
    ])
  })

  it.each<[string, unknown]>([
    ['空串', ''],
    ['emoji', '🔎 搜索'],
    ['引号与反斜杠', 'a "quoted" \\ value'],
    ['换行', 'line 1\nline 2'],
    ['像 JSON 的字符串', '{"a":1}'],
    ['整数', 42],
    ['小数', 3.25],
    ['负数', -7],
    ['true', true],
    ['false', false],
    ['null', null],
    ['混合数组', [1, 'two', null, false, [3], { a: 'b' }]],
    ['四层对象', { a: { b: { c: { d: ['x', 1] } } } }]
  ])('MA-4 JSON 往返：%s', (_label, value) => {
    mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'k', value })
    const [attr] = mdAttrDao.findByObject(U)
    expect(attr.value).toEqual(value)
    expect(typeof attr.value).toBe(typeof value)
  })

  it('MA-4b null 也是一行：存成 JSON 的 null 文本', () => {
    mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'k', value: null })
    expect(rawRows().map((r) => r.value)).toEqual(['null'])
    expect(mdAttrDao.findByObject(U)).toHaveLength(1)
  })

  it.each<[string, unknown]>([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['undefined', undefined],
    ['函数', () => 1],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['Set', new Set()],
    ['bigint', 10n],
    [
      '类实例',
      new (class Box {
        v = 1
      })()
    ],
    ['深处有 NaN', { a: [1, NaN] }],
    ['对象值为 undefined', { a: undefined }],
    // eslint-disable-next-line no-sparse-arrays
    ['稀疏数组', [1, , 3]]
  ])('MA-5 JSON 表达不了（%s）：抛错点名键、一行不写；已有的行原样', (_label, value) => {
    mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'keep', value: 'old' })
    vi.setSystemTime(5_000)

    expect(() => mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'bad-key', value })).toThrow(
      /bad-key/
    )
    expect(() => mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'keep', value })).toThrow(/keep/)

    expect(count()).toBe(1)
    expect(mdAttrDao.findByObject(U)).toEqual([
      { objectId: U, scope: '', ns: 'fm', key: 'keep', value: 'old', updatedAt: 1_000 }
    ])
  })

  it('MA-6 手改数据库造出的坏行读时跳过：value 不是 JSON / 空串、ns 不认识；好行照常', () => {
    mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'good', value: 'ok' })
    insertRaw({
      objectId: U,
      scope: '',
      ns: 'fm',
      key: 'not-json',
      value: 'not json',
      updatedAt: 1
    })
    insertRaw({ objectId: U, scope: '', ns: 'fm', key: 'empty', value: '', updatedAt: 1 })
    insertRaw({ objectId: U, scope: '', ns: 'bogus', key: 'k', value: '1', updatedAt: 1 })
    expect(count()).toBe(4)

    expect(mdAttrDao.findByObject(U).map((a) => a.key)).toEqual(['good'])
    expect(mdAttrDao.findAll().map((a) => a.key)).toEqual(['good'])
  })

  it('MA-7 delete：删到 → true；没有匹配（含 ns 不对）→ false；不写 scope 只删 "" 那一行', () => {
    mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'k', value: 1 })
    mdAttrDao.upsert({ objectId: U, scope: 'project:p1', ns: 'fm', key: 'k', value: 2 })

    expect(mdAttrDao.delete({ objectId: U, ns: 'meta', key: 'k' })).toBe(false)
    expect(mdAttrDao.delete({ objectId: U, ns: 'fm', key: 'other' })).toBe(false)
    expect(mdAttrDao.delete({ objectId: W, ns: 'fm', key: 'k' })).toBe(false)
    expect(count()).toBe(2)

    expect(mdAttrDao.delete({ objectId: U, ns: 'fm', key: 'k' })).toBe(true)
    expect(mdAttrDao.findByObject(U).map((a) => [a.scope, a.value])).toEqual([['project:p1', 2]])
    expect(mdAttrDao.delete({ objectId: U, ns: 'fm', key: 'k' })).toBe(false)

    expect(mdAttrDao.delete({ objectId: U, scope: 'project:p1', ns: 'fm', key: 'k' })).toBe(true)
    expect(count()).toBe(0)
  })

  it('MA-8 deleteByObject：跨 scope / ns 全删、回删掉的行数；别的对象不动；未知 id → 0', () => {
    mdAttrDao.upsert({ objectId: U, ns: 'fm', key: 'a', value: 1 })
    mdAttrDao.upsert({ objectId: U, ns: 'meta', key: 'b', value: 2 })
    mdAttrDao.upsert({ objectId: U, scope: 'project:p1', ns: 'fm', key: 'a', value: 3 })
    mdAttrDao.upsert({ objectId: W, ns: 'fm', key: 'a', value: 4 })

    expect(mdAttrDao.deleteByObject(U)).toBe(3)
    expect(mdAttrDao.findByObject(U)).toEqual([])
    expect(mdAttrDao.findAll().map((a) => [a.objectId, a.value])).toEqual([[W, 4]])
    expect(mdAttrDao.deleteByObject('agent:builtin:nobody')).toBe(0)
  })

  it('MA-9 空结果都是 []', () => {
    expect(mdAttrDao.findAll()).toEqual([])
    expect(mdAttrDao.findByObject(U)).toEqual([])
    expect(mdAttrDao.deleteByObject(U)).toBe(0)
  })

  it('MA-10 ns 不在词表里：抛错、一行不写', () => {
    expect(() =>
      mdAttrDao.upsert({ objectId: U, ns: 'bogus' as MdAttrNamespace, key: 'k', value: 1 })
    ).toThrow(/bogus/)
    expect(count()).toBe(0)
  })

  it('MA-11 objectId 原样存：大写 UUID、内置 id 都不归一', () => {
    const upper = U.toUpperCase()
    mdAttrDao.upsert({ objectId: upper, ns: 'fm', key: 'k', value: 1 })
    mdAttrDao.upsert({ objectId: 'agent:builtin:Explore', ns: 'fm', key: 'k', value: 2 })
    expect(mdAttrDao.findByObject(U)).toEqual([])
    expect(mdAttrDao.findByObject(upper).map((a) => a.objectId)).toEqual([upper])
    expect(mdAttrDao.findByObject('agent:builtin:Explore')).toHaveLength(1)
    expect(
      rawRows()
        .map((r) => r.objectId)
        .sort()
    ).toEqual([upper, 'agent:builtin:Explore'].sort())
  })
})

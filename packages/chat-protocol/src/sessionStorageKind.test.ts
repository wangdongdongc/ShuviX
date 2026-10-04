/**
 * 会话存储类型的契约模块 —— `sessionStorageKind.ts`。
 *
 * 这张表是「永不迁移会话数据」的分流依据：一个值一旦落过库就永远指那一种格式，所以表只追加、
 * 不改名、不删除。这里钉的是那几条不能悄悄变的事：已发布值的位置与拼写、当前版本用哪一种、
 * 认不认识一个值（更新版本写下的值在旧版本里必须不认识）、缺省怎么读。
 *
 *   SK-1  已发布的两个值按序在表头，且表里没有重复
 *   SK-2  HARNESS_V3_JSONL / DURABLE_SQLITE_1 的拼写；CURRENT 是表里的成员；切换（P1-01）之后 CURRENT 是 durable
 *   SK-3  isKnownStorageKind：成员为真；相近拼写 / 大小写 / 空串 / 非字符串一律为假
 *   SK-4  storageKindOf：缺省（无键 / undefined / null）读成 v3；已知值原样；不认识的值原样交回
 */
import { describe, expect, it } from 'vitest'
import {
  CURRENT_SESSION_STORAGE_KIND,
  DURABLE_SQLITE_1,
  HARNESS_V3_JSONL,
  SESSION_STORAGE_KINDS,
  isKnownStorageKind,
  storageKindOf
} from './sessionStorageKind'

describe('sessionStorageKind 契约', () => {
  it('SK-1 已发布的值按序在表头，表里没有重复', () => {
    // 只追加：已落过库的值永远在原位、原拼写。后来的值只能排在它们后面
    expect(SESSION_STORAGE_KINDS.slice(0, 2)).toEqual(['harness-v3-jsonl', 'durable-sqlite-1'])
    expect(new Set(SESSION_STORAGE_KINDS).size).toBe(SESSION_STORAGE_KINDS.length)
  })

  it('SK-2 两个常量的拼写；CURRENT 是成员；切换之后 CURRENT 是 durable-sqlite-1', () => {
    expect(HARNESS_V3_JSONL).toBe('harness-v3-jsonl')
    expect(DURABLE_SQLITE_1).toBe('durable-sqlite-1')
    expect(SESSION_STORAGE_KINDS).toContain(CURRENT_SESSION_STORAGE_KIND)
    // 存储切换（P1-01）的钉子：新会话改用 pi-durable 的存储，旧会话保持 v3、不迁移
    expect(CURRENT_SESSION_STORAGE_KIND).toBe(DURABLE_SQLITE_1)
  })

  it('SK-3 isKnownStorageKind：成员为真；其余一律为假', () => {
    for (const kind of SESSION_STORAGE_KINDS) expect(isKnownStorageKind(kind), kind).toBe(true)

    const unknown: unknown[] = [
      // 更新版本才会写下的值：旧版本必须不认识，才会拒绝拿自己的格式去读写它
      'durable-sqlite-2',
      '',
      'HARNESS-V3-JSONL',
      undefined,
      null,
      42,
      {}
    ]
    for (const value of unknown) {
      expect(isKnownStorageKind(value), JSON.stringify(value) ?? String(value)).toBe(false)
    }
  })

  it('SK-4 storageKindOf：缺省读成 v3；已知值原样；不认识的值原样交回', () => {
    expect(storageKindOf({})).toBe('harness-v3-jsonl')
    expect(storageKindOf({ storageKind: undefined })).toBe('harness-v3-jsonl')
    expect(storageKindOf({ storageKind: null })).toBe('harness-v3-jsonl')

    expect(storageKindOf({ storageKind: 'durable-sqlite-1' })).toBe('durable-sqlite-1')
    // 不认识的值不改写、不兜底成 v3 —— 交给调用方拒绝
    expect(storageKindOf({ storageKind: 'future-x' })).toBe('future-x')
    // 空串不是「缺省」：它是一个（坏的）值，同样原样交回
    expect(storageKindOf({ storageKind: '' })).toBe('')
  })
})

/**
 * sessionDao —— 标签页会话的绑定（`settings.chromeTab`，一个对象）经 `pickSettings` 读回来仍是对象。
 *
 * 为什么单独钉：桌面上判定「这是不是 Chrome 标签页会话 / 这条会话归不归这条桥连接」的每一处 ——
 * 侧边栏对话接口的归属核对、日历、桌面通知、调试租约（observeChromeTabRun）、`chrome` 能力服务器与
 * 它的后端 —— 都是 `chromeTabOf(sessionDao.pickSettings(id, ['chromeTab']))`。`pickSettings` 曾走
 * `json_extract`，而 SQLite 的 json_extract 对**对象**值回的是 JSON 文本、DAO 只把 `[` 开头的再解析；
 * DAO 声明的返回类型却是 `Pick<SessionSettings, K>`（chromeTab 是 ChromeTabBinding 对象）。读回来是
 * 字符串的话，chromeTabOf 一律判「不是」，上面那些地方全部静默失效。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV28.test）：按顺序跑全部迁移建表，
 * BaseDao 换成直接在这个库上 prepare。
 *
 *   SD-1  pickSettings(id, ['chromeTab']) 回的 chromeTab 是对象、与存进去的绑定相等；
 *   SD-2  chromeTabOf / isChromeTabSessionSettings 套在 pickSettings 上认得出它（各处的原样写法）；
 *   SD-3  对照：pick(['settings']) / findAll / findById 解析整份 settings，本来就是对象；
 *   SD-4  对照：数组值（enabledTools）与标量值照旧；键不存在是 undefined / null。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { chromeTabOf, isChromeTabSessionSettings } from '@shuvix/chat-protocol/chromeTabSession'

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
import { sessionDao } from '../sessionDao'
import type { Session } from '../types'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

const BINDING = { installId: 'i1', runId: 'r1', tabId: 5 }

function session(id: string, settings: Session['settings']): Session {
  return {
    id,
    title: `Chrome · ${id}`,
    projectId: null,
    parentId: null,
    settings,
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1
  }
}

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  sessionDao.insert(session('tab-1', { chromeTab: BINDING, enabledTools: [] }))
  sessionDao.insert(session('desk-1', { enabledTools: ['mcp:ssh'], bot: 'scout' }))
})

describe('SD-1 / SD-2 pickSettings 读回标签页绑定', () => {
  it('SD-1 chromeTab 读回来是对象，与存进去的相等', () => {
    const picked = sessionDao.pickSettings('tab-1', ['chromeTab'])
    expect(typeof picked?.chromeTab).toBe('object')
    expect(picked?.chromeTab).toEqual(BINDING)
  })

  it('SD-2 各处的判定写法认得出这条标签页会话', () => {
    expect(chromeTabOf(sessionDao.pickSettings('tab-1', ['chromeTab']))).toEqual(BINDING)
    expect(isChromeTabSessionSettings(sessionDao.pickSettings('tab-1', ['chromeTab']))).toBe(true)
    // 反例：桌面会话、不存在的会话
    expect(isChromeTabSessionSettings(sessionDao.pickSettings('desk-1', ['chromeTab']))).toBe(false)
    expect(isChromeTabSessionSettings(sessionDao.pickSettings('nope', ['chromeTab']))).toBe(false)
  })
})

describe('SD-3 / SD-4 对照', () => {
  it('SD-3 读整份 settings 的几条路本来就是对象', () => {
    expect(sessionDao.pick('tab-1', ['settings'])?.settings.chromeTab).toEqual(BINDING)
    expect(sessionDao.findById('tab-1')?.settings.chromeTab).toEqual(BINDING)
    expect(sessionDao.findAll().find((s) => s.id === 'tab-1')?.settings.chromeTab).toEqual(BINDING)
  })

  it('SD-4 数组照旧解析，字符串照旧；没有的键不是对象', () => {
    expect(sessionDao.pickSettings('desk-1', ['enabledTools', 'bot'])).toEqual({
      enabledTools: ['mcp:ssh'],
      bot: 'scout'
    })
    const missing = sessionDao.pickSettings('desk-1', ['chromeTab'])
    expect(missing?.chromeTab ?? undefined).toBeUndefined()
  })
})

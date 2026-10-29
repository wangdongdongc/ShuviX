/**
 * BrowserHistoryDao —— 内置浏览器历史记录的两张表（迁移 v36）的纯数据访问。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 triggerLogDao.test）：按顺序跑全部迁移建表，
 * BaseDao 换成直接在这个库上 prepare。「天」按本机时区算（SQLite 的 'localtime' 与 JS 的本地 Date 同一个口径）。
 *
 *   BHD-1   用户的访问：typed → 访问 1 / 敲过 1 / lastVisitAt；link 只加访问；generated 算访问不算敲过；
 *           访问表记着 transition、sessionId 为 NULL
 *   BHD-2   agent 的访问：只有 agent 去过的网址三个计数都是 0；访问行带 sessionId；之后用户的访问只数它自己；
 *           lastVisitAt 取最大（晚记的较早访问不把它拨回去）
 *   BHD-3   标题：addVisit 带非空标题就写、空标题不抹掉；setTitle / setFavicon 改已有的网址，不认识的网址不建行
 *   BHD-4   candidates：只给 visitCount > 0 的；多个词之间 AND、网址 / 标题之间 OR；ASCII 不分大小写；
 *           `%` `_` `\` 按字面；按 lastVisitAt 降序；limit；没有词 = 用户去过的全部；
 *           非 ASCII 的词同样拿百分号转义的写法比网址（标题无关也算）；落单的代理对不抛
 *   BHD-5   listGroups 的合并：同一天同一网址的用户访问合成一行（count、lastAt 取晚的）；不同会话各一行；
 *           下一天另一行；本地日期的边界（23:30 与次日 00:30）
 *   BHD-6   按 lastId 降序；actor 过滤 user / agent / all；搜索网址或标题（LIKE 转义）
 *   BHD-7   翻页：before = 上一页最后一行的 lastId，三页不重不漏、每页不超过 limit
 *   BHD-8   removeGroup：只删那一天那个网址那一方的访问（别的天、agent 的留着），重算计数（只剩 agent 的 → 0）；
 *           带会话 id 只删那个会话的；一次访问都不剩 → 网址那行也删
 *   BHD-9   removeUrl：网址那行与全部访问；不认识的什么也不做；clear 两张表都清
 *   BHD-10  pruneBefore(cutoff)：删 cutoff 之前的访问（恰好在 cutoff 的留着）、重算、删掉不剩访问的网址；
 *           只剩 agent 访问的网址计数归 0、lastVisitAt 0，不再是候选
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

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
import { browserHistoryDao as dao } from '../browserHistoryDao'
import type { HistoryTransition } from '../../../shared/browserHistory'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

const db = (): DatabaseSync => holder.db as DatabaseSync

beforeEach(() => {
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  holder.db = fresh
})

/** 本地某天某时某分的毫秒数（月份从 1 起） */
const at = (y: number, mo: number, d: number, h = 12, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi).getTime()

/** 本地日期 YYYY-MM-DD（与 DAY_SQL 同一个口径） */
function dayOf(ms: number): string {
  const t = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

const D1 = at(2026, 6, 10)
const D2 = at(2026, 6, 11)
const D3 = at(2026, 6, 12)

function visit(
  url: string,
  visitedAt: number,
  over: { transition?: HistoryTransition; sessionId?: string | null; title?: string } = {}
): void {
  dao.addVisit({
    url,
    title: over.title ?? '',
    visitedAt,
    transition: over.transition ?? 'link',
    sessionId: over.sessionId ?? null
  })
}

const urlRow = (url: string): Row | undefined =>
  db().prepare('SELECT * FROM browser_history_urls WHERE url = ?').get(url) as Row | undefined
const visitsOf = (url: string): Row[] =>
  db()
    .prepare(
      `SELECT v.visitedAt, v.transition, v.sessionId FROM browser_history_visits v
       JOIN browser_history_urls u ON u.id = v.urlId WHERE u.url = ? ORDER BY v.id`
    )
    .all(url) as Row[]
const counts = (url: string): [number, number, number] | null => {
  const r = urlRow(url)
  return r ? [Number(r.visitCount), Number(r.typedCount), Number(r.lastVisitAt)] : null
}
const idOf = (url: string): number => Number(urlRow(url)!.id)
const total = (table: string): number =>
  Number((db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
const urlsOf = (rows: Array<{ url: string }>): string[] => rows.map((r) => r.url)

const A = 'https://a.test/'
const B = 'https://b.test/page'
const C = 'https://c.test/'

describe('用户的访问（BHD-1）', () => {
  it('BHD-1 typed → 1 / 1 / t；link 只加访问；generated 算访问不算敲过；访问表记 transition、sessionId NULL', () => {
    visit(A, 100, { transition: 'typed' })
    expect(counts(A)).toEqual([1, 1, 100])

    visit(A, 200, { transition: 'link' })
    expect(counts(A)).toEqual([2, 1, 200])

    visit(A, 300, { transition: 'generated' })
    expect(counts(A)).toEqual([3, 1, 300])

    expect(visitsOf(A)).toEqual([
      { visitedAt: 100, transition: 'typed', sessionId: null },
      { visitedAt: 200, transition: 'link', sessionId: null },
      { visitedAt: 300, transition: 'generated', sessionId: null }
    ])
    expect(total('browser_history_urls')).toBe(1)
  })
})

describe('agent 的访问（BHD-2）', () => {
  it('BHD-2 只有 agent 去过：三个计数都是 0；访问行带会话 id', () => {
    visit(A, 500, { sessionId: 's1' })
    expect(counts(A)).toEqual([0, 0, 0])
    expect(visitsOf(A)).toEqual([{ visitedAt: 500, transition: 'link', sessionId: 's1' }])
  })

  it('BHD-2 之后用户的访问只数它自己；agent 再访问不动计数', () => {
    visit(A, 500, { sessionId: 's1', transition: 'typed' })
    visit(A, 600, { transition: 'typed' })
    expect(counts(A)).toEqual([1, 1, 600])
    visit(A, 900, { sessionId: 's2' })
    expect(counts(A)).toEqual([1, 1, 600])
  })

  it('BHD-2 lastVisitAt 取最大：晚记下的较早访问不把它拨回去', () => {
    visit(A, 800)
    visit(A, 300)
    expect(counts(A)).toEqual([2, 0, 800])
  })
})

describe('标题与站点图标（BHD-3）', () => {
  it('BHD-3 addVisit 带非空标题就写；之后空标题不抹掉', () => {
    visit(A, 1, { title: 'Alpha' })
    expect(urlRow(A)?.title).toBe('Alpha')
    visit(A, 2, { title: '' })
    expect(urlRow(A)?.title).toBe('Alpha')
    visit(A, 3, { title: 'Alpha v2' })
    expect(urlRow(A)?.title).toBe('Alpha v2')
  })

  it('BHD-3 setTitle / setFavicon 改已有的网址；不认识的网址不建行', () => {
    visit(A, 1)
    dao.setTitle(A, 'Titled')
    dao.setFavicon(A, 'https://a.test/favicon.ico')
    expect(urlRow(A)).toMatchObject({ title: 'Titled', favicon: 'https://a.test/favicon.ico' })

    dao.setTitle(B, 'nobody')
    dao.setFavicon(B, 'x')
    expect(urlRow(B)).toBeUndefined()
    expect(total('browser_history_urls')).toBe(1)
  })
})

describe('地址栏的候选（BHD-4）', () => {
  it('BHD-4 只给 visitCount > 0 的', () => {
    visit(A, 10)
    visit(B, 20, { sessionId: 's1' })
    expect(urlsOf(dao.candidates([], 50))).toEqual([A])
    expect(urlsOf(dao.candidates(['test'], 50))).toEqual([A])
  })

  it('BHD-4 多个词之间 AND，网址与标题之间 OR；ASCII 不分大小写', () => {
    visit('https://docs.test/guide', 10, { title: 'Install Guide' })
    visit('https://blog.test/install', 20, { title: 'Release notes' })
    visit('https://misc.test/', 30, { title: 'Other' })
    expect(urlsOf(dao.candidates(['install'], 50))).toEqual([
      'https://blog.test/install',
      'https://docs.test/guide'
    ])
    expect(urlsOf(dao.candidates(['install', 'docs'], 50))).toEqual(['https://docs.test/guide'])
    expect(urlsOf(dao.candidates(['INSTALL', 'GUIDE'], 50))).toEqual(['https://docs.test/guide'])
    expect(dao.candidates(['install', 'nope'], 50)).toEqual([])
  })

  it('BHD-4 `%` `_` `\\` 按字面', () => {
    visit('https://p.test/500', 10, { title: 'five hundred' })
    visit('https://p.test/sale', 20, { title: '50% off' })
    visit('https://p.test/axb', 30, { title: 'axb' })
    visit('https://p.test/ab', 40, { title: 'a_b' })
    visit('https://p.test/bs', 50, { title: 'back\\slash' })
    visit('https://p.test/plain', 60, { title: 'backslash' })
    expect(urlsOf(dao.candidates(['50%'], 50))).toEqual(['https://p.test/sale'])
    expect(urlsOf(dao.candidates(['a_b'], 50))).toEqual(['https://p.test/ab'])
    expect(urlsOf(dao.candidates(['k\\s'], 50))).toEqual(['https://p.test/bs'])
  })

  it('BHD-4 按 lastVisitAt 降序；limit；回的字段就是 HistoryUrlRecord', () => {
    visit(A, 30, { transition: 'typed', title: 'A' })
    visit(B, 10)
    visit(C, 20)
    expect(urlsOf(dao.candidates([], 50))).toEqual([A, C, B])
    expect(urlsOf(dao.candidates([], 2))).toEqual([A, C])
    expect(dao.candidates(['a.test'], 50)).toEqual([
      { url: A, title: 'A', favicon: '', visitCount: 1, typedCount: 1, lastVisitAt: 30 }
    ])
  })

  it('BHD-4 非 ASCII 的词也拿百分号转义的写法比网址：标题无关的中文路径照样是候选；落单的代理对不抛', () => {
    const wiki = 'https://zh.wikipedia.org/wiki/%E5%8C%97%E4%BA%AC'
    visit(wiki, 10, { title: 'Wikipedia' })
    visit('https://zh.wikipedia.org/wiki/%E4%B8%8A%E6%B5%B7', 20, { title: 'Wikipedia' })
    expect(urlsOf(dao.candidates(['北京'], 50))).toEqual([wiki])
    expect(urlsOf(dao.candidates(['北京', 'wiki'], 50))).toEqual([wiki])
    expect(() => dao.candidates(['\uD800'], 50)).not.toThrow()
    expect(dao.candidates(['\uD800'], 50)).toEqual([])
  })
})

describe('历史记录页的合并（BHD-5）', () => {
  it('BHD-5 同一天同一网址的用户访问：一行、count 2、lastAt 取晚的', () => {
    visit(A, D1)
    visit(A, D1 + 3_600_000)
    const rows = dao.listGroups({ search: '', actor: 'all', before: null, limit: 50 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      url: A,
      urlId: idOf(A),
      sessionId: null,
      day: dayOf(D1),
      count: 2,
      lastAt: D1 + 3_600_000
    })
  })

  it('BHD-5 不同会话各一行（与用户的也分开）；下一天另一行', () => {
    visit(A, D1)
    visit(A, D1 + 1, { sessionId: 's1' })
    visit(A, D1 + 2, { sessionId: 's2' })
    visit(A, D1 + 3, { sessionId: 's1' })
    visit(A, D2)
    const rows = dao.listGroups({ search: '', actor: 'all', before: null, limit: 50 })
    expect(rows.map((r) => [r.day, r.sessionId, r.count])).toEqual([
      [dayOf(D2), null, 1],
      [dayOf(D1), 's1', 2],
      [dayOf(D1), 's2', 1],
      [dayOf(D1), null, 1]
    ])
  })

  it('BHD-5 本地日期的边界：23:30 与次日 00:30 是两天', () => {
    const late = at(2026, 6, 10, 23, 30)
    const early = at(2026, 6, 11, 0, 30)
    visit(A, late)
    visit(A, early)
    const rows = dao.listGroups({ search: '', actor: 'all', before: null, limit: 50 })
    expect(rows.map((r) => [r.day, r.count, r.lastAt])).toEqual([
      ['2026-06-11', 1, early],
      ['2026-06-10', 1, late]
    ])
  })
})

describe('顺序、过滤与搜索（BHD-6）', () => {
  beforeEach(() => {
    visit(A, D1, { title: 'Alpha' })
    visit(B, D1 + 1, { sessionId: 's1', title: 'Beta 100%' })
    visit(C, D1 + 2, { title: 'Gamma' })
    // 晚记下的一次 A：A 那一组的 lastId 最大，排到最前
    visit(A, D1 + 3)
  })

  it('BHD-6 按 lastId 降序（不是按网址）', () => {
    const rows = dao.listGroups({ search: '', actor: 'all', before: null, limit: 50 })
    expect(urlsOf(rows)).toEqual([A, C, B])
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].lastId).toBeLessThan(rows[i - 1].lastId)
    }
  })

  it('BHD-6 actor：user 只有用户的、agent 只有 agent 的、all 都有', () => {
    const list = (actor: 'all' | 'user' | 'agent'): string[] =>
      urlsOf(dao.listGroups({ search: '', actor, before: null, limit: 50 }))
    expect(list('user')).toEqual([A, C])
    expect(list('agent')).toEqual([B])
    expect(list('all')).toEqual([A, C, B])
  })

  it('BHD-6 搜索网址或标题；% 按字面', () => {
    const find = (search: string): string[] =>
      urlsOf(dao.listGroups({ search, actor: 'all', before: null, limit: 50 }))
    expect(find('gamma')).toEqual([C])
    expect(find('b.test')).toEqual([B])
    expect(find('100%')).toEqual([B])
    expect(find('1%0')).toEqual([])
    expect(find('_')).toEqual([])
    expect(find('alpha')).toEqual([A])
  })
})

describe('翻页（BHD-7）', () => {
  it('BHD-7 before = 上一页最后一行的 lastId：三页不重不漏、每页不超过 limit', () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://p${i}.test/`)
    urls.forEach((u, i) => visit(u, D1 + i))
    const seen: string[] = []
    let before: number | null = null
    const sizes: number[] = []
    for (let page = 0; page < 3; page++) {
      const rows = dao.listGroups({ search: '', actor: 'all', before, limit: 3 })
      sizes.push(rows.length)
      seen.push(...urlsOf(rows))
      before = rows.at(-1)?.lastId ?? null
    }
    expect(sizes).toEqual([3, 3, 1])
    expect(seen).toEqual([...urls].reverse())
    expect(dao.listGroups({ search: '', actor: 'all', before, limit: 3 })).toEqual([])
  })
})

describe('删一行（BHD-8）', () => {
  it('BHD-8 removeGroup(天, 网址, null)：只删那天用户的访问；别的天、agent 的留着；重算计数', () => {
    visit(A, D1, { transition: 'typed' })
    visit(A, D1 + 1)
    visit(A, D1 + 2, { sessionId: 's1' })
    visit(A, D2)
    dao.removeGroup(dayOf(D1), idOf(A), null)
    expect(visitsOf(A)).toEqual([
      { visitedAt: D1 + 2, transition: 'link', sessionId: 's1' },
      { visitedAt: D2, transition: 'link', sessionId: null }
    ])
    expect(counts(A)).toEqual([1, 0, D2])

    // 只剩 agent 的访问：计数 0、lastVisitAt 0，行还在
    dao.removeGroup(dayOf(D2), idOf(A), null)
    expect(counts(A)).toEqual([0, 0, 0])
    expect(visitsOf(A)).toHaveLength(1)
  })

  it('BHD-8 removeGroup(天, 网址, s1)：只删 s1 那天的；用户的计数不动', () => {
    visit(A, D1)
    visit(A, D1 + 1, { sessionId: 's1' })
    visit(A, D1 + 2, { sessionId: 's2' })
    dao.removeGroup(dayOf(D1), idOf(A), 's1')
    expect(visitsOf(A).map((v) => v.sessionId)).toEqual([null, 's2'])
    expect(counts(A)).toEqual([1, 0, D1])
  })

  it('BHD-8 最后一次访问删掉 → 网址那行也删', () => {
    visit(A, D1)
    visit(B, D1)
    dao.removeGroup(dayOf(D1), idOf(A), null)
    expect(urlRow(A)).toBeUndefined()
    expect(urlRow(B)).toBeDefined()
  })
})

describe('删网址与清空（BHD-9）', () => {
  it('BHD-9 removeUrl：网址那行与它的全部访问；别的网址不动；不认识的什么也不做', () => {
    visit(A, D1)
    visit(A, D2, { sessionId: 's1' })
    visit(B, D1)
    dao.removeUrl(A)
    expect(urlRow(A)).toBeUndefined()
    expect(total('browser_history_visits')).toBe(1)
    expect(counts(B)).toEqual([1, 0, D1])

    dao.removeUrl('https://unknown.test/')
    expect(total('browser_history_urls')).toBe(1)
    expect(total('browser_history_visits')).toBe(1)
  })

  it('BHD-9 clear：两张表都清', () => {
    visit(A, D1)
    visit(B, D2, { sessionId: 's1' })
    dao.clear()
    expect(total('browser_history_urls')).toBe(0)
    expect(total('browser_history_visits')).toBe(0)
  })
})

describe('修剪（BHD-10）', () => {
  it('BHD-10 删 cutoff 之前的（恰好在 cutoff 的留着）、重算、删掉不剩访问的网址', () => {
    visit(A, D1, { transition: 'typed' })
    visit(A, D3, { transition: 'link' })
    visit(B, D1)
    visit(C, D2)
    dao.pruneBefore(D2)
    expect(visitsOf(A)).toEqual([{ visitedAt: D3, transition: 'link', sessionId: null }])
    expect(counts(A)).toEqual([1, 0, D3])
    expect(urlRow(B)).toBeUndefined()
    expect(counts(C)).toEqual([1, 0, D2])
  })

  it('BHD-10 只剩 agent 访问的网址：计数归 0、lastVisitAt 0，不再是候选', () => {
    visit(A, D1, { transition: 'typed' })
    visit(A, D3, { sessionId: 's1' })
    expect(urlsOf(dao.candidates([], 50))).toEqual([A])
    dao.pruneBefore(D2)
    expect(counts(A)).toEqual([0, 0, 0])
    expect(dao.candidates([], 50)).toEqual([])
    expect(visitsOf(A)).toEqual([{ visitedAt: D3, transition: 'link', sessionId: 's1' }])
  })

  it('BHD-10 没有可删的：什么也不动', () => {
    visit(A, D2, { transition: 'typed' })
    dao.pruneBefore(D1)
    expect(counts(A)).toEqual([1, 1, D2])
  })
})

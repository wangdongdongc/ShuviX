import { BaseDao } from './database'
import type {
  HistoryActorFilter,
  HistoryTransition,
  HistoryUrlRecord
} from '../../shared/browserHistory'

/** 历史记录页的一行（未补会话标题、未拼 key） */
export interface HistoryGroupRow {
  urlId: number
  url: string
  title: string
  favicon: string
  sessionId: string | null
  day: string
  lastAt: number
  lastId: number
  count: number
}

/** 本地日期（与历史记录页的「天」同一个口径） */
const DAY_SQL = "date(v.visitedAt / 1000, 'unixepoch', 'localtime')"

/** LIKE 的通配符转义（配 ESCAPE '\'） */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * 内置浏览器历史记录 DAO —— browser_history_urls / browser_history_visits 两张表（迁移 v36）的纯数据访问。
 * 网址表的三个计数只数用户自己的访问（sessionId 为空的那些），删访问后由 recompute 照剩下的访问重算。
 */
export class BrowserHistoryDao extends BaseDao {
  /** 记一次访问。用户自己的访问（sessionId 为 null）才加网址的计数 */
  addVisit(visit: {
    url: string
    title: string
    visitedAt: number
    transition: HistoryTransition
    sessionId: string | null
  }): void {
    this.stmt(
      'INSERT INTO browser_history_urls (url, title) VALUES (?, ?) ON CONFLICT(url) DO NOTHING'
    ).run(visit.url, visit.title)
    const row = this.stmt('SELECT id FROM browser_history_urls WHERE url = ?').get(visit.url) as
      | { id: number }
      | undefined
    if (!row) return
    this.stmt(
      'INSERT INTO browser_history_visits (urlId, visitedAt, transition, sessionId) VALUES (?, ?, ?, ?)'
    ).run(row.id, visit.visitedAt, visit.transition, visit.sessionId)
    if (visit.sessionId === null) {
      this.stmt(
        `UPDATE browser_history_urls SET visitCount = visitCount + 1, typedCount = typedCount + ?,
           lastVisitAt = MAX(lastVisitAt, ?) WHERE id = ?`
      ).run(visit.transition === 'typed' ? 1 : 0, visit.visitedAt, row.id)
    }
    if (visit.title) this.setTitle(visit.url, visit.title)
  }

  setTitle(url: string, title: string): void {
    this.stmt('UPDATE browser_history_urls SET title = ? WHERE url = ?').run(title, url)
  }

  setFavicon(url: string, favicon: string): void {
    this.stmt('UPDATE browser_history_urls SET favicon = ? WHERE url = ?').run(favicon, url)
  }

  /**
   * 地址栏建议的候选：用户自己去过的（visitCount > 0）、每个词都出现在网址或标题里的，最近访问的在前，最多 limit 条。
   * 打分在调用方（shared/browserHistory.ts 的 rankHistory）。
   */
  candidates(words: string[], limit: number): HistoryUrlRecord[] {
    // 网址按 URL.href 存（非 ASCII 的路径是百分号转义的）：含非 ASCII 的词也拿它的转义形式比一次
    const where = words.map(
      () => "(url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')"
    )
    const params = words.flatMap((w) => {
      const like = `%${likeEscape(w)}%`
      let encoded = like
      try {
        encoded = `%${likeEscape(encodeURIComponent(w))}%`
      } catch {
        // 落单的代理对：照原样比
      }
      return [like, encoded, like]
    })
    return this.stmt(
      `SELECT url, title, favicon, visitCount, typedCount, lastVisitAt FROM browser_history_urls
       WHERE visitCount > 0${where.length ? ` AND ${where.join(' AND ')}` : ''}
       ORDER BY lastVisitAt DESC LIMIT ?`
    ).all(...params, limit) as unknown as HistoryUrlRecord[]
  }

  /** 一个网址的汇总；没有回 null */
  findUrl(url: string): (HistoryUrlRecord & { id: number }) | null {
    return (
      (this.stmt(
        'SELECT id, url, title, favicon, visitCount, typedCount, lastVisitAt FROM browser_history_urls WHERE url = ?'
      ).get(url) as (HistoryUrlRecord & { id: number }) | undefined) ?? null
    )
  }

  /**
   * 历史记录页：同一天、同一个网址、同一个访问者的访问合成一行，按其中最近的一次从新到旧。
   * 翻页用上一页最后一行的 lastId（组里最大的访问 id —— 各组的访问互不相交，所以它在组之间唯一）。
   */
  listGroups(q: {
    search: string
    actor: HistoryActorFilter
    before: number | null
    limit: number
  }): HistoryGroupRow[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (q.actor === 'user') where.push('v.sessionId IS NULL')
    else if (q.actor === 'agent') where.push('v.sessionId IS NOT NULL')
    if (q.search) {
      const like = `%${likeEscape(q.search)}%`
      where.push("(u.url LIKE ? ESCAPE '\\' OR u.title LIKE ? ESCAPE '\\')")
      params.push(like, like)
    }
    const having = q.before !== null ? 'HAVING MAX(v.id) < ?' : ''
    if (q.before !== null) params.push(q.before)
    return this.stmt(
      `SELECT v.urlId AS urlId, u.url AS url, u.title AS title, u.favicon AS favicon,
         v.sessionId AS sessionId, ${DAY_SQL} AS day,
         MAX(v.visitedAt) AS lastAt, MAX(v.id) AS lastId, COUNT(*) AS count
       FROM browser_history_visits v JOIN browser_history_urls u ON u.id = v.urlId
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY day, v.urlId, v.sessionId
       ${having}
       ORDER BY lastId DESC
       LIMIT ?`
    ).all(...params, q.limit) as unknown as HistoryGroupRow[]
  }

  /** 删掉某一天某个网址某个访问者的全部访问（历史记录页上删一行），再重算这个网址 */
  removeGroup(day: string, urlId: number, sessionId: string | null): void {
    this.stmt(
      `DELETE FROM browser_history_visits WHERE urlId = ?
         AND date(visitedAt / 1000, 'unixepoch', 'localtime') = ? AND sessionId IS ?`
    ).run(urlId, day, sessionId)
    this.recompute(urlId)
  }

  /** 把一个网址从历史里整个删掉（地址栏建议上的 Shift+Delete / ×） */
  removeUrl(url: string): void {
    const row = this.findUrl(url)
    if (!row) return
    this.stmt('DELETE FROM browser_history_visits WHERE urlId = ?').run(row.id)
    this.stmt('DELETE FROM browser_history_urls WHERE id = ?').run(row.id)
  }

  clear(): void {
    this.stmt('DELETE FROM browser_history_visits').run()
    this.stmt('DELETE FROM browser_history_urls').run()
  }

  /** 删掉 cutoff 之前的访问，所有网址照剩下的访问重算、一次访问都不剩的网址删掉 */
  pruneBefore(cutoff: number): void {
    const removed = this.stmt('DELETE FROM browser_history_visits WHERE visitedAt < ?').run(cutoff)
    if (Number(removed.changes) === 0) return
    this.stmt(
      `UPDATE browser_history_urls SET
         visitCount = (SELECT COUNT(*) FROM browser_history_visits v
                       WHERE v.urlId = browser_history_urls.id AND v.sessionId IS NULL),
         typedCount = (SELECT COUNT(*) FROM browser_history_visits v
                       WHERE v.urlId = browser_history_urls.id AND v.sessionId IS NULL AND v.transition = 'typed'),
         lastVisitAt = COALESCE((SELECT MAX(v.visitedAt) FROM browser_history_visits v
                       WHERE v.urlId = browser_history_urls.id AND v.sessionId IS NULL), 0)`
    ).run()
    this.stmt(
      `DELETE FROM browser_history_urls WHERE NOT EXISTS
         (SELECT 1 FROM browser_history_visits v WHERE v.urlId = browser_history_urls.id)`
    ).run()
  }

  /** 一个网址照剩下的访问重算三个计数；一次访问都不剩就删掉这一行 */
  private recompute(urlId: number): void {
    const stats = this.stmt(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN sessionId IS NULL THEN 1 ELSE 0 END) AS visits,
         SUM(CASE WHEN sessionId IS NULL AND transition = 'typed' THEN 1 ELSE 0 END) AS typed,
         MAX(CASE WHEN sessionId IS NULL THEN visitedAt END) AS last
       FROM browser_history_visits WHERE urlId = ?`
    ).get(urlId) as {
      total: number
      visits: number | null
      typed: number | null
      last: number | null
    }
    if (!stats || Number(stats.total) === 0) {
      this.stmt('DELETE FROM browser_history_urls WHERE id = ?').run(urlId)
      return
    }
    this.stmt(
      'UPDATE browser_history_urls SET visitCount = ?, typedCount = ?, lastVisitAt = ? WHERE id = ?'
    ).run(Number(stats.visits ?? 0), Number(stats.typed ?? 0), Number(stats.last ?? 0), urlId)
  }
}

export const browserHistoryDao = new BrowserHistoryDao()

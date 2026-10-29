/**
 * 内置浏览器的历史记录（Chrome 的 History）—— 主进程（记录、查询、打分）与渲染端（地址栏建议、历史记录页）
 * 共用的类型与纯函数（src/shared 是叶子层）。
 *
 * 一个网址一行（visitCount / typedCount / lastVisitAt 只数**用户自己**的访问），每次访问一行（sessionId =
 * 哪个会话的 agent 打开的；用户自己的为空）。用户裁定（2026-10-29）：agent 打开的页面照样记进历史、在历史记录页
 * 标出是哪个会话，但**从不进地址栏建议** —— 地址栏只拿 visitCount > 0 的网址，而 agent 的访问不加这个数。
 */

/**
 * 一次访问是怎么来的（只分地址栏建议用得上的三种）：
 * - typed：用户在地址栏里敲的网址、或从地址栏建议里选的网址（Chrome 的 TYPED，内联补全只认这种）；
 * - generated：从地址栏去的搜索结果页（Chrome 的 GENERATED：算一次访问，不算「敲过」）；
 * - link：其余（点链接、前进后退、页面自己跳转、agent 的导航）。
 */
export type HistoryTransition = 'typed' | 'generated' | 'link'

/** 一个网址的汇总（地址栏建议的候选） */
export interface HistoryUrlRecord {
  url: string
  title: string
  /** 站点图标的地址（页面报的；没有为空串） */
  favicon: string
  /** 用户自己访问的次数（agent 的不算） */
  visitCount: number
  /** 其中从地址栏敲进去 / 选中的次数 */
  typedCount: number
  /** 用户最近一次访问的时刻（ms）；只有 agent 访问过为 0 */
  lastVisitAt: number
}

/** 地址栏建议里的一条历史网址（主进程打过分、按分数从高到低） */
export interface HistorySuggestion extends HistoryUrlRecord {
  score: number
}

/** 历史记录页按谁的访问过滤 */
export type HistoryActorFilter = 'all' | 'user' | 'agent'

export interface HistoryListQuery {
  /** 网址或标题里包含的字（空 = 不过滤） */
  search?: string
  actor?: HistoryActorFilter
  /** 上一页最后一项的 cursor；不给 = 从最新的开始 */
  cursor?: number | null
  limit?: number
}

/**
 * 历史记录页的一行：**同一天、同一个网址、同一个访问者**的访问合成一行（Chrome 的历史记录页同样按天去重），
 * 时间是其中最近的一次。删一行 = 删掉这些访问。
 */
export interface HistoryItem {
  /** 删除用的键（`<天>|<网址 id>|<会话 id>`），渲染端原样交回 */
  key: string
  /** 本地日期 YYYY-MM-DD */
  day: string
  url: string
  title: string
  favicon: string
  /** 这一天最近一次访问的时刻（ms） */
  lastAt: number
  /** 这一天访问了几次 */
  count: number
  /** agent 打开的：哪个会话（用户自己的没有） */
  sessionId?: string
  /** 会话标题；会话已删或查不到为空串 */
  sessionTitle?: string
}

export interface HistoryListResult {
  items: HistoryItem[]
  /** 下一页的 cursor；没有更多为 null */
  next: number | null
}

/** 历史记录保留多久（照 Chrome：90 天） */
export const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** 存进历史的网址最长多少（再长多半是把数据塞进了地址，不记） */
const MAX_URL_LENGTH = 8192

/**
 * 地址 → 记进历史的样子；不该记的回 null。只记网页（http / https）与本地文件；about:、data:、blob:、
 * view-source:、内部页面（shuvix://）一律不记。网址里的用户名密码去掉（不落盘）。
 */
export function historyUrlOf(url: string): string | null {
  if (!url || url.length > MAX_URL_LENGTH) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol === 'file:') return u.href
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname) return null
  u.username = ''
  u.password = ''
  return u.href
}

/**
 * 页内导航（pushState / 改 hash）要不要算一次新访问：路径或查询变了算；只改了 hash 的，只有 hash 路由
 * （`#/…`、`#!/…`）算 —— 页内锚点（目录里点「安装」跳到 #install）不算，不然看一篇长文档就刷出一排历史。
 */
export function inPageVisitCounts(prev: string, next: string): boolean {
  try {
    const a = new URL(prev)
    const b = new URL(next)
    if (a.origin !== b.origin || a.pathname !== b.pathname || a.search !== b.search) return true
    if (a.hash === b.hash) return false
    return /^#!?\//.test(b.hash)
  } catch {
    return prev !== next
  }
}

/** decodeURI，坏的转义原样留着 */
function safeDecode(text: string): string {
  try {
    return decodeURI(text)
  } catch {
    return text
  }
}

/**
 * 地址在地址栏建议里的样子（Chrome 的省略）：去掉 http(s)://、开头的 www.、只有根路径时的那个 `/`，
 * 百分号转义还原成字。本地文件与认不出的地址原样。
 */
export function displayUrlOf(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return safeDecode(url)
  const host = u.host.replace(/^www\./i, '')
  const path = u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname
  return safeDecode(`${host}${path}${u.search}${u.hash}`)
}

/**
 * 网址的几种写法，输入（不分大小写）从任一写法的开头对上都算前缀匹配：省略过的、去协议的、完整的。
 * 保留原来的大小写 —— 内联补全补上的那段照网址自己的写法。
 */
function prefixFormsOf(url: string): string[] {
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return [displayUrlOf(url), url.slice(u.protocol.length + 2), url]
    }
  } catch {
    // 落到下面
  }
  return [url]
}

/** 这种写法从开头对上了输入（输入已是小写） */
function startsWithInput(form: string, lowerInput: string): boolean {
  return form.toLowerCase().startsWith(lowerInput)
}

/** 含汉字 / 假名 / 谚文：这些文字没有词边界，包含就当词首匹配 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const WORD_CHAR = /[\p{L}\p{N}]/u

/** word 在 text 里出现在一个词的开头（前一个字不是字母数字） */
function atWordStart(text: string, word: string): boolean {
  if (CJK.test(word)) return text.includes(word)
  let from = 0
  for (;;) {
    const i = text.indexOf(word, from)
    if (i < 0) return false
    if (i === 0 || !WORD_CHAR.test(text[i - 1])) return true
    from = i + 1
  }
}

/** 最近访问的权重：越近越高 */
function recencyOf(lastVisitAt: number, now: number): number {
  const days = (now - lastVisitAt) / 86_400_000
  if (days < 1) return 1
  if (days < 4) return 0.85
  if (days < 14) return 0.7
  if (days < 31) return 0.5
  if (days < 90) return 0.3
  return 0.15
}

/** 地址栏输入 → 匹配用的词（小写、按空白切开） */
export function historyQueryWords(input: string): string[] {
  return input.toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * 一条历史网址对这个输入的分数；对不上回 0。
 * 匹配度：从网址开头对上（只有一个词时）> 每个词都落在网址或标题的词首 > 每个词都只是被包含；
 * 再乘「常去度」（敲过的次数最重、访问次数封顶、越近越高）。只有根路径的网址（`github.com`）略加一点，
 * 同等情况下站点首页排在它下面的页面前头。
 */
export function historyMatchScore(input: string, row: HistoryUrlRecord, now: number): number {
  const words = historyQueryWords(input)
  if (words.length === 0 || row.visitCount <= 0) return 0
  const display = displayUrlOf(row.url).toLowerCase()
  const title = row.title.toLowerCase()
  let quality: number
  if (words.length === 1 && prefixFormsOf(row.url).some((f) => startsWithInput(f, words[0]))) {
    quality = 4
  } else if (words.every((w) => atWordStart(display, w) || atWordStart(title, w))) {
    quality = 2
  } else if (words.every((w) => display.includes(w) || title.includes(w))) {
    quality = 1
  } else {
    return 0
  }
  const frecency =
    (row.typedCount * 10 + Math.min(row.visitCount, 30) * 2 + 4) * recencyOf(row.lastVisitAt, now)
  let root = 1
  try {
    const u = new URL(row.url)
    if (u.pathname === '/' && !u.search) root = 1.2
  } catch {
    // 不加
  }
  return quality * frecency * root
}

/** 给一批候选打分、去掉对不上的、按分数从高到低（同分按最近访问） */
export function rankHistory(
  input: string,
  rows: HistoryUrlRecord[],
  now: number,
  limit: number
): HistorySuggestion[] {
  return rows
    .map((row) => ({ ...row, score: historyMatchScore(input, row, now) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.lastVisitAt - a.lastVisitAt)
    .slice(0, limit)
}

/** 地址栏里的内联补全：回车打开的地址，与地址栏里整段文字（用户敲的那段原样 + 补上的部分） */
export interface InlineCompletion {
  url: string
  fill: string
}

/**
 * 内联补全（Chrome 的 inline autocomplete）：敲 `git` 时地址栏里直接补成 `github.com`、补上的部分选中。
 * 只对这样的网址补：用户敲过（typedCount > 0）或常去（访问 4 次以上）、http(s)、输入没有空白且是它某种写法的开头。
 * 输入还停在主机名里（没有 `/`）时补到主机名为止、打开站点首页（Chrome 同样把深一层的页面提升成站点）；
 * 补出来跟输入一样（没东西可补）不算。几个候选里取分数最高的，同分取补得短的。
 */
export function inlineCompletionFor(
  input: string,
  rows: HistorySuggestion[]
): InlineCompletion | null {
  if (!input || /\s/.test(input)) return null
  const lower = input.toLowerCase()
  const inHost = !lower.replace(/^https?:\/\//, '').includes('/')
  let best: { completion: InlineCompletion; score: number } | null = null
  for (const row of rows) {
    if (row.typedCount <= 0 && row.visitCount < 4) continue
    let u: URL
    try {
      u = new URL(row.url)
    } catch {
      continue
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    let completion: InlineCompletion | null = null
    if (inHost) {
      const root = `${u.protocol}//${u.host}/`
      const form = prefixFormsOf(root).find((f) => startsWithInput(f, lower))
      if (form)
        completion = { url: root, fill: input + form.slice(lower.length).replace(/\/$/, '') }
    }
    if (!completion) {
      const form = prefixFormsOf(row.url).find((f) => startsWithInput(f, lower))
      if (form) completion = { url: row.url, fill: input + form.slice(lower.length) }
    }
    if (!completion || completion.fill.length <= input.length) continue
    if (
      !best ||
      row.score > best.score ||
      (row.score === best.score && completion.fill.length < best.completion.fill.length)
    ) {
      best = { completion, score: row.score }
    }
  }
  return best?.completion ?? null
}

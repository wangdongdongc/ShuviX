/**
 * `web_search` 工具的浏览器一半：在内置浏览器里开一个 tab 搜一次，取回结果，关掉 tab。
 *
 * 用的是用户自己的浏览器分区（cookie、登录都在）：2026-11-16 实测，全新的浏览器身份搜 Google 每次都被人机验证
 * 拦住，而通过一次验证之后同一个分区连搜 25 次都没有再被拦。
 *
 * 人机验证（用户裁定，2026-11-16 第二版）：不躲、不替用户过，也**不停下来等** —— 遇到验证页这次搜索立刻失败
 * （SearchNeedsHumanCheck），由模型告诉用户、自己先想别的办法。那张验证页留在浏览器里（`checkTab`，全应用至多
 * 一张），用户什么时候去点都行；它还挂着的时候后面的搜索不再去撞搜索引擎，直接回同一句话；它过了（或被关了）
 * 之后的第一次搜索把它收掉、照常搜。
 *
 * tab 开在后台（不选中、不弹浏览器窗口，见 createTab），标签上记着是哪个会话开的；除了留下的那张验证页，搜完一律关掉。
 * 只读页面：不点、不输入，取数是一段只读的页面脚本，所以不经 CDP、也不装 agentGuards。
 */
import { net, session } from 'electron'
import {
  SEARCH_ENGINE_SETTING,
  SEARCH_ENGINES,
  searchEngineOf,
  searchUrl,
  type SearchEngineId
} from '../../../shared/browserSearchEngines'
import { settingsDao } from '../../dao/settingsDao'
import { createLogger } from '../../logger'
import {
  BROWSER_PARTITION,
  closeTab,
  createTab,
  getTabView,
  noteAgentUse
} from './browserViewService'
import {
  cleanResults,
  formatPageTextFallback,
  formatResults,
  isOpaqueRedirect,
  isVerificationPage,
  SEARCH_PAGE_SCRIPT,
  SEARCH_PAGE_TEXT_SCRIPT,
  type SearchPageState,
  type SearchResult
} from './searchResults'

const log = createLogger('WebSearch')

/** 同时最多几个搜索 tab：模型一次并行发好几条搜索很常见，全放出去既占 tab 上限，也更容易招来人机验证 */
const SEARCH_CONCURRENCY = 2
const POLL_MS = 300
const ASK_TIMEOUT_MS = 3_000
/** 等结果页的上限 */
const LOAD_BUDGET_MS = 20_000
/** 结果够一页时停止变化多久算好；结果很少时多等一会儿（有的结果页分几批出） */
const SETTLE_MS = 600
const SETTLE_THIN_MS = 4_000
const ENOUGH_RESULTS = 3
/**
 * 正文不到这么多字的页面不算「结果很少的结果页」，接着等到上限：Bing 先给一张空页再跳一次，中间那几秒
 * 既不在加载、内容也不变（2026-11-16 实测 4 ~ 6 秒）
 */
const MIN_PAGE_TEXT = 200
/** 跟一次不透明跳转链接的上限，以及一次搜索里花在这上面的总上限 */
const FOLLOW_TIMEOUT_MS = 3_000
const FOLLOW_BUDGET_MS = 4_000
export const WEB_SEARCH_MAX_RESULTS = 10

export interface WebSearchOptions {
  query: string
  /** 用哪个搜索引擎（调用方读设置：过门的地址与真正打开的地址得是同一个） */
  engine: SearchEngineId
  /** 至多几条结果 */
  limit: number
  /** 发起搜索的会话（tab 记在它名下） */
  sessionId: string
  signal?: AbortSignal
  /** 跟一次跳转链接、回它指向的地址（测试注入；缺省走浏览器分区的网络栈） */
  followRedirect?: (url: string) => Promise<string | undefined>
}

export interface WebSearchOutcome {
  engine: SearchEngineId
  /** 交给模型的文字 */
  text: string
  /** 整理出的结果条数；0 = 用的是页面正文 */
  resultCount: number
}

/** 设置里选的搜索引擎（与地址栏同一项设置） */
export function configuredSearchEngine(): SearchEngineId {
  return searchEngineOf(settingsDao.findByKey(SEARCH_ENGINE_SETTING))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

let running = 0
const waiting: Array<() => void> = []

function acquireSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (running < SEARCH_CONCURRENCY) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const grant = (): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = (): void => {
      waiting.splice(waiting.indexOf(grant), 1)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    waiting.push(grant)
  })
}

function releaseSlot(): void {
  const next = waiting.shift()
  if (next) next()
  else running--
}

const TAB_GONE = 'The search tab was closed before the results were read.'

/** 问页面；tab 没了抛错，页面卡住或正在跳转只算「还没好」 */
async function askPage<T>(tabId: string, code: string): Promise<T | undefined> {
  const wc = getTabView(tabId)?.webContents
  if (!wc || wc.isDestroyed()) throw new Error(TAB_GONE)
  return Promise.race([
    wc.executeJavaScript(code).catch(() => undefined) as Promise<T | undefined>,
    sleep(ASK_TIMEOUT_MS).then(() => undefined)
  ])
}

function isLoading(tabId: string): boolean {
  const wc = getTabView(tabId)?.webContents
  return !!wc && !wc.isDestroyed() && wc.isLoadingMainFrame()
}

type Settled =
  | { kind: 'results' | 'thin'; state: SearchPageState }
  | { kind: 'verification'; state: SearchPageState }
  | { kind: 'timeout'; state: SearchPageState | undefined }

/** 等结果页稳定下来（或认出验证页、或到时间） */
async function waitForPage(
  tabId: string,
  budgetMs: number,
  signal?: AbortSignal
): Promise<Settled> {
  const started = Date.now()
  let last: SearchPageState | undefined
  let lastKey = ''
  let stableSince = started
  while (Date.now() - started < budgetMs) {
    await sleep(POLL_MS)
    if (signal?.aborted) throw signal.reason
    const state = await askPage<SearchPageState>(tabId, SEARCH_PAGE_SCRIPT)
    if (!state || typeof state.url !== 'string' || !Array.isArray(state.results)) continue
    last = state
    if (isVerificationPage(state)) return { kind: 'verification', state }
    const key = `${state.url}\u0000${state.results.length}\u0000${state.textLength}`
    if (key !== lastKey) {
      lastKey = key
      stableSince = Date.now()
      continue
    }
    if (isLoading(tabId)) continue
    const enough = state.results.length >= ENOUGH_RESULTS
    if (!enough && state.results.length === 0 && state.textLength < MIN_PAGE_TEXT) continue
    if (Date.now() - stableSince >= (enough ? SETTLE_MS : SETTLE_THIN_MS)) {
      return { kind: enough ? 'results' : 'thin', state }
    }
  }
  return { kind: 'timeout', state: last }
}

/**
 * 跟一次跳转链接，只取它指向哪儿、不去加载那一页。用浏览器分区的网络栈（验证通过的 cookie 在那儿）。
 * 不是 3xx（Google 限速时回一张「等几秒」的页面）、出错、超时都回 undefined。
 */
function followInBrowserSession(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const request = net.request({
      url,
      method: 'GET',
      redirect: 'manual',
      session: session.fromPartition(BROWSER_PARTITION)
    })
    const done = (target: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(target)
      try {
        request.abort()
      } catch {
        /* 已经结束 */
      }
    }
    const timer = setTimeout(() => done(undefined), FOLLOW_TIMEOUT_MS)
    request.on('redirect', (_status, _method, redirectUrl) => done(redirectUrl))
    request.on('response', () => done(undefined))
    request.on('error', () => done(undefined))
    request.end()
  })
}

/**
 * 把结果里的不透明跳转链接换成真实地址：一个一个跟（并发会立刻被限速），第一次跟不出来、或花的时间到了上限
 * 就停，剩下的留着原样 —— 实测连着跟五个左右之后 Google 开始回「等几秒」。
 */
async function resolveOpaqueLinks(
  results: SearchResult[],
  follow: (url: string) => Promise<string | undefined>,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const started = Date.now()
  const out = [...results]
  for (let i = 0; i < out.length; i++) {
    if (!isOpaqueRedirect(out[i].url)) continue
    if (signal?.aborted || Date.now() - started >= FOLLOW_BUDGET_MS) break
    let target: string | undefined
    try {
      target = await follow(out[i].url)
    } catch {
      target = undefined
    }
    if (!target || !/^https?:\/\//i.test(target) || isOpaqueRedirect(target)) break
    out[i] = { ...out[i], url: target }
  }
  return out
}

/** 跳转链接解开之后两条结果可能指向同一个地址 */
function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  return results.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
}

/**
 * 搜索引擎要人机验证：这次搜索没有结果。消息是写给模型的 —— 让它告诉用户去哪儿点，并且自己先换个办法。
 */
export class SearchNeedsHumanCheck extends Error {
  constructor(readonly engineName: string) {
    super(
      `${engineName} is asking for a human check before it shows results, so this search returned nothing. ` +
        `The check page is open in a tab of ShuviX's browser. Tell the user that they can open ShuviX's browser and complete the check in that tab, and that searches will work again once it is passed. ` +
        `Do not wait for them and do not call web_search again in this turn: get what you need another way if you can (for example read a page whose address you already know), or carry on without it and say what you could not look up.`
    )
    this.name = 'SearchNeedsHumanCheck'
  }
}

/** 留在浏览器里等用户去点的那张验证页（全应用至多一张） */
let checkTab: { tabId: string; engine: SearchEngineId } | null = null

/** 留下的那张验证页此刻怎样了：还挂着 / 用户过了（或拿它去看别的了）/ 被关了 */
async function checkTabState(tabId: string): Promise<'pending' | 'passed' | 'gone'> {
  let state: SearchPageState | undefined
  try {
    state = await askPage<SearchPageState>(tabId, SEARCH_PAGE_SCRIPT)
  } catch {
    return 'gone'
  }
  // 读不出来（页面卡着、正在跳转）按还挂着算：宁可少搜一次，也不再去撞一次验证
  if (!state || typeof state.url !== 'string' || !Array.isArray(state.results)) return 'pending'
  return isVerificationPage(state) ? 'pending' : 'passed'
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname
  } catch {
    return false
  }
}

export async function runWebSearch(opts: WebSearchOptions): Promise<WebSearchOutcome> {
  const { query, engine, sessionId, signal } = opts
  const engineName = SEARCH_ENGINES[engine].name
  const limit = Math.max(1, Math.min(WEB_SEARCH_MAX_RESULTS, Math.floor(opts.limit)))
  const url = searchUrl(query, engine)

  await acquireSlot(signal)
  let tabId: string | undefined
  let keepTab = false
  try {
    // 上一次留下的验证页：还挂着就不再去撞（同一个搜索引擎），过了就收掉它照常搜
    const left = checkTab
    if (left) {
      const state = await checkTabState(left.tabId)
      if (signal?.aborted) throw signal.reason
      if (state === 'pending' && left.engine === engine) throw new SearchNeedsHumanCheck(engineName)
      if (state !== 'pending' && checkTab === left) {
        checkTab = null
        // 用户过了验证、页面还在它那个搜索引擎上：这张 tab 是我们开的，收掉。被拿去看别的了就留给用户
        const wc = getTabView(left.tabId)?.webContents
        if (
          state === 'passed' &&
          wc &&
          !wc.isDestroyed() &&
          sameHost(wc.getURL(), searchUrl(query, left.engine))
        ) {
          closeTab(left.tabId)
        }
      }
    }

    tabId = createTab(url, { openerSessionId: sessionId })
    noteAgentUse(tabId, sessionId)

    const settled = await waitForPage(tabId, LOAD_BUDGET_MS, signal)
    if (settled.kind === 'verification') {
      log.info(`${engineName} asked for a human check (tab ${tabId})`)
      // 已经留着一张同一个搜索引擎的验证页（并行的另一次搜索先到）：这张不用留
      if (!checkTab) {
        checkTab = { tabId, engine }
        keepTab = true
      }
      throw new SearchNeedsHumanCheck(engineName)
    }

    const cleaned = settled.state ? cleanResults(settled.state.results, limit) : []
    if (cleaned.length > 0) {
      const resolved = await resolveOpaqueLinks(
        cleaned,
        opts.followRedirect ?? followInBrowserSession,
        signal
      )
      if (signal?.aborted) throw signal.reason
      const results = dedupeByUrl(resolved)
      return {
        engine,
        text: formatResults(query, engineName, results),
        resultCount: results.length
      }
    }
    // 选择器没取到：结果页换了结构，或者真的没有结果 —— 把页面正文交回去
    const text = (await askPage<string>(tabId, SEARCH_PAGE_TEXT_SCRIPT)) ?? ''
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error(`${engineName} did not show a results page for this search.`)
    }
    return {
      engine,
      text: formatPageTextFallback(query, engineName, settled.state?.url ?? url, text),
      resultCount: 0
    }
  } finally {
    if (tabId && !keepTab) closeTab(tabId)
    releaseSlot()
  }
}

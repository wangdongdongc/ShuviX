/**
 * web_search 工具 —— 最基础的网络搜索：在内置浏览器里开一个 tab 搜一次，把结果整理成「标题 / 地址 / 摘要」交回，
 * 搜完关掉 tab（services/browser/webSearch.ts）。
 *
 * 搜索引擎是内置浏览器的那项设置（`browser.searchEngine`，缺省 Google），与地址栏同一个。
 *
 * 另一种方式（2026-11-16）：用户在设置里选一家商业搜索 API（Tavily / Exa，`webSearch.provider`），那就只用它 ——
 * 没密钥、被拒、额度用完都报失败，不退回浏览器（services/webSearchApiService.ts）。工具名、参数、描述不变。
 *
 * 人机验证（用户裁定，2026-11-16 第二版）：不停下来等用户。搜索引擎要验证时这次调用失败，错误消息让模型告诉用户
 * 去内置浏览器里那张验证页上点、自己先换个办法（见 services/browser/webSearch.ts SearchNeedsHumanCheck）。
 * 工具从不打开浏览器窗口（agent 的动作不打扰用户，noDisturbGuard）。
 *
 * 门：结果页地址照浏览器的导航上报 `{type:'url', browser:'app'}`（出厂没有 url 策略，no policy = allow）。
 */
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import {
  BaseTool,
  callOwnerOf,
  urlObjectOf,
  type ToolCallScope,
  type ToolResult
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { SEARCH_ENGINES, searchUrl } from '../../shared/browserSearchEngines'
import {
  configuredSearchEngine,
  formatResults,
  runWebSearch,
  WEB_SEARCH_MAX_RESULTS
} from '../services/browser'
import { configuredWebSearchProvider, searchWithApi } from '../services/webSearchApiService'
import { isWebSearchApiProvider, WEB_SEARCH_API_PROVIDERS } from '../../shared/webSearchProviders'
import { withCallAgent } from '../services/toolAgent'
import { getDesktopSecurityContext, TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import { registerBuiltinTool } from '../services/toolRegistry'
import { t } from '../i18n'

export const WEB_SEARCH_TOOL_NAME = 'web_search'

const MAX_QUERY_CHARS = 400
const DEFAULT_RESULTS = 8

/** 描述固定不变（不写搜索引擎的名字）：它变了就是一次工具重新声明，会打穿不支持中途改工具的模型的缓存 */
export const WEB_SEARCH_DESCRIPTION =
  'Search the web the way the user set it up in ShuviX. ' +
  'Returns the first page of results: title, address and a short snippet for each. ' +
  'It does not open the results; use read on an address to get the page. ' +
  'Write the query the way you would type it into a search engine: a few specific words, not a question to an assistant. ' +
  "If the search engine asks for a human check, the call fails and says so: tell the user they can complete it in ShuviX's browser, and get what you need another way meanwhile."

export const WebSearchParamsSchema = obj({
  query: str({ description: 'What to search for' }),
  max_results: opt(
    int({
      description: `How many results to return (1 to ${WEB_SEARCH_MAX_RESULTS}, default ${DEFAULT_RESULTS})`,
      minimum: 1,
      maximum: WEB_SEARCH_MAX_RESULTS
    })
  )
})

interface WebSearchParams {
  query?: unknown
  max_results?: unknown
}

const textResult = (text: string): ToolResult => ({
  content: [{ type: 'text' as const, text }],
  details: undefined
})

export class WebSearchTool extends BaseTool<typeof WebSearchParamsSchema> {
  readonly name = WEB_SEARCH_TOOL_NAME
  readonly label = t(BUILTIN_TOOL_PRESENTATIONS.web_search.labelKey)
  readonly description = WEB_SEARCH_DESCRIPTION
  readonly parameters = WebSearchParamsSchema
  /** 重跑只是再搜一次 */
  readonly replay = 'safe' as const

  constructor(private readonly ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 门在 executeInternal 里：要先把搜索词拼成结果页地址 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    toolCallId: string,
    params: WebSearchParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope
  ): Promise<ToolResult> {
    const query = typeof params.query === 'string' ? params.query.trim() : ''
    if (query === '') throw new Error('query must not be empty')
    if (query.length > MAX_QUERY_CHARS) {
      throw new Error(
        `query is ${query.length} characters; a search query is a few words (at most ${MAX_QUERY_CHARS} characters)`
      )
    }
    const limit =
      typeof params.max_results === 'number' && Number.isFinite(params.max_results)
        ? params.max_results
        : DEFAULT_RESULTS

    const provider = configuredWebSearchProvider()
    const gate = async (url: string, name: string): Promise<void> => {
      await getDesktopSecurityContext(withCallAgent(this.ctx, call)).enforceUrl(
        urlObjectOf(url, 'app'),
        {
          toolCallId,
          ...callOwnerOf(call),
          toolName: WEB_SEARCH_TOOL_NAME,
          description: t('tool.webSearchAskDescription', { engine: name, query }),
          abortError: TOOL_ABORTED,
          missingChannel: 'deny'
        }
      )
      if (signal?.aborted) throw signal.reason
    }

    // 用户选了一家搜索 API：就用它，失败就是失败（不退回浏览器）
    if (isWebSearchApiProvider(provider)) {
      const { name, endpoint } = WEB_SEARCH_API_PROVIDERS[provider]
      await gate(endpoint, name)
      const count = Math.max(1, Math.min(WEB_SEARCH_MAX_RESULTS, Math.floor(limit)))
      const results = await searchWithApi(provider, query, count, {
        ...(signal ? { signal } : {})
      })
      if (results.length === 0)
        return textResult(`${name} found no results for ${JSON.stringify(query)}.`)
      return textResult(formatResults(query, name, results))
    }

    const engine = configuredSearchEngine()
    await gate(searchUrl(query, engine), SEARCH_ENGINES[engine].name)

    const outcome = await runWebSearch({
      query,
      engine,
      limit,
      sessionId: this.ctx.sessionId,
      ...(signal ? { signal } : {})
    })
    return textResult(outcome.text)
  }
}

registerBuiltinTool({
  name: WEB_SEARCH_TOOL_NAME,
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.web_search.labelKey),
  getHint: () => t('tool.webSearchHint'),
  factory: (ctx) => new WebSearchTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.web_search.presentation,
  describe: () => ({ description: WEB_SEARCH_DESCRIPTION, parameters: WebSearchParamsSchema })
})

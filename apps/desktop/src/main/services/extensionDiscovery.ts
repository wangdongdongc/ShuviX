/**
 * 查找这条会话没开启的 MCP 服务器 —— `tool_search` 工具和提示词里那段说明共用。
 *
 * 全程不连接任何服务器：搜索不该启动一个进程，用户还没批准。内置服务器的工具名与说明是随产品发布的
 * （chat-protocol builtinMcpPresentations + 语言文件），第三方服务器用上次连接时记下的 `cachedTools`，组件用它的
 * 名字、说明和 API 清单（组件也是一台服务器，见 builtinMcp/widgetMcpServer.ts）。
 *
 * 第三方服务器和组件自己写的描述**只参与匹配，不进任何给模型看的文字**：用户还没批准它，那段文字不该先到模型面前。
 * 名字（服务器名是用户起的，工具名是服务器报的，组件名是 agent 起的）过滤后才输出。批准之后工具声明本来就会发给模型。
 */
import { BUILTIN_MCP_PRESENTATIONS } from '@shuvix/chat-protocol/builtinMcpPresentations'
import { safeExtensionName } from '@shuvix/chat-protocol/toolSelection'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import { widgetIdOfServer } from '@shuvix/chat-protocol/widgetServers'
import i18next from 'i18next'
import { mcpService } from './mcpService'
import { widgetRegistry } from './widget/widgetRegistry'

/** 不拿去问的内置服务器：chrome 只属于 Chrome 标签页会话 */
const NOT_OFFERED = new Set(['chrome'])

const BUILTIN_COPY_LANGUAGES = ['en', 'zh', 'ja'] as const

/** 提示词里最多列几个组件：组件可能很多，其余的搜得到 */
const PROMPT_WIDGET_LIMIT = 20

const STOP_WORDS = new Set(
  `an and are as at be by for from in is it of on or that the this to with
   一下 这个 那个`.split(/\s+/)
)

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

function normalizeExtensionText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2') // 小驼峰也拆开：组件的操作名是 `addBook`，要能被 `book` 搜到
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
}

/**
 * 分词（中日文也切得开，pi-durable 1.2 的搜索只认 ASCII）。`_` / `-` 按空格算：`read_page` 要能被 `page` 搜到。
 * 单个字符不算（`a`、`的`、`で`、`器`）：它们到处都是，只会让不相干的服务器也算命中。
 */
export function tokenizeExtensionText(text: string): string[] {
  const tokens: string[] = []
  for (const part of segmenter.segment(normalizeExtensionText(text))) {
    if (!part.isWordLike) continue
    const word = part.segment
    if (STOP_WORDS.has(word) || [...word].length === 1) continue
    tokens.push(word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)
  }
  return tokens
}

export interface ExtensionDocument {
  name: string
  text: string
  /** 名字得分按它算，缺省按 `name`。组件的服务器名都带 `widget-`，否则搜「expense widget」每个组件都拿名字分 */
  matchName?: string
}

/**
 * 按查询排序：查询里的词命中几个算几分，命中服务器名多给分。只留得分不低于最高分一半的 —— 一句话里碰巧撞上一个词的
 * 服务器不该把唯一命中变成“多个命中”。
 */
export function rankExtensionDocuments(
  query: string,
  documents: readonly ExtensionDocument[]
): string[] {
  const wanted = [...new Set(tokenizeExtensionText(query))]
  const scored = documents
    .map((document, index) => {
      const words = new Set(tokenizeExtensionText(document.text))
      const nameWords = new Set(tokenizeExtensionText(document.matchName ?? document.name))
      const raw = normalizeExtensionText(document.text)
      let score = 0
      for (const word of wanted) {
        if (nameWords.has(word)) score += 3
        // 非 ASCII 的词也认子串：切词结果随 ICU 版本变（`データベース` 对 `リモートデータベース`）
        else if (words.has(word) || (/\P{ASCII}/u.test(word) && raw.includes(word))) score += 1
      }
      return { name: document.name, score, index }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const top = scored[0]?.score ?? 0
  return scored.filter((entry) => entry.score * 2 >= top).map((entry) => entry.name)
}

/**
 * 查询就是某台服务器的名字（也接受 `mcp:x`、`mcp__x`），不分大小写。过滤后的写法也认：模型只见过那个写法
 * （`my server` 列出来是 `myserver`），照着调回来要能找到。
 */
export function exactExtensionName(query: string, names: readonly string[]): string | undefined {
  const wanted = query
    .trim()
    .replace(/^mcp(:|__)/i, '')
    .toLowerCase()
  return (
    names.find((name) => name.toLowerCase() === wanted) ??
    names.find((name) => safeExtensionName(name).toLowerCase() === wanted)
  )
}

interface CachedTool {
  name?: unknown
  description?: unknown
}

function cachedToolsOf(server: McpServer): CachedTool[] {
  try {
    const tools: unknown = JSON.parse(server.cachedTools || '[]')
    if (!Array.isArray(tools)) return []
    return tools.filter((tool): tool is CachedTool => typeof tool === 'object' && tool !== null)
  } catch {
    return []
  }
}

function builtinPresentationOf(
  server: McpServer
): (typeof BUILTIN_MCP_PRESENTATIONS)[string] | undefined {
  return server.type === 'inproc' ? BUILTIN_MCP_PRESENTATIONS[server.name] : undefined
}

/** 组件的显示名（agent 起的）：过滤、截断之后才能出现在给模型看的文字里。服务器不是组件 → undefined */
function widgetLabelOf(server: McpServer): string | undefined {
  const widgetId = widgetIdOfServer(server.name)
  if (widgetId === undefined) return undefined
  const name = widgetRegistry.findById(widgetId)?.name ?? ''
  return name
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, 40)
}

/** 查询就是某个组件的 id 或显示名（显示名只有唯一一个对得上才算） */
function widgetNamed(query: string, servers: readonly McpServer[]): McpServer | undefined {
  const wanted = normalizeExtensionText(query.trim())
  const widgets = servers.flatMap((server) => {
    const widgetId = widgetIdOfServer(server.name)
    return widgetId === undefined ? [] : [{ server, widgetId }]
  })
  // id 唯一，先认它：别的组件恰好起了这个显示名，也不该让它变成「多个命中」
  const byId = widgets.find(({ widgetId }) => normalizeExtensionText(widgetId) === wanted)
  if (byId) return byId.server
  const byName = widgets.filter(
    ({ widgetId }) =>
      normalizeExtensionText(widgetRegistry.findById(widgetId)?.name ?? '') === wanted
  )
  return byName.length === 1 ? byName[0].server : undefined
}

function documentOf(server: McpServer): ExtensionDocument {
  const widgetId = widgetIdOfServer(server.name)
  if (widgetId !== undefined) {
    const widget = widgetRegistry.findById(widgetId)
    const ops = cachedToolsOf(server).flatMap((tool) => [
      typeof tool.name === 'string' ? tool.name : '',
      typeof tool.description === 'string' ? tool.description : ''
    ])
    return {
      name: server.name,
      matchName: `${widgetId} ${widget?.name ?? ''}`,
      text: ['widget', widget?.name ?? '', widget?.description ?? '', ...ops].join(' ')
    }
  }
  const def = builtinPresentationOf(server)
  if (def) {
    const copy = BUILTIN_COPY_LANGUAGES.flatMap((language) => {
      const t = i18next.getFixedT(language)
      return [t(def.labelKey), t(def.hintKey)]
    })
    return { name: server.name, text: [...def.toolNames, ...copy].join(' ') }
  }
  const tools = cachedToolsOf(server).flatMap((tool) => [
    typeof tool.name === 'string' ? tool.name : '',
    typeof tool.description === 'string' ? tool.description : ''
  ])
  return { name: server.name, text: tools.join(' ') }
}

/** 拿得出来问的服务器：配置里启用、配齐了（缺 key 的连不上），不含只属于别处的内置服务器 */
export function offeredServers(): McpServer[] {
  return mcpService.configuredServers().filter((server) => !NOT_OFFERED.has(server.name))
}

/** 这条查询找到的服务器：精确同名只回它，否则按相关度排 */
export function findExtensions(query: string, servers: readonly McpServer[]): McpServer[] {
  const byName = new Map(servers.map((server) => [server.name, server]))
  const exact = exactExtensionName(query, [...byName.keys()])
  if (exact !== undefined) return [byName.get(exact)!]
  const widget = widgetNamed(query, servers)
  if (widget) return [widget]
  return rankExtensionDocuments(query, servers.map(documentOf)).map((name) => byName.get(name)!)
}

/** 多个命中时列给模型的一行：内置的带英文说明，第三方只有名字和工具名 */
export function extensionChoiceLine(server: McpServer): string {
  const def = builtinPresentationOf(server)
  if (def) return `- ${server.name}: ${i18next.getFixedT('en')(def.hintKey)}`
  const tools = cachedToolsOf(server)
    .map((tool) => (typeof tool.name === 'string' ? safeExtensionName(tool.name) : ''))
    .filter(Boolean)
    .slice(0, 8)
  const label = widgetLabelOf(server)
  const name = `${safeExtensionName(server.name)}${label ? ` "${label}"` : ''}`
  return tools.length > 0 ? `- ${name} (tools: ${tools.join(', ')})` : `- ${name}`
}

/** 这条会话的工具状态（`sessionService.rootToolState` 的那两项）：哪些开着、哪些被用户明确取消了 */
export interface ExtensionSessionState {
  names: readonly string[]
  optedOut: ReadonlySet<string>
}

export function isExtensionOff(server: McpServer, state: ExtensionSessionState): boolean {
  const entry = `mcp:${server.name}`
  return !state.names.includes(entry) && !state.optedOut.has(entry)
}

/** 提示词里列出的可开启扩展：名字，内置服务器再带一句当前语言的说明 */
export function extensionPromptEntries(
  state: ExtensionSessionState
): Array<{ name: string; hint?: string }> {
  const off = offeredServers().filter((server) => isExtensionOff(server, state))
  const widgets = off.filter((server) => widgetIdOfServer(server.name) !== undefined)
  const shownWidgets = new Set(widgets.slice(0, PROMPT_WIDGET_LIMIT))
  const entries = off
    .filter((server) => widgetIdOfServer(server.name) === undefined || shownWidgets.has(server))
    .map((server) => {
      const def = builtinPresentationOf(server)
      if (def) return { name: server.name, hint: i18next.t(def.hintKey) }
      const label = widgetLabelOf(server)
      return label === undefined
        ? { name: safeExtensionName(server.name) }
        : {
            name: safeExtensionName(server.name),
            ...(label ? { hint: i18next.t('tool.extensionWidgetHint', { name: label }) } : {})
          }
    })
  const more = widgets.length - shownWidgets.size
  return more > 0
    ? [
        ...entries,
        { name: 'widget-…', hint: i18next.t('tool.extensionMoreWidgets', { count: more }) }
      ]
    : entries
}

/** 卡片上的来源：组件 / 内置 / 要运行的命令行（不含环境变量）/ 要连接的主机（地址里可能带 token） */
export function extensionSourceOf(
  server: McpServer
):
  | { type: 'builtin' }
  | { type: 'widget'; name: string }
  | { type: 'command'; command: string }
  | { type: 'url'; host: string } {
  const widgetId = widgetIdOfServer(server.name)
  if (widgetId !== undefined) {
    return { type: 'widget', name: widgetRegistry.findById(widgetId)?.name ?? widgetId }
  }
  if (server.type === 'inproc') return { type: 'builtin' }
  if (server.type === 'http') {
    try {
      return { type: 'url', host: new URL(server.url).host }
    } catch {
      // 地址解析不了（模板没展开之类）：去掉协议和账号，只留主机那一段
      const rest = server.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0]
      return { type: 'url', host: rest.slice(rest.lastIndexOf('@') + 1) }
    }
  }
  let args: string[] = []
  try {
    const parsed: unknown = JSON.parse(server.args || '[]')
    if (Array.isArray(parsed)) args = parsed.filter((arg) => typeof arg === 'string')
  } catch {
    /* 参数读不出来：只显示命令本身 */
  }
  return { type: 'command', command: [server.command, ...args].join(' ').slice(0, 500) }
}

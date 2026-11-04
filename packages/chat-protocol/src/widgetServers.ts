/**
 * 组件的 MCP 服务器名字（2026-11-04）—— 每个有 API 的组件是一台 `widget-<id>`，它的操作是工具 `mcp__widget-<id>__<op>`。
 *
 * 这个前缀是**保留的**：用户的服务器不能叫 `widget-…`（添加和导入都拒绝，迁移 v39 给旧行改了名），所以界面可以只凭
 * 前缀认组件的工具 —— 组件的操作是组件自己定的，没有 `builtinMcpPresentations` 那样的固定清单可以对。
 */

/** 造组件的内置工具，和它依赖的技能：没有这个技能的 agent 不给这个工具 */
export const WIDGET_TOOL_NAME = 'widget'
export const WIDGET_SKILL = 'builtin:widget'

/** 组件 id：小写 ASCII kebab-case，至少一个连字符 */
export const WIDGET_ID_REGEX = /^[a-z0-9]+(-[a-z0-9]+)+$/

const WIDGET_SERVER_PREFIX = 'widget-'

/** 配置行 id 的前缀：组件的服务器没有数据库行，这个 id 只在连接记账里用 */
const WIDGET_SERVER_ID_PREFIX = 'widget-server:'

/** 主流 provider 对工具名的长度上限 */
const TOOL_NAME_MAX = 64

export function widgetServerName(widgetId: string): string {
  return `${WIDGET_SERVER_PREFIX}${widgetId}`
}

export function widgetServerId(widgetId: string): string {
  return `${WIDGET_SERVER_ID_PREFIX}${widgetId}`
}

/** 这个名字是不是留给组件的（用户的服务器不能用）。不分大小写：找服务器时名字是不分大小写比的 */
export function isReservedMcpServerName(name: string): boolean {
  return name.toLowerCase().startsWith(WIDGET_SERVER_PREFIX)
}

/** 服务器名 → 组件 id；不是组件的服务器 → undefined */
export function widgetIdOfServer(server: string): string | undefined {
  if (!server.startsWith(WIDGET_SERVER_PREFIX)) return undefined
  const id = server.slice(WIDGET_SERVER_PREFIX.length)
  return WIDGET_ID_REGEX.test(id) ? id : undefined
}

/** 这一项勾选是不是某个组件 */
export function isWidgetSelectionEntry(entry: string): boolean {
  return entry.startsWith('mcp:') && widgetIdOfServer(entry.slice('mcp:'.length)) !== undefined
}

/** 勾选里代表这个组件的那一项 */
export function widgetSelectionEntry(widgetId: string): string {
  return `mcp:${widgetServerName(widgetId)}`
}

export function widgetToolName(widgetId: string, op: string): string {
  return `mcp__${widgetServerName(widgetId)}__${op}`
}

/** 这个操作的工具名放不放得下。放不下的工具名可能让整个请求被 provider 拒绝，所以不声明 */
export function widgetToolNameFits(widgetId: string, op: string): boolean {
  return widgetToolName(widgetId, op).length <= TOOL_NAME_MAX
}

const WIDGET_TOOL_RE = /^mcp__widget-([a-z0-9]+(?:-[a-z0-9]+)+)__([a-z][a-zA-Z0-9]*)$/

/** `mcp__widget-<id>__<op>` → { widgetId, op }；别的工具 → undefined */
export function parseWidgetToolName(
  toolName: string
): { widgetId: string; op: string } | undefined {
  const match = WIDGET_TOOL_RE.exec(toolName)
  return match ? { widgetId: match[1], op: match[2] } : undefined
}

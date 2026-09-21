/**
 * 扩展工具渲染配置 —— 喂给 chat-ui 的 toolPresentations（折叠态图标+摘要、展开态表单）。
 *
 * read/write/edit/ask 复用共享 @shuvix/chat-protocol/builtinToolPresentations（与桌面同一真源，
 * label 经扩展 i18n 解析）。浏览器操控现在是内置 MCP server（`mcp__browser__*`），渲染由
 * chat-ui 按 chat-protocol 的 builtinMcpPresentations 兜底，这里不必再列。
 */
import i18next from 'i18next'
import { resolveBuiltinToolPresentations } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'

/** 历史会话兼容：浏览器曾是一个 multiplex `browser` 工具，更早是一组离散工具 ——
 *  两代都已退役，保留渲染配置只为含历史调用的会话正常展示 */
const BROWSER_TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  browser: { label: 'Browser', icon: 'Globe' },
  list_tabs: { label: 'List Tabs', icon: 'Monitor' },
  open_tab: { label: 'Open Tab', icon: 'Globe' },
  read_page: { label: 'Read Page', icon: 'FileText' },
  snapshot: { label: 'Snapshot', icon: 'Search' },
  click: { label: 'Click' },
  fill: { label: 'Fill' },
  key: { label: 'Press Key' },
  navigate: { label: 'Navigate', icon: 'Globe' },
  screenshot: { label: 'Screenshot', icon: 'Monitor' }
}

/** 扩展全部工具渲染配置（按当前语言解析共享内置 + 浏览器工具） */
export function getToolPresentations(): Record<string, ToolPresentation> {
  return {
    ...resolveBuiltinToolPresentations((k) => i18next.t(k)),
    ...BROWSER_TOOL_PRESENTATIONS
  }
}

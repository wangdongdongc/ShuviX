/**
 * 扩展工具渲染配置 —— 喂给 chat-ui 的 toolPresentations（折叠态图标+摘要、展开态表单）。
 *
 * read/write/edit/ask 复用共享 @shuvix/chat-protocol/builtinToolPresentations（与桌面同一真源，
 * label 经扩展 i18n 解析）；浏览器操控工具是扩展独有，就地定义。
 */
import i18next from 'i18next'
import { resolveBuiltinToolPresentations } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'

/** 扩展独有的浏览器操控工具（桌面无 chrome.debugger 等价工具）—— 图标取自 LucideIconName 受限集，无合适项则省略走 Wrench 兜底 */
const BROWSER_TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  list_tabs: { label: 'List Tabs', icon: 'Monitor' },
  open_tab: { label: 'Open Tab', icon: 'Globe', summaryField: 'url' },
  read_page: { label: 'Read Page', icon: 'FileText', summaryField: 'tabId' },
  snapshot: { label: 'Snapshot', icon: 'Search', summaryField: 'tabId' },
  click: { label: 'Click', summaryField: 'uid' },
  fill: { label: 'Fill', summaryField: 'text' },
  key: { label: 'Press Key', summaryField: 'key' },
  navigate: { label: 'Navigate', icon: 'Globe', summaryField: 'url' },
  screenshot: { label: 'Screenshot', icon: 'Monitor', summaryField: 'tabId' },
  release_tab: { label: 'Release Tab', summaryField: 'tabId' }
}

/** 扩展全部工具渲染配置（按当前语言解析共享内置 + 浏览器工具） */
export function getToolPresentations(): Record<string, ToolPresentation> {
  return {
    ...resolveBuiltinToolPresentations((k) => i18next.t(k)),
    ...BROWSER_TOOL_PRESENTATIONS
  }
}

/**
 * 扩展工具渲染配置 —— 喂给 chat-ui 的 toolPresentations（折叠态图标+摘要、展开态表单）。
 *
 * read/write/edit/ask 复用共享 @shuvix/chat-protocol/builtinToolPresentations（与桌面同一真源，
 * label 经扩展 i18n 解析）；浏览器操控工具是扩展独有，就地定义。
 */
import i18next from 'i18next'
import { resolveBuiltinToolPresentations } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'

/** 浏览器工具渲染配置 —— 现役是统一 multiplex `browser` 工具；其余旧离散工具名
 *  已收敛进 browser（action 参数），保留渲染配置供含历史调用的会话正常展示 */
const BROWSER_TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  browser: { label: 'Browser', icon: 'Globe' },
  // ── 以下为历史会话兼容条目（工具已并入 browser） ──
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

/**
 * browser 工具（桌面注册壳）—— 统一 multiplex 浏览器工具，实现共享自 @shuvix/agent-runtime。
 *
 * backend 操作主窗口内嵌浏览器面板（services/browser），无询问门控（面板可见即监督）。
 * 深度用法文档在内置 skill `browser`（SKILL.md）与工具自身的 action:"help"。
 */
import {
  createBrowserTool,
  buildBrowserToolDescription,
  buildBrowserParamsSchema,
  BROWSER_TOOL_NAME
} from '@shuvix/agent-runtime'
import { t } from '../i18n'
import { TOOL_ABORTED } from '../services/toolContext'
import { registerBuiltinTool } from '../services/toolRegistry'
import { createDesktopBrowserBackend, DESKTOP_BROWSER_CAPS } from '../services/browser'

registerBuiltinTool({
  name: BROWSER_TOOL_NAME,
  group: 'general',
  getLabel: () => t('tool.browserLabel'),
  getHint: () => t('tool.browserHint'),
  factory: (ctx) =>
    createBrowserTool({
      backend: createDesktopBrowserBackend(ctx.sessionId),
      abortError: TOOL_ABORTED,
      label: t('tool.browserLabel')
    }),
  presentation: {
    icon: 'Globe',
    iconColor: '#60a5fa'
  },
  describe: () => ({
    description: buildBrowserToolDescription(DESKTOP_BROWSER_CAPS),
    parameters: buildBrowserParamsSchema(DESKTOP_BROWSER_CAPS)
  })
})

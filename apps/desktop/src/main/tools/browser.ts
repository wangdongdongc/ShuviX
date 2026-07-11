/**
 * browser 工具（桌面注册壳）—— 统一 multiplex 浏览器工具，实现共享自 @shuvix/agent-runtime。
 *
 * backend 操作主窗口内嵌浏览器面板（services/browser），mutating 操作经会话 autoApprove
 * 门控逐次审批（走现成 kind:'approval' 表单，command 文案由共享 describeBrowserOp 渲染）。
 * 深度用法文档在内置 skill `browser`（SKILL.md）与工具自身的 action:"help"。
 */
import {
  createBrowserTool,
  buildBrowserToolDescription,
  buildBrowserParamsSchema,
  BROWSER_TOOL_NAME
} from '@shuvix/agent-runtime'
import { t } from '../i18n'
import { sessionDao } from '../dao/sessionDao'
import { TOOL_ABORTED } from '../services/toolContext'
import { registerBuiltinTool } from '../services/toolRegistry'
import { createDesktopBrowserBackend, DESKTOP_BROWSER_CAPS } from '../services/browser'

registerBuiltinTool({
  name: BROWSER_TOOL_NAME,
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t('tool.browserLabel'),
  getHint: () => t('tool.browserHint'),
  factory: (ctx) =>
    createBrowserTool({
      backend: createDesktopBrowserBackend(ctx.sessionId),
      approval: ctx.requestUserInput
        ? {
            // 每次读 SQLite：会话中途开启「免审批」立即生效（与 bash 同款语义）
            isAutoApprove: () =>
              sessionDao.pickSettings(ctx.sessionId, ['autoApprove'])?.autoApprove === true,
            requestUserInput: ctx.requestUserInput
          }
        : undefined,
      abortError: TOOL_ABORTED,
      label: t('tool.browserLabel')
    }),
  presentation: {
    icon: 'Globe',
    iconColor: '#60a5fa',
    summaryField: 'action'
  },
  describe: () => ({
    description: buildBrowserToolDescription(DESKTOP_BROWSER_CAPS),
    parameters: buildBrowserParamsSchema(DESKTOP_BROWSER_CAPS)
  })
})

/**
 * Ask 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createAskTool。
 * 工具定义/执行逻辑全共享；桌面只注入 requestUserInput（IPC InputRequest）、abort 文案、本地化 label。
 */
import { createAskTool } from '@shuvix/agent-runtime'
import { registerBuiltinTool } from '../services/toolRegistry'
import { TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import { t } from '../i18n'

registerBuiltinTool({
  name: 'ask',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t('tool.askLabel'),
  getHint: () => t('tool.askHint'),
  factory: (ctx: ToolContext) =>
    createAskTool({
      requestUserInput: (req) => {
        if (!ctx.requestUserInput) throw new Error('requestUserInput callback not available')
        return ctx.requestUserInput(req)
      },
      abortError: TOOL_ABORTED,
      label: t('tool.askLabel')
    }),
  presentation: {
    icon: 'MessageCircleQuestion',
    iconColor: '#60a5fa',
    summaryField: 'question'
  }
})

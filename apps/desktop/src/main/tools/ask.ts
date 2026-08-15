/**
 * Ask 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createAskTool。
 * 工具定义/执行逻辑全共享；桌面只注入 requestUserInput（IPC InputRequest）、abort 文案、本地化 label。
 */
import { createAskTool, AskParamsSchema, ASK_DESCRIPTION } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { registerBuiltinTool } from '../services/toolRegistry'
import { TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import { t } from '../i18n'

registerBuiltinTool({
  name: 'ask',
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.ask.labelKey),
  getHint: () => t('tool.askHint'),
  factory: (ctx: ToolContext) =>
    createAskTool({
      requestUserInput: (req) => {
        if (!ctx.requestUserInput) throw new Error('requestUserInput callback not available')
        return ctx.requestUserInput(req)
      },
      abortError: TOOL_ABORTED,
      label: t(BUILTIN_TOOL_PRESENTATIONS.ask.labelKey)
    }),
  presentation: BUILTIN_TOOL_PRESENTATIONS.ask.presentation,
  describe: () => ({ description: ASK_DESCRIPTION, parameters: AskParamsSchema })
})

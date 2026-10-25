/**
 * Suggest 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createSuggestTool。
 * 工具只校验参数、交回结果；卡片由 chat-ui 按调用参数画，采纳走 `suggestion:accept`（见 DefaultChatGateway.acceptSuggestion）。
 */
import { createSuggestTool, SuggestParamsSchema, SUGGEST_DESCRIPTION } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { registerBuiltinTool } from '../services/toolRegistry'
import { t } from '../i18n'

registerBuiltinTool({
  name: 'suggest',
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.suggest.labelKey),
  getHint: () => t('tool.suggestHint'),
  factory: () => createSuggestTool({ label: t(BUILTIN_TOOL_PRESENTATIONS.suggest.labelKey) }),
  presentation: BUILTIN_TOOL_PRESENTATIONS.suggest.presentation,
  describe: () => ({ description: SUGGEST_DESCRIPTION, parameters: SuggestParamsSchema })
})

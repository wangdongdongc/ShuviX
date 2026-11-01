/**
 * Suggest 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createSuggestTool。
 * 工具只校验参数、交回结果；卡片由 chat-ui 按调用参数画，采纳走 `suggestion:accept`（见 DefaultChatGateway.acceptSuggestion）。
 * 桌面能摆图：每条提议可以带一张（快照进会话目录，见 services/shownImages.ts；不过权限判断，照样立刻返回）。
 */
import {
  createSuggestTool,
  SuggestParamsWithImagesSchema,
  SUGGEST_DESCRIPTION_WITH_IMAGES
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { registerBuiltinTool } from '../services/toolRegistry'
import { presentImages } from '../services/shownImages'
import { resolveProjectConfig } from '../services/toolContext'
import { t } from '../i18n'

registerBuiltinTool({
  name: 'suggest',
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.suggest.labelKey),
  getHint: () => t('tool.suggestHint'),
  factory: (ctx) =>
    createSuggestTool({
      label: t(BUILTIN_TOOL_PRESENTATIONS.suggest.labelKey),
      presentImages: (images) =>
        presentImages({
          sessionId: ctx.sessionId,
          workingDirectory: resolveProjectConfig(ctx.sessionId).workingDirectory,
          images
        })
    }),
  presentation: BUILTIN_TOOL_PRESENTATIONS.suggest.presentation,
  describe: () => ({
    description: SUGGEST_DESCRIPTION_WITH_IMAGES,
    parameters: SuggestParamsWithImagesSchema
  })
})

/**
 * preview 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createPreviewTool 内核。
 *
 * 校验/分类映射/事件/文案全共享；桌面只注入端适配：Node fs port、resolveToCwd 解析、
 * previewFile 分类内核（与 FilesPanel 预览同源）、图表渲染验证（AppEvent 请渲染端
 * 跑同款 renderMermaid + IPC 回执，见 previewValidationBroker）、ctx.emitChatEvent。
 *
 * **无路径准入门**：预览把文件呈现给用户、正文不进模型上下文，与用户点击 Files 面板
 * 走的 previewSessionFile 同一哲学（用户对本机文件本有完全访问权）。原「工作目录外
 * 直接报错」的硬边界随之取消 —— 预览展示链路本就吃绝对路径，区外文件照常展示。
 * 想按工具设门：L1 全工具门 + 用户策略 `tool.name == 'preview'`（内置不设）。
 */
import {
  createPreviewTool,
  previewFile,
  PreviewParamsSchema,
  PREVIEW_DESCRIPTION
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { resolveProjectConfig, TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import { nodeFileSystemPort } from '../utils/toolUtils/nodeFileSystemPort'
import { resolveToCwd } from '../utils/toolUtils/pathUtils'
import { validateChartViaRenderer } from '../services/previewValidationBroker'
import { registerBuiltinTool } from '../services/toolRegistry'
import { t } from '../i18n'
import { createLogger } from '../logger'

const log = createLogger('Tool:preview')

/** 构建桌面 preview 工具实例 */
export const makePreviewTool = (ctx: ToolContext): ReturnType<typeof createPreviewTool> =>
  createPreviewTool({
    port: nodeFileSystemPort,
    resolvePath: (p) => {
      const config = resolveProjectConfig(ctx.sessionId)
      const absPath = resolveToCwd(p, config.workingDirectory)
      return { statPath: absPath, absPath }
    },
    // 与 FilesPanel 预览同一个分类内核
    readPreview: (statPath, absPath) => previewFile(nodeFileSystemPort, statPath, absPath),
    // 图表渲染验证：渲染端跑与 ChartView 同款 renderMermaid，broker 超时诚实降级
    validateChart: ({ absPath }) => validateChartViaRenderer({ sessionId: ctx.sessionId, absPath }),
    emitFilePreview: (absPath) => {
      if (!ctx.emitChatEvent) {
        throw new Error('Preview is not available in this context (no frontend event channel)')
      }
      log.info(`preview ${absPath}`)
      ctx.emitChatEvent({ type: 'file_preview', absPath })
    },
    label: t(BUILTIN_TOOL_PRESENTATIONS.preview.labelKey),
    abortError: TOOL_ABORTED
  })

registerBuiltinTool({
  name: 'preview',
  group: 'general',
  // 不在内置 default 档案的工具清单里（与 git 同模式，可覆盖 default.md 加入）；可视化等子代理经白名单按名解析
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.preview.labelKey),
  getHint: () => t('tool.previewHint'),
  factory: (ctx) => makePreviewTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.preview.presentation,
  describe: () => ({ description: PREVIEW_DESCRIPTION, parameters: PreviewParamsSchema })
})

/**
 * preview 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createPreviewTool 内核。
 *
 * 校验/分类映射/事件/文案全共享；桌面只注入端适配：Node fs port、resolveToCwd + 工作目录
 * 边界判定、previewFile 分类内核（与 FilesPanel 预览同源）、图表渲染验证（AppEvent 请渲染端
 * 跑同款 renderMermaid + IPC 回执，见 previewValidationBroker）、ctx.emitChatEvent。
 * Files 面板按 projectPath 相对化路径，工作目录之外无法展示 —— 越界在 resolvePath 内直接报错
 * （给 LLM 可行动的反馈，而非发出一个前端静默忽略的事件）。
 */
import {
  createPreviewTool,
  previewFile,
  PreviewParamsSchema,
  PREVIEW_DESCRIPTION
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import {
  resolveProjectConfig,
  isPathWithinWorkspace,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
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
      if (!isPathWithinWorkspace(absPath, config.workingDirectory)) {
        throw new Error(
          `Cannot preview ${absPath}: the Files panel can only preview files inside the working directory (${config.workingDirectory})`
        )
      }
      return { statPath: absPath, absPath }
    },
    // 与 FilesPanel 预览同一个分类内核（准入已由 resolvePath 更严地把过关）
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
  // 主 Agent 默认不注入（与 git 同模式）；可视化等子代理经白名单按名解析
  defaultEnabled: false,
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.preview.labelKey),
  getHint: () => t('tool.previewHint'),
  factory: (ctx) => makePreviewTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.preview.presentation,
  describe: () => ({ description: PREVIEW_DESCRIPTION, parameters: PreviewParamsSchema })
})

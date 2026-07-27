/**
 * Write 工具（桌面注册）—— 整条执行流程复用共享 createFileToolSuite，
 * 仅注入桌面端适配（Node fs / fileTime / 绝对路径 / SQLite ApprovalPolicy，见 fileToolDeps）。
 */
import { createFileToolSuite, WriteParamsSchema } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { ToolContext } from '../services/toolContext'
import { makeDesktopFileToolDeps, WRITE_DESCRIPTION } from './fileToolDeps'
import { registerBuiltinTool } from '../services/toolRegistry'
import { t } from '../i18n'

/** 构建桌面 write 工具实例 */
export const makeWriteTool = (ctx: ToolContext): ReturnType<typeof createFileToolSuite>['write'] =>
  createFileToolSuite(makeDesktopFileToolDeps(ctx)).write

registerBuiltinTool({
  name: 'write',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.write.labelKey),
  getHint: () => t('tool.writeHint'),
  factory: (ctx) => makeWriteTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.write.presentation,
  describe: () => ({ description: WRITE_DESCRIPTION, parameters: WriteParamsSchema })
})

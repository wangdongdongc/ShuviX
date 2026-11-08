/**
 * Delete 工具（桌面注册）—— 删除一个文件或一个空目录（不递归）。整条执行流程复用共享 createFileToolSuite，
 * 仅注入桌面端适配（Node fs 的 unlink / rmdir、fileTime、绝对路径、桌面安全上下文，见 fileToolDeps）。
 * 过写路径门；改动经 onFileChange 进 files.changed 与知识库变更管线（Deletion）。
 */
import { createFileToolSuite, DELETE_DESCRIPTION, DeleteParamsSchema } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { ToolContext } from '../services/toolContext'
import { makeDesktopFileToolDeps } from './fileToolDeps'
import { registerBuiltinTool } from '../services/toolRegistry'
import { t } from '../i18n'

/** 构建桌面 delete 工具实例 */
export const makeDeleteTool = (
  ctx: ToolContext
): ReturnType<typeof createFileToolSuite>['delete'] =>
  createFileToolSuite(makeDesktopFileToolDeps(ctx)).delete

registerBuiltinTool({
  name: 'delete',
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.delete.labelKey),
  getHint: () => t('tool.deleteHint'),
  factory: (ctx) => makeDeleteTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.delete.presentation,
  describe: () => ({ description: DELETE_DESCRIPTION, parameters: DeleteParamsSchema })
})

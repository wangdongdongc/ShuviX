/**
 * Move 工具（桌面注册）—— 挪动 / 改名一个文件或目录。整条执行流程复用共享 createFileToolSuite，
 * 仅注入桌面端适配（Node fs 的 rename / fileTime / 绝对路径 / 桌面安全上下文，见 fileToolDeps）。
 * 源与目标各过一次写路径门；改动经 onFileChange 进 files.changed 与知识库变更管线（源 delete + 目标 write）。
 */
import { createFileToolSuite, MOVE_DESCRIPTION, MoveParamsSchema } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { ToolContext } from '../services/toolContext'
import { makeDesktopFileToolDeps } from './fileToolDeps'
import { registerBuiltinTool } from '../services/toolRegistry'
import { t } from '../i18n'

/** 构建桌面 move 工具实例 */
export const makeMoveTool = (ctx: ToolContext): ReturnType<typeof createFileToolSuite>['move'] =>
  createFileToolSuite(makeDesktopFileToolDeps(ctx)).move

registerBuiltinTool({
  name: 'move',
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.move.labelKey),
  getHint: () => t('tool.moveHint'),
  factory: (ctx) => makeMoveTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.move.presentation,
  describe: () => ({ description: MOVE_DESCRIPTION, parameters: MoveParamsSchema })
})

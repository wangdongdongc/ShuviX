/**
 * Edit 工具（桌面注册）—— 整条执行流程复用共享 createFileToolSuite，
 * 仅注入桌面端适配（Node fs / fileTime / 绝对路径 / SQLite SandboxPolicy，见 fileToolDeps）。
 */
import { createFileToolSuite } from '@shuvix/agent-runtime'
import type { ToolContext } from '../services/toolContext'
import { makeDesktopFileToolDeps } from './fileToolDeps'
import { registerBuiltinTool } from '../services/toolRegistry'
import { t } from '../i18n'

/** 构建桌面 edit 工具实例 */
export const makeEditTool = (ctx: ToolContext): ReturnType<typeof createFileToolSuite>['edit'] =>
  createFileToolSuite(makeDesktopFileToolDeps(ctx)).edit

registerBuiltinTool({
  name: 'edit',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t('tool.editLabel'),
  getHint: () => t('tool.editHint'),
  factory: (ctx) => makeEditTool(ctx),
  presentation: {
    icon: 'FilePen',
    summaryField: 'path',
    formItems: [
      { field: 'path' },
      { field: 'oldText', renderer: { type: 'code', language: 'typescript' } },
      { field: 'newText', renderer: { type: 'code', language: 'typescript' } }
    ]
  }
})

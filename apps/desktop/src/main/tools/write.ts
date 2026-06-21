/**
 * Write 工具（桌面注册）—— 整条执行流程复用共享 createFileToolSuite，
 * 仅注入桌面端适配（Node fs / fileTime / 绝对路径 / SQLite SandboxPolicy，见 fileToolDeps）。
 */
import { createFileToolSuite } from '@shuvix/agent-runtime'
import type { ToolContext } from '../services/toolContext'
import { makeDesktopFileToolDeps } from './fileToolDeps'
import { registerBuiltinTool } from '../services/toolRegistry'
import { t } from '../i18n'

/** 构建桌面 write 工具实例 */
export const makeWriteTool = (ctx: ToolContext): ReturnType<typeof createFileToolSuite>['write'] =>
  createFileToolSuite(makeDesktopFileToolDeps(ctx)).write

registerBuiltinTool({
  name: 'write',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t('tool.writeLabel'),
  getHint: () => t('tool.writeHint'),
  factory: (ctx) => makeWriteTool(ctx),
  presentation: {
    icon: 'FileOutput',
    summaryField: 'path',
    formItems: [
      { field: 'path' },
      { field: 'content', renderer: { type: 'code', language: 'typescript' } }
    ]
  }
})

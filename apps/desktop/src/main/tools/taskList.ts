/**
 * update_plan 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createTaskListTool（docs/task-list-design.md §9）。
 *
 * 列表从这条会话开着的 durable 会话里读（agent-runtime `readTaskList`，折叠到这次调用之前），不在工具里记账；
 * 界面那边由 chat-ui `TaskListPanel` 按投影出来的消息画，两边用同一份折叠。会话没开着（不该发生：工具正在
 * 这条会话里跑）就当这个请求里还没有列表。
 */
import {
  createTaskListTool,
  readTaskList,
  TaskListParamsSchema,
  TASK_LIST_DESCRIPTION
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { TASK_LIST_TOOL_NAME } from '@shuvix/chat-protocol/taskList'
import { registerBuiltinTool } from '../services/toolRegistry'
import { peekSessionHost } from '../services/sessionHost'
import { createLogger } from '../logger'
import { t } from '../i18n'

const log = createLogger('tool:update_plan')

registerBuiltinTool({
  name: TASK_LIST_TOOL_NAME,
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS[TASK_LIST_TOOL_NAME].labelKey),
  getHint: () => t('tool.taskListHint'),
  factory: (ctx) =>
    createTaskListTool({
      label: t(BUILTIN_TOOL_PRESENTATIONS[TASK_LIST_TOOL_NAME].labelKey),
      readTaskList: async (beforeToolCallId) => {
        const session = peekSessionHost()?.get(ctx.sessionId)
        return session === undefined ? undefined : readTaskList(session, beforeToolCallId)
      },
      onReadError: (error) =>
        log.warn(`readTaskList failed session=${ctx.sessionId}: ${String(error)}`)
    }),
  presentation: BUILTIN_TOOL_PRESENTATIONS[TASK_LIST_TOOL_NAME].presentation,
  describe: () => ({ description: TASK_LIST_DESCRIPTION, parameters: TaskListParamsSchema })
})

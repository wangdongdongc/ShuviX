/**
 * 任务列表工具 `update_plan`（宿主无关）—— pi-durable 原生注册项（docs/task-list-design.md §3、§9）。
 *
 * agent 用它维护「这次请求的步骤 + 状态」，界面把它钉在对话流末尾，让用户不读每条消息也能跟上进度。它是
 * **进度显示**，不是流程：没有审批关口、不产出文档，只规定形状（步骤 + 状态），怎么拆、怎么做都是模型自己的事。
 * 规则全部写在工具描述里（与系统提示一样常驻），并挂在模型本来就要做的动作上（第一个工具调用带上整张列表、
 * 开始下一步的那个调用顺带推进）；**收尾归宿主**（会话空闲时界面按请求怎么结束的来收），模型忘了最后一步
 * 也不会留下一张永远「进行中」的列表。
 *
 * **不存状态**：每次调用经宿主注入的 `readTaskList` 从已提交的条目折叠出这次调用之前的列表（`readTaskList`，
 * durable/taskListReader.ts），套上这次的参数、校验、回一行状态。读不到（宿主没接、会话没开着）就按「这个请求里
 * 还没有列表」处理 —— 只影响这一行状态和推进类调用的校验，界面那边读的是投影，不受影响。
 *
 * **只给会话的根 agent**：列表只画在这条会话的对话流末尾，读的也是根 agent 那条对话；派出的 agent 档案里写了
 * 也不给（`normalizeToolNames`，与 `tool_search` 同一条）。
 *
 * 2026-11-14 从实验的内置 MCP（`plan` server 的 `mcp__plan__update`）转正：参数、结果文本、折叠规则都没变，
 * 换的只是载体与名字（与 Codex、Claude 桌面端的同类工具同名）。`replay: 'safe'`：一次调用只读转写、不改任何东西。
 */
import { Type } from 'typebox'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import {
  applyTaskListUpdate,
  describeTaskList,
  parseTaskListUpdate,
  TASK_LIST_MAX_ITEMS,
  TASK_LIST_TOOL_NAME,
  type TaskListItem
} from '@shuvix/chat-protocol/taskList'
import { catchToolErrors, toExecutionResult } from './tools/toolResult'
import { backstopOutputLimits } from './tools/outputLimits'

export const TASK_LIST_DESCRIPTION = [
  'Keep a short task list that ShuviX pins under your latest message while you work, so they can follow your progress without reading every message. It shows progress; it is not an approval step — keep working after you send it.',
  '',
  'Use it for a request that will take several tool calls (edits files, runs more than one command, reads across many files). Skip it for a direct answer or a single command.',
  '',
  '- Start of the request: send `items`, the whole plan in order — short imperative steps of a few words, the step you are starting `in_progress`, the rest `pending`. Send it in the same message as your first real tool call, even one that only reads. If you must look around first, make that the first step and send `items` again once you know more.',
  '- A step finished: send `{"advance": true}` in the same message as the call that begins the next step. Out of order: `{"done": [2], "start": 4}` (1-based).',
  '- The plan changed — including after the user sends a message mid-run that changes what they want: send `items` again, the whole new list.',
  '- Keep exactly one step `in_progress` while working.',
  '- Do not also write the plan as a list in your reply.',
  '- No closing call is needed: when your run ends, ShuviX closes the list.'
].join('\n')

export const TaskListParamsSchema = Type.Object(
  {
    items: Type.Optional(
      Type.Array(
        Type.Object(
          {
            content: Type.String({ description: 'A short imperative step, a few words.' }),
            status: Type.Union([
              Type.Literal('pending'),
              Type.Literal('in_progress'),
              Type.Literal('completed')
            ])
          },
          { additionalProperties: false }
        ),
        {
          description: 'The whole plan, in order; replaces the current list.',
          minItems: 1,
          maxItems: TASK_LIST_MAX_ITEMS
        }
      )
    ),
    advance: Type.Optional(
      Type.Boolean({
        description: 'true: finish the step in progress and start the next pending one.'
      })
    ),
    done: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1 }), {
        description: 'Step numbers (1-based) to mark completed.'
      })
    ),
    start: Type.Optional(
      Type.Integer({ minimum: 1, description: 'Step number (1-based) to start.' })
    )
  },
  { additionalProperties: false }
)

/** 宿主的读者：这条会话里、`beforeToolCallId` 那次调用之前的列表；这个请求里还没有 → undefined */
export type TaskListReader = (beforeToolCallId: string) => Promise<TaskListItem[] | undefined>

export interface CreateTaskListToolOptions {
  label?: string
  /** 不给 → 推进类调用一律当「还没有列表」（只有 `items` 能成功） */
  readTaskList?: TaskListReader
  /** 读者抛错时（当作还没有列表）记一笔 */
  onReadError?: (error: unknown) => void
}

/** 任务列表工具：durable 注册项 + 界面显示名 */
export type TaskListTool = ToolRegistration<typeof TaskListParamsSchema> & {
  readonly label: string
  readonly replay: 'safe'
}

export function createTaskListTool({
  label = 'Task list',
  readTaskList,
  onReadError
}: CreateTaskListToolOptions = {}): TaskListTool {
  return {
    name: TASK_LIST_TOOL_NAME,
    label,
    description: TASK_LIST_DESCRIPTION,
    parameters: TaskListParamsSchema,
    replay: 'safe',
    outputLimits: backstopOutputLimits({}),
    execute: (params, api, context) =>
      catchToolErrors(context, async () => {
        const update = parseTaskListUpdate(params ?? {})
        if ('error' in update) throw new Error(update.error)
        let current: TaskListItem[] | undefined
        if (update.kind !== 'items' && readTaskList) {
          try {
            current = await readTaskList(api.callId)
          } catch (error) {
            // 读不到当作还没有列表：只影响这一行状态，界面读的是投影
            onReadError?.(error)
          }
        }
        const next = applyTaskListUpdate(current, update)
        if ('error' in next) throw new Error(next.error)
        return toExecutionResult(
          {
            content: [{ type: 'text', text: describeTaskList(next, update.kind === 'items') }],
            details: undefined
          },
          TASK_LIST_TOOL_NAME
        )
      })
  }
}

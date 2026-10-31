/**
 * 内置能力服务器 `plan` —— 任务列表（docs/task-list-design.md §3，实验）。进程内 MCP server，按会话实例化。
 *
 * agent 用唯一的工具 `update` 维护「这次请求的步骤 + 状态」，界面把它钉在输入框上方，让用户不读每条消息也能
 * 跟上进度。它是**进度显示**，不是流程：没有审批关口、不产出文档，只规定形状（步骤 + 状态），怎么拆、怎么做
 * 都是模型自己的事。规则全部写在工具描述里（与系统提示一样常驻），并挂在模型本来就要做的动作上（第一个工具调用
 * 带上整张列表、开始下一步的那个调用顺带推进）；**收尾归宿主**（会话空闲时界面按请求怎么结束的来收），模型
 * 忘了最后一步也不会留下一张永远「进行中」的列表。
 *
 * **不存状态**：实例里不记账（实例随会话重建，记账会和转写分叉）。每次调用经 scope 注入的 `readTaskList`
 * 从已提交的条目折叠出这次调用之前的列表（agent-runtime `readTaskList`），套上这次的参数、校验、回一行状态。
 * 读不到（宿主没接、会话没开着）就按「这个请求里还没有列表」处理 —— 只影响这一行状态和推进类调用的校验，
 * 界面那边读的是投影，不受影响。
 *
 * **只给会话的根 agent**：列表只画在这条会话的输入框上方，读的也是根 agent 那条对话。一份实例由根与它派出的
 * agent 共用 —— 用户自己的 agent md 也能声明 `mcp:plan` 并被派出去，那样的调用按 `_meta` 里的对话认出来
 * （`agentOf`）直接回错误，免得它推进根 agent 的列表、也免得它以为有人看得到。认不出（宿主没接）按根处理。
 *
 * 为什么是内置能力服务器：实验功能要按会话默认不勾、用户自己勾上，`settings.enabledTools` 只收 `mcp:` 名；
 * 用到的特权是「专属渲染」（输入框上方的列表、卡片里不出行，chat-protocol `taskList.ts`）。
 *
 * 用**低层 `Server`**（纯 JSON Schema），理由同 ssh / database。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { builtinCallOwnerOf, type BuiltinMcpFactory } from '@shuvix/agent-runtime'
import {
  applyTaskListUpdate,
  describeTaskList,
  parseTaskListUpdate,
  TASK_LIST_MAX_ITEMS,
  TASK_LIST_MCP_SERVER_NAME,
  TASK_LIST_TOOL
} from '@shuvix/chat-protocol/taskList'
import type { DesktopBuiltinMcpScope } from './types'
import { createLogger } from '../../logger'

const log = createLogger('mcp:plan')

export { TASK_LIST_MCP_SERVER_NAME as PLAN_MCP_SERVER_NAME }

const DESCRIPTION = [
  "Keep a short task list that ShuviX pins above the user's input box while you work, so they can follow your progress without reading every message. It shows progress; it is not an approval step — keep working after you send it.",
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

const UPDATE_TOOL = {
  name: TASK_LIST_TOOL,
  title: 'Update the task list',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object' as const,
    properties: {
      items: {
        type: 'array',
        description: 'The whole plan, in order; replaces the current list.',
        minItems: 1,
        maxItems: TASK_LIST_MAX_ITEMS,
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'A short imperative step, a few words.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
          },
          required: ['content', 'status'],
          additionalProperties: false
        }
      },
      advance: {
        type: 'boolean',
        description: 'true: finish the step in progress and start the next pending one.'
      },
      done: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description: 'Step numbers (1-based) to mark completed.'
      },
      start: { type: 'integer', minimum: 1, description: 'Step number (1-based) to start.' }
    },
    additionalProperties: false
  },
  // 不改页面、不改文件、不碰外界；同一次调用重发会再推进一步，所以不幂等
  annotations: {
    title: 'Update the task list',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  }
}

export function createPlanMcpServerFactory(): BuiltinMcpFactory<DesktopBuiltinMcpScope> {
  return (scope, transport) => createPlanMcpServer(scope, transport)
}

export async function createPlanMcpServer(
  scope: DesktopBuiltinMcpScope,
  transport: Transport
): Promise<void> {
  const server = new Server(
    { name: 'shuvix-plan', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [UPDATE_TOOL] }))

  const text = (value: string, isError = false): CallToolResult => ({
    content: [{ type: 'text' as const, text: value }],
    ...(isError ? { isError: true } : {})
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TASK_LIST_TOOL) {
      return text(`Unknown tool: ${request.params.name}`, true)
    }
    const meta = request.params._meta as Record<string, unknown> | undefined
    const { conversationId } = builtinCallOwnerOf(meta)
    if (conversationId !== undefined && scope.agentOf?.(conversationId)?.kind === 'spawned') {
      return text(
        "The task list is shown only for the session's main agent; a dispatched agent cannot keep one. Report progress in your reply instead.",
        true
      )
    }
    const update = parseTaskListUpdate(request.params.arguments ?? {})
    if ('error' in update) return text(update.error, true)
    let current
    if (update.kind !== 'items') {
      const toolCallId =
        typeof meta?.['shuvix.dev/toolCallId'] === 'string'
          ? (meta['shuvix.dev/toolCallId'] as string)
          : undefined
      try {
        current = await scope.readTaskList?.(toolCallId)
      } catch (e) {
        // 读不到当作还没有列表：只影响这一行状态，界面读的是投影
        log.warn(`readTaskList failed session=${scope.sessionId}: ${String(e)}`)
      }
    }
    const next = applyTaskListUpdate(current, update)
    if ('error' in next) return text(next.error, true)
    return text(describeTaskList(next, update.kind === 'items'))
  })

  await server.connect(transport)
}

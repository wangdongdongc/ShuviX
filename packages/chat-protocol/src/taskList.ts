/**
 * 任务列表（内置能力服务器 `plan`，docs/task-list-design.md §3）的契约 —— agent 用 `mcp__plan__update` 维护
 * 「这次请求的步骤 + 状态」，界面把它钉在输入框上方。是**进度显示**，不是审批流程。
 *
 * **不存状态**（与 `suggest` 同一条纪律）：列表的内容就是工具调用的参数。一个请求里所有**成功**的调用按顺序
 * 折叠（`foldTaskList`）就是当前列表 —— server（读已提交的条目）与界面（读投影出来的消息）各自把手上的东西
 * 摊成同一种事件序列，再交给这一份折叠，所以两边不会分叉；回退、分支、fork 之后状态自然跟着转写走。
 *
 * **请求的边界**：一条「用户发起一轮」的消息开始一个新请求，列表随之清空。运行中插进来的话（带插话说明，
 * `midRunNote.ts`）、后台完成通知、指令注入都不算 —— 所以插话之后、自动续跑的那一轮里，列表还是同一张。
 *
 * **收尾归宿主**：模型不用（也没法）发一次「收尾」调用。会话空闲时按这个请求是不是以一条不带工具调用的回复
 * 结束来判断（`endedWithAnswer`）：是 → 剩下的步骤都算完成；否 → 已停止（中止、出错、中途退出），未完成的
 * 步骤保持原样。
 *
 * 纯数据、纯函数，不依赖 Node / Electron。
 */
import type { ChatMessage } from './types/chatMessage'
import { hasMidRunNote } from './midRunNote'

/** `mcp_servers.name` —— 也是工具名前缀 */
export const TASK_LIST_MCP_SERVER_NAME = 'plan'
/** server 里唯一的工具 */
export const TASK_LIST_TOOL = 'update'
/** 转写里的完整工具名 */
export const TASK_LIST_TOOL_NAME = `mcp__${TASK_LIST_MCP_SERVER_NAME}__${TASK_LIST_TOOL}`

export const TASK_LIST_MAX_ITEMS = 12
export const TASK_LIST_MAX_ITEM_CHARS = 200

export type TaskListStatus = 'pending' | 'in_progress' | 'completed'

export interface TaskListItem {
  content: string
  status: TaskListStatus
}

/** 一次调用说了什么（三选一） */
export type TaskListUpdate =
  | { kind: 'items'; items: TaskListItem[] }
  | { kind: 'advance' }
  | { kind: 'jump'; done: number[]; start?: number }

const STATUSES: readonly TaskListStatus[] = ['pending', 'in_progress', 'completed']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStepNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/** 参数 → 一次更新；不合格 → 给模型读的错误（英文） */
export function parseTaskListUpdate(args: unknown): TaskListUpdate | { error: string } {
  if (!isRecord(args)) return { error: 'Arguments must be an object.' }
  const hasItems = args.items !== undefined
  const hasAdvance = args.advance !== undefined
  const hasJump = args.done !== undefined || args.start !== undefined
  if (Number(hasItems) + Number(hasAdvance) + Number(hasJump) !== 1) {
    return { error: 'Send exactly one of: `items`, `advance`, or `done` / `start`.' }
  }
  if (hasItems) {
    const raw = args.items
    if (!Array.isArray(raw) || raw.length === 0) {
      return { error: '`items` must be a non-empty array of steps.' }
    }
    if (raw.length > TASK_LIST_MAX_ITEMS) {
      return {
        error: `The list has ${raw.length} steps; keep it to ${TASK_LIST_MAX_ITEMS} or fewer.`
      }
    }
    const items: TaskListItem[] = []
    for (const [i, item] of raw.entries()) {
      if (!isRecord(item)) return { error: `Step ${i + 1} must be an object.` }
      const content = typeof item.content === 'string' ? item.content.trim() : ''
      if (content === '') return { error: `Step ${i + 1} needs a non-empty \`content\`.` }
      if (content.length > TASK_LIST_MAX_ITEM_CHARS) {
        return { error: `Step ${i + 1} is too long; keep each step to a few words.` }
      }
      const status = item.status === undefined ? 'pending' : item.status
      if (!STATUSES.includes(status as TaskListStatus)) {
        return {
          error: `Step ${i + 1} has an unknown status; use pending, in_progress or completed.`
        }
      }
      items.push({ content, status: status as TaskListStatus })
    }
    return { kind: 'items', items }
  }
  if (hasAdvance) {
    if (args.advance !== true) return { error: '`advance` must be true.' }
    return { kind: 'advance' }
  }
  const done = args.done === undefined ? [] : args.done
  if (!Array.isArray(done) || !done.every(isStepNumber)) {
    return { error: '`done` must be an array of step numbers (1-based).' }
  }
  if (args.start !== undefined && !isStepNumber(args.start)) {
    return { error: '`start` must be a step number (1-based).' }
  }
  return {
    kind: 'jump',
    done: [...done],
    ...(args.start === undefined ? {} : { start: args.start as number })
  }
}

/** 把一次更新套到当前列表上；不合格（还没有列表、步骤号越界）→ 给模型读的错误 */
export function applyTaskListUpdate(
  current: readonly TaskListItem[] | undefined,
  update: TaskListUpdate
): TaskListItem[] | { error: string } {
  if (update.kind === 'items') return update.items.map((item) => ({ ...item }))
  if (current === undefined || current.length === 0) {
    return { error: 'No task list in this request yet: send `items` first.' }
  }
  const items = current.map((item) => ({ ...item }))
  if (update.kind === 'advance') {
    const at = items.findIndex((item) => item.status === 'in_progress')
    if (at !== -1) items[at].status = 'completed'
    // 下一步：进行中那一步之后的第一个待做；没有进行中的 → 第一个待做
    const after = items.findIndex((item, i) => i > at && item.status === 'pending')
    const next = after !== -1 ? after : items.findIndex((item) => item.status === 'pending')
    if (next !== -1) items[next].status = 'in_progress'
    return items
  }
  const steps = [...update.done, ...(update.start === undefined ? [] : [update.start])]
  const outOfRange = steps.find((n) => n > items.length)
  if (outOfRange !== undefined) {
    return { error: `Step ${outOfRange} does not exist: the list has ${items.length} steps.` }
  }
  for (const n of update.done) items[n - 1].status = 'completed'
  if (update.start !== undefined) {
    // 只留一个进行中：之前进行中的那一步（没说做完）退回待做
    for (const item of items) if (item.status === 'in_progress') item.status = 'pending'
    items[update.start - 1].status = 'in_progress'
  }
  return items
}

/** 一次成功调用的结果文本（模型读）：只是一行状态，与 Claude 桌面端的同一种口吻 */
export function describeTaskList(items: readonly TaskListItem[], replaced: boolean): string {
  const total = items.length
  if (replaced) return `Plan shown (${total} ${total === 1 ? 'step' : 'steps'}).`
  const at = items.findIndex((item) => item.status === 'in_progress')
  if (at !== -1) return `Plan updated: step ${at + 1} of ${total} is in progress.`
  const done = items.filter((item) => item.status === 'completed').length
  if (total === 1)
    return done === 1 ? 'Plan updated: the step is done.' : 'Plan updated: the step is not started.'
  if (done === total) return `Plan updated: all ${total} steps are done.`
  return `Plan updated: ${done} of ${total} steps are done.`
}

/** 折叠的输入：一个新请求开始，或一次**成功**的列表调用（失败的调用不改列表，调用方不交进来） */
export type TaskListEvent = { type: 'request' } | { type: 'update'; args: unknown }

/** 按顺序折叠出当前请求的列表；这个请求里还没有成功的调用 → undefined */
export function foldTaskList(events: Iterable<TaskListEvent>): TaskListItem[] | undefined {
  let items: TaskListItem[] | undefined
  for (const event of events) {
    if (event.type === 'request') {
      items = undefined
      continue
    }
    const update = parseTaskListUpdate(event.args)
    if ('error' in update) continue
    const next = applyTaskListUpdate(items, update)
    if (!('error' in next)) items = next
  }
  return items
}

/** 一条投影出来的用户消息是不是「用户发起一轮」（插话、通知、指令注入都不是） */
export function startsTaskListRequest(message: ChatMessage): boolean {
  if (message.role !== 'user' || message.type !== 'text') return false
  const meta = message.metadata
  if (meta?.isSystemNotice || meta?.isInstructionInjection) return false
  return !hasMidRunNote(meta?.inlineTokens)
}

/** 界面要的：当前请求的列表，以及这个请求是不是以一条最终回复收尾的 */
export interface TaskListSnapshot {
  items: TaskListItem[]
  /**
   * 请求里最后一条消息是正常结束、不带工具调用的助手回复（会话空闲时据此判「完成」还是「已停止」；
   * 被中止时截断的正文带 `metadata.stopped`，不算）
   */
  endedWithAnswer: boolean
  /** 开始这个请求的那条用户消息的 id（压缩掉了 / 会话第一条之前没有 → ''）：界面按请求记展开状态 */
  requestId: string
}

/** 投影出来的消息 → 当前请求的列表；这个请求里没有成功的列表调用 → undefined */
export function taskListOfMessages(messages: readonly ChatMessage[]): TaskListSnapshot | undefined {
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (startsTaskListRequest(messages[i])) {
      start = i + 1
      break
    }
  }
  const events: TaskListEvent[] = []
  for (let i = start; i < messages.length; i++) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    for (const block of message.blocks) {
      if (block.type !== 'tool' || block.toolName !== TASK_LIST_TOOL_NAME) continue
      if (block.result === undefined || block.isError) continue
      events.push({ type: 'update', args: block.args })
    }
  }
  const items = foldTaskList(events)
  if (items === undefined) return undefined
  const last = messages[messages.length - 1]
  const endedWithAnswer =
    last !== undefined &&
    last.role === 'assistant' &&
    !last.metadata?.isCompactionSummary &&
    !last.metadata?.stopped &&
    !last.blocks.some((block) => block.type === 'tool')
  return { items, endedWithAnswer, requestId: start > 0 ? messages[start - 1].id : '' }
}

/**
 * 卡片里不显示的列表调用：没失败的（在跑的、成功的）—— 全部信息就在输入框上方那张列表里，它们一闪而过地
 * 占一行只是噪音。失败的照常是红行：模型要重发，用户也该看到。
 */
export function isHiddenTaskListBlock(block: {
  type: string
  toolName?: string
  isError?: boolean
}): boolean {
  return block.type === 'tool' && block.toolName === TASK_LIST_TOOL_NAME && !block.isError
}

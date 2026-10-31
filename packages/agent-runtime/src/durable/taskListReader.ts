/**
 * 任务列表的 server 侧读者（docs/task-list-design.md §3.2）：从当前对话**已提交**的条目折叠出这次调用之前的列表。
 *
 * 与界面读投影消息的 `taskListOfMessages` 用同一份折叠（chat-protocol `foldTaskList`），只是把条目摊成事件：
 *  - `pi.user`：通知形状（`isSystemNoticeText`）与带插话说明的（模型文本以说明结尾，`midRunNote.ts`）不算新请求，
 *    其余开始一个新请求 —— 与界面的 `startsTaskListRequest` 同一口径（界面看侧车里的 Token，这里看它写进模型
 *    文本的那段说明，两者出自同一次写入）；
 *  - `pi.assistant` 里的 `mcp__plan__update` 调用登记下来，配上**没出错**的 `pi.toolResult` 才算一次更新；
 *  - 失败轮（`stopReason === 'error'` 且带 errorMessage）里的调用不登记，与转写摘要相同。
 * `beforeToolCallId` 那次调用（正在执行的这一次）不算：结果只反映它之外、已经落定的那些。
 *
 * **只读**：只用 `currentConversation()` 与 `Conversation.context()`，不开启调度器、不建 agent、不写。
 * 不依赖 Node / Electron。
 */
import {
  AssistantEntry,
  ToolResultEntry,
  UserEntry,
  type EntryRecord
} from '@earendil-works/pi-durable'
import { MID_RUN_NOTE_SEPARATOR, MID_RUN_NOTE_TEXT } from '@shuvix/chat-protocol/midRunNote'
import { isSystemNoticeText } from '@shuvix/chat-protocol/systemNoticeContract'
import {
  foldTaskList,
  TASK_LIST_TOOL_NAME,
  type TaskListEvent,
  type TaskListItem
} from '@shuvix/chat-protocol/taskList'
import { backgroundContext as BG, isClosedError } from './context'
import { SessionClosedError, type DurableSession } from './durableSession'
import { firstMessage, userText } from './projection/entryText'

export type TaskListReaderSession = Pick<DurableSession, 'sessionId' | 'currentConversation'>

const NOTE_SUFFIX = `${MID_RUN_NOTE_SEPARATOR}${MID_RUN_NOTE_TEXT}`

/**
 * 条目（按转写顺序）→ 折叠事件；`before` 那次调用（正在执行的这一次）不算。
 *
 * 「这一次」是转写里**最后一个**带这个 id 的列表调用：有的 provider 按消息编号 toolCallId（`call_0` …），
 * 同一个 id 在会话里会重复出现，第一个同名的是很久以前的另一次调用。读到它也不停下：同一条助手消息里排在
 * 它前面的列表调用，结果条目落在这条消息之后，读完才算得进去（与界面折叠同一批调用）。
 */
export function taskListEventsOfEntries(
  entries: Iterable<EntryRecord>,
  before?: string
): TaskListEvent[] {
  const all = [...entries]
  /** 正在执行的这一次：最后一个带 `before` 这个 id 的列表调用（条目下标 + 块下标） */
  let current: { entry: number; block: number } | undefined
  if (before !== undefined) {
    all.forEach((entry, entryIndex) => {
      if (entry.kind !== AssistantEntry.kind) return
      const content = firstMessage(entry, 'assistant')?.content
      ;(Array.isArray(content) ? content : []).forEach((block, blockIndex) => {
        if (
          block?.type === 'toolCall' &&
          block.name === TASK_LIST_TOOL_NAME &&
          block.id === before
        ) {
          current = { entry: entryIndex, block: blockIndex }
        }
      })
    })
  }
  const events: TaskListEvent[] = []
  /** toolCallId → 参数（还没配上结果的列表调用；同一个 id 再出现时以新的为准） */
  const pending = new Map<string, unknown>()
  all.forEach((entry, entryIndex) => {
    switch (entry.kind) {
      case UserEntry.kind: {
        const message = firstMessage(entry, 'user')
        if (message === undefined) break
        const text = userText(message.content)
        if (isSystemNoticeText(text) || text.endsWith(NOTE_SUFFIX)) break
        events.push({ type: 'request' })
        break
      }
      case AssistantEntry.kind: {
        const message = firstMessage(entry, 'assistant')
        if (message === undefined) break
        if (message.stopReason === 'error' && message.errorMessage) break
        const content = Array.isArray(message.content) ? message.content : []
        content.forEach((block, blockIndex) => {
          if (block?.type !== 'toolCall' || block.name !== TASK_LIST_TOOL_NAME) return
          if (current?.entry === entryIndex && current.block === blockIndex) {
            // 正在执行的这一次不算；之前登记的同名调用也作废（它的结果若还没到，就不会再到了）
            pending.delete(block.id)
            return
          }
          pending.set(block.id, block.arguments)
        })
        break
      }
      case ToolResultEntry.kind: {
        const message = firstMessage(entry, 'toolResult')
        if (message === undefined || !pending.has(message.toolCallId)) break
        const args = pending.get(message.toolCallId)
        pending.delete(message.toolCallId)
        if (!message.isError) events.push({ type: 'update', args })
        break
      }
    }
  })
  return events
}

/**
 * 当前对话里、`beforeToolCallId` 那次调用之前的列表；这个请求里还没有 → undefined。
 * 句柄已关停 → `SessionClosedError`；其余失败原样抛出。
 */
export async function readTaskList(
  session: TaskListReaderSession,
  beforeToolCallId?: string
): Promise<TaskListItem[] | undefined> {
  try {
    const conversation = await session.currentConversation()
    const view = await conversation.context(BG)
    return foldTaskList(taskListEventsOfEntries(view.entries, beforeToolCallId))
  } catch (error) {
    if (isClosedError(error)) throw new SessionClosedError(session.sessionId)
    throw error
  }
}

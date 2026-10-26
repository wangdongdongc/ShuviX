/**
 * 正在执行的工具调用各还原了哪些类别（docs/auto-redaction-design.md §3.5）。
 *
 * 还原发生在工具包装层（wrapToolOutput），而路径门、命令门这些执行点在工具本体里各自构造 EnforceOpts ——
 * 它们按 (会话, durable taskId) 在这里查到这次调用的 `tool.restored`。taskId 会话内唯一（provider 的 toolCallId
 * 可能重复）。执行前记、执行完（成败、取消都算）删。
 */

const calls = new Map<string, string[]>()

const keyOf = (sessionId: string, taskId: number): string => `${sessionId}\u0000${taskId}`

export function setRestoredCategories(
  sessionId: string,
  taskId: number,
  categories: string[]
): void {
  if (categories.length > 0) calls.set(keyOf(sessionId, taskId), categories)
}

export function clearRestoredCategories(sessionId: string, taskId: number): void {
  calls.delete(keyOf(sessionId, taskId))
}

/** 这次调用还原了哪些类别；没有 taskId（不经 durable 工具的检查）或没还原 → undefined */
export function restoredCategoriesOf(
  sessionId: string,
  taskId: number | undefined
): string[] | undefined {
  return taskId === undefined ? undefined : calls.get(keyOf(sessionId, taskId))
}

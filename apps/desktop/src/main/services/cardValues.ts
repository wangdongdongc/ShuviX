/**
 * 询问卡上填的值（`AskResponse.values`，见 chat-protocol `AskField`）—— 宿主收下、交给发起询问的那个工具，**从不往下传**。
 *
 * 为什么另放一处而不随应答走：应答要交给运行时，运行时会把它记进会话（卡片答完之后留在对话里当记录）。
 * 卡上填的多半是 API key、token，它们只该落进工具要写的那个地方（比如加密的 mcp_servers 行），
 * 不该进会话记录，更不该进模型。所以 `AgentSession.respondToInput` 先把值取下来存在这里，剩下的应答照常交下去；
 * 工具等到「批准」之后按自己的询问 id 来取，取一次就没了。
 *
 * 只在内存里：进程退出就没了 —— 那次工具调用本来也随之中断（`shuvix` 工具不重跑）。
 * 没人来取的（工具在批准之后、取值之前被中止）过一会儿自己清掉，不留在内存里。
 */

/** 没人取的值留多久 */
const UNCLAIMED_TTL_MS = 10 * 60 * 1000

const pending = new Map<string, { values: Record<string, string>; timer: NodeJS.Timeout }>()

const keyOf = (sessionId: string, requestId: string): string => `${sessionId}\u0000${requestId}`

/** 收下一次应答带的值（同一条询问再来一次就换成新的） */
export function stashCardValues(
  sessionId: string,
  requestId: string,
  values: Record<string, string>
): void {
  const key = keyOf(sessionId, requestId)
  const previous = pending.get(key)
  if (previous) clearTimeout(previous.timer)
  const timer = setTimeout(() => pending.delete(key), UNCLAIMED_TTL_MS)
  timer.unref?.()
  pending.set(key, { values, timer })
}

/** 取走这条询问的值（取一次就没了）；没有 → undefined */
export function takeCardValues(
  sessionId: string,
  requestId: string
): Record<string, string> | undefined {
  const key = keyOf(sessionId, requestId)
  const entry = pending.get(key)
  if (!entry) return undefined
  clearTimeout(entry.timer)
  pending.delete(key)
  return entry.values
}

/**
 * 只留询问里要的键、只留字符串值：应答来自前端（不可信），多给的键不该借这条路送进工具。
 * 询问没要值（没有 fields）→ undefined，应答带来的值整个丢掉。
 */
export function acceptedCardValues(
  request: { fields?: ReadonlyArray<{ key: string }> } | undefined,
  values: unknown
): Record<string, string> | undefined {
  if (!request?.fields || request.fields.length === 0) return undefined
  if (typeof values !== 'object' || values === null) return undefined
  const out: Record<string, string> = {}
  for (const { key } of request.fields) {
    const value = (values as Record<string, unknown>)[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** 仅供测试 */
export function resetCardValuesForTests(): void {
  for (const { timer } of pending.values()) clearTimeout(timer)
  pending.clear()
}

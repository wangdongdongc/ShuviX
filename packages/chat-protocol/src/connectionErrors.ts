/**
 * 连接类失败的约定：会「断线」的渠道（web 客户端的 WebSocket）拒绝一次调用时带的 `code`。两种要分开对待：
 *
 *  - `disconnected`（`lost`）：调用已经发出去，没等到结果连接就断了。**结果未知** —— 服务端多半照常在处理
 *    （`agent.prompt` / `agent.continue` 要等整轮落定才回，断线时这一轮通常还在跑）。
 *  - `not_connected`（`not-sent`）：断着的时候调的，根本没发出去。**一定没生效**。
 */
export const CONNECTION_LOST_CODE = 'disconnected'
export const NOT_CONNECTED_CODE = 'not_connected'

export type ConnectionFailure = 'lost' | 'not-sent'

/** 这次拒绝是不是连接造成的；不是（处理函数抛错、策略拒绝 ……）→ null */
export function connectionFailureOf(error: unknown): ConnectionFailure | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (code === CONNECTION_LOST_CODE) return 'lost'
  if (code === NOT_CONNECTED_CODE) return 'not-sent'
  return null
}

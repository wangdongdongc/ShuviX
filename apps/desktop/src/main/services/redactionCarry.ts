import { createLogger } from '../logger'

/**
 * 内容跨会话流动时，带上它引用到的对照表项（docs/auto-redaction-design.md §5.3）：子会话的指令、引导、回答，
 * 以及从子会话 / 别的会话读回来的结果。对方的历史因此不依赖来源会话还在不在 —— 来源被删了，复制过去的
 * 表项还在对方的表里。
 *
 * 哪边没配脱敏、来源会话的存储不存在（从没发过消息）就什么都不做；出错只记日志 —— 复制失败的后果是对方那几个
 * 占位符还原不了（工具调用会被拦下、界面只显示标记），不该让消息本身发不出去。
 */

const log = createLogger('Redaction')

export async function carryRedactions(
  fromSessionId: string,
  toSessionId: string,
  texts: readonly string[]
): Promise<void> {
  if (fromSessionId === toSessionId || !texts.some((t) => t.includes('_'))) return
  try {
    // 现取（动态 import）：会话宿主一 import 就连着数据库与 Electron，工具模块在测试里不该被它拖上
    const { getSessionHost } = await import('./sessionHost')
    const host = getSessionHost()
    const target = host.get(toSessionId) ?? (await host.peek(toSessionId))
    const source = host.get(fromSessionId) ?? (await host.peek(fromSessionId))
    if (!target?.redaction || !source?.redaction) return
    await target.redaction.importFrom(source.redaction, texts)
  } catch (err) {
    log.warn(
      `copying placeholder entries from ${fromSessionId} to ${toSessionId} failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** 从几条候选来源会话里复制（等多个子会话的结果时，不知道哪个占位符来自哪条） */
export async function carryRedactionsFromAny(
  fromSessionIds: readonly string[],
  toSessionId: string,
  texts: readonly string[]
): Promise<void> {
  for (const id of new Set(fromSessionIds)) await carryRedactions(id, toSessionId, texts)
}
